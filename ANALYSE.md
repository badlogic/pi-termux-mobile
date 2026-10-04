# pi-termux-mobile — Architektur- und Plattformanalyse

Ziel: `@earendil-works/pi-coding-agent` auf Android als eigene, kleine App mit
eingebetteter Termux-Runtime und WebView-UI betreiben.

**Stand: 2026-10-04.** Die in Abschnitt 4 beschriebene eigene App ist umgesetzt
und als aarch64-Debug-APK testbar. Sie enthält Node.js 26.4.0, eine Termux-
Rootfs, `pi-durable`/`pi-ai`/`pi-server`/`pi-client` 1.0.2 und
`pi-coding-agent` 1.0.2. Lokal gibt es persistente, auswählbare Sessions;
Remote-Sessions laufen über SSH + `pi-serverd`, einschließlich Modellwahl,
Verlauf und Session-Verwaltung.

Dieses Dokument bewahrt außerdem die ursprüngliche Recherche und offene
Plattformrisiken. Abschnitte 1–2 sind technische Hintergrundfakten; Abschnitte
3–7 sind Entscheidungs- und Architekturgeschichte, nicht mehr nur ein Plan.

Legende: **[F]** = geprüft (Quelle angegeben), **[A]** = Annahme/zu verifizieren.

---

## 1. Was pi zur Laufzeit braucht

**[F]** pi ist ein reines JS-Bundle (ESM) + eine WASM-Datei:

- `bin: pi → dist/bundle/cli.js`, `main: dist/index.js`, SDK-Entry
  `createAgentSession/ModelRuntime/SessionManager`, headless RPC-Entry
  `dist/bundle/rpc-entry.js` (`pi --mode rpc`, JSONL over stdin/stdout;
  `docs/rpc.md`, 1600+ Zeilen Protokoll).
- `engines.node >=22.19.0` (package.json).
- Einziges natives/WASM-Artefakt im Produktivbaum: `photon_rs_bg.wasm`
  (`@silvia-odwyer/photon-node`, Bild-Resize — WASM, kein natives Binary).
- Optionales natives Clipboard-Modul (`@mariozechner/clipboard`, napi-Prebuilds
  nur für win32/darwin/linux-x64/arm64 — **kein Android-Target**) wird unter
  Termux gar nicht erst geladen: `clipboard = !process.env.TERMUX_VERSION &&
  hasDisplay ? loadClipboardNative() : null` (bundle, `TERMUX_VERSION` erkannt).
  Clipboard läuft stattdessen über `termux-clipboard-set/-get` (Termux:API).
- `.node`-Prebuilds in `pi-tui` nur für darwin/win32 (Keyboard-Modifiers);
  Linux/Android-Pfad ist reines Terminal-IO, kein natives Modul.

**[F]** Externe Programme, die pi spawned (bundle `chunk-JVUZSMYM.js`):

- **Shell**: `getShellConfig()` — Reihenfolge: `shellPath` aus settings.json →
  `/bin/bash` → `which bash` (PATH) → Fallback `sh -c`. Auf Termux existiert
  `/bin/bash` nicht, `which bash` findet `$PREFIX/bin/bash`. `which` kommt aus
  `debianutils` (im Bootstrap enthalten).
  Achtung: die interaktive TUI-Persistent-Shell `BashSession` ruft
  `spawn("/bin/bash", ["--noprofile","--norc"])` **hartkodiert** auf — betrifft
  vermutlich nur den interaktiven `!`-Shell-Modus, nicht den RPC-Pfad.
  **[A]** Auf Termux verifizieren; ggf. `shellPath` in `~/.pi/agent/settings.json`
  setzen.
- **ripgrep**: `findRg()` sucht `rg` auf PATH; ohne `rg` fällt das grep-Tool auf
  einen eingebauten JS-Walker zurück. Optional, aber empfohlen (Speed).
- **git**: `spawnSync("git", ["symbolic-ref", ...])` für Branch-Auflösung mit
  graceful `null`-Fallback; `pi install git:…` klont Repos. Kein Hard-Requirement
  — aber praktisch nötig, weil der Agent selbst per bash-Tool `git` aufruft.
