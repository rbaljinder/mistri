/**
 * The counters a `--workers` start keeps in its primary (packages/mistri/src/server/cli/primaryCounters.ts): the
 * workers spend one rate budget and one lockout count, as one process would; and when the primary does not answer, a
 * lockout fails closed while a plain rate limit goes on in the worker's own count.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CacheUnavailable } from '../packages/engine/src/adapters/cache/cacheStore.js';
import { configurePublicFormLimits, publicFormLimiter, SharedWindowLimiter } from '../packages/engine/src/server/http/rateLimit.js';
import { configureSignInState, resetSignInState, signInState } from '../packages/mistri/src/server/auth/signInState.js';
import { answerCounters, COUNTERS_OP, primaryCounters, resetPrimaryCounters } from '../packages/mistri/src/server/cli/primaryCounters.js';
import { NoAnswer } from '../packages/mistri/src/server/processBus.js';
import { ROOT } from './appApiCli.js';

/* A worker's question, answered by the primary's own handler in this process (what the bus carries is JSON). */
const routed = async (op: string, args: unknown[]) => JSON.parse(JSON.stringify((await answerCounters(op, args)) ?? null)) as unknown;
let stuck = false;
const asking = (op: string, args: unknown[]) => (stuck ? Promise.reject(new NoAnswer('the primary did not answer.')) : routed(op, args));

after(() => {
  configureSignInState(undefined, '');
  configurePublicFormLimits(undefined, '');
  resetSignInState();
  resetPrimaryCounters();
});

test('the primary answers counter questions it keeps, and refuses any other', async () => {
  resetPrimaryCounters();
  const one = primaryCounters('signin', asking);
  const two = primaryCounters('signin', asking);
  assert.equal(one.kind, 'primary');
  assert.deepEqual(await one.incr('k', 60_000), { count: 1, ttlMs: 60_000 });
  assert.equal((await two.incr('k', 60_000)).count, 2);
  assert.equal((await one.incr('k', 60_000, 3)).count, 5);
  await two.set('s', 'v', 60_000);
  assert.equal(await one.get('s'), 'v');
  await one.delete('s');
  assert.equal(await two.get('s'), undefined);
  // The buckets are apart: a flood in one cannot push out another's entries, nor read them.
  assert.equal((await primaryCounters('forms', asking).incr('k', 60_000)).count, 1);
  assert.throws(() => answerCounters('other', []), /no answer to other/);
  assert.throws(() => answerCounters(COUNTERS_OP, ['nowhere', 'get', 'k']), /does not keep/);
  assert.throws(() => answerCounters(COUNTERS_OP, ['signin', 'flush', 'k']), /does not keep/);
  stuck = true;
  try {
    await assert.rejects(one.get('k'), CacheUnavailable);
    await assert.rejects(one.incr('k', 1_000), CacheUnavailable);
  } finally {
    stuck = false;
  }
});

