# pi-termux-mobile

> **Experimental software:** This is a personal prototype under active
> development. Remote sessions, the embedded Termux runtime, and Android
> background-process handling may still change or fail on individual devices.
>
> **Quick & dirty version 0.**

Minimal Android app that embeds Termux-built binaries (Node.js 26.4.0, bash,
coreutils, git, ripgrep, fd, openssh, npm, util-linux `script`, …) plus a
**pi-durable** harness (`@earendil-works/pi-durable` 1.0.2 + pi-ai/chord, with
pi-coding-agent 1.0.2 bundled for the CLI + TUI) behind a tiny
HTTP/SSE/WebSocket bridge (`runtime/server.mjs`). UI is a local WebView on
`http://127.0.0.1:<port>` (ephemeral port → `files/home/.pi-mobile/port`,
token → `…/token`).

The durable harness gives: SQLite-backed conversations
(`files/home/.pi-mobile/harness.sqlite` — survive process death,
`harness.resume()` continues interrupted runs), a `subagent` tool (child
conversations owned by the calling task), model selection per conversation,
and per-conversation execution environments — including remote hosts.

## App pages

- **Chat** (`/`) — durable pi conversation (prompt, abort, new session,
  model dropdown). `pi mobile` header links back here from every page.
- **API keys** (`keys.html`) — provider key management (list/add/delete,
  stored as `~/.pi/agent/auth.json` in pi CLI format).
- **Clients** (`clients.html`) — remote SSH host registry + device keypair
  (ed25519): generate, show pubkey, interactive `ssh-copy-id` in the
  terminal page.
- **Remote** (`remote.html`) — attach to durable sessions on other machines
  via the pi-server protocol: choose a saved SSH host, select/create/remove a
  session, and choose that remote session's model (see below).
- **pi CLI** (`terminal.html`) — real pi TUI over WebSocket → `script` PTY
  → `node cli.js`, with on-screen extra keys (esc/tab/ctrl/arrows/pgup/pgdn)
  for menus and scrollback. `?ssh=user@host` runs `ssh -tt <host> pi`
  instead — full remote pi TUI.

## Remote control, two ways

### 1. SSH pi TUI (immediate, full fidelity)

`ssh`/`ssh-copy-id`/`ssh-keygen` ship in the rootfs. Workflow:
Clients → *generate key* → *add client* (`user@host[:port]`) → `⇧key`
(interactive ssh-copy-id, type remote password) → `▸_` connects. The menu
item *pi CLI (ssh)* does a one-off connect without saving a host.

### 2. pi-server protocol (multi-client attach to durable sessions)

`runtime/pi-serverd.mjs` is a `pi-server` (`createUnixServer`) host app:
durable Harness + own SQLite under `~/.pi-serverd/`, services
`sessions.list/create/attach` and `chat.prompt/abort/state/configure/events`
(events via long-poll cursor — Chord subscriptions deliberately skipped).

```bash
# on the remote machine (Node >= 22, same runtime dir, uses ~/.pi/agent/auth.json)
node pi-serverd.mjs        # socket: ~/.pi-serverd/server.sock
```

The phone bridge (`runtime/remote-client.mjs`) forwards the remote unix
socket through the saved SSH client entry (`ssh -N -L port:~/.pi-serverd/server.sock`
— OpenSSH 6.7+ unix→tcp forwarding; SSH is the auth, no extra token), then
attaches via `@earendil-works/pi-client` with a small TCP
`ByteTransportFactory`. `user@host:port` is converted to OpenSSH's `-p port`
form. The Remote page opens the newest session first, restores its transcript,
and displays a model picker using the remote host's available models.
Endpoints: `/api/remote/{connect,sessions,models,model,create,delete,attach,prompt,abort,state,history,events,disconnect}`.

Deleting a session removes its entry from `~/.pi-serverd/sessions.json`, so it
no longer appears or can be attached through Remote. Its SQLite data is kept
as a safety measure; it is not a destructive database purge. `pi-client` runs
on the phone as the protocol client, while the durable harness, model calls,
and tools run in `pi-serverd` on the remote host. For the full interactive Pi
TUI instead, use **Clients → ▸_** or **pi CLI (ssh)**; run it in `tmux` when an
SSH disconnect must not end the TUI process.

### 3. env-server (remote *tool execution*, different thing)