- **pty**: kein `node-pty`-Native-Modul gebündelt; PTY-Nutzung ist JS-seitig /
  über spawn (KEIN natives node-pty im Produktivbaum gefunden).
- `npm`: nur für `pi install npm:…` / `pi update --self`; nicht für den reinen
  Agent-Betrieb nötig, wenn `node_modules` vorgebündelt wird.

**[F]** Offizieller Termux-Support existiert bereits:
`docs/termux.md` im Paket — Setup ist dokumentiert und getestet:

```
pkg update && pkg install nodejs termux-api git
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
mkdir -p ~/.pi/agent && pi
```

(`--ignore-scripts` und `TERMUX_VERSION`-Erkennung zeigen: kein native-build-
Pfad nötig.)

**[F]** Lokale Referenz-Integrationen:

- `../ecowitt-nextjs15/pi-sidecar/server.mjs` — schlanker HTTP-Server, der
  `createAgentSession` **in-process** nutzt (kein Subprozess nötig).
- `../tile_compile/agent_service/` und `../tile_compile/packaging/` — lokale
  Referenz für Agent-Service-Struktur, Lockfiles und Packaging-Abläufe.

**[F]** pi-server/pi-client (Monorepo `packages/server`, `packages/client`):
experimenteller lokaler Server, framed CBOR, Unix-Socket-Transport; Routing von
Session-Attachments. Kein fertiges HTTP/WebSocket/Browser-Frontend — ein Web-UI
müsste als eigener HTTP/WS-Adapter (RPC- oder SDK-Bridge) gebaut werden.
Kein separates `web-ui`-Package im Repo-Root gefunden.

---

## 2. Was Termux bereitstellt (geprüft)

- **Bootstrap**: ZIP pro ABI (aarch64/arm/i686/x86_64), erzeugt von
  `termux-packages/scripts/generate-bootstraps.sh` aus `.deb`s von
  `packages-cf.termux.dev`. Inhalt: `apt`, `bash`, `coreutils`, `dash`,
  `curl`, `grep`, `sed`, `gawk`, `gzip`, `tar`, `xz-utils`, `findutils`,
  `procps`, `psmisc`, `less`, `ed`, `debianutils` (u.a. `which`),
  `termux-core`, `termux-exec`, `termux-keyring`, `termux-tools`,
  `util-linux`, `bzip2`, `diffutils`, (+`command-not-found`, `proot`,
  `dos2unix`). **Kein** nodejs/git/npm/rg — kommen per `pkg install`.
- **nodejs-Paket**: aktuell `26.4.0` (MIT), `--dest-os=android`,
  shared-lib-Deps `libc++, openssl, c-ares, libicu, libsqlite, zlib, libffi`;
  npm seit nodejs 25.3 als separates `npm`-Paket. Erfüllt pi `>=22.19`.
- **Exec-Modell**: App forkt Child-Prozesse aus dem Hauptprozess
  (keine separaten Service-Prozesse), `termux-exec` wird per `$LD_PRELOAD`
  geladen und hookt die `exec()`-Familie (Pfad-Rewriting `/bin|/usr/bin` →
  `$PREFIX/bin` + Umgehung der App-data-exec-Restriktion).
- **App-data-exec-Restriktion** (Android ≥10, `targetSdkVersion ≥29`):
  `execve()` auf Dateien in `/data/data/<pkg>` ist SELinux-blockiert
  (W^X). termux-app bleibt deshalb auf `targetSdkVersion=28`
  (`gradle.properties`, versionName 0.118.0). Für `targetSdk ≥29` existiert
  der dokumentierte `termux-exec`-`system_linker_exec`-Workaround: Binaries
  werden über `/system/bin/linker64 <binary>` gestartet (linker ist
  `system_linker_exec`, exec erlaubt).
