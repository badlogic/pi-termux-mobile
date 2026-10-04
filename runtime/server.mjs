// Minimal HTTP+SSE bridge: web UI <-> pi-durable Harness (crash-safe, SQLite storage).
// Env: HOME (set by app), PI_PORT (default 0=ephemeral, port written to
// $HOME/.pi-mobile/port), PI_WORKDIR (agent cwd), PI_SHELL (bash path),
// PI_REMOTES (JSON: {"name": {"url": "http://host:port", "token": "..."}})
// — a conversation whose cwd is "remote:<name>:/path" runs its tools on that host.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  AssistantEntry, configure, createRegistry, defineExtension, defineTool,
  Harness, watchEvents,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { RemoteExecutionEnv } from './remote-env.mjs';

const ctx = BACKGROUND_CONTEXT;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME || ROOT;
const WORKDIR = process.env.PI_WORKDIR || HOME_DIR;
const AGENT_DIR = path.join(HOME_DIR, '.pi', 'agent');
const AUTH_PATH = path.join(AGENT_DIR, 'auth.json');
const STATE_DIR = path.join(HOME_DIR, '.pi-mobile');
const PORT_FILE = path.join(STATE_DIR, 'port');
const TOKEN_FILE = path.join(STATE_DIR, 'token');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const PUBLIC = path.join(ROOT, 'public');
const REMOTES = JSON.parse(process.env.PI_REMOTES || '{}');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// --- credentials: file-backed CredentialStore over ~/.pi/agent/auth.json ----

function readAuthFile() {
  try { return JSON.parse(readFileSync(AUTH_PATH, 'utf8')); } catch { return {}; }
}
async function writeAuth(data) {
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(AUTH_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}
const credentialStore = {
  read: async (providerId) => readAuthFile()[providerId],
  list: async () => Object.entries(readAuthFile()).map(([providerId, c]) => ({ providerId, type: c?.type })),
  modify: async (providerId, fn) => {
    const data = readAuthFile();
    const next = await fn(data[providerId]);
    if (next === undefined) delete data[providerId]; else data[providerId] = next;
    await writeAuth(data);
    return next;
  },
  delete: async (providerId) => { const d = readAuthFile(); delete d[providerId]; await writeAuth(d); },
};

// --- subagent extension (pi-durable README pattern) --------------------------

const Subagent = defineExtension({
  name: 'subagent',
  tools: [
    defineTool({
      name: 'subagent',
      description: 'Delegate a self-contained task to a subagent conversation and return its final answer.',
      parameters: Type.Object({ task: Type.String() }),
      replay: 'safe',
      execute: async (args, api, context) => {
        const childId = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
          await configure(tx, created.id, { extensions: { remove: [Subagent] } });
          return created.id;
        }, context);
        await api.details({ conversationId: childId }, context);
        const conv = await api.conversation(childId, context);
        if (!conv) return { content: [{ type: 'text', text: 'subagent conversation unavailable' }] };
        const settled = await (await conv.submit(
          { type: 'input', content: args.task, requestId: `subagent:${api.taskId}` }, context)).wait(context);
        let text = settled.status;
        if (settled.status === 'done' && settled.answer) {
          const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
          const parts = entry?.content ?? entry?.model ?? [];
          text = Array.isArray(parts)
            ? parts.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
            : String(parts);
        }
        return { content: [{ type: 'text', text }] };
      },
    }),
  ],
});

// --- harness ----------------------------------------------------------------

let harness = null;
let root = null;
let eventStream = null;
let localSessions = { sessions: {} };
const sseClients = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

function envFor({ cwd } = {}) {
  const dir = cwd ?? WORKDIR;
  const m = /^remote:([^:]+):(.+)$/.exec(dir);
  if (m && REMOTES[m[1]]) {
    return new RemoteExecutionEnv({ cwd: m[2], baseUrl: REMOTES[m[1]].url, token: REMOTES[m[1]].token });
  }
  const prefix = process.env.PREFIX;
  const bash = prefix && existsSync(path.join(prefix, 'bin/bash'))
    ? path.join(prefix, 'bin/bash') : undefined;
  const shellEnv = prefix
    ? { ...process.env, PATH: `${prefix}/bin:/system/bin:${process.env.PATH || ''}` }
    : undefined;
  return new NodeExecutionEnv({
    cwd: dir,
    shellPath: process.env.PI_SHELL || bash,
    shellEnv,
  });
}

