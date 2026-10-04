import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();
const q = (p) => `${p}?token=${encodeURIComponent(token)}`;
const list = document.getElementById('client-list');
const msg = document.getElementById('msg');

const post = (path, body) => fetch(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-token': token },
  body: JSON.stringify(body),
});

// --- ssh key ----------------------------------------------------------------

async function loadKey() {
  const r = await fetch(`${API.sshkey}?token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  document.getElementById('sshkey-status').textContent = j.exists
    ? 'key exists (ed25519)'
    : 'no key yet';
  const pub = document.getElementById('sshkey-pub');
  if (j.pubkey) { pub.textContent = j.pubkey; pub.classList.remove('hidden'); }
  document.getElementById('sshkey-gen').classList.toggle('hidden', !!j.exists);
}
document.getElementById('sshkey-gen').addEventListener('click', async () => {
  msg.textContent = 'generating…';
  const r = await post(API.sshkey, {});
  msg.textContent = r.ok ? 'key generated' : 'error generating key';
  loadKey();
});

// --- hosts -------------------------------------------------------------------

async function load() {
  const r = await fetch(`${API.clients}?token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({ clients: [] }));
  list.innerHTML = '';
  if (!j.clients?.length) {
    list.innerHTML = '<div class="key-empty">no hosts yet — add one below</div>';
    return;
  }
  for (const c of j.clients) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = c.name;
    const tgt = document.createElement('span');
    tgt.className = 'key-hint';
    tgt.textContent = c.target;

    const go = document.createElement('button');
    go.textContent = '▸_';
    go.title = 'connect (pi cli)';
    go.addEventListener('click', () => {
      location.href = `/terminal.html?token=${encodeURIComponent(token)}&ssh=${encodeURIComponent(c.target)}`;
    });

    const copy = document.createElement('button');
    copy.textContent = '⇧key';
    copy.title = 'copy ssh key (ssh-copy-id)';
    copy.addEventListener('click', () => {
      location.href = `/terminal.html?token=${encodeURIComponent(token)}&ssh=${encodeURIComponent(c.target)}&sshop=copyid`;
    });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'key-del';
    del.addEventListener('click', async () => {
      await post(API.clients, { delete: c.name });
      load();
    });

    row.append(name, tgt, go, copy, del);
    list.appendChild(row);
  }
}

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('add-name').value.trim();
  const target = document.getElementById('add-target').value.trim();
  if (!target) return;
  const r = await post(API.clients, { name, target });
  const j = await r.json().catch(() => ({}));
  msg.textContent = j.ok ? 'added' : `error: ${j.error || r.status}`;
  if (j.ok) {
    document.getElementById('add-name').value = '';
    document.getElementById('add-target').value = '';
    load();
  }
});

loadKey();
load();