- **Prefix-Fixierung**: alle Termux-Pakete sind hart auf
  `/data/data/com.termux/files` kompiliert (`properties.sh`;
  `$TERMUX_APP__PACKAGE_NAME`, `$TERMUX__PREFIX` …). Anderer packageName ⇒
  Pakete neu bauen. **[A]** termux-exec unterstützt Fork-Prefixe per
  Env/Build-Props — genaue Wirksamkeit für einzelne Binaries verifizieren.
- **Phantom-Prozesse** (Android ≥12): vom App-Prozess geforkte Kinder sind
  „phantom processes"; Limit (Default 32, CPU-gewichtetes Capping) killt sie
  per SIGKILL. Deaktivierbar nur via `adb`/`settings put` bzw. ab Android 14
  per Developer-Option — nicht aus der App heraus.
- **Background**: TermuxService läuft als Foreground-Service;
  `termux-wake-lock` hält PARTIAL_WAKE_LOCK. Ohne Wake-Lock/Battery-
  Ausnahme schläft die CPU im Doze → Node-Server pausiert.
- **Lizenzen**: termux-app **GPLv3-only** (Ausnahmen: terminal-view/
  terminal-emulator Apache-2.0; termux-shared eigene LICENSE.md).
  `termux-exec` **Apache-2.0** — frei einbettbar. termux-packages:
  Build-Infra Apache-2.0, `packages/*/build.sh` jeweils Lizenz des Pakets.
  `nodejs` MIT, `bash` GPLv3, `git` GPLv2, `ripgrep` MIT/Unlicense,
  `openssl` Apache-2.0, `libicu` ICU, `libsqlite` PD.
- **Distribution**: Play Store erzwingt aktuelles targetSdk (≥35) ⇒
  Termux nur via F-Droid/GitHub-APK (targetSdk 28). Eigene App mit
  targetSdk 28 ist ebenfalls sideload/F-Droid-only.

---

## 3. Weg A — pi in echtem Termux (heute machbar, null eigener Code)