async function pickModel() {
  const provider = process.env.PI_PROVIDER;
  const modelId = process.env.PI_MODEL;
  if (provider && modelId) return { provider, modelId };
  try {
    const avail = await models.getAvailable();
    console.log('pickModel: available =', avail.length);
    const m = avail[0];
    if (m) return { provider: m.provider, modelId: m.id };
  } catch (e) { console.error('pickModel:', e); }
  return undefined;
}

const models = createModels({ credentials: credentialStore });
for (const p of builtinProviders()) models.setProvider(p);

function readLocalSessions() {
  try { return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')); } catch { return { sessions: {} }; }
}
async function saveLocalSessions() {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SESSIONS_FILE, JSON.stringify(localSessions, null, 2));
}
async function watchConversation(conversation) {
  if (eventStream) { try { await eventStream.stop(); } catch {} }
  root = conversation;
  eventStream = await watchEvents(harness, root.id, ctx);
  broadcast({ type: 'bridge_snapshot', snapshot: eventStream.snapshot });
  eventStream.start(async (events) => { for (const e of events) broadcast(e); });
}

async function initHarness() {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Subagent);
  const storage = await openNodeSqliteStorage(path.join(STATE_DIR, 'harness.sqlite'));
  harness = await Harness.open(storage, { models, registry, env: envFor }, ctx);
  root = await harness.root(ctx, { agent: { model: await pickModel() } });
  // root() only applies `agent` on first creation — configure explicitly so
  // restarts against existing storage also get a model.
  try {
    const view = await root.viewState(ctx);
    if (!view?.value?.agent?.model) {
      const m = await pickModel();
      if (m) await root.configure({ model: m }, ctx);
    }
  } catch (e) { console.error('configure model:', e?.message || e); }
  localSessions = readLocalSessions();
  if (!localSessions.sessions[root.id]) {
    localSessions.sessions[root.id] = { id: root.id, name: 'Main', created: new Date().toISOString() };
    await saveLocalSessions();
  }
  await watchConversation(root);
  harness.resume();
}

async function setApiKey(provider, key) {
  await credentialStore.modify(provider, async () => ({ type: 'api_key', key }));
  try { await models.refresh(); } catch {}
  // If the root conversation has no usable model yet, pick one now.
  if (root) {
    try {
      const view = await root.viewState(ctx);
      if (!view?.value?.agent?.model) {
        const m = await pickModel();
        if (m) await root.configure({ model: m }, ctx);
      }
    } catch {}
  }
}

const token = existsSync(TOKEN_FILE)
  ? (await readFile(TOKEN_FILE, 'utf8')).trim()
  : await (async () => {
      const t = crypto.randomBytes(24).toString('base64url');
      await mkdir(STATE_DIR, { recursive: true });
      await writeFile(TOKEN_FILE, t, { mode: 0o600 });
      return t;
    })();

