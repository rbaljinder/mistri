/**
 * Jobs at times (jobSchedule.ts, jobHost.ts): `every` is cron read on a
 * timezone's wall clock; each slot is enqueued under a key every process
 * computes alike, so two servers over one job store run it once; and after a
 * stop only the most recent missed slot runs, the ones before it skipped.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { everySlotKey } from '../packages/mistri/src/server/jobs/jobCommands.js';
import { defineJob, defineJobs, JobDeclarationError } from '../packages/mistri/src/server/jobs/jobModule.js';
import { latestSlot, nextSlot, parseEvery } from '../packages/mistri/src/server/jobs/jobSchedule.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

test("every reads cron on the timezone's wall clock, through daylight saving", () => {
  const weekdays = parseEvery('0 6 * * 1-5', 'America/New_York');
  // Friday 2026-03-06, 06:00 in New York is 11:00 UTC (EST); after the spring change, Monday 2026-03-09 06:00 is 10:00 UTC (EDT).
  assert.equal(iso(nextSlot(weekdays, at('2026-03-06T10:00:00Z'))), '2026-03-06T11:00:00.000Z');
  assert.equal(iso(nextSlot(weekdays, at('2026-03-06T11:00:00Z'))), '2026-03-09T10:00:00.000Z');
  assert.equal(iso(latestSlot(weekdays, at('2026-03-08T12:00:00Z'))), '2026-03-06T11:00:00.000Z');
  // The words, and cron's either-day rule when both day fields are restricted.
  assert.equal(iso(nextSlot(parseEvery('@hourly'), at('2026-01-01T10:15:00Z'))), '2026-01-01T11:00:00.000Z');
  assert.equal(iso(nextSlot(parseEvery('@monthly'), at('2026-01-15T00:00:00Z'))), '2026-02-01T00:00:00.000Z');
  const either = parseEvery('0 0 13 * 5');
  assert.equal(iso(nextSlot(either, at('2026-02-01T00:00:00Z'))), '2026-02-06T00:00:00.000Z', 'a Friday before the 13th');
  assert.equal(iso(nextSlot(parseEvery('*/15 9-10 * * *'), at('2026-01-01T09:31:00Z'))), '2026-01-01T09:45:00.000Z');
  assert.equal(iso(nextSlot(parseEvery('0 0 * * 7'), at('2026-01-01T00:00:00Z'))), '2026-01-04T00:00:00.000Z', '7 is Sunday too');
  for (const [text, zone, message] of [
    ['6am', 'UTC', /not five cron fields/],
    ['61 * * * *', 'UTC', /outside 0-59/],
    ['* * * * *', 'Mars/Olympus', /not an IANA time zone/],
    ['1-x * * * *', 'UTC', /not a number, a range, a list or a step/],
    ['0 0 30 2 *', 'UTC', /matches no calendar date/],
  ] as const) {
    assert.throws(() => parseEvery(text, zone), message);
  }
  // The key a slot is enqueued under: the job store's pattern, the same in every process.
  assert.match(everySlotKey(at('2026-03-06T11:00:00Z')), /^every-\d{16}$/);
  assert.equal(everySlotKey(at('2026-03-06T11:00:00Z')), everySlotKey(at('2026-03-06T11:00:00Z')));
});

test('annual and leap-day schedules cross more than two months in both directions', () => {
  const annual = parseEvery('0 0 1 1 *');
  assert.equal(iso(nextSlot(annual, at('2026-03-01T00:00:00Z'))), '2027-01-01T00:00:00.000Z');
  assert.equal(iso(latestSlot(annual, at('2026-12-01T00:00:00Z'))), '2026-01-01T00:00:00.000Z');
  const leap = parseEvery('0 0 29 2 *');
  assert.equal(iso(nextSlot(leap, at('2096-03-01T00:00:00Z'))), '2104-02-29T00:00:00.000Z');
});

