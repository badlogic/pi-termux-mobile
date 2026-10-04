import { API } from './constants.js';

// Shared header on every page. <header><div id="menubar">…page items…</div></header>
// renderMenu() prepends the "pi mobile" home link and appends the ≡ menu.
// The current page's item is hidden via <body data-page="chat|keys|term">.
export function renderMenu() {
  const token = new URLSearchParams(location.search).get('token')
    || localStorage.getItem('pi-token') || '';
  if (token) localStorage.setItem('pi-token', token);
  const q = (p) => `${p}?token=${encodeURIComponent(token)}`;

  const bar = document.getElementById('menubar');
  if (!bar) return token;

  const brand = document.createElement('a');
  brand.id = 'brand';
  brand.href = q('/');
  brand.textContent = 'pi mobile';
  bar.prepend(brand);

  const btn = document.createElement('button');
  btn.id = 'btn-menu';
  btn.title = 'Menu';
  btn.textContent = '≡';
  const menu = document.createElement('div');
  menu.id = 'menu';
  menu.className = 'hidden';
  menu.innerHTML = `
    <a href="${q('/')}" data-pg="chat">Chat</a>
    <a href="${q('/keys.html')}" data-pg="keys">API keys</a>
    <a href="${q('/sessions.html')}" data-pg="sessions">Sessions</a>
    <a href="${q('/clients.html')}" data-pg="clients">Clients</a>
    <a href="${q('/remote.html')}" data-pg="remote">Remote</a>
    <a href="${q('/terminal.html')}" data-pg="term">pi CLI</a>
    <a href="#" id="menu-ssh">pi CLI (ssh)</a>
    <a href="#" id="menu-abort">Abort</a>
    <a href="#" id="menu-new">New session</a>`;
  bar.append(btn, menu);

  const page = document.body.dataset.page;
  if (page) menu.querySelector(`[data-pg="${page}"]`)?.remove();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => menu.classList.add('hidden'));
  menu.querySelector('#menu-ssh').addEventListener('click', (e) => {
    e.preventDefault();
    const target = prompt('ssh target (user@host[:port], pi must be installed there):',
      localStorage.getItem('pi-ssh-target') || '');
    if (!target) return;
    localStorage.setItem('pi-ssh-target', target);
    location.href = `/terminal.html?token=${encodeURIComponent(token)}&ssh=${encodeURIComponent(target)}`;
  });
  menu.querySelector('#menu-abort').addEventListener('click', (e) => {
    e.preventDefault();
    fetch(API.abort, { method: 'POST', headers: { 'x-token': token } });
  });
  menu.querySelector('#menu-new').addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch(API.sessionNew, { method: 'POST', headers: { 'x-token': token } });
    location.href = q('/');
  });
  return token;
}