function authed(req) {
  const url = new URL(req.url, 'http://localhost');
  return req.headers['x-token'] === token || url.searchParams.get('token') === token;
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/events' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'bridge_connected' })}\n\n`);
    if (eventStream) res.write(`data: ${JSON.stringify({ type: 'bridge_snapshot', snapshot: eventStream.snapshot })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p.startsWith('/api/')) {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    try {
      if (p === '/api/state') {
        const snap = eventStream?.snapshot;
        const view = root ? await root.viewState(ctx) : null;
        return json(res, 200, {
          model: snap?.agent?.model ?? view?.value?.agent?.model ?? null,
          busy: Boolean(snap?.run ?? view?.value?.live?.run ?? view?.value?.live),
          cwd: WORKDIR,
          sessionId: root?.id ?? null,
          sessionName: localSessions.sessions[root?.id]?.name ?? 'Main',
          remotes: Object.keys(REMOTES),
        });
      }
      if (p === '/api/sessions' && req.method === 'GET') {
        return json(res, 200, {
          activeId: root?.id ?? null,
          sessions: Object.values(localSessions.sessions)
            .sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? ''))),
        });
      }
      if (p === '/api/sessions/new' && req.method === 'POST') {
        if (!harness) await initHarness();
        const conversation = await harness.createConversation(
          { ownership: { kind: 'ownerless' }, agent: { model: await pickModel() } }, ctx,
        );
        localSessions.sessions[conversation.id] = {
          id: conversation.id,
          name: String(body.name || `Session ${conversation.id}`),
          created: new Date().toISOString(),
        };
        await saveLocalSessions();
        await watchConversation(conversation);
        return json(res, 200, { ok: true, activeId: conversation.id });
      }
      if (p === '/api/sessions/select' && req.method === 'POST') {
        const id = String(body.id || '');
        if (!localSessions.sessions[id]) return json(res, 404, { error: 'unknown session' });
        const conversation = await harness.conversation(Number(id), ctx);
        if (!conversation) return json(res, 404, { error: 'session unavailable' });
        await watchConversation(conversation);
        return json(res, 200, { ok: true, activeId: conversation.id });
      }
      if (p === '/api/sessions/delete' && req.method === 'POST') {
        const id = String(body.id || '');
        if (!localSessions.sessions[id]) return json(res, 404, { error: 'unknown session' });
        if (id === String(root?.id)) return json(res, 400, { error: 'select another session first' });
        delete localSessions.sessions[id];
        await saveLocalSessions();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/prompt' && req.method === 'POST') {
        if (!root) await initHarness();
        // ensure a model is configured before submitting
        try {
          const view = await root.viewState(ctx);
          if (!view?.value?.agent?.model) {
            const m = await pickModel();
            if (!m) return json(res, 400, { error: 'no model: set an API key first' });
            await root.configure({ model: m }, ctx);
            console.log('auto-configured model:', m.provider + '/' + m.modelId);
          }
        } catch (e) { console.error('model check:', e?.message || e); }
        const sub = await root.submit({
          type: 'input',
          content: String(body.message || ''),
          whenBusy: body.whenBusy === 'steer' ? 'steer' : undefined,
        }, ctx);
        return json(res, 200, { ok: true, submissionId: sub.id });
      }
      if (p === '/api/abort' && req.method === 'POST') {
        await root?.abort(ctx);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/new' && req.method === 'POST') {
        await root?.reset(typeof body.note === 'string' ? body.note : undefined, ctx);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/models' && req.method === 'GET') {
        const avail = await models.getAvailable();
        return json(res, 200, { models: avail.map((m) => ({ provider: m.provider, modelId: m.id })) });
      }
      if (p === '/api/model' && req.method === 'POST') {
        if (!body.provider || !body.modelId) return json(res, 400, { error: 'provider+modelId required' });
        await root.configure({ model: { provider: body.provider, modelId: body.modelId } }, ctx);
        const check = await root.viewState(ctx);
        const applied = check?.value?.agent?.model;
        console.log('model set ->', JSON.stringify(applied));
        return json(res, 200, { ok: true, applied });
      }
      if (p === '/api/clients' && req.method === 'GET') {
        return json(res, 200, { clients: readClients() });
      }
      if (p === '/api/clients' && req.method === 'POST') {
        if (body.delete) {
          writeClients(readClients().filter((c) => c.name !== String(body.delete)));
          return json(res, 200, { ok: true });
        }
        if (!body.target) return json(res, 400, { error: 'target required' });
        const clients = readClients().filter((c) => c.name !== String(body.name || body.target));
        clients.push({ name: String(body.name || body.target), target: String(body.target) });
        writeClients(clients);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/sshkey' && req.method === 'GET') {
        return json(res, 200, sshKeyInfo());
      }
      if (p === '/api/sshkey' && req.method === 'POST') {
        if (sshKeyInfo().exists) return json(res, 200, { ok: true, ...sshKeyInfo() });
        const prefix = process.env.PREFIX || '';
        const sshDir = `${HOME_DIR}/.ssh`;
        await mkdir(sshDir, { recursive: true });
        const r = await new Promise((resolve) => {
          const kg = spawn(`${prefix}/bin/ssh-keygen`, ['-t', 'ed25519', '-N', '', '-f', `${sshDir}/id_ed25519`, '-C', 'pi-mobile'], {
            env: process.env,
          });
          kg.on('exit', (c) => resolve(c));
          kg.on('error', (e) => resolve(-1));
        });
        return json(res, r === 0 ? 200 : 500, { ok: r === 0, ...sshKeyInfo() });
      }
      // --- remote pi-server attach -----------------------------------------
      if (p === '/api/remote/connect' && req.method === 'POST') {
        try {
          await remoteState.disconnect();
          const prefix = process.env.PREFIX || '';
          remoteState.remote = await attachRemote({ ssh: String(body.target), prefix });
          const sessions = await remoteState.remote.list();
          return json(res, 200, { ok: true, serverId: remoteState.remote.serverId, sessions });
        } catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
      }
      if (p === '/api/remote/sessions' && req.method === 'GET') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        return json(res, 200, await remoteState.remote.list());
      }
      if (p === '/api/remote/models' && req.method === 'GET') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        return json(res, 200, await remoteState.remote.models());
      }
      if (p === '/api/remote/model' && req.method === 'POST') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        if (!body.provider || !body.modelId) return json(res, 400, { error: 'provider+modelId required' });
        return json(res, 200, await remoteState.remote.request('configure', [{
          model: { provider: String(body.provider), modelId: String(body.modelId) },
        }]));
      }
      if (p === '/api/remote/create' && req.method === 'POST') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        return json(res, 200, await remoteState.remote.create());
      }
      if (p === '/api/remote/delete' && req.method === 'POST') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        return json(res, 200, await remoteState.remote.delete(String(body.id)));
      }
      if (p === '/api/remote/attach' && req.method === 'POST') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        await remoteState.remote.attach(String(body.id));
        remoteState.cursor = -1;
        return json(res, 200, { ok: true, target: remoteState.remote.client.attachment });
      }
      if (p === '/api/remote/prompt' && req.method === 'POST') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        return json(res, 200, await remoteState.remote.request('prompt', [{ message: String(body.message ?? '') }]));
      }
      if (p === '/api/remote/abort' && req.method === 'POST') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        return json(res, 200, await remoteState.remote.request('abort', []));
      }
      if (p === '/api/remote/state' && req.method === 'GET') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        return json(res, 200, await remoteState.remote.request('state', []));
      }
      if (p === '/api/remote/history' && req.method === 'GET') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        return json(res, 200, await remoteState.remote.request('history', [{ limit: 200 }]));
      }
      if (p === '/api/remote/events' && req.method === 'GET') {
        if (!remoteState.remote) return json(res, 400, { error: 'not connected' });
        const cursor = Number(url.searchParams.get('cursor') ?? remoteState.cursor);
        const r = await remoteState.remote.request('events', [{ cursor }]);
        remoteState.cursor = r.cursor;
        return json(res, 200, r);
      }
      if (p === '/api/remote/disconnect' && req.method === 'POST') {
        await remoteState.disconnect();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/auth' && req.method === 'POST') {
        if (!body.provider) return json(res, 400, { error: 'provider required' });
        if (body.delete) {
          await credentialStore.delete(String(body.provider));
          return json(res, 200, { ok: true });
        }
        if (!body.key) return json(res, 400, { error: 'key required' });
        await setApiKey(String(body.provider), String(body.key));
        return json(res, 200, { ok: true });
      }
      if (p === '/api/providers' && req.method === 'GET') {
        const auth = readAuthFile();
        return json(res, 200, {
          providers: Object.entries(auth).map(([provider, c]) => ({
            provider,
            type: c?.type ?? 'api_key',
            keyHint: c?.key ? `…${String(c.key).slice(-4)}` : null,
          })),
        });
      }
      if (p === '/api/result' && req.method === 'POST') {
        const sub = await harness.submission(String(body.id), ctx);
        if (!sub) return json(res, 404, { error: 'unknown submission' });
        const settled = await sub.wait(ctx);
        return json(res, 200, { status: settled.status });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  let filePath = path.join(PUBLIC, p === '/' ? 'index.html' : p);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!existsSync(filePath)) filePath = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
});

// --- remote pi-server attach state --------------------------------------------

import { attachRemote } from './remote-client.mjs';
const remoteState = {
  remote: null,
  cursor: -1,
  async disconnect() {
    if (this.remote) { try { await this.remote.disconnect(); } catch {} this.remote = null; }
    this.cursor = -1;
  },
};

// --- client host registry + ssh key helpers ----------------------------------

const CLIENTS_FILE = `${STATE_DIR}/clients.json`;
function readClients() {
  try { return JSON.parse(readFileSync(CLIENTS_FILE, 'utf8')); } catch { return []; }
}
function writeClients(clients) {
  writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
}
function sshKeyInfo() {
  const pub = `${HOME_DIR}/.ssh/id_ed25519.pub`;
  const priv = `${HOME_DIR}/.ssh/id_ed25519`;
  if (existsSync(pub) && existsSync(priv)) {
    try { return { exists: true, pubkey: readFileSync(pub, 'utf8').trim() }; }
    catch { return { exists: true, pubkey: null }; }
  }
  return { exists: false, pubkey: null };
}

// --- interactive pi CLI over WebSocket + util-linux `script` pty -------------

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/pty' || !authed(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => startPty(ws, url));
});

function startPty(ws, url) {
  const cols = Number(url.searchParams.get('cols')) || 120;
  const rows = Number(url.searchParams.get('rows')) || 30;
  const cli = path.join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  const prefix = process.env.PREFIX || '';
  const scriptBin = prefix && existsSync(`${prefix}/bin/script`) ? `${prefix}/bin/script` : 'script';
  const sshTarget = url.searchParams.get('ssh');
  const sshCmd = url.searchParams.get('sshop'); // 'copyid' -> interactive ssh-copy-id
  let inner;
  if (sshTarget && /^[\w.@:-]+$/.test(sshTarget)) {
    const m = sshTarget.match(/^([\w.@]+):(\d+)$/);
    const portFlag = m ? `-p ${m[2]}` : '';
    const host = m ? m[1] : sshTarget;
    if (sshCmd === 'copyid') {
      // run ssh-copy-id inside the pty so password entry is interactive
      inner = `stty cols ${cols} rows ${rows}; "${prefix}/bin/bash" "${prefix}/bin/ssh-copy-id" -i "$HOME/.ssh/id_ed25519" ${portFlag} -o "UserKnownHostsFile=$HOME/.ssh/known_hosts" "${host}"; echo; echo '[done — close or tap to exit]'; read -r _ 2>/dev/null`;
    } else {
      // remote pi session over ssh (keys via $HOME/.ssh on this device)
      inner = `stty cols ${cols} rows ${rows}; exec "${prefix}/bin/ssh" -tt ${portFlag} -o "StrictHostKeyChecking=accept-new" -o "UserKnownHostsFile=$HOME/.ssh/known_hosts" -i "$HOME/.ssh/id_ed25519" "${host}" pi`;
    }
  } else {
    // -c runs under sh inside the pty: set size first, then replace with pi
    inner = `stty cols ${cols} rows ${rows}; exec "${process.execPath}" "${cli}"`;
  }
  const child = spawn(scriptBin, ['-qfec', inner, '/dev/null'], {
    env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) },
    cwd: WORKDIR,
  });
  child.stdout.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
  child.stderr.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
  child.on('exit', () => { try { ws.close(1000, 'pty exited'); } catch {} });
  child.on('error', (e) => { try { ws.send(`\r\n[pty error] ${e.message}\r\n`); } catch {} });

  // discover the pty slave path so we can push resizes via stty -F
  let ptsPath = null;
  const findPts = setInterval(async () => {
    if (ptsPath || !child.pid) { clearInterval(findPts); return; }
    try {
      const { readdirSync, readlinkSync } = await import('node:fs');
      for (const fd of readdirSync(`/proc/${child.pid}/fd`)) {
        const l = readlinkSync(`/proc/${child.pid}/fd/${fd}`);
        if (l.startsWith('/dev/pts/')) { ptsPath = l; break; }
      }
      if (ptsPath) clearInterval(findPts);
    } catch {}
  }, 300);
  setTimeout(() => clearInterval(findPts), 15000);

  ws.on('message', (data) => {
    // \x01-prefixed frames are JSON control messages, everything else is stdin
    const s = data.toString();
    if (s.charCodeAt(0) === 1) {
      try {
        const msg = JSON.parse(s.slice(1));
        if (msg.resize && ptsPath) {
          spawn(`${prefix}/bin/stty`, ['-F', ptsPath, 'cols', String(msg.resize.cols), 'rows', String(msg.resize.rows)]);
        }
      } catch {}
      return;
    }
    child.stdin.write(data);
  });
  ws.on('close', () => child.kill('SIGKILL'));
}

await mkdir(WORKDIR, { recursive: true });
try { await initHarness(); } catch (e) { console.error('initHarness:', e?.message || e); }
server.listen(Number(process.env.PI_PORT || 0), '127.0.0.1', async () => {
  const port = server.address().port;
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(PORT_FILE, String(port));
  console.log(`pi-mobile durable bridge on 127.0.0.1:${port}`);
});
