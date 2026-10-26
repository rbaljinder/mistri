/*
 * A stopping server exits promptly while a client still holds a connection.
 *
 * `close()` drops the keep-alive sockets idle when it runs, but a response
 * still in flight then finished with `Connection: keep-alive`, and its socket
 * idled for the whole keep-alive timeout (sixty-five seconds) while shutdown
 * waited on it: a browser left open on a page held SIGTERM for a minute, and
 * the browser suite's helpers learned to SIGKILL. The request here is one the
 * server has accepted and is still reading when the signal lands; its body
 * arrives after, the server answers it, and the process must still be gone
 * well inside the keep-alive window.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/tablewalk/src/server/index.ts', import.meta.url));

function start(args: string[], env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line:\n${output}`)), 60_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const listening = /Listening on http:\/\/localhost:(\d+)/.exec(output);
      if (listening) {
        clearTimeout(timer);
        resolve({ child, port: Number(listening[1]), output: () => output });
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code}:\n${output}`));
    });
  });
}

test('SIGTERM with a request in flight on a keep-alive connection exits within seconds', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-shutdown-'));
  const db = join(dir, 'shop.db');
  const sqlite = new DatabaseSync(db);
  sqlite.exec("CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO product VALUES (1, 'Lamp');");
  sqlite.close();
  const server = await start(['--db', db, '--port', '0', '--no-config'], {
    ...process.env,
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    TABLEWALK_OPEN: '0',
  });
  const exited = new Promise<number>((resolve) => server.child.once('exit', () => resolve(Date.now())));
  const socket = connect(server.port, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let answer = '';
    socket.on('data', (chunk) => {
      answer += chunk.toString();
    });
    socket.on('error', () => {});
    // The headers and half the body: the server has the request and waits.
    const body = JSON.stringify({ connection: 'shop', table: 'product', key: { id: 1 }, values: { name: 'Lamp' } });
    socket.write(
      `POST /api/update HTTP/1.1\r\nHost: localhost:${server.port}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body.slice(0, 10)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const signalled = Date.now();
    server.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.write(body.slice(10));
    // Whatever the answer (a read-only connection refuses the write), one comes.
    const answered = await Promise.race([
      new Promise<boolean>((resolve) => {
        const poll = setInterval(() => {
          if (/^HTTP\/1\.1 \d{3}/.test(answer)) {
            clearInterval(poll);
            resolve(true);
          }
        }, 20);
      }),
      exited.then(() => false),
    ]);
    let patience: NodeJS.Timeout | undefined;
    const gone = await Promise.race([
      exited,
      new Promise<number>((resolve) => {
        patience = setTimeout(() => resolve(Number.NaN), 15_000);
      }),
    ]);
    clearTimeout(patience);
    assert.ok(Number.isFinite(gone), `the server was still running 15 s after SIGTERM:\n${server.output()}`);
    assert.ok(gone - signalled < 5_000, `the server took ${gone - signalled} ms to exit`);
    assert.ok(answered, 'the accepted request was answered before the server went');
  } finally {
    socket.destroy();
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--drain-delay keeps answering, with /readyz failing, before the listener closes', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-drain-'));
  const db = join(dir, 'shop.db');
  const sqlite = new DatabaseSync(db);
  sqlite.exec('CREATE TABLE product(id INTEGER PRIMARY KEY);');
  sqlite.close();
  const server = await start(['--db', db, '--port', '0', '--no-config', '--drain-delay', '2', '--shutdown-grace', '3'], {
    ...process.env,
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    TABLEWALK_OPEN: '0',
  });
  const exited = new Promise<number>((resolve) => server.child.once('exit', () => resolve(Date.now())));
  try {
    // Not keep-alive: a pooled socket would be closed by the listener's close and read as the refusal under test.
    const ask = (path: string) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { connection: 'close' } }).then((response) => response.status);
    assert.equal(await ask('/readyz'), 200);
    const signalled = Date.now();
    server.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await ask('/readyz'), 503, 'readiness fails at once');
    assert.equal(await ask('/healthz'), 200, 'the listener still answers during the drain');
    const gone = await exited;
    assert.ok(gone - signalled >= 1_900, `the listener closed ${gone - signalled} ms after SIGTERM, inside the 2 s drain`);
    assert.ok(gone - signalled < 10_000, `the server took ${gone - signalled} ms to exit`);
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
