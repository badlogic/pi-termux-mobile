import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();
const hostSel = document.getElementById('host-select');
const sessSel = document.getElementById('session-select');
const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const btnConnect = document.getElementById('btn-connect');
const btnNew = document.getElementById('btn-new-session');

const post = (path, body = {}) => fetch(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-token': token },
  body: JSON.stringify(body),
}).then((r) => r.json());

const el = (cls, text) => {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
};

// --- connect -----------------------------------------------------------------

async function loadHosts() {
  const r = await fetch(`${API.clients}?token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({ clients: [] }));
  for (const c of j.clients ?? []) {
    const o = document.createElement('option');
    o.value = c.target;
    o.textContent = c.name;
    hostSel.appendChild(o);
  }
}

let polling = false;
async function pollEvents() {
  if (polling) return;
  polling = true;
  try {
    const r = await fetch(`${API.remoteEvents}?token=${encodeURIComponent(token)}`);
    const j = await r.json().catch(() => ({}));
    if (j.events) renderEvents(j.events);
  } catch {}
  polling = false;
  setTimeout(pollEvents, 500);
}

function renderEvents(events) {
  for (const ev of events) {
    if (ev.type === 'message_end') {
      const m = ev.entry?.model?.[0];
      if (m?.role === 'assistant' && Array.isArray(m.content)) {
        const t = m.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
        if (t) el('msg assistant', t);
      }
    } else if (ev.type === 'tool_execution_start' || ev.type === 'tool_call') {
      el('msg tool', `⚙ ${ev.toolName || 'tool'}`);
    } else if (ev.type === 'submission' && ev.status) {
      el('msg sys', `submission ${ev.status}`);
    }
  }
}

btnConnect.addEventListener('click', async () => {
  const target = hostSel.value;
  if (!target) return;
  el('msg sys', `connecting ${target}…`);
  const r = await post(API.remoteConnect, { target });
  if (!r.ok) { el('msg sys', `error: ${r.error}`); return; }
  el('msg sys', `connected: ${r.serverId}`);
  sessSel.innerHTML = '';
  for (const s of r.sessions?.sessions ?? []) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.id} (${s.cwd})`;
    sessSel.appendChild(o);
  }
  sessSel.classList.remove('hidden');
  btnNew.classList.remove('hidden');
});

sessSel.addEventListener('change', async () => {
  if (!sessSel.value) return;
  const r = await post(API.remoteAttach, { id: sessSel.value });
  if (r.ok) {
    el('msg sys', `attached ${sessSel.value}`);
    composer.classList.remove('hidden');
    pollEvents();
  }
});

btnNew.addEventListener('click', async () => {
  const r = await post(API.remoteCreate, {});
  if (r.id) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.id;
    sessSel.appendChild(o);
    sessSel.value = r.id;
    sessSel.dispatchEvent(new Event('change'));
  }
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  el('msg user', text);
  const r = await post(API.remotePrompt, { message: text });
  if (r.error) el('msg sys', `error: ${r.error}`);
});

loadHosts();
