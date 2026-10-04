// remote-client.mjs — attach to a remote pi-serverd over ssh unix-socket
// forwarding. Usage (in server.mjs):
//   const remote = await attachRemote({ ssh: 'user@host', sock: '/remote/path.sock', localPort });
//   await remote.list() / remote.attach(id) / remote.request(member, args) / remote.pollEvents(cursor)
import { spawn } from 'node:child_process';
import net from 'node:net';
import { Client } from '@earendil-works/pi-client';

// TCP byte transport for pi-client (ByteTransportFactory shape)
function createTcpTransportFactory({ host = '127.0.0.1', port }) {
  return async (handlers) => {
    const sock = net.connect(port, host);
    sock.on('data', (chunk) => handlers.onData(chunk));
    sock.on('close', () => handlers.onClose());
    sock.on('error', (e) => handlers.onError(e));
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    return {
      send: (chunk) => new Promise((resolve) => sock.write(chunk, resolve)),
      close: () => sock.destroy(),
    };
  };
}

const REMOTE_SOCK_DEFAULT = '~/.pi-serverd/server.sock';

export async function attachRemote({ ssh, prefix = '', localPort = 0, serverId, remoteSock, keepTunnel }) {
  const port = localPort || 40000 + Math.floor(Math.random() * 20000);
  const remotePath = remoteSock || `$HOME/.pi-serverd/server.sock`;
  // ssh -N -L: forward local TCP -> remote unix socket (openssh 6.7+)
  const sshBin = `${prefix}/bin/ssh`;
  const home = process.env.HOME || '/tmp';
  const sshOpts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${home}/.ssh/known_hosts`];
  const tunnel = spawn(sshBin, ['-N', ...sshOpts, '-o', 'ExitOnForwardFailure=yes',
    '-L', `${port}:${remotePath}`, ssh], { env: process.env });
  let tunnelErr = '';
  tunnel.stderr.on('data', (d) => { tunnelErr += d; });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('ssh tunnel timeout: ' + tunnelErr.trim())), 10000);
    tunnel.on('exit', (c) => reject(new Error(`ssh tunnel exited ${c}: ${tunnelErr.trim()}`)));
    setTimeout(resolve, 1500); // give ssh a moment; exit would have rejected
    setTimeout(() => clearTimeout(to), 10000);
  });

  const discoverServerId = async () => {
    if (serverId) return serverId;
    // read via ssh: cat remote server-id
    return new Promise((resolve, reject) => {
      const cat = spawn(sshBin, [...sshOpts, ssh, 'cat ~/.pi-serverd/server-id'], { env: process.env });
      let out = '';
      cat.stdout.on('data', (d) => { out += d; });
      cat.on('exit', () => resolve(out.trim()));
      cat.on('error', reject);
    });
  };

  const sid = await discoverServerId();
  const client = await Client.connect({
    serverId: sid,
    transportFactory: createTcpTransportFactory({ port }),
  });

  const remote = {
    client,
    tunnel,
    serverId: sid,
    async list() {
      return client.request({ serverId: sid }, { serviceId: 'sessions', member: 'list', args: [] });
    },
    async create() {
      return client.request({ serverId: sid }, { serviceId: 'sessions', member: 'create', args: [] });
    },
    async attach(id) {
      return client.request({ serverId: sid }, { serviceId: 'sessions', member: 'attach', args: [id] });
    },
    async request(member, args = []) {
      if (!client.attachment) throw new Error('not attached');
      return client.request(client.attachment, { serviceId: 'chat', member, args });
    },
    async disconnect() {
      try { await client.dispose(); } catch {}
      try { tunnel.kill('SIGKILL'); } catch {}
    },
  };
  return remote;
}
