/* global Terminal, FitAddon */
import { renderMenu } from './menu.js';
const token = renderMenu();

const term = new Terminal({
  fontFamily: 'monospace',
  fontSize: 10,
  cursorBlink: true,
  scrollback: 5000,
  convertEol: false,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();

let ws;
const sshTarget = new URLSearchParams(location.search).get('ssh');
const sshOp = new URLSearchParams(location.search).get('sshop');
function connect() {
  const cols = term.cols || 120;
  const rows = term.rows || 30;
  let u = `ws://${location.host}/pty?token=${encodeURIComponent(token)}&cols=${cols}&rows=${rows}`;
  if (location.protocol === 'https:') u = u.replace('ws://', 'wss://');
  if (sshTarget) u += `&ssh=${encodeURIComponent(sshTarget)}`;
  if (sshOp) u += `&sshop=${encodeURIComponent(sshOp)}`;
  ws = new WebSocket(u);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { term.focus(); };
  ws.onmessage = (e) => term.write(new Uint8Array(e.data));
  ws.onclose = () => {
    term.write('\r\n\r\n[disconnected — tap to respawn]\r\n');
    document.getElementById('status').textContent = 'disconnected';
  };
  term.onData((d) => {
    if (ws.readyState !== 1) return;
    if (ctrlArmed && d.length === 1) {
      const c = d.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) {
        ws.send(String.fromCharCode(c - 96)); // ctrl+letter
        ctrlArmed = false;
        document.querySelector('#keybar [data-k="ctrl"]')?.classList.remove('armed');
        return;
      }
    }
    ws.send(d);
  });
}
document.getElementById('term').addEventListener('click', () => {
  if (ws?.readyState === 3) { term.reset(); connect(); }
});
function sendSize() {
  fit.fit();
  if (ws?.readyState === 1 && term.cols && term.rows) {
    ws.send('\x01' + JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
  }
}
window.addEventListener('resize', sendSize);
setTimeout(sendSize, 1500); // push real size once the ws is up
connect();

// --- extra keys bar ----------------------------------------------------------

const KEYS = {
  esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B',
  right: '\x1b[C', left: '\x1b[D', slash: '/', enter: '\r',
  pgup: '\x1b[5~', pgdn: '\x1b[6~',
};
let ctrlArmed = false;
const send = (d) => { if (ws?.readyState === 1) ws.send(d); };
for (const b of document.querySelectorAll('#keybar button')) {
  b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (k === 'ctrl') {
      ctrlArmed = !ctrlArmed;
      b.classList.toggle('armed', ctrlArmed);
      return;
    }
    if (ctrlArmed) {
      ctrlArmed = false;
      document.querySelector('#keybar [data-k="ctrl"]').classList.remove('armed');
      const ch = k === 'enter' ? '\r' : k === 'tab' ? '\t' : k === 'slash' ? '/' : k[0];
      if (ch && ch.length === 1) {
        // ctrl+<letter> / common ctrl combos
        const map = { c: '\x03', d: '\x04', z: '\x1a', l: '\x0c', a: '\x01', e: '\x05', k: '\x0b', u: '\x15', w: '\x17', o: '\x0f', '/': '\x1f' };
        if (k === 'esc') send('\x1b\x1b');
        else if (k === 'up' || k === 'down') send(k === 'up' ? '\x10' : '\x0e'); // ctrl+p/n
        else if (map[ch]) send(map[ch]);
        else send('\x00');
      }
      return;
    }
    send(KEYS[k]);
    term.focus();
  });
}

