/**
 * `mistri --app <dir> --workers 2` on PostgreSQL, through the real CLI, on databases this run owns: two processes
 * serve one port; a change made in one reaches a live-sync stream held by the other; a session signed out through
 * one is refused at once by the other, which had it kept; a job's runs (a manual run and
 * the slot a store with a run catches up) run once, not once per worker; a worker killed is started again; and a
 * SIGTERM stops every process cleanly. Opt-in like the other live suites (`TABLEWALK_TEST_PG`); SQLite is refused
 * (workers-cli.test.ts), so there is no SQLite twin.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { provisionPostgresLiveChange } from '../packages/mistri/src/adapters/live/postgresLiveChange.js';
import { sessionKey, slotOf } from '../packages/mistri/src/server/cli/workers.js';
import { ROOT, childEnv, cliArgs, freePort, runCli } from './appApiCli.js';
import { liveSkip } from './live.js';
import { LIVE_PG } from './support/jobStoreEngines.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);

async function until(check: () => boolean | Promise<boolean>, what: string, said: () => string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${what} did not happen. The server said:\n${said()}`);
    await delay(50);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  'two workers serve one port on PostgreSQL: live sync crosses them, a job runs once, a dead worker comes back, SIGTERM stops all',
  { timeout: 240_000, skip: liveSkip('postgres', LIVE_PG) },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-workers-pg-'));
    const business = await uuidPostgresDatabase('tw_workers');
    const accounts = await uuidPostgresDatabase('tw_workers_auth');
    const pids: number[] = [];
    t.after(async () => {
      // Only the processes this test started, by the pids it recorded.
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      await business.drop();
      await accounts.drop();
      rmSync(directory, { recursive: true, force: true });
    });

    const control = await pgClient(business.url);
    try {
      await control.query('CREATE TABLE tick (id serial PRIMARY KEY, at text NOT NULL)');
      await control.query("CREATE TABLE job (id serial PRIMARY KEY, title text NOT NULL); INSERT INTO job (title) VALUES ('Tune')");
    } finally {
      await control.end();
    }
    await provisionPostgresLiveChange(business.url);

    const app = join(directory, 'desk');
    mkdirSync(app);
    writeFileSync(
      join(app, 'app.json'),
      JSON.stringify({
        id: 'desk',
        name: 'Desk',
        live: true,
        sources: { desk: { connection: 'desk', default: true } },
        resources: { tick: { access: 'write' }, job: { access: 'write' } },
        auth: {
          providers: ['email'],
          store: accounts.url,
          signUp: 'open',
          defaultRole: 'clerk',
          roles: { clerk: { read: true, write: ['job'] }, automation: { read: true, commands: ['stamp'] } },
        },
        views: { jobs: { kind: 'list', from: 'job' } },
        home: 'jobs',
      }),
    );
    writeFileSync(
      join(app, 'commands.mjs'),
      `import { defineCommand, defineCommands } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({ stamp: defineCommand({ source: 'desk', target: 'tick', targets: 'none',
  async handle({ db, now }) { await db.tick.insert({ at: now().toISOString() }); } }) });
`,
    );
    const jobs = join(app, 'jobs.mjs');
    writeFileSync(
      jobs,
      `import { defineJob, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({ yearly: defineJob({ every: '0 0 1 1 *', runAs: 'clock', command: 'stamp' }) },
  { principals: { clock: { roles: ['automation'] } } });
`,
    );
    const config = join(directory, 'mistri.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: business.url, writable: true }] }));
    const flags = ['--app', app, '--jobs', jobs, '--config', config];
    const env = { XDG_CONFIG_HOME: join(directory, 'config'), DATABASE_URL: '', MISTRI_DIAGNOSTICS: '' };
    const up = await runCli(['migrate', 'stores', 'up', ...flags], childEnv(env));
    assert.equal(up.code, 0, up.out + up.err);
    // With no server, a run now waits in the store; the store then holds a run, so a start catches up January's slot.
    const queued = await runCli(['jobs', 'run', 'yearly', ...flags, '--wait', '1'], childEnv(env));
    assert.equal(queued.code, 2, queued.out + queued.err);

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, cliArgs([...flags, '--host', '127.0.0.1', '--port', String(port), '--workers', '2']), {
      cwd: ROOT,
      /* The session cache on, as it is unless a deployment turns it off: what the sign-out below must reach. The
         sign-up budget is the start's, not each worker's (cli/primaryCounters.ts), and the sign-ups below until two
         sessions land apart can outspend it. */
      env: childEnv({
        ...env,
        MISTRI_PUBLIC_URL: origin,
        MISTRI_AUTH_SESSION_CACHE: '60',
        NODE_ENV: 'test',
        MISTRI_TEST_AUTH_LIMITS: 'off',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pids.push(child.pid!);
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once('exit', (code, signal) => done({ code, signal })),
    );
    let ended = false;
    void exited.then(() => (ended = true));
    // A start that fails says so at once rather than after the longest wait.
    const said = () => output;
    const serving = () => {
      assert.ok(!ended, `the server exited:\n${output}`);
      return /serving with 2 workers: as asked \(pids \d+, \d+\)/.test(output);
    };

    // Both workers serve, each its own process beside the primary.
    await until(serving, 'both workers serving', said, 90_000);
    const [first, second] = /serving with 2 workers: as asked \(pids (\d+), (\d+)\)/.exec(output)!.slice(1).map(Number);
    pids.push(first, second);
    assert.equal(new Set([child.pid, first, second]).size, 3, output);
    assert.match(output, /Listening on http:\/\/(localhost|127\.0\.0\.1):\d+/);

    const call = async (path: string, cookie = '', body?: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        signal: AbortSignal.timeout(15_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        text,
        worker: response.headers.get('x-mistri-worker'),
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
      };
    };

    /* Two accounts whose sessions belong to different workers: the primary sends each session's requests to one
       worker, by the same hash read here. */
    const bySlot = new Map<number, string>();
    for (let n = 0; bySlot.size < 2; n++) {
      assert.ok(n < 24, 'two sessions on different workers');
      const signed = await call('/api/auth/sign-up/email', '', {
        name: `clerk${n}`,
        email: `clerk${n}@example.org`,
        password: 'fixture-password-123',
      });
      assert.equal(signed.status, 200, signed.text + output);
      const slot = slotOf(sessionKey(signed.cookie), 2);
      if (!bySlot.has(slot)) bySlot.set(slot, signed.cookie);
    }
    const reader = bySlot.get(0)!;
    const writer = bySlot.get(1)!;

    // The reader's stream is held by worker 1; the writer's change is made by worker 2, and reaches it.
    const controller = new AbortController();
    t.after(() => controller.abort());
    const stream = await fetch(`${origin}/api/live?app=desk`, { headers: { origin, cookie: reader }, signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('x-mistri-worker'), '1');
    let told = '';
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of stream.body!) told += decoder.decode(chunk as Uint8Array, { stream: true });
      } catch {
        /* aborted */
      }
    })();
    await until(
      () => told.includes('event: hello'),
      'the stream saying hello',
      () => told,
    );
    const update = await call('/api/update?app=desk', writer, { table: 'job', key: { id: 1 }, values: { title: 'Tuned' } });
    assert.equal(update.status, 200, update.text);
    assert.equal(update.worker, '2');
    await until(
      () => /event: change\ndata: .*"job"/.test(told),
      'the change reaching the other worker',
      () => told + output,
    );

    /* A session signed out through one worker is refused at once by the other, though it kept that session for a
       minute (auth/authStoreReads.ts): the sign-out tells every worker. A second session cookie, one the server does
       not read, moves the same session's requests to the other worker. */
    const leaver = await call('/api/auth/sign-up/email', '', {
      name: 'leaver',
      email: 'leaver@example.org',
      password: 'fixture-password-123',
    });
    assert.equal(leaver.status, 200, leaver.text + output);
    const home = slotOf(sessionKey(leaver.cookie), 2);
    let moved = '';
    for (let n = 0; !moved; n++) {
      assert.ok(n < 64, 'a cookie that moves the session');
      const candidate = `${leaver.cookie}; z${n}.session_token=elsewhere`;
      if (slotOf(sessionKey(candidate), 2) !== home) moved = candidate;
    }
    const kept = await call('/api/schema?app=desk', moved);
    assert.equal(kept.status, 200, kept.text);
    assert.equal(kept.worker, String(2 - home));
    assert.equal((await call('/api/schema?app=desk', moved)).status, 200);
    const out = await call('/api/auth/sign-out', leaver.cookie, {});
    assert.equal(out.status, 200, out.text);
    assert.equal(out.worker, String(home + 1));
    const refused = await call('/api/schema?app=desk', moved);
    assert.equal(refused.worker, String(2 - home));
    assert.ok(refused.status === 401 || refused.status === 403, `${refused.status} ${refused.text}`);

    // The manual run and January's slot: each run once, by one of the two runners, never by both.
    const runs = async () => {
      const pg = await pgClient(business.url);
      try {
        const rows = (
          await pg.query(`SELECT idempotency_key AS key, state FROM ${runtimeTable('postgres', JOB_TABLES.job)} WHERE job = 'yearly'`)
        ).rows as { key: string; state: string }[];
        const ticks = Number(((await pg.query('SELECT count(*)::int AS n FROM tick')).rows[0] as { n: number }).n);
        return { rows, ticks };
      } finally {
        await pg.end();
      }
    };
    await until(async () => (await runs()).rows.filter((row) => row.state === 'succeeded').length === 2, 'two runs', said, 90_000);
    await delay(3_000);
    const ran = await runs();
    assert.equal(ran.rows.length, 2, JSON.stringify(ran));
    assert.deepEqual(ran.rows.map((row) => row.key.replace(/^(manual|every)-.*/, '$1')).sort(), ['every', 'manual']);
    assert.equal(ran.ticks, 2, 'each run ran its command once');

    // A worker killed is started again, as a new process, and its sessions are served again.
    process.kill(second, 'SIGKILL');
    await until(() => /worker 2 serves again \(pid \d+\)/.test(output), 'worker 2 restarted', said);
    assert.match(output, new RegExp(`worker 2 \\(pid ${second}\\) was stopped by SIGKILL; starting it again in \\d+ ms`));
    const again = Number(/worker 2 serves again \(pid (\d+)\)/.exec(output)![1]);
    pids.push(again);
    assert.notEqual(again, second);
    const read = await call('/api/schema?app=desk', writer);
    assert.equal(read.worker, '2', read.text);

    // SIGTERM: every process stops, and the primary leaves cleanly.
    controller.abort();
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, output);
    await until(() => !alive(first) && !alive(again), 'the workers stopping', said, 10_000);
  },
);
