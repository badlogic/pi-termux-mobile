import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();
const hostSel = document.getElementById('host-select');
const sessSel = document.getElementById('session-select');
const modelSel = document.getElementById('model-select');
const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const btnConnect = document.getElementById('btn-connect');
const btnNew = document.getElementById('btn-new-session');
const btnDelete = document.getElementById('btn-delete-session');

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

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
}

function renderEntry(entry) {
  const message = entry?.model?.[0];
  const text = messageText(message);
  if (text && (message?.role === 'user' || message?.role === 'assistant')) {
    el(`msg ${message.role}`, text);
  }
}

function renderEvents(events) {
  for (const ev of events) {
    if (ev.type === 'message_end') {
      // Local user input is rendered optimistically in submit(). Rendering its
      // echoed event again produced every prompt twice.
      if (ev.entry?.model?.[0]?.role === 'assistant') renderEntry(ev.entry);
    } else if (ev.type === 'tool_execution_start' || ev.type === 'tool_call') {
      el('msg tool', `⚙ ${ev.toolName || 'tool'}`);
    } else if (ev.type === 'submission' && ev.status) {
      el('msg sys', `submission ${ev.status}`);
    }
  }
}

async function loadRemoteModels() {
  const [modelsResult, state] = await Promise.all([
    fetch(`${API.remoteModels}?token=${encodeURIComponent(token)}`).then((x) => x.json()),
    fetch(`${API.remoteState}?token=${encodeURIComponent(token)}`).then((x) => x.json()),
  ]).catch(() => [{ models: [] }, {}]);
  const active = state.docs?.['pi.agent']?.model;
  modelSel.innerHTML = '';
  for (const model of modelsResult.models ?? []) {
    const option = document.createElement('option');
    option.value = JSON.stringify(model);
    option.textContent = `${model.provider}/${model.modelId}`;
    option.selected = model.provider === active?.provider && model.modelId === active?.modelId;
    modelSel.appendChild(option);
  }
  modelSel.classList.toggle('hidden', !modelSel.options.length);
}

async function attachSession(id) {
  const r = await post(API.remoteAttach, { id });
  if (!r.ok) { el('msg sys', `error: ${r.error || 'could not attach'}`); return; }
  chat.innerHTML = '';
  el('msg sys', `attached ${id}`);
  const history = await fetch(`${API.remoteHistory}?token=${encodeURIComponent(token)}`).then((x) => x.json()).catch(() => ({}));
  for (const entry of history.entries ?? []) renderEntry(entry);
  await loadRemoteModels();
  composer.classList.remove('hidden');
  pollEvents();
}

async function showSessions(sessions, attachFirst = false) {
  sessSel.innerHTML = '';
  for (const s of sessions) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.id} (${s.cwd})`;
    sessSel.appendChild(o);
  }
  sessSel.classList.toggle('hidden', !sessions.length);
  btnNew.classList.remove('hidden');
  btnDelete.classList.toggle('hidden', !sessions.length);
  // The first option is selected automatically by HTML but does not emit a
  // change event. Attach it explicitly so a one-session host is usable.
  if (attachFirst && sessions.length) await attachSession(sessions[0].id);
}

btnConnect.addEventListener('click', async () => {
  const target = hostSel.value;
  if (!target) return;
  el('msg sys', `connecting ${target}…`);
  const r = await post(API.remoteConnect, { target });
  if (!r.ok) { el('msg sys', `error: ${r.error}`); return; }
  el('msg sys', `connected: ${r.serverId}`);
  await showSessions(r.sessions?.sessions ?? [], true);
});

sessSel.addEventListener('change', async () => {
  if (sessSel.value) await attachSession(sessSel.value);
});

modelSel.addEventListener('change', async () => {
  try {
    const model = JSON.parse(modelSel.value);
    const r = await post(API.remoteModel, model);
    if (!r.ok) el('msg sys', `error: ${r.error || 'could not change model'}`);
  } catch { el('msg sys', 'error: invalid model selection'); }
});

btnNew.addEventListener('click', async () => {
  const r = await post(API.remoteCreate, {});
  if (r.id) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.id;
    sessSel.prepend(o);
    sessSel.value = r.id;
    sessSel.dispatchEvent(new Event('change'));
  }
});

btnDelete.addEventListener('click', async () => {
  const id = sessSel.value;
  if (!id || !confirm(`Remove remote session ${id}?`)) return;
  const r = await post(API.remoteDelete, { id });
  if (!r.ok) { el('msg sys', `error: ${r.error || 'could not remove session'}`); return; }
  chat.innerHTML = '';
  composer.classList.add('hidden');
  const sessions = await fetch(`${API.remoteSessions}?token=${encodeURIComponent(token)}`)
    .then((x) => x.json()).catch(() => ({ sessions: [] }));
  await showSessions(sessions.sessions ?? [], true);
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