1. Termux + Termux:API von GitHub/F-Droid installieren (gleiche Signatur!).
2. `pkg install nodejs npm git ripgrep termux-api`
3. `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`
4. Laufend halten: `termux-wake-lock`, Akku-Optimierung für Termux aus,
   Android ≥12: Phantom-Killer per adb deaktivieren
   (`settings put global settings_enable_monitor_phantom_procs false`
   bzw. Dev-Option „Disable child process restrictions" ab Android 14).
5. Web-UI: kleiner Node-Bridge (`server.mjs`, siehe ecowitt `pi-sidecar` —
   in-process `createAgentSession` oder `pi --mode rpc`-Subprozess) auf
   `http://localhost:<port>`; Frontend per `termux-open-url` im Browser —
   kein WebView zwingend nötig. **[A]** Auth-Token setzen, sonst liegt eine
   bash-fähige Agent-API ungeschützt auf localhost/LAN.

Nachteil: Termux-App bleibt die Shell; UX ist „Terminal + Browser-Tab".

## 4. Weg B — minimale eigene App (umgesetzte Basis)

Dieser Weg ist die Basis von `pi-termux-mobile`: benötigte Termux-Binaries
werden eingebettet, die Termux-App wird nicht geforkt (GPL- und
PackageName-Kopplung). Die nachfolgende Beschreibung enthält weiterhin
Entwurfsdetails und verbleibende Risiken.

### Kleinste tragfähige Architektur

```
APK (pro ABI, oder AAB mit Splits)
├─ assets/runtime/<abi>/
│   ├─ node            (Termux-deb, aarch64; + libc++_shared, libssl,
│   │                   libcrypto, libcares, libicu*, libsqlite3, libz, libffi)
│   ├─ bash, coreutils-Teilmenge, which, tar/xz (für Updates)
│   ├─ rg              (ripgrep, statisch)
│   ├─ git             (optional, + libgit deps)
│   └─ libtermux-exec.so  (Apache-2.0, LD_PRELOAD-Hook)
├─ assets/pi-runtime/  (node_modules prod-only, ~30–45 MB;
│                      nach dem lokalen `tile_compile`-Packaging-Muster:
│                      npm ci --omit=dev --omit=optional --ignore-scripts
│                      + Manifest/SHA256)
├─ Java/Kotlin:
│   ├─ ForegroundService (Notification + WakeLock)
│   ├─ Bootstrap-Extraktor (assets → filesDir, chmod, first-run)
│   └─ Bridge: spawn node → HTTP+WS auf 127.0.0.1:<port>
└─ WebView (oder Intent → Browser)
```

**Exec-Pfad (entscheidend):**
- targetSdk ≤28: direktes `execve()` auf filesDir-Binaries erlaubt —
  aber nur sideload/F-Droid.
- targetSdk ≥29 (Pflicht für Play): Binaries **über den system_linker_exec-
  Trick starten**: `ProcessBuilder("/system/bin/linker64",
  "/data/data/<pkg>/files/usr/bin/node", ...)`. Genau das macht
  `termux-exec` intern; für einzelne bekannte Binaries reicht der direkte
  Linker-Aufruf ohne LD_PRELOAD. **[A]** Alternativ Binaries als
  `lib*.so` per `jniLibs` ausliefern (werden nach `nativeLibraryDir`
  extrahiert und sind dort ausführbar — geläufiger Trick, SELinux-Status
  pro Gerät/Android-Version verifizieren) — hat zusätzlich den Vorteil, dass
  AGP die 16-KB-Page-Alignment prüft.
- Subprozesse von node (bash/git/rg) laufen unter demselben App-UID —
  phantom-process-Limit gilt auch hier.
- `LD_LIBRARY_PATH=<prefix>/lib`, `PATH`, `HOME=<files>/home`,
  `TMPDIR`, `PREFIX` setzen; `TERMUX_VERSION`-Env **bewusst nicht** setzen
  bzw. setzen, je nachdem ob Clipboard-Fallback erwünscht.
- Shebangs in Termux-Skripten (`#!/data/data/com.termux/…`) zeigen ins
  Leere ⇒ für eigene Paketauswahl Shebangs umschreiben oder nur ELF-
  Binaries + eigene Wrapper verwenden. **[A]** termux-exec-Pfad-Rewriting
  deckt `/bin|/usr/bin`-Shebangs ab, nicht `com.termux`-Pfade — dafür ggf.
  eigene termux-exec-Build mit eigenem Prefix kompilieren (Apache-2.0).

**Minimalpaket-Liste:** nodejs(+deps) · bash · coreutils(de)· which ·
ripgrep · git(optional) · tar/xz · ca-certificates/openssl. **SQLite ist
nicht nötig** — pi persistiert Sessions als JSONL, Node baut gegen
libsqlite nur für `node:sqlite`; trotzdem mitliefern (dep des nodejs-deb).
Kein apt/dpkg im Bundle ⇒ kein Runtime-Package-Manager ⇒ Play-konformer
(alles aus APK/AAB). Updates nur über App-Release ⇒ Supply-Chain = npm-
Lockfile + Termux-Repo-Pins, beide mit Hash-Manifest.

**WebView-Checkliste:** `http://localhost`/`127.0.0.1` gilt als secure
context (Clipboard-API, crypto.subtle ok); WS auf localhost ok; Vite-HMR
über ws://localhost ok, solange die Seite selbst via http (kein mixed
content); Datei-Upload: `onShowFileChooser` implementieren; Downloads:
`setDownloadListener` + SAF; Cookies via CookieManager unproblematisch;
xterm.js/Fokus/IME und Hardware-Keyboard gesondert testen.

**Remote-Zugriff sicher:** bevorzugt Tailscale/WireGuard oder
cloudflared-Tunnel; bei LAN-Binding Token-Auth + optional TLS.
Niemals unauthentifiziert an 0.0.0.0 binden — das bash-Tool ist RCE.

## 5. Weg C — termux-app forken

- GPLv3-only ⇒ **gesamte App wird GPLv3** (inkl. Bridge/ eigenem Code).
- packageName ≠ com.termux ⇒ **alle Pakete neu kompilieren** (Prefix hart
  kodiert) — eigener Build-Server für termux-packages nötig.
