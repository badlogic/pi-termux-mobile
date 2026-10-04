import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();

const list = document.getElementById('key-list');
const msg = document.getElementById('msg');

async function load() {
  const r = await fetch(`${API.providers}?token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({ providers: [] }));
  list.innerHTML = '';
  if (!j.providers?.length) {
    list.innerHTML = '<div class="key-empty">no keys saved</div>';
    return;
  }
  for (const p of j.providers) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = p.provider;
    const hint = document.createElement('span');
    hint.className = 'key-hint';
    hint.textContent = p.keyHint ?? p.type;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'key-del';
    del.addEventListener('click', async () => {
      const r2 = await fetch(API.auth, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-token': token },
        body: JSON.stringify({ provider: p.provider, delete: true }),
      });
      msg.textContent = r2.ok ? `${p.provider} removed` : 'error';
      load();
    });
    row.append(name, hint, del);
    list.appendChild(row);
  }
}

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const provider = document.getElementById('add-provider').value;
  const key = document.getElementById('add-key').value.trim();
  if (!key) return;
  const r = await fetch(API.auth, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': token },
    body: JSON.stringify({ provider, key }),
  });
  const j = await r.json().catch(() => ({}));
  msg.textContent = j.ok ? `saved ${provider}` : `error: ${j.error || r.status}`;
  if (j.ok) { document.getElementById('add-key').value = ''; load(); }
});

load();