test('a job at times names a command, a principal and a fixed input, and is refused a schedule or an event', () => {
  assert.throws(
    () => defineJob({ every: '0 6 * * *', timezone: 'Nowhere/City', runAs: 'clock', command: 'close' } as never),
    JobDeclarationError,
  );
  assert.throws(
    () => defineJob({ every: '0 6 * * *', runAs: 'clock', command: 'close', schedule: () => ({}) } as never),
    JobDeclarationError,
  );
  assert.throws(() => defineJob({ every: '0 6 * * *', runAs: 'clock', command: 'close', version: 2 } as never), /unknown option: version/);
  assert.doesNotThrow(() =>
    defineJobs(
      { nightly: defineJob({ every: '0 6 * * 1-5', timezone: 'America/New_York', runAs: 'clock', command: 'close', input: { days: 30 } }) },
      { principals: { clock: { roles: ['automation'] } }, store: { namespace: 'desk' } },
    ),
  );
});

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function serve(args: string[], env: Record<string, string>, started: (child: ChildProcess) => void): Promise<ChildProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...args, '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, MISTRI_OPEN: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started(child);
  let log = '';
  child.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start: ${log}`)), 180_000);
    child.stdout!.on('data', () => {
      if (log.includes('Listening on')) {
        clearTimeout(timer);
        done();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`exited: ${log}`));
    });
  });
  return child;
}

test(
  'two servers over one job store run each slot once; a fresh store runs no slot missed before its first start',
  { timeout: 600_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-every-'));
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null) continue;
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
      rmSync(directory, { recursive: true, force: true });
    });
    const db = join(directory, 'desk.db');
    const raw = new DatabaseSync(db);
    raw.exec('CREATE TABLE tick (id INTEGER PRIMARY KEY, at TEXT NOT NULL)');
    raw.close();
    migrateSqliteCommandJournal(db);
    const dir = join(directory, 'desk');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'desk',
        name: 'Desk',
        sources: { desk: { connection: 'desk', default: true } },
        resources: { tick: { access: 'write' } },
        auth: { providers: ['email'], store: join(directory, 'auth.db'), roles: { automation: { read: true, commands: ['stamp'] } } },
        views: { ticks: { kind: 'list', from: 'tick' } },
        home: 'ticks',
      }),
    );
    writeFileSync(
      join(dir, 'commands.mjs'),
      `import { defineCommand, defineCommands } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({ stamp: defineCommand({ source: 'desk', target: 'tick', targets: 'none',
  async handle({ db, now }) { await db.tick.insert({ at: now().toISOString() }); } }) });
`,
    );
    // Every minute: since the epoch, every one of them is a missed slot.
    writeFileSync(
      join(dir, 'jobs.mjs'),
      `import { defineJob, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({ minutely: defineJob({ every: '* * * * *', runAs: 'clock', command: 'stamp' }) },
  { principals: { clock: { roles: ['automation'] } }, store: { namespace: 'desk' } });
`,
    );
    const commands = (await import(pathToFileURL(join(dir, 'commands.mjs')).href)).default;
    const jobs = (await import(pathToFileURL(join(dir, 'jobs.mjs')).href)).default;
    await provisionStores({ sqlite: db }, { app: { id: 'desk', commands }, jobs });
    const config = join(directory, 'mistri.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: db, writable: true }] }));
    const env = { XDG_CONFIG_HOME: join(directory, 'config'), BETTER_AUTH_SECRET: 'synthetic-every-secret-at-least-thirty-two-characters' };
    const started = Date.now();
    const args = ['--config', config, '--app', dir, '--jobs', join(dir, 'jobs.mjs'), '--host', '127.0.0.1'];
    // Bootstrap the shared auth store once; both job runners then use it concurrently.
    await serve(args, env, (child) => children.push(child));
    await serve(args, env, (child) => children.push(child));

    const check = new DatabaseSync(db, { readOnly: true });
    t.after(() => check.close());
    // Both writers live in child processes and may hold a short commit lock
    // when this independent observer reads. Wait for it without retrying jobs.
    check.exec('PRAGMA busy_timeout = 5000');
    const jobRows = () =>
      check.prepare(`SELECT idempotency_key AS key, state FROM "${JOB_TABLES.job}" ORDER BY idempotency_key`).all() as {
        key: string;
        state: string;
      }[];
    const ticks = () => Number((check.prepare('SELECT count(*) AS n FROM tick').get() as { n: number }).n);
    const deadline = Date.now() + 120_000;
    while (!jobRows().some((row) => row.state === 'succeeded') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 500));
    // Both hosts keep cycling a while longer, each asking to enqueue the slots it sees.
    await new Promise((done) => setTimeout(done, 5_000));
    const rows = jobRows();
    assert.ok(
      rows.some((row) => row.state === 'succeeded'),
      JSON.stringify(rows),
    );
    // One job per slot, whichever process saw it first, and one run of the command per job.
    const slots = rows.map((row) => Number(row.key.slice('every-'.length)));
    assert.equal(new Set(slots).size, slots.length);
    assert.equal(ticks(), rows.filter((row) => row.state === 'succeeded').length);
    // Every minute since the epoch was missed, and a fresh store catches none of them up: only the slots after the start ran
    // (jobs-run.test.ts shows a store with a run catching up the latest).
    const firstSlot = Math.floor(started / 60_000) * 60_000 - 60_000;
    assert.ok(
      slots.every((slot) => slot >= firstSlot && slot <= Date.now()),
      JSON.stringify({ slots, started }),
    );
    assert.ok(slots.length <= Math.ceil((Date.now() - firstSlot) / 60_000) + 1, JSON.stringify(slots));
  },
);
