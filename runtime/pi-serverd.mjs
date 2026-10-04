// pi-serverd.mjs — durable pi sessions over the pi-server protocol (unix socket).
// Remote attach flow: `ssh -L <localport>:<socket>` from the client machine, then
// pi-client over a TCP transport; same machine: connect the socket directly.
//
// Env: HOME (storage root), PI_SERVERD_SOCK (socket path, default
// $HOME/.pi-serverd/server.sock), PI_SERVERD_ID (stable serverId, default:
// persisted random uuid), PI_WORKDIR (agent cwd), PI_PROVIDER/PI_MODEL.
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Harness, watchEvents, createRegistry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { createModels } from '@earendil-works/pi-ai/models';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { createUnixServer } from '@earendil-works/pi-server/unix';
import { SessionNotFoundError } from '@earendil-works/pi-server';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || ROOT;
const STATE_DIR = `${HOME}/.pi-serverd`;
const SOCK_PATH = process.env.PI_SERVERD_SOCK || `${STATE_DIR}/server.sock`;
const WORKDIR = process.env.PI_WORKDIR || HOME;
const MANIFEST = `${STATE_DIR}/sessions.json`;
const DB = `${STATE_DIR}/harness.sqlite`;

await mkdir(STATE_DIR, { recursive: true });
await mkdir(WORKDIR, { recursive: true });

const ID_FILE = `${STATE_DIR}/server-id`;
let serverId = process.env.PI_SERVERD_ID;
if (!serverId) {
  try { serverId = readFileSync(ID_FILE, 'utf8').trim(); } catch {}
  if (!serverId) { serverId = randomUUID(); writeFileSync(ID_FILE, serverId); }
}

const manifest = (() => {
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { return { sessions: {} }; }
})();
const saveManifest = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

// --- harness ----------------------------------------------------------------

const ctx = BACKGROUND_CONTEXT;
const storage = await openNodeSqliteStorage(DB);
const env = new NodeExecutionEnv({ cwd: WORKDIR, env: process.env });
// file-backed CredentialStore over ~/.pi/agent/auth.json (same file as pi CLI)
const AUTH_PATH = `${HOME}/.pi/agent/auth.json`;
const readAuthFile = () => {
  try { return JSON.parse(readFileSync(AUTH_PATH, 'utf8')); } catch { return {}; }
};
const credentialStore = {
  async get(provider) { return readAuthFile()[provider] ?? null; },
  async modify(provider, fn) {
    const auth = readAuthFile();
    auth[provider] = await fn(auth[provider]);
    await mkdir(path.dirname(AUTH_PATH), { recursive: true });
    writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), { mode: 0o600 });
    return auth[provider];
  },
  async delete(provider) {
    const auth = readAuthFile();
    delete auth[provider];
    writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), { mode: 0o600 });
  },
};
const models = createModels({ credentials: credentialStore });
for (const p of builtinProviders()) models.setProvider(p);
const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(storage, {
  models,
  registry,
  env: () => env,
}, ctx);
harness.resume();
async function pickModel() {
  if (process.env.PI_PROVIDER && process.env.PI_MODEL) {
    return { provider: process.env.PI_PROVIDER, modelId: process.env.PI_MODEL };
  }
  try {
    const avail = await models.getAvailable();
    const m = avail[0];
    if (m) return { provider: m.provider, modelId: m.id };
  } catch {}
  return undefined;
}
const defaultModel = await pickModel();

// --- per-conversation event buffers (long-poll, no chord subscription needed) -

const buffers = new Map(); // conversationId -> {queue: [], waiters: []}
async function bufferFor(convId) {
  if (!buffers.has(convId)) {
    const buf = { queue: [], waiters: [], cursor: 0 };
    const stream = await watchEvents(harness, convId, ctx);
    buf.snapshot = stream.snapshot;
    stream.start(async (events) => {
      buf.queue.push(...events);
      for (const w of buf.waiters.splice(0)) w();
    });
    buffers.set(convId, buf);
  }
  return buffers.get(convId);
}

// --- routed session handles ---------------------------------------------------

function routedSession(conversationId) {
  return {
    async attachClient() {
      const conv = await harness.conversation(conversationId, ctx);
      const buf = await bufferFor(conversationId);
      return {
        async invokeService(call, publish, context) {
          if (call.serviceId !== 'chat') throw new Error(`unknown service: ${call.serviceId}`);
          switch (call.member) {
            case 'prompt': {
              const text = String(call.args[0]?.message ?? call.args[0] ?? '');
              const sub = await conv.submit({ type: 'input', content: text }, context ?? ctx);
              return { submissionId: sub.id };
            }
            case 'abort':
              await conv.abort(context ?? ctx);
              return { ok: true };
            case 'state': {
              const s = await conv.viewState(context ?? ctx);
              return s?.value ?? s;
            }
            case 'configure': {
              const model = call.args[0]?.model;
              if (model) await conv.configure({ model }, context ?? ctx);
              return { ok: true };
            }
            case 'snapshot':
              return { snapshot: buf.snapshot };
            case 'events': {
              // long-poll: wait for events newer than cursor (max ~25s)
              const after = Number(call.args[0]?.cursor ?? -1);
              const deadline = Date.now() + 25000;
              while (buf.cursor === after && Date.now() < deadline && !buf.queue.length) {
                await new Promise((r) => {
                  buf.waiters.push(r);
                  setTimeout(r, 1000);
                });
              }
              const events = buf.queue.splice(0);
              return { events, cursor: ++buf.cursor };
            }
            default:
              throw new Error(`unknown member: ${call.member}`);
          }
        },
        release() {},
      };
    },
    terminated: new Promise(() => {}),
    async close() {},
  };
}

const host = {
  serverServices: {
    attachClient(presentation) {
      return {
        async invokeService(call, publish, context) {
          if (call.serviceId !== 'sessions') throw new Error(`unknown service: ${call.serviceId}`);
          switch (call.member) {
            case 'list':
              return { sessions: Object.entries(manifest.sessions).map(([id, s]) => ({ id, ...s })) };
            case 'create': {
              const conv = await harness.createConversation(
                { ownership: { kind: 'ownerless' }, agent: { model: defaultModel } },
                ctx,
              );
              manifest.sessions[conv.id] = {
                conversationId: conv.id,
                cwd: WORKDIR,
                model: defaultModel,
                created: new Date().toISOString(),
              };
              saveManifest();
              return { id: conv.id };
            }
            case 'attach': {
              const id = String(call.args[0]);
              if (!manifest.sessions[id]) throw new SessionNotFoundError(`unknown session: ${id}`);
              await presentation.attachSession(id, context ?? ctx);
              return { ok: true };
            }
            default:
              throw new Error(`unknown member: ${call.member}`);
          }
        },
        release() {},
      };
    },
  },
  async resolveSession(sessionId) {
    if (!manifest.sessions[sessionId]) throw new SessionNotFoundError(`unknown session: ${sessionId}`);
    return { id: sessionId };
  },
  async openSession(metadata) {
    return routedSession(manifest.sessions[metadata.id].conversationId);
  },
};

const server = createUnixServer(host, { serverId, path: SOCK_PATH });
await server.start();
console.log(`pi-serverd on ${SOCK_PATH} (serverId ${serverId})`);