test('a lockout counted by two workers is one count; without an answer it fails closed and keeps nothing', async () => {
  resetPrimaryCounters();
  resetSignInState();
  configureSignInState(primaryCounters('signin', asking), 'crm', primaryCounters('pending', asking));
  assert.equal(await signInState.fail('receipt:1', 60_000), 1);
  assert.equal(await signInState.fail('receipt:1', 60_000), 2);
  assert.equal(await signInState.failures('receipt:1'), 2);
  await signInState.put('otp-spent', 'code-1', { at: 1 }, Date.now() + 60_000);
  assert.deepEqual(await signInState.read('otp-spent', 'code-1'), { at: 1 });
  // Better Auth's request budget is the start's too.
  const rule = { window: 60, max: 1 };
  assert.equal((await signInState.consume('ip:1', rule)).allowed, true);
  assert.equal((await signInState.consume('ip:1', rule)).allowed, false);

  stuck = true;
  try {
    // Closed: an unknown count is past every limit, and a proof that cannot be read is no proof.
    assert.equal(await signInState.failures('receipt:2'), Number.MAX_SAFE_INTEGER);
    assert.equal(await signInState.fail('receipt:2', 60_000), Number.MAX_SAFE_INTEGER);
    assert.equal(await signInState.read('otp-spent', 'code-1'), undefined);
    await signInState.put('signin-lock', 'receipt:2', { until: 1 }, Date.now() + 60_000);
    await signInState.clearFailures('receipt:1');
    // A one-use OAuth record the primary did not see taken away would stay usable through another worker: refused.
    await assert.rejects(signInState.remove('oauth-consent', 'nonce-1'), CacheUnavailable);
    await signInState.remove('signin-lock', 'receipt:2');
    // Open: the request budget goes on in this worker's own count.
    assert.equal((await signInState.consume('ip:2', rule)).allowed, true);
    assert.equal((await signInState.consume('ip:2', rule)).allowed, false);
  } finally {
    stuck = false;
  }
  // Nothing written during the outage outlives it: no lock was kept, and the failures it could not clear remain.
  assert.equal(await signInState.read('signin-lock', 'receipt:2'), undefined);
  assert.equal(await signInState.failures('receipt:2'), 0);
  assert.equal(await signInState.failures('receipt:1'), 2);
});

test("public forms' budgets are the start's, and go on in the worker's own count when the primary does not answer", async () => {
  resetPrimaryCounters();
  configurePublicFormLimits(primaryCounters('forms', asking), 'crm');
  const limiter = publicFormLimiter('read');
  assert.ok(limiter instanceof SharedWindowLimiter);
  let allowed = 0;
  while ((await limiter.take('192.0.2.70')).ok) allowed += 1;
  assert.ok(allowed > 0);
  stuck = true;
  try {
    assert.equal((await limiter.take('192.0.2.70')).ok, true);
  } finally {
    stuck = false;
  }
  assert.equal((await limiter.take('192.0.2.70')).ok, false);
});

test(
  'between real workers the counts are one, and a worker whose primary does not answer gets CacheUnavailable',
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-counters-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const script = join(directory, 'counters.mjs');
    const url = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
    /* Two workers count one key three times each through a primary that answers as cli/workers.ts does; a third asks a
     primary that never answers. */
    writeFileSync(
      script,
      `import cluster from 'node:cluster';
import { answer } from ${url('packages/mistri/src/server/processBus.ts')};
import { answerCounters, primaryCounters } from ${url('packages/mistri/src/server/cli/primaryCounters.ts')};
if (cluster.isPrimary) {
  const counted = cluster.fork({ COUNTERS_ROLE: 'count' });
  const also = cluster.fork({ COUNTERS_ROLE: 'count' });
  const ignored = cluster.fork({ COUNTERS_ROLE: 'ignored' });
  const said = {};
  for (const [name, worker, answers] of [['a', counted, true], ['b', also, true], ['ignored', ignored, false]])
    worker.on('message', (message) => {
      if (answers && answer(message, worker, answerCounters)) return;
      if (message.said) {
        said[name] = message.said;
        if (Object.keys(said).length === 3) {
          console.log(JSON.stringify(said));
          for (const w of [counted, also, ignored]) w.kill();
        }
      }
    });
} else if (process.env.COUNTERS_ROLE === 'count') {
  const store = primaryCounters('signin');
  const counts = [];
  for (let n = 0; n < 3; n++) counts.push((await store.incr('shared', 60_000)).count);
  process.send({ said: counts });
} else {
  const started = Date.now();
  try {
    await primaryCounters('signin').get('shared');
    process.send({ said: 'answered' });
  } catch (error) {
    process.send({ said: [error.constructor.name, Date.now() - started < 5_000] });
  }
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
    const said = JSON.parse(out.trim().split('\n').at(-1)!) as { a: number[]; b: number[]; ignored: unknown };
    // Six counts of one key between them, each answered once: 1 to 6 with none twice.
    assert.deepEqual(
      [...said.a, ...said.b].sort((x, y) => x - y),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(said.ignored, ['CacheUnavailable', true]);
  },
);
