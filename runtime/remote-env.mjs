// RemoteExecutionEnv — pi-durable ExecutionEnv over HTTP against env-server.mjs
// running on a remote host (anywhere Node runs, incl. another phone's Termux).
// Wire format: POST <baseUrl>/<op> with bearer token, JSON in/out.
// Result<T,E> = { ok: true, value } | { ok: false, error }.

export class RemoteExecutionEnv {
  constructor({ cwd, baseUrl, token, id }) {
    this.cwd = cwd;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.id = id || `remote:${baseUrl}`;
    this.cwdPath = cwd;
  }

  async #call(op, payload, context) {
    if (context?.signal?.aborted) {
      return { ok: false, error: fileErr('aborted', 'aborted', payload?.path) };
    }
    try {
      const res = await fetch(`${this.baseUrl}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(payload ?? {}),
        signal: context?.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error ?? `http ${res.status}` };
      return { ok: true, value: body };
    } catch (e) {
      return { ok: false, error: fileErr('unknown', String(e?.message || e), payload?.path) };
    }
  }

  async exec(command, options, context) {
    const r = await this.#call('exec', {
      command, cwd: options?.cwd ?? this.cwdPath, env: options?.env,
      timeout: options?.timeout, inheritEnv: options?.inheritEnv,
    }, context);
    if (!r.ok) {
      return { ok: false, error: new RemoteExecError('unknown', String(r.error?.message || r.error)) };
    }
    const out = r.value.output ?? '';
    if (out && options?.onOutput) options.onOutput(out, context);
    return { ok: true, value: { exitCode: r.value.exitCode ?? 1, spillPath: r.value.spillPath } };
  }

  async absolutePath(p, context) {
    if (p.startsWith('/')) return { ok: true, value: p };
    return { ok: true, value: `${this.cwdPath}/${p}` };
  }
  async joinPath(parts) { return { ok: true, value: parts.join('/') }; }
  async canonicalPath(p, context) {
    const r = await this.#call('fs', { op: 'canonical', path: this.#abs(p) }, context);
    return r.ok ? { ok: true, value: r.value.path } : r;
  }
  #abs(p) { return p.startsWith('/') ? p : `${this.cwdPath}/${p}`; }

  async readTextFile(p, context) {
    const r = await this.#call('fs', { op: 'read', path: this.#abs(p) }, context);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, value: Buffer.from(r.value.contentB64, 'base64').toString('utf8') };
  }
  async readBinaryFile(p, context) {
    const r = await this.#call('fs', { op: 'read', path: this.#abs(p) }, context);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, value: Buffer.from(r.value.contentB64, 'base64') };
  }
  async readTextLines(p, options, context) {
    const r = await this.readTextFile(p, context);
    if (!r.ok) return r;
    let lines = r.value.split('\n');
    if (options?.maxLines) lines = lines.slice(0, options.maxLines);
    return { ok: true, value: lines };
  }
  async openTextLineReader(p, context) {
    const r = await this.readTextFile(p, context);
    if (!r.ok) return r;
    const lines = r.value.split('\n');
    let i = 0;
    const reader = {
      readLine: async () => i < lines.length
        ? { ok: true, value: { text: lines[i++], terminated: i < lines.length } }
        : { ok: true, value: undefined },
      close: async () => {},
    };
    return { ok: true, value: reader };
  }
  async writeFile(p, content, context) {
    return this.#fsOp('write', p, { contentB64: Buffer.from(content).toString('base64') }, context);
  }
  async appendFile(p, content, context) {
    return this.#fsOp('append', p, { contentB64: Buffer.from(content).toString('base64') }, context);
  }
  async truncateFile(p, size, context) { return this.#fsOp('truncate', p, { size }, context); }
  async flushFile() { /* remote fs is synchronous per request */ }
  async renameFile(s, d, context) { return this.#fsOp('rename', s, { dest: this.#abs(d) }, context); }
  async fileInfo(p, context) {
    const r = await this.#call('fs', { op: 'info', path: this.#abs(p) }, context);
    return r.ok ? { ok: true, value: r.value.info } : r;
  }
  async listDir(p, context) {
    const r = await this.#call('fs', { op: 'list', path: this.#abs(p) }, context);
    return r.ok ? { ok: true, value: r.value.entries } : r;
  }
  async exists(p, context) {
    const r = await this.#call('fs', { op: 'exists', path: this.#abs(p) }, context);
    return r.ok ? { ok: true, value: r.value.exists } : r;
  }
  async createDir(p, options, context) { return this.#fsOp('mkdir', p, { recursive: options?.recursive }, context); }
  async remove(p, options, context) { return this.#fsOp('remove', p, { recursive: options?.recursive, force: options?.force }, context); }
  async createTempDir(prefix, context) { return this.#fsOp('tempdir', prefix || 'pi-', {}, context); }
  async createTempFile(options, context) {
    return this.#fsOp('tempfile', undefined, { prefix: options?.prefix, suffix: options?.suffix }, context);
  }
  async #fsOp(op, p, extra, context) {
    const r = await this.#call('fs', { op, path: p === undefined ? undefined : this.#abs(p), ...extra }, context);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, value: r.value.path !== undefined ? r.value.path : r.value.ok };
  }
  async cleanup() {}
}

class RemoteExecError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

function fileErr(code, message, p) {
  const e = new Error(message);
  e.code = code;
  if (p) e.path = p;
  return e;
}
