import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './fixture.mjs';

// Explicit opt-in: ordinary unit checks must not silently start browser load.
const enabled = process.env.TABLEWALK_LOAD_INTEGRATION === '1';

async function run(args, signal) {
  /* The run's artifacts and its browser's profile go in a TMPDIR of this test's own, removed once the report is
     read: the run keeps its artifacts for a person, and in a lane they are a leak (scripts/test-node.mjs). */
  const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-load-lifecycle-'));
  try {
    return await runIn(scratch, args, signal);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function runIn(scratch, args, signal) {
  const child = spawn(process.execPath, ['test/load/run.mjs', '--smoke', '--duration', '1', ...args], {
    cwd: ROOT,
    env: { ...process.env, TMPDIR: scratch },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    sent = false,
    timedOut = false,
    force;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    force = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, 40000);
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-128 * 1024);
      if (signal && !sent && output.includes('warming up')) {
        sent = true;
        child.kill(signal);
      }
    });
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
  }
  assert.equal(timedOut, false, output);
  const directory = output.match(/Local-only load artifacts: (.+)/)?.[1];
  assert.ok(directory, output);
  const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
  assert.throws(() => process.kill(report.server.pid, 0), { code: 'ESRCH' }, 'Owned child must have exited');
  assert.ok(readFileSync(join(directory, 'report.md'), 'utf8').includes('not INP'));
  return { code, report, output };
}

test('real one-second smoke succeeds with owned fixture and both workloads', { skip: !enabled, timeout: 50000 }, async () => {
  const { code, report, output } = await run([]);
  assert.equal(code, 0, output);
  assert.equal(report.status, 'passed');
  assert.equal(report.mode, 'source-dev-vite');
  assert.equal(report.server.fixtureIdentityVerified, true);
  assert.ok(report.warmup.http.completed > 0);
  assert.ok(report.measured.http.completed > 0);
  assert.ok(report.measured.browser.completed > 0);
  assert.equal(report.measured.browserEvents.errors, 0);
  assert.equal(typeof report.measured.endpoints['/api/run'].latencyMs.p95, 'number');
});

test(
  'built-mode smoke preserves owned fixture proof and teardown',
  { skip: !enabled || process.env.TABLEWALK_LOAD_PRODUCTION_INTEGRATION !== '1', timeout: 50000 },
  async () => {
    const { code, report, output } = await run(['--production']);
    assert.equal(code, 0, output);
    assert.equal(report.mode, 'production-dist');
    assert.deepEqual(report.server.args.slice(0, 2), ['--conditions=mistri-built', 'packages/mistri/dist/server/index.js']);
    assert.equal(report.server.args.includes('tsx'), false);
    assert.equal(report.server.fixtureIdentityVerified, true);
    assert.ok(report.measured.http.completed > 0 && report.measured.browser.completed > 0);
  },
);

test(
  'built fixed-arrival smoke accounts for the offered window without hidden queueing',
  { skip: !enabled || process.env.TABLEWALK_LOAD_PRODUCTION_INTEGRATION !== '1', timeout: 50000 },
  async () => {
    const { code, report, output } = await run(['--production', '--arrival-rps', '10', '--users', '4']);
    assert.equal(code, 0, output);
    assert.equal(report.measured.arrivals.rate, 10);
    assert.equal(report.measured.arrivals.scheduled, 10);
    assert.equal(report.measured.arrivals.admitted, 10);
    assert.equal(report.measured.arrivals.droppedBusy + report.measured.arrivals.droppedLate, 0);
    assert.equal(report.measured.http.attempts, 10);
  },
);

for (const signal of ['SIGINT', 'SIGTERM'])
  test(`${signal} retains interruption report and stops owned child`, { skip: !enabled, timeout: 50000 }, async () => {
    const { code, report, output } = await run([], signal);
    assert.equal(code, signal === 'SIGINT' ? 130 : 143, output);
    assert.equal(report.status, 'interrupted');
    assert.equal(report.interruptedBy, signal);
  });

test('real UI latency gate failure returns nonzero and still cleans up', { skip: !enabled, timeout: 50000 }, async () => {
  const { code, report, output } = await run(['--ui-p95-ms', '1']);
  assert.equal(code, 1, output);
  assert.equal(report.status, 'failed');
  assert.equal(report.gates.passed, false);
  assert.ok(report.gates.failures.some((failure) => failure.startsWith('browser: p95')));
});
