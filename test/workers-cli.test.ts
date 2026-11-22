/**
 * `--workers` without a database server: how a request's session picks its worker, what the flag accepts, and the
 * starts it refuses (a SQLite App, and `mistri dev`). The PostgreSQL start itself is workers-cli-pg.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { availableCores, coreSourceSaid, MAX_WORKERS, WORKER_MEMORY_BYTES, workerCount } from '../packages/engine/src/server/cli/args.js';
import { cookieOfHead, sessionKey, slotOf } from '../packages/mistri/src/server/cli/workers.js';
import { childEnv, cliArgs, freePort, ROOT, runCli, within } from './appApiCli.js';

test('a session belongs to one worker: its key is the session cookies alone, in any order, and its slot is stable', () => {
  const one = sessionKey('theme=dark; mistri.session_token=abc.def; other=1');
  assert.equal(one, 'mistri.session_token=abc.def');
  assert.equal(
    sessionKey('__Secure-mistri.session_token=x; a.session_token=y'),
    sessionKey('a.session_token=y; __Secure-mistri.session_token=x'),
  );
  assert.equal(sessionKey('theme=dark'), '');
  assert.equal(sessionKey(undefined), '');
  for (const count of [1, 2, 3, 8]) {
    const slot = slotOf(one, count);
    assert.ok(slot >= 0 && slot < count);
    assert.equal(slotOf(one, count), slot);
  }
  // Enough sessions spread over every worker, so no worker is left idle by the hash.
  const seen = new Set(Array.from({ length: 64 }, (_, n) => slotOf(`mistri.session_token=${n}`, 4)));
  assert.equal(seen.size, 4);
});

test("the primary reads a request head's Cookie lines and nothing else", () => {
  const head = Buffer.from('GET /a HTTP/1.1\r\nHost: x\r\nCookie: a=1\r\ncookie: mistri.session_token=t\r\n\r\nCookie: body=1');
  assert.equal(cookieOfHead(head), 'a=1; mistri.session_token=t');
  assert.equal(cookieOfHead(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')), undefined);
  // A head cut short (the read cap) is read for what it has.
  assert.equal(cookieOfHead(Buffer.from('GET / HTTP/1.1\r\nCookie: a=1\r\nX-Long: ')), 'a=1');
});

test('--workers takes a whole number or auto, one per core when unsaid, and says why for anything else', () => {
  assert.equal(workerCount({}, 1), 1);
  assert.equal(workerCount({}, 4), 4);
  assert.equal(workerCount({ workers: '3' }), 3);
  assert.equal(workerCount({ workers: 'auto' }, 6), 6);
  assert.equal(workerCount({ workers: 'auto' }, 0), 1);
  assert.equal(workerCount({ workers: 'auto' }, 512), MAX_WORKERS);
  for (const bad of ['0', '-1', '1.5', 'lots', '', String(MAX_WORKERS + 1)])
    assert.match(String(workerCount({ workers: bad })), /--workers takes a whole number from 1 to 64 or "auto"/, bad);
});

test("auto counts the cores a container is given, not the host's: the CPU quota, then the memory limit", () => {
  const files = (given: Record<string, string>) => (name: string) => given[name];
  const MiB = 1024 * 1024;
  // No cgroup files at all (a Mac, a host with no container): the host's cores.
  assert.deepEqual(availableCores(files({}), 8), { cores: 8, cpus: 8, source: 'cores' });
  assert.equal(coreSourceSaid(availableCores(files({}), 8)), '8 cores');
  assert.equal(coreSourceSaid(availableCores(files({}), 1)), '1 core');
  // cgroup v2: "max" is no quota; a quota of two periods is two CPUs, and a part of one is a whole one.
  assert.equal(availableCores(files({ 'cpu.max': 'max 100000\n' }), 8).source, 'cores');
  const two = availableCores(files({ 'cpu.max': '200000 100000\n' }), 32);
  assert.deepEqual(two, { cores: 2, cpus: 2, source: 'cpu-quota' });
  assert.equal(coreSourceSaid(two), "the container's CPU quota");
  assert.equal(availableCores(files({ 'cpu.max': '150000 100000' }), 32).cores, 2);
  assert.equal(availableCores(files({ 'cpu.max': '50000 100000' }), 32).cores, 1);
  // A quota past the host's cores is the host's cores.
  assert.deepEqual(availableCores(files({ 'cpu.max': '1600000 100000' }), 4), { cores: 4, cpus: 4, source: 'cores' });
  // cgroup v1: quota and period, -1 for none.
  assert.equal(availableCores(files({ 'cpu/cpu.cfs_quota_us': '300000', 'cpu/cpu.cfs_period_us': '100000' }), 16).cores, 3);
  assert.equal(availableCores(files({ 'cpu/cpu.cfs_quota_us': '-1', 'cpu/cpu.cfs_period_us': '100000' }), 16).source, 'cores');
  // Memory: a worker per WORKER_MEMORY_BYTES, never none; the CPUs (which pools are shared by) stay the quota's.
  const tight = availableCores(files({ 'memory.max': String(512 * MiB) }), 8);
  assert.deepEqual(tight, { cores: 2, cpus: 8, source: 'memory-limit' });
  assert.match(coreSourceSaid(tight), /the container's memory limit \(256 MiB a worker\)/);
  assert.equal(availableCores(files({ 'memory.max': String(WORKER_MEMORY_BYTES / 2) }), 8).cores, 1);
  assert.equal(availableCores(files({ 'memory.max': 'max' }), 8).source, 'cores');
  assert.equal(availableCores(files({ 'memory/memory.limit_in_bytes': String(768 * MiB) }), 8).cores, 3);
  assert.equal(availableCores(files({ 'memory/memory.limit_in_bytes': '9223372036854771712' }), 8).source, 'cores');
  // Both: the narrower wins, and says so.
  assert.equal(availableCores(files({ 'cpu.max': '200000 100000', 'memory.max': String(4096 * MiB) }), 32).source, 'cpu-quota');
  assert.equal(availableCores(files({ 'cpu.max': '400000 100000', 'memory.max': String(256 * MiB) }), 32).source, 'memory-limit');
  // Unreadable text is no limit.
  assert.equal(availableCores(files({ 'cpu.max': 'garbage', 'memory.max': '' }), 6).cores, 6);
});

test('a start nobody asked for workers serves a SQLite App as one process, and says why', { timeout: 120_000 }, async (t) => {
  const config = mkdtempSync(join(tmpdir(), 'mistri-workers-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const port = await freePort();
  // MISTRI_WORKERS blank: the default, as a deployment that sets nothing has it.
  const env = childEnv({ XDG_CONFIG_HOME: config, DATABASE_URL: '', MISTRI_WORKERS: '' });
  const args = ['--demo', '--app', 'test/fixtures/apps/fieldops', '--no-config', '--host', '127.0.0.1', '--port', String(port)];
  const child = spawn(process.execPath, cliArgs(args), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await closed;
    clearTimeout(timer);
  });
  const listening = new Promise<void>((done, fail) => {
    const read = (chunk: Buffer) => {
      said += chunk.toString();
      if (said.includes('Listening on http://')) done();
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('close', () => fail(new Error(`closed before listening: ${said}`)));
  });
  await within(listening, 90_000, 'The SQLite start listening', () => said);
  const answer = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
  assert.ok(answer.status < 500, `${answer.status}`);
  assert.doesNotMatch(said, /--workers needs a network database/);
  assert.doesNotMatch(said, /serving with \d+ workers/);
  // A one-core machine forks nothing, so has nothing to fall back from.
  if (availableCores().cores > 1) {
    assert.match(
      said,
      /mistri: one process: SQLite has one writer; workers need the App's data on PostgreSQL or MySQL and auth\.store on PostgreSQL\./,
    );
    assert.equal(said.match(/one process: SQLite/g)?.length, 1, said);
  }
});

test('a start with no App is refused once and exits, under the workers default and an explicit count', { timeout: 120_000 }, async (t) => {
  /* The primary forks before it reads the config, so a worker meets the refusal first: it must hand the start back
     (or exit) rather than wait on the cluster channel with its primary waiting on it. A field report saw it hang. */
  const config = mkdtempSync(join(tmpdir(), 'mistri-workers-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const file = join(config, 'plain.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)');
  db.close();
  const env = childEnv({ XDG_CONFIG_HOME: config, DATABASE_URL: '', MISTRI_WORKERS: '' });
  const start = ['--db', file, '--no-config', '--host', '127.0.0.1', '--port', '0'];

  const unsaid = await runCli(start, env);
  assert.equal(unsaid.code, 2, unsaid.out + unsaid.err);
  assert.equal((unsaid.out + unsaid.err).match(/npx tablewalk/g)?.length, 1, unsaid.out + unsaid.err);
  assert.doesNotMatch(unsaid.out + unsaid.err, /one process: SQLite/);

  const asked = await runCli([...start, '--workers', '2'], env);
  assert.equal(asked.code, 2, asked.out + asked.err);
  assert.match(asked.out + asked.err, /npx tablewalk/);
});

