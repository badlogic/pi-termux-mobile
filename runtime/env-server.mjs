// env-server.mjs — dependency-free remote execution environment for
// pi-termux-mobil. Run on any host with Node >= 22:
//
//   PI_REMOTE_TOKEN=<secret> PI_REMOTE_PORT=7842 node env-server.mjs
//
// Endpoints (all POST, JSON, bearer auth):
//   /exec { command, cwd?, env?, timeout? }       -> { exitCode, output }
//   /fs   { op, path?, ... }                      -> per-op payload
// fs ops: read write append truncate rename info list exists mkdir remove
//         canonical tempdir tempfile
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.env.PI_REMOTE_TOKEN || '';
const PORT = Number(process.env.PI_REMOTE_PORT || 7842);
const HOST = process.env.PI_REMOTE_HOST || '0.0.0.0';
const SHELL = process.env.PI_REMOTE_SHELL || '/bin/bash';
const MAX_OUTPUT = 8 * 1024 * 1024;

if (!TOKEN) {
  console.error('PI_REMOTE_TOKEN is required');
  process.exit(1);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function fe(code, message, p) { return { code, message, path: p }; }

function execCmd(body) {
  return new Promise((resolve) => {
    const env = body.inheritEnv === false
      ? (body.env || {})
      : { ...process.env, ...(body.env || {}) };
    const child = spawn(SHELL, ['-c', String(body.command)], {
      cwd: body.cwd || process.cwd(), env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let killed = false;
    const timer = body.timeout
      ? setTimeout(() => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, body.timeout)
      : null;
    const onData = (d) => { if (out.length < MAX_OUTPUT) out += d.toString('utf8'); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: killed ? 124 : (code ?? 1), output: out, timedOut: killed });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 127, output: String(e.message) });
    });
  });
}

function fsOp(b) {
  const p = b.path;
  switch (b.op) {
    case 'read': return { contentB64: fs.readFileSync(p).toString('base64') };
    case 'write': fs.writeFileSync(p, Buffer.from(b.contentB64, 'base64')); return { ok: true };
    case 'append': fs.appendFileSync(p, Buffer.from(b.contentB64, 'base64')); return { ok: true };
    case 'truncate': fs.truncateSync(p, b.size); return { ok: true };
    case 'rename': fs.renameSync(p, b.dest); return { ok: true };
    case 'info': {
      const s = fs.statSync(p);
      return { info: { name: path.basename(p), path: p, kind: s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'file', size: s.size, mtimeMs: s.mtimeMs } };
    }
    case 'list': {
      return {
        entries: fs.readdirSync(p, { withFileTypes: true }).map((d) => {
          const fp = path.join(p, d.name);
          let size = 0, mtimeMs = 0;
          try { const s = fs.statSync(fp); size = s.size; mtimeMs = s.mtimeMs; } catch {}
          return { name: d.name, path: fp, kind: d.isDirectory() ? 'directory' : d.isSymbolicLink() ? 'symlink' : 'file', size, mtimeMs };
        }),
      };
    }
    case 'exists': return { exists: fs.existsSync(p) };
    case 'mkdir': fs.mkdirSync(p, { recursive: Boolean(b.recursive) }); return { ok: true };
    case 'remove': fs.rmSync(p, { recursive: Boolean(b.recursive), force: b.force !== false }); return { ok: true };
    case 'canonical': return { path: fs.realpathSync(p) };
    case 'tempdir': return { path: fs.mkdtempSync(path.join(os.tmpdir(), String(p || 'pi-'))) };
    case 'tempfile': {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), String(b.prefix || 'pi-')));
      const fp = path.join(dir, `f${b.suffix || ''}`);
      fs.writeFileSync(fp, '');
      return { path: fp };
    }
    default: throw fe('invalid', `unknown op ${b.op}`, p);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  try {
    if (req.url === '/exec') return json(res, 200, await execCmd(body));
    if (req.url === '/fs') return json(res, 200, fsOp(body));
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const code = e.code === 'ENOENT' ? 'not_found' : e.code === 'EACCES' || e.code === 'EPERM' ? 'permission_denied' : 'unknown';
    return json(res, 400, { error: { code, message: String(e.message || e), path: e.path } });
  }
});

server.listen(PORT, HOST, () => console.log(`env-server on ${HOST}:${PORT}`));
