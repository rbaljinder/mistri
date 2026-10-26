import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT, startOwnedServer } from './fixture.mjs';
import { seedPostgresFixture } from './postgres-fixture.mjs';
import { captureReleasePostgres } from './postgres-ownership.mjs';
const enabled = process.env.TABLEWALK_TEST_PG_LOAD === '1';
async function absent(evidence) {
  const identity = captureReleasePostgres(JSON.parse(execFileSync('docker', ['inspect', 'tablewalk-050-postgres'], { encoding: 'utf8' })));
  assert.equal(identity.id, evidence.container.id);
  assert.match(evidence.database, /^tw_load_[a-f0-9]{32}$/);
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: 'postgresql://postgres@127.0.0.1:55450/tablewalk',
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  try {
    await client.connect();
    assert.equal(
      (await client.query('SELECT count(*)::integer AS n FROM pg_catalog.pg_database WHERE datname=$1', [evidence.database])).rows[0].n,
      0,
    );
  } finally {
    await client.end();
  }
}

test('failed owned CLI startup still permits exact captured PG database cleanup', { skip: !enabled, timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-pg-load-failed-start-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await seedPostgresFixture(directory, 100);
  try {
    await assert.rejects(
      startOwnedServer(
        directory,
        { ...fixture, configFile: join(directory, 'missing-owned-config.json') },
        new AbortController().signal,
        true,
      ),
      /Owned server exited during startup/,
    );
  } finally {
    await fixture.cleanup();
  }
  await absent(fixture.evidence);
});

test(
  'PG SIGINT reports interruption, stops the child and drops only the captured database',
  { skip: !enabled, timeout: 60000 },
  async (t) => {
    // The run's artifacts and its browser's profile, in a TMPDIR of the test's own (lifecycle.test.mjs says why).
    const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-pg-load-sigint-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const entry = pathToFileURL(join(ROOT, 'test/load/run.mjs')).href;
    const source = `import { main } from ${JSON.stringify(entry)}; process.exitCode = await main(['--production','--smoke','--arrival-rps','10','--users','2'], {postgres:true});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
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
    }, 45000);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + String(chunk)).slice(-128 * 1024);
        if (!sent && output.includes('warming up')) {
          sent = true;
          child.kill('SIGINT');
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
    assert.equal(timedOut, false);
    assert.equal(sent, true);
    assert.equal(code, 130, output);
    const directory = output.match(/Local-only load artifacts: (.+)/)?.[1];
    assert.ok(directory, output);
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.status, 'interrupted');
    assert.equal(report.cleanupError, undefined);
    assert.equal(report.interruptedBy, 'SIGINT');
    assert.throws(() => process.kill(report.server.pid, 0), { code: 'ESRCH' });
    await absent(report.database);
  },
);