- packageName = com.termux behalten ⇒ Konflikt/Signature-Clash mit
  installiertem Termux, nicht parallel installierbar, Play ohnehin raus.
- Lohnend nur, wenn die komplette Terminal-UI + apt-Ökosystem mitgeliefert
  werden soll. Für „pi-Server + Web-UI" over-engineered.
  **Nicht empfohlen** für Minimalziel.

## 6. Weg D — TWA/PWA/Browser ohne eigene Runtime-App

PWA/TWA kann keinen lokalen Node-Server hosten. Nutzbar nur als reine
Fernbedienung: wenn der pi-Server ohnehin in echter Termux-App läuft
(Weg A) oder auf einem entfernten Host. Billigster UI-Pfad: PWA mit
`display: standalone`, installierbar vom eigenen Bridge-Server.

## 7. Was übernommen / ersetzt werden kann

**Übernehmen:**
- `termux-exec` (Apache-2.0) — exec-Hook oder zumindest dessen
  linker-Mechanismus als Vorlage.
- Termux-`.deb`-Binaries für node+deps, bash, rg, git — ABI aarch64
  reicht für MVP (armeabi-v7a/x86_64 optional).
- `tile_compile` als lokale Referenz für einen reproduzierbaren
  Package-Workflow: Lockfile, `--omit=dev --omit=optional --ignore-scripts`
  und Hash-Manifest.
- pi `docs/termux.md`-Annahmen (`TERMUX_VERSION`, termux-api Clipboard).

**Ersetzen/weg lassen:**
- apt/dpkg/pkg, termux-keyring, gawk/diffutils/procps-Meiste —
  nicht runtime-nötig.
- Terminal-Emulator/termux-app-UI (WebView stattdessen).
- Termux:API (nur für Clipboard/Notifications nötig — optional;
  im WebView ist Clipboard per JS API lösbar).
- npm on-device (node_modules pre-bundled; npm nur falls Extension-
  Install in der App gewünscht).

## 8. Offene Punkte (zu verifizieren)

1. jniLibs-exec auf targetSdk 35 / Android 15–16 auf echter Hardware
   (SELinux kann pro Build variieren) — sonst linker64-Trick.
2. 16-KB-Page-Alignment der Termux-Binaries (Neubau für Android 15
   angeblich erfolgt — konkretes deb prüfen, `readelf -l`/`p_align`).
   Bei jniLibs-Auslieferung zwingt AGP/Play die Prüfung auf.
3. `BashSession` (interaktiver Modus) hardcoded `/bin/bash` — für RPC/
   WebView-Betrieb prüfen, ob der Pfad erreicht wird; ggf. `shellPath`
   setzen oder eigenes spawn-Hook.
4. termux-exec unter fremdem Prefix: welche Rewrites per Env steuerbar
   vs. Compile-Time — eigenes kleines Build-Repo für termux-exec
   erwägen.
5. Upgrade-Pfad für die aktuell gebündelten 1.0.2-Pakete festlegen und bei
   jedem Upgrade die Tool-/Extension-Oberfläche sowie die vorhandenen
   Schreibrechte gezielt prüfen.
6. WebView-Uploads/Downloads/IME-Feinschliff erst an Prototyp messbar.
7. Phantom-Prozess-Verhalten auf Zielgerät(en) (Versionen variieren;
   „assertive" OEMs killen trotz WakeLock Aggressiver).
8. Play-Policy zu bundled Executables: Ausliefern in APK ok; jedes
   Runtime-Nachladen von Executables ist policy-riskant ⇒ fest einkleben.
9. Remote-Session-Verhalten bei gleichzeitigen Clients, Tunnel-Abbruch und
   Wiederverbindung auf echter Hardware weiter testen.
10. Lizenztexte aller gebündelten .debs in App-Notices (GPL-Texte
    beilegen genügt; kein Copyleft-Effekt auf App-Code, solange keine
    GPL-Bibliothek gelinkt wird — termux-exec ist Apache-2.0, kein
    Problem).
