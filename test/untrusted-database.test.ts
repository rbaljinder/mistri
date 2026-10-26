/**
 * A database address typed by a browser beyond this machine is dialled
 * sealed (packages/engine/src/adapters/net/untrustedDatabase.ts): nothing is filled in from
 * this process's environment, and only public addresses are reached.
 *
 * The fake servers here speak just enough of each protocol to see what the
 * driver sends before any query: the PostgreSQL startup packet and the
 * password message after a cleartext-password request.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { connect } from '../packages/engine/src/adapters/connect.js';
import { untrustedTargetRefusal } from '../packages/engine/src/server/http/trust.js';
import { UNTRUSTED_NETWORK } from '../packages/engine/src/adapters/net/untrustedDatabase.js';

interface Seen {
  user?: string;
  password?: string;
  connections: number;
}

/* Answers the startup packet with AuthenticationCleartextPassword, records the
   password message, then ends: the driver's connect fails, which is fine. */
function fakePostgres(): Promise<{ server: Server; port: number; seen: Seen }> {
  const seen: Seen = { connections: 0 };
  const server = createServer((socket: Socket) => {
    seen.connections++;
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const code = buffer.readInt32BE(4);
        if (code === 80877103) {
          // An SSLRequest: say no, and wait for the plain startup packet.
          buffer = buffer.subarray(8);
          socket.write('N');
          return;
        }
        const fields = buffer.subarray(8, length).toString('utf8').split('\0');
        for (let at = 0; at + 1 < fields.length; at += 2) if (fields[at] === 'user') seen.user = fields[at + 1];
        buffer = buffer.subarray(length);
        started = true;
        const ask = Buffer.alloc(9);
        ask.write('R', 0);
        ask.writeInt32BE(8, 1);
        ask.writeInt32BE(3, 5);
        socket.write(ask);
        return;
      }
      if (buffer.length < 5 || buffer[0] !== 'p'.charCodeAt(0)) return;
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      seen.password = buffer
        .subarray(5, length + 1)
        .toString('utf8')
        .replace(/\0$/, '');
      socket.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, seen })),
  );
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

const saved = { PGPASSWORD: process.env.PGPASSWORD, PGUSER: process.env.PGUSER };
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function dial(url: string, options: Parameters<typeof connect>[1]): Promise<string> {
  const adapter = connect(url, { label: 'probe', ...options });
  try {
    await adapter.introspect();
    return 'opened';
  } catch (error) {
    return (error as Error).message;
  } finally {
    await adapter.close().catch(() => {});
  }
}

test("an operator's address fills a missing password from PGPASSWORD: what the sealed dial must not do", async () => {
  const { server, port, seen } = await fakePostgres();
  servers.push(server);
  process.env.PGPASSWORD = 'operator-secret';
  await dial(`postgres://probe@127.0.0.1:${port}/db`, {});
  assert.equal(seen.password, 'operator-secret', 'pg filled the password in from the environment');
});

test('a sealed address sends its own user and an empty password, never the environment', async () => {
  const { server, port, seen } = await fakePostgres();
  servers.push(server);
  process.env.PGPASSWORD = 'operator-secret';
  process.env.PGUSER = 'operator';
  // Loopback allowed here only so the fake server can be reached; the shape of the dial is what is under test.
  await dial(`postgres://probe@127.0.0.1:${port}/db`, { network: { allowPrivate: true, allowLinkLocal: false } });
  assert.equal(seen.user, 'probe');
  assert.equal(seen.password, '');
});

test('a sealed address reaches no loopback, private or metadata address, by number or by name', async () => {
  const { server, port, seen } = await fakePostgres();
  servers.push(server);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const message = await dial(`postgres://probe@${host}:${port}/db`, { network: UNTRUSTED_NETWORK });
    assert.match(message, /may not reach/, host);
  }
  for (const host of ['169.254.169.254', '10.0.0.1', '192.168.1.1']) {
    const message = await dial(`mysql://probe@${host}:${port}/db`, { network: UNTRUSTED_NETWORK });
    assert.match(message, /may not reach/, host);
  }
  assert.equal(seen.connections, 0, 'no socket reached the server');
});

test('an untrusted URL names its host and user and carries no parameter that reads this machine', () => {
  for (const url of [
    'postgres://attacker.example/db',
    'postgres://u@/db',
    'postgres://u@attacker.example/db?host=/var/run/postgresql',
    'postgres://u@attacker.example/db?sslrootcert=/etc/passwd',
    'postgres://u@attacker.example/db?sslmode=bogus',
    'mysql://u@attacker.example/db?socketPath=/tmp/mysql.sock',
  ]) {
    assert.ok(untrustedTargetRefusal(url), url);
  }
  for (const url of [
    'postgres://u@db.example.com/app',
    'postgres://u:p@db.example.com:5433/app?sslmode=require',
    'postgres://u@db.example.com/app?sslrootcert=system',
    'mysql://u:p@db.example.com/app',
  ]) {
    assert.equal(untrustedTargetRefusal(url), null, url);
  }
});
