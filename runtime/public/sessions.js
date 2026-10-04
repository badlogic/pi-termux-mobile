import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();
const list = document.getElementById('session-list');
const msg = document.getElementById('msg');
const q = (path) => `${path}?token=${encodeURIComponent(token)}`;
const post = (path, body = {}) => fetch(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body),
}).then((r) => r.json());

document.getElementById('new-session').addEventListener('click', async () => {
  const r = await post(API.sessionNew);
  if (r.ok) location.href = q('/'); else msg.textContent = `error: ${r.error}`;
});

async function load() {
  const data = await fetch(q(API.sessions)).then((r) => r.json()).catch(() => ({ sessions: [] }));
  list.innerHTML = '';
  for (const session of data.sessions ?? []) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = session.name || `Session ${session.id}`;
    const hint = document.createElement('span');
    hint.className = 'key-hint';
    hint.textContent = session.id === data.activeId ? 'active' : session.id;
    row.append(name, hint);
    if (session.id !== data.activeId) {
      const select = document.createElement('button');
      select.textContent = 'open';
      select.addEventListener('click', async () => {
        const r = await post(API.sessionSelect, { id: session.id });
        if (r.ok) location.href = q('/'); else msg.textContent = `error: ${r.error}`;
      });
      row.append(select);
      const remove = document.createElement('button');
      remove.className = 'key-del';
      remove.textContent = '✕';
      remove.title = 'Remove from session list';
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove ${session.name || session.id}?`)) return;
        const r = await post(API.sessionDelete, { id: session.id });
        if (r.ok) load(); else msg.textContent = `error: ${r.error}`;
      });
      row.append(remove);
    }
    list.append(row);
  }
  if (!list.children.length) list.innerHTML = '<div class="key-empty">no sessions</div>';
}

load();
