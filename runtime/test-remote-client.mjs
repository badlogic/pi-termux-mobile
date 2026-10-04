// test-remote-client.mjs — exercises pi-serverd end-to-end over the unix socket.
// Usage: node test-remote-client.mjs [socketPath] [serverId]
import { readFileSync } from 'node:fs';
import { Client } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';

const home = process.env.HOME;
const sock = process.argv[2] || `${home}/.pi-serverd/server.sock`;
const serverId = process.argv[3] || readFileSync(`${home}/.pi-serverd/server-id`, 'utf8').trim();

const client = await Client.connect({
  serverId,
  transportFactory: createUnixTransportFactory({ path: sock }),
});
console.log('connected, hello:', JSON.stringify(client.hello));

const server = { serverId };
const list = await client.request(server, { serviceId: 'sessions', member: 'list', args: [] });
console.log('list:', JSON.stringify(list));

const created = await client.request(server, { serviceId: 'sessions', member: 'create', args: [] });
console.log('created:', JSON.stringify(created));
const sessionId = created.id;

await client.request(server, { serviceId: 'sessions', member: 'attach', args: [sessionId] });
console.log('attached, target:', JSON.stringify(client.attachment));
const target = client.attachment;

const snap = await client.request(target, { serviceId: 'chat', member: 'state', args: [] });
console.log('state:', JSON.stringify(snap).slice(0, 300));

const prompt = await client.request(target, { serviceId: 'chat', member: 'prompt', args: [{ message: 'say just the word pong' }] });
console.log('prompt:', JSON.stringify(prompt));

let cursor = -1;
for (let i = 0; i < 20; i++) {
  const r = await client.request(target, { serviceId: 'chat', member: 'events', args: [{ cursor }] });
  cursor = r.cursor;
  if (r.events?.length) {
    for (const e of r.events) {
      const t = e?.type ?? e;
      const txt = e?.entry?.model?.[0]?.content?.filter?.((c) => c?.type === 'text')?.[0]?.text;
      console.log('event:', typeof t === 'string' ? t : JSON.stringify(t).slice(0, 80), txt ? `| ${txt.slice(0, 80)}` : '');
      if (t === 'submission' && e.status) { console.log('SUBMISSION:', e.status); i = 99; }
    }
  }
}
await client.dispose();
process.exit(0);
