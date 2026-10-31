import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

// The desktop shell cannot load without Electron, so its lifecycle lives in a
// module that takes its collaborators as arguments; these cases run it as is.
const require = createRequire(import.meta.url);
const { createServerLifecycle, isAllowedExternal } = require('../desktop/lifecycle.js');

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills: string[] = [];
  kill(signal: string) {
    this.kills.push(signal);
    // A real server closes its database and exits on SIGTERM.
    if (signal === 'SIGTERM') queueMicrotask(() => this.die(0));
    return true;
  }
  die(code: number) {
    this.exitCode = code;
    this.emit('exit', code);
  }
}

function harness(over: Record<string, unknown> = {}) {
  const children: FakeChild[] = [];
  const unexpected: Array<[string, number]> = [];
  const lifecycle = createServerLifecycle({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    fetch: async () => ({ ok: true }),
    freePort: async () => 4100 + children.length,
    entry: () => ({ args: ['server.js'] }),
    root: '/nowhere',
    onUnexpectedExit: (log: string, code: number) => unexpected.push([log, code]),
    deadlineMs: 400,
    pollMs: 5,
    firstPollMs: 1,
    graceMs: 20,
    ...over,
  });
  return { lifecycle, children, unexpected };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('switching databases does not report the retired server as a crash', async () => {
  const { lifecycle, children, unexpected } = harness();
  await lifecycle.start('a.db');
  for (const db of ['b.db', 'c.db', 'a.db']) {
    lifecycle.stop();
    await lifecycle.start(db);
  }
  await tick();
  assert.equal(children.length, 4);
  assert.deepEqual(unexpected, []);
  assert.equal(lifecycle.port, 4100 + 3);
});

test('an old child exiting late cannot affect its successor', async () => {
  const { lifecycle, children, unexpected } = harness();
  await lifecycle.start('a.db');
  const [first] = children;
  first.kill = () => true; // slow to die
  lifecycle.stop();
  await lifecycle.start('b.db');
  first.die(0);
  assert.deepEqual(unexpected, []);
  // The successor is still the current server: its own death still reports.
  children[1].stderr.emit('data', 'boom');
  children[1].die(2);
  assert.deepEqual(unexpected, [['boom', 2]]);
});

test('the current server dying after it was ready is reported', async () => {
  const { lifecycle, children, unexpected } = harness();
  await lifecycle.start();
  children[0].die(1);
  assert.deepEqual(unexpected, [['', 1]]);
});

test('an exit while the app is quitting is not reported', async () => {
  const { lifecycle, children, unexpected } = harness({ isQuitting: () => true });
  await lifecycle.start();
  children[0].die(0);
  assert.deepEqual(unexpected, []);
});

test('stop terminates the current child, then kills one that ignores it', async () => {
  const { lifecycle, children } = harness();
  await lifecycle.start();
  children[0].kill = function (this: FakeChild, signal: string) {
    this.kills.push(signal);
    return true;
  };
  lifecycle.stop();
  await tick(60);
  assert.deepEqual(children[0].kills, ['SIGTERM', 'SIGKILL']);
});

test('a child that exits before it is ready fails startup with its own words', async () => {
  const { lifecycle, children } = harness({
    fetch: () => new Promise(() => {}),
  });
  const started = lifecycle.start('x.db');
  await tick(5);
  children[0].stderr.emit('data', 'cannot open x.db');
  children[0].die(1);
  await assert.rejects(started, /cannot open x\.db/);
});

test('a server that accepts the connection and never answers fails at the deadline and is stopped', async () => {
  const signals: AbortSignal[] = [];
  const { lifecycle, children, unexpected } = harness({
    deadlineMs: 60,
    fetch: (_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      return new Promise(() => {});
    },
  });
  const began = Date.now();
  await assert.rejects(lifecycle.start('x.db'), /did not answer within/);
  assert.ok(Date.now() - began < 400);
  assert.ok(signals.length > 0 && signals.every((s) => s.aborted), 'the pending request is aborted');
  await tick();
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  assert.deepEqual(unexpected, []);
  // Recoverable: a retry starts a fresh child.
  const retry = harness().lifecycle;
  await retry.start('x.db');
});

test('a slow but valid startup succeeds before the deadline', async () => {
  let calls = 0;
  const { lifecycle, children } = harness({
    fetch: async () => {
      calls += 1;
      if (calls < 5) throw new Error('ECONNREFUSED');
      return { ok: true };
    },
  });
  assert.equal(await lifecycle.start(), 4100);
  assert.deepEqual(children[0].kills, []);
});

test('a missing executable fails startup instead of throwing or hanging', async () => {
  const asEvent = harness({
    spawn: () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    },
    fetch: () => new Promise(() => {}),
  });
  await assert.rejects(asEvent.lifecycle.start(), /ENOENT/);

  const asThrow = harness({
    spawn: () => {
      throw new Error('spawn EACCES');
    },
  });
  await assert.rejects(asThrow.lifecycle.start(), /EACCES/);
});

test('no server entry is reported without spawning', async () => {
  const { lifecycle, children } = harness({ entry: () => null });
  await assert.rejects(lifecycle.start(), /No server found/);
  assert.equal(children.length, 0);
});

test('only web, mail and telephone links may reach the operating system', () => {
  for (const ok of ['https://example.com/a?b=1', 'http://example.com', 'mailto:a@example.com', 'tel:+15555550100']) {
    assert.equal(isAllowedExternal(ok), true, ok);
  }
  for (const bad of [
    'file:///synthetic-only.txt',
    'javascript:alert(1)',
    'custom-handler:synthetic-only',
    'vbscript:x',
    'data:text/html,hi',
    'ftp://example.com',
    'not a url',
    '',
    '//example.com',
  ]) {
    assert.equal(isAllowedExternal(bad), false, bad);
  }
});