A conversation whose cwd is `remote:<name>:/path` runs its tools on that
host via `runtime/remote-env.mjs` (client) + `runtime/env-server.mjs`:

```bash
# on the remote machine — Node >= 22, no deps
PI_REMOTE_TOKEN=<secret> PI_REMOTE_PORT=7842 node env-server.mjs

# on the phone (env of the node process / PiService)
PI_REMOTES='{"workstation":{"url":"http://host:7842","token":"<secret>"}}'
```

Use Tailscale/WireGuard instead of plain LAN HTTP where possible — the env
server executes arbitrary commands.

## Layout

- `android/` — Gradle project (app module, Java only, no NDK)
- `runtime/` — `server.mjs` (durable bridge + `/pty` WS + remote attach),
  `pi-serverd.mjs` (remote session daemon), `remote-client.mjs` (pi-client
  + ssh tunnel), `remote-env.mjs`/`env-server.mjs` (tool exec),
  `public/` (chat, keys, clients, remote, terminal pages + shared menu),
  package.json for prod node_modules
- `debs/` — Termux apt packages (aarch64) + extracted `rootfs/` used to build
  `rootfs.bin` (see below)
- `tools/` — local toolchain (JDK 21, Android SDK, Gradle 8.10.2) — not committed

## Build

```bash
cd android
JAVA_HOME=<path-to>/tools/jdk21 ./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk (~95 MB, aarch64 only content)
```

Toolchain notes:

- JDK 21 (Temurin) — Gradle/AGP 8.7.3 does not support the system JDK 25.
- compileSdk 35, minSdk 26, targetSdk **28** — keeps direct `execve()` of
  app-private binaries working (Android 10+ SELinux blocks it for
  targetSdk >= 29). `PiService` falls back to launching node via
  `/system/bin/linker64` if direct exec ever fails, so targetSdk can be raised.
- `RUNTIME_VERSION` in `RuntimeInstaller.java` gates re-extraction — bump it
  whenever assets change.

## Repackaging assets

```bash
# rootfs.bin = gzipped tar of the Termux usr/ tree
cd debs/rootfs/data/data/com.termux/files
tar czf ../../../../../android/app/src/main/assets/rootfs.bin usr

# runtime.bin = gzipped tar of the pi runtime as runtime/ prefix
# IMPORTANT: strip node_modules/.bin dirs + dangling symlinks first —
# toybox tar on-device exits non-zero on them and extraction aborts
cd runtime
find node_modules -type d -name .bin -exec rm -rf {} +    # npm recreates these!
find node_modules -type l ! -exec test -e {} \; -delete
tar czf ../android/app/src/main/assets/runtime.bin --transform 's,^,runtime/,' \
  server.mjs remote-env.mjs env-server.mjs pi-serverd.mjs remote-client.mjs \
  package.json package-lock.json public node_modules
```

(.bin suffix because aapt decompresses *.gz assets into the APK uncompressed.
`RuntimeInstaller` tolerates tar's non-zero exit when the expected payload
files are present — bad-symlink warnings are only logged.)

## Install / run

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
# or wireless: ./install-wifi.sh (pairs via mDNS, installs, starts)
```

First launch extracts ~170 MB to app-private storage, then a foreground
service starts `node runtime/server.mjs`. Open the app → API keys page to
store a provider key, then prompt. Old state lives in
`files/home/.pi-mobile/harness.sqlite` — nothing is lost on process death,
but there is no session browser for the local conversation yet.

Caveats on device:

- MIUI kills the process aggressively in the background (foreground works
  fine): Settings → Apps → pi mobile → battery saver "no restrictions" +
  autostart.
- Android 12+: phantom-process killer may kill node/bash subprocesses;
  workaround needs `adb shell settings put global
  settings_enable_monitor_phantom_procs false` or the Android 14+ developer
  option. Foreground service + PARTIAL_WAKE_LOCK are held while running.
- Termux scripts inside the bundle have `com.termux` shebangs and will fail;
  binaries are invoked directly by absolute path (npm CLI shim may need
  `node $PREFIX/lib/node_modules/npm/bin/npm-cli.js` instead of `npm`).
- `stty -F /dev/pts/N` is used to push terminal resizes into the `script`
  PTY (control frames are `\x01`-prefixed JSON on the WS).

See ANALYSE.md for the full evaluation and upstream facts.

---

*vibe coding fun with pi* — [Earendil Pi on GitHub](https://github.com/earendil-works/pi)