test('a start refuses --workers on SQLite, a bad count, and under mistri dev, each with its sentence', { timeout: 120_000 }, async (t) => {
  const config = mkdtempSync(join(tmpdir(), 'mistri-workers-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const env = childEnv({ XDG_CONFIG_HOME: config, DATABASE_URL: '', MISTRI_WORKERS: '' });
  const start = ['--demo', '--app', 'test/fixtures/apps/fieldops', '--no-config', '--host', '127.0.0.1', '--port', '0'];

  const sqlite = await runCli([...start, '--workers', '2'], env);
  assert.equal(sqlite.code, 2, sqlite.out + sqlite.err);
  assert.match(sqlite.err, /--workers needs a network database; SQLite has one writer/);
  assert.doesNotMatch(sqlite.out + sqlite.err, /Listening on/);

  const fromEnv = await runCli(start, { ...env, MISTRI_WORKERS: 'lots' });
  assert.equal(fromEnv.code, 2);
  assert.match(
    fromEnv.err,
    /--workers takes a whole number from 1 to 64 or "auto"; "lots" is not one\. It comes from the flag or MISTRI_WORKERS\./,
  );

  const dev = await runCli(['dev', ...start, '--workers', '2'], env);
  assert.equal(dev.code, 2, dev.out + dev.err);
  assert.match(dev.err, /mistri dev: --workers is for a production start; dev runs one process/);
});
