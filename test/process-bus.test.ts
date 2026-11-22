/**
 * The process bus (packages/mistri/src/server/processBus.ts): in one process a loopback, and between the workers of
 * one start a message one publishes reaches the others through the primary, once each, and never back to the sender.
 * A worker's question to its primary (ask/answer) is test/primary-counters.test.ts's between real workers.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:cluster';
import { answer, ask, busMessage, NoAnswer, publish, subscribe } from '../packages/mistri/src/server/processBus.js';
import { ROOT } from './appApiCli.js';

test("in one process the bus is a loopback: a publish runs this process's subscribers, a failing one stops no other", () => {
  const heard: unknown[] = [];
  const offA = subscribe('test.loop', (payload) => heard.push(['a', payload]));
  const offB = subscribe('test.loop', () => {
    throw new Error('a subscriber that fails');
  });
  const offC = subscribe('test.loop', (payload) => heard.push(['c', payload]));
  const said = console.error;
  console.error = () => {};
  try {
    publish('test.loop', { key: 'k1' });
    publish('test.other', 'nobody listens');
  } finally {
    console.error = said;
  }
  assert.deepEqual(heard, [
    ['a', { key: 'k1' }],
    ['c', { key: 'k1' }],
  ]);
  offA();
  offB();
  offC();
  publish('test.loop', 'after');
  assert.equal(heard.length, 2);
  assert.equal(busMessage({ mistriBus: { topic: 't', payload: 1 } })?.topic, 't');
  assert.equal(busMessage({ mistriWorker: 'connection' }), undefined);
  assert.equal(busMessage('mistriBus'), undefined);
});

test('between workers, a publish reaches every other worker once and not its sender twice', { timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-bus-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, 'bus.mjs');
  const bus = JSON.stringify(pathToFileURL(join(ROOT, 'packages/mistri/src/server/processBus.ts')).href);
  /* Three workers: each subscribes and says so; once all have, worker 1 publishes; each reports what it heard. The
     primary relays exactly as cli/workers.ts does, through relay(). */
  writeFileSync(
    script,
    `import cluster from 'node:cluster';
import { publish, relay, subscribe } from ${bus};
if (cluster.isPrimary) {
  const workers = [1, 2, 3].map((n) => cluster.fork({ BUS_N: String(n) }));
  const heard = {};
  let ready = 0;
  for (const worker of workers)
    worker.on('message', (message) => {
      if (relay(message, worker, workers)) return;
      if (message.ready && ++ready === workers.length) workers[0].send({ go: true });
      if (message.heard) {
        heard[message.n] = message.heard;
        if (Object.keys(heard).length === workers.length) {
          console.log(JSON.stringify(heard));
          for (const w of workers) w.kill();
        }
      }
    });
} else {
  const n = process.env.BUS_N;
  const heard = [];
  subscribe('test.evict', (payload) => heard.push(payload));
  process.on('message', (message) => {
    if (message.go) publish('test.evict', { key: 'k', from: n });
  });
  process.send({ ready: true });
  // Long enough for a relayed message to arrive, and for a double delivery to show.
  setTimeout(() => process.send({ heard: heard.length ? heard : ['nothing'], n }), 1500);
}
`,
  );
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (err += chunk));
  const code = await new Promise<number | null>((done) => child.once('exit', done));
  assert.equal(code, 0, err);
  const heard = JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, unknown[]>;
  const once = [{ key: 'k', from: '1' }];
  assert.deepEqual(heard, { 1: once, 2: once, 3: once });
});

test('a question has no primary to ask outside a worker, and the primary answers one with its value or its error', async () => {
  await assert.rejects(ask('counters', [], 50), NoAnswer);
  const sent: unknown[] = [];
  const worker = { isConnected: () => true, send: (message: unknown) => sent.push(message) } as unknown as Worker;
  assert.equal(
    answer({ mistriBus: { topic: 't', payload: 1 } }, worker, () => 1),
    false,
  );
  assert.equal(
    answer({ mistriAsk: { id: 'x', op: 'o' } }, worker, () => 1),
    false,
  );
  assert.equal(
    answer({ mistriAsk: { id: 1, op: 'double', args: [21] } }, worker, (op, args) => (op === 'double' ? Number(args[0]) * 2 : 0)),
    true,
  );
  assert.equal(
    answer({ mistriAsk: { id: 2, op: 'fails', args: [] } }, worker, () => {
      throw new Error('no such counter');
    }),
    true,
  );
  // Arguments that are not a list are none.
  assert.equal(
    answer({ mistriAsk: { id: 3, op: 'count', args: 'x' } }, worker, (_op, args) => args.length),
    true,
  );
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(sent, [
    { mistriAnswer: { id: 1, value: 42 } },
    { mistriAnswer: { id: 2, error: 'no such counter' } },
    { mistriAnswer: { id: 3, value: 0 } },
  ]);
});
