import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();

const chat = document.getElementById('chat');
const input = document.getElementById('input');
const statusEl = document.getElementById('status');
const sessionNameEl = document.getElementById('session-name');

let currentAssistant = null;

function el(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

function addUser(text) { currentAssistant = null; el('msg user', text); }
function addAssistant() {
  if (!currentAssistant) currentAssistant = el('msg assistant', '');
  return currentAssistant;
}
function addTool(name, args) {
  currentAssistant = null;
  const brief = args ? (args.command || args.path || args.pattern || JSON.stringify(args).slice(0, 80)) : '';
  el('msg tool', `⚙ ${name}${brief ? '  ' + brief : ''}`);
}
function addSys(text) { currentAssistant = null; el('msg sys', text); }

function renderHistory(entries) {
  chat.innerHTML = '';
  for (const e of entries) {
    for (const m of e.model ?? []) {
      if (m.role === 'user' && typeof m.content === 'string') el('msg user', m.content);
      else if (m.role === 'assistant' && Array.isArray(m.content)) {
        const text = m.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
        if (text) el('msg assistant', text);
      } else if (m.role === 'toolResult') {
        el('msg tool', `⚙ ${m.toolName || 'tool'}`);
      }
    }
  }
  chat.scrollTop = chat.scrollHeight;
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message_end': {
      // durable watchEvents: entry.model[] holds the committed message
      const msgs = ev.entry?.model ?? (ev.entry ? [ev.entry] : []);
      for (const m of msgs) {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          const text = m.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
          if (text) el('msg assistant', text);
        }
      }
      currentAssistant = null;
      break;
    }
    case 'message_update': {
      const a = ev.assistantMessageEvent;
      if (a?.type === 'text_delta' && a.delta) {
        const b = addAssistant();
        b.textContent += a.delta;
        chat.scrollTop = chat.scrollHeight;
      }
      break;
    }
    case 'run_end': currentAssistant = null; status('idle'); break;
    case 'turn_start': status('running…'); break;
    case 'tool_execution_start': addTool(ev.toolName || ev.tool || ev.name || 'tool', ev.args); break;
    case 'tool_execution_end': {
      if (ev.isError || ev.error) addSys(`tool error: ${ev.error || 'failed'}`);
      break;
    }
    case 'turn_end': currentAssistant = null; break;
    case 'agent_end': currentAssistant = null; status('idle'); break;
    case 'agent_settled': status('idle'); break;
    case 'compaction_start': addSys('compacting…'); break;
    case 'auto_retry_start': addSys(`retry ${ev.attempt}/${ev.maxAttempts}: ${ev.errorMessage || ''}`); break;
    case 'bash_execution_update': {
      if (ev.delta) {
        const b = addAssistant();
        b.textContent += ev.delta;
        chat.scrollTop = chat.scrollHeight;
      }
      break;
    }
    
    case 'bridge_snapshot': {
      const m = ev.snapshot?.agent?.model;
      currentModel = m || null;
      syncModelSelect();
      renderHistory(ev.snapshot?.entries ?? []);
      status('idle');
      break;
    }
    case 'agent': {
      const m = ev.agent?.model;
      if (m) { currentModel = m; syncModelSelect(); }
      break;
    }
    case 'bridge_error': addSys(`error: ${ev.error}`); break;
    case 'error': addSys(`error: ${ev.error?.message || ev.error || 'unknown'}`); break;
    default: break;
  }
}

function status(t) { statusEl.textContent = t; }

function connect() {
  const es = new EventSource(`${API.events}?token=${encodeURIComponent(token)}`);
  es.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch {} };
  es.onerror = () => status('reconnecting…');
}

async function post(endpoint, body = {}) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': token },
    body: JSON.stringify(body),
  });
  return r.json();
}

document.getElementById('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addUser(text);
  status('running…');
  const r = await post(API.prompt, { message: text });
  if (r.error) addSys(`error: ${r.error}`);
});

// header menu is rendered by menu.js (brand -> home, ≡ dropdown)

// --- model picker ------------------------------------------------------------

const modelSelect = document.getElementById('model-select');
let currentModel = null;

function syncModelSelect() {
  if (!currentModel) return;
  const v = `${currentModel.provider}|${currentModel.modelId}`;
  if (![...modelSelect.options].some((o) => o.value === v)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `${currentModel.provider}/${currentModel.modelId}`;
    modelSelect.appendChild(o);
  }
  modelSelect.value = v;
}

async function refreshModels() {
  try {
    const r = await fetch(`${API.models}?token=${encodeURIComponent(token)}`);
    const j = await r.json();
    modelSelect.innerHTML = '<option value="">no model</option>';
    for (const m of j.models ?? []) {
      const o = document.createElement('option');
      o.value = `${m.provider}|${m.modelId}`;
      o.textContent = `${m.provider}/${m.modelId}`;
      modelSelect.appendChild(o);
    }
    syncModelSelect();
  } catch {}
}

modelSelect.addEventListener('change', async () => {
  const [provider, modelId] = modelSelect.value.split('|');
  if (!modelId) return;
  const r = await post(API.model, { provider, modelId });
  addSys(r.ok ? `model → ${provider}/${modelId}` : `error: ${r.error}`);
});

connect();
refreshModels();
fetch(`${API.state}?token=${encodeURIComponent(token)}`)
  .then((r) => r.json())
  .then((state) => {
    sessionNameEl.textContent = state.sessionName || 'Main';
    status('idle');
  })
  .catch(() => status('offline'));
