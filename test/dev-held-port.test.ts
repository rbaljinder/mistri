/**
 * `mistri dev` restarted its host on a save, and every request in the gap between the old host letting the port go and
 * the new one taking it was refused (field report #30). The supervising parent (cli/devSupervisor.ts) now holds the
 * port and hands each connection to the host that is ready: a request sent while no host is up waits and is answered
 * by the next one, a stream ends with the host that served it, and a request that waits too long is told the App is
 * starting again, with a Retry-After.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseDev } from '../packages/mistri/src/server/cli/devSupervisor.js';

const SUPERVISOR = resolve('packages/mistri/src/server/cli/devSupervisor.ts');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** One request on a connection of its own (no agent), so none rides a socket an old host held. */
function get(port: number, path: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
    const sent = request({ port, host: '127.0.0.1', path, agent: false, headers: { host } }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += String(chunk)));
      response.on('end', () => done({ status: response.statusCode!, headers: response.headers, body }));
    });
    sent.on('error', fail);
    sent.end();
  });
}

/**
 * The host: a plain HTTP server served through listenForDev. It says who answered (pid, the Host it was sent, the peer
 * address it sees), starts slowly so a restart has a gap, retires as a host does on a save (releaseForDev, then exit
 * 75), fails its start while `fail` exists, and leaves with 0 (the person's own stop) once `done` does.
 */
function hostModule(dir: string) {
  const host = join(dir, 'host.mts');
  const fail = join(dir, 'fail');
  const done = join(dir, 'done');
  writeFileSync(
    host,
    `import { createServer } from 'node:http';\n` +
      `import { existsSync } from 'node:fs';\n` +
      `import { listenForDev, releaseForDev } from ${JSON.stringify(SUPERVISOR)};\n` +
      `if (existsSync(${JSON.stringify(fail)})) process.exit(1);\n` +
      `if (existsSync(${JSON.stringify(done)})) process.exit(0);\n` +
      `const server = createServer((req, res) => {\n` +
      `  if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: open\\n\\n'); return; }\n` +
      `  res.end(JSON.stringify({ pid: process.pid, host: req.headers.host, peer: req.socket.remoteAddress }));\n` +
      `  if (req.url === '/retire') setTimeout(async () => { await releaseForDev(); server.close(); server.closeAllConnections(); process.exit(75); }, 20);\n` +
      `});\n` +
      `setTimeout(() => listenForDev(server, 0, '127.0.0.1'), 600);\n`,
  );
  return { host, fail, done };
}

test(
  'a request sent while the host starts again is answered by the new host, a stream ends with the old one, and a long wait is a 503',
  { timeout: 60000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-dev-port-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { host, fail, done } = hostModule(dir);
    const port = await freePort();
    const said: string[] = [];
    t.mock.method(console, 'error', (line: string) => said.push(line));
    let save: (() => void) | undefined;
    const supervised = superviseDev({
      argv: [],
      env: { PATH: process.env.PATH },
      entry: ['--import', 'tsx', host],
      listen: { port, host: '127.0.0.1' },
      holdMs: 3000,
      watch: (changed) => {
        save = changed;
        return () => (save = undefined);
      },
    });
    const stopping = new AbortController();
    t.after(() => stopping.abort());

    // Sent before the first host listens: held, not refused, and answered once it does.
    const first = JSON.parse((await get(port, '/', 'dev.example.test:4111')).body) as { pid: number; host: string; peer: string };
    assert.equal(first.host, 'dev.example.test:4111', 'Host arrives as it was sent');
    assert.match(first.peer, /127\.0\.0\.1$/, 'the peer is the real one, not a proxy');

    // A stream on the first host ends when it goes.
    const stream = await fetch(`http://127.0.0.1:${port}/stream`, { signal: stopping.signal });
    const reader = stream.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: open/);
    const streamEnded = (async () => {
      try {
        while (!(await reader.read()).done);
      } catch {
        /* Ended by a reset: ended all the same. */
      }
    })();

    // The host retires as on a save; a request sent once it is gone, while the next one is still starting, waits for it.
    assert.equal(JSON.parse((await get(port, '/retire')).body).pid, first.pid);
    for (let waited = 0; alive(first.pid); waited += 10) {
      assert.ok(waited < 10000, 'the first host never left');
      await delay(10);
    }
    const during = await get(port, '/');
    assert.equal(during.status, 200);
    const second = JSON.parse(during.body) as { pid: number };
    assert.notEqual(second.pid, first.pid, 'answered by the new host');
    await streamEnded;
    assert.ok(
      said.some((line) => /the App changed; starting it again/.test(line)),
      said.join('\n'),
    );

    // A start that fails leaves the parent waiting for a save; a request that waits past the hold is told why, with a retry.
    writeFileSync(fail, '');
    await get(port, '/retire');
    for (let waited = 0; !save; waited += 25) {
      assert.ok(waited < 15000, 'the failed start never waited for a save');
      await delay(25);
    }
    const held = await get(port, '/');
    assert.equal(held.status, 503);
    assert.equal(held.headers['retry-after'], '1');
    assert.match(held.body, /the App is starting again/);

    // A request held while the save comes is answered by the host that save starts.
    rmSync(fail);
    const pending = get(port, '/');
    await delay(100);
    (save as unknown as () => void)();
    const third = JSON.parse((await pending).body) as { pid: number };
    assert.ok(third.pid !== first.pid && third.pid !== second.pid);

    writeFileSync(done, '');
    await get(port, '/retire');
    assert.equal(await supervised, 0);
    assert.equal(existsSync(fail), false);
    await assert.rejects(get(port, '/'), 'the port is let go once the session ends');
  },
);
