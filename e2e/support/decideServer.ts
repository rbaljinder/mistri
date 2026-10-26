/*
 * A disposable App that decides: incidents whose category a decision answers,
 * served from a fresh SQLite database on its own port, with the operator's
 * scripted provider (MISTRI_DECIDE_SCRIPT) in place of a model — no network.
 * Its sweep runs once before the browser opens, so a record is met with what
 * the decision said of it: one applied, one suggested on an empty field, one
 * suggested beside a person's value.
 */
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { spawn } from './spawned';

const source = (path: string) => JSON.stringify(pathToFileURL(resolve(path)).href);
const ENTRY = 'packages/mistri/src/server/index.ts';

export async function startDecideApp() {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-decide-'));
  let child: ReturnType<typeof spawn> | undefined;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const database = join(directory, 'desk.db');
    const db = new DatabaseSync(database);
    db.exec(`
      CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE incident (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', category TEXT,
        team_id INTEGER REFERENCES team(id));
      INSERT INTO team VALUES (1, 'Network team'), (2, 'Service desk');
      INSERT INTO incident (id, title, status, category) VALUES
        (1, 'VPN down for everyone', 'new', NULL), (2, 'Printer jams on floor 3', 'new', NULL),
        (3, 'Laptop is slow', 'new', 'software'), (4, 'Old ticket', 'closed', NULL);
    `);
    db.close();
    const app = join(directory, 'app');
    mkdirSync(app);
    writeFileSync(
      join(app, 'app.json'),
      JSON.stringify({
        id: 'desk',
        name: 'Desk',
        sources: { desk: { connection: 'desk' } },
        resources: {
          incident: { access: 'write', actions: { categorize: { label: 'Categorize', command: 'categorize' } } },
          team: {},
        },
        auth: {
          providers: ['email'],
          signUp: 'open',
          defaultRole: 'agent',
          store: join(directory, 'sessions.db'),
          roles: { automation: { read: true, commands: ['categorize'] }, agent: { read: true, commands: ['categorize'] } },
        },
        views: { incidents: { kind: 'list', from: 'incident', show: ['title', 'status', 'category'] } },
        home: 'incidents',
      }),
    );
    const commands = join(app, 'commands.mjs');
    writeFileSync(
      commands,
      `import { defineCommand, defineCommands, field } from ${source('packages/mistri/src/server/commands.ts')};
export default defineCommands({
  categorize: defineCommand({ source: 'desk', target: 'incident',
    input: { category: field.choice(['network', 'hardware', 'printer', 'software']) },
    async handle({ db, record }, input) { await db.incident.update(record, { category: input.category }); } }),
});
`,
    );
    const jobs = join(app, 'jobs.mjs');
    writeFileSync(
      jobs,
      `import { defineDecision, defineDecisions, defineJobs } from ${source('packages/mistri/src/server/jobs.ts')};
export default defineJobs({}, {
  principals: { triage: { roles: ['automation'] } },
  decisions: defineDecisions({
    triageCategory: defineDecision({
      question: 'Which category is this incident?', target: 'incident', inputs: ['title'],
      answer: { command: 'categorize', field: 'category' },
      every: '0 0 1 1 *', where: 'status = new', apply: 0.9, runAs: 'triage', provider: 'jev',
    }),
  }),
});
`,
    );
    const script = join(directory, 'script.json');
    writeFileSync(
      script,
      JSON.stringify({
        model: 'jev-1',
        modelVersion: 'jev-1-2026-10',
        decisions: {
          triageCategory: [
            { when: { title: 'VPN' }, answer: 'network', probability: 0.97 },
            { when: { title: 'Printer' }, answer: 'printer', probability: 0.78 },
            { when: { title: 'Laptop' }, answer: 'hardware', probability: 0.88 },
          ],
        },
      }),
    );
    // The model is pinned, as `mistri decide eval --pin` would have: the decision's digest, read from its modules.
    const pin = join(directory, 'pin.mjs');
    writeFileSync(
      pin,
      `import { writeFileSync } from 'node:fs';
import { decisionDigests } from ${source('packages/mistri/src/server/decide/decisionCheck.ts')};
import { decisionLockText, withPin } from ${source('packages/mistri/src/server/decide/decisionLock.ts')};
import { capturedJobModule } from ${source('packages/mistri/src/server/jobs/jobModule.ts')};
const commands = (await import(${JSON.stringify(pathToFileURL(commands).href)})).default;
const module = capturedJobModule((await import(${JSON.stringify(pathToFileURL(jobs).href)})).default);
const digest = decisionDigests(module.decisions.values(), commands).get('triageCategory');
const lock = withPin(new Map([['triageCategory', { version: 1, digest, pins: [] }]]), 'triageCategory', digest,
  { provider: 'jev', modelVersion: 'jev-1-2026-10', error: 0.01, n: 400, at: '2026-10-23' });
writeFileSync(${JSON.stringify(join(app, 'decisions.lock'))}, decisionLockText(lock));
`,
    );
    execFileSync(process.execPath, ['--import', 'tsx', pin], { stdio: 'pipe' });
    const config = join(directory, 'mistri.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: database, writable: true }] }));
    const env = {
      ...process.env,
      DATABASE_URL: '',
      XDG_CONFIG_HOME: join(directory, 'xdg'),
      MISTRI_OPEN: '0',
      MISTRI_DECIDE_SCRIPT: script,
      BETTER_AUTH_SECRET: 'isolated-decide-fixture-secret-at-least-thirty-two-characters',
      MISTRI_AUTH_ADMIN_EMAIL: '',
      MISTRI_AUTH_ADMIN_PASSWORD: '',
    };
    const cli = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], { stdio: 'pipe', env });
    cli(['migrate', 'stores', 'up', '--app', app, '--jobs', jobs, '--config', config]);

    const reservation = createServer();
    await new Promise<void>((done, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', done);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', ENTRY, '--config', config, '--app', app, '--commands', commands, '--jobs', jobs, '--port', String(port)],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const running = child;
    let log = '';
    running.stdout!.on('data', (chunk) => (log += String(chunk)));
    running.stderr!.on('data', (chunk) => (log += String(chunk)));
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`The decide fixture did not start: ${log}`)), 30_000);
      const ready = () => {
        if (!log.includes('Listening on ')) return;
        clearTimeout(timer);
        running.stdout!.off('data', ready);
        done();
      };
      running.stdout!.on('data', ready);
      running.once('exit', () => reject(new Error(`The decide fixture exited: ${log}`)));
      ready();
    });

    // The sweep, once, by hand: each new incident asked about, a run of its own.
    cli(['jobs', 'run', 'decide-triageCategory', '--app', app, '--jobs', jobs, '--commands', commands, '--config', config, '--wait', '30']);
    const decided = () => {
      const read = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
      try {
        return read
          .prepare(`SELECT record_key, outcome, outcome_reason FROM "__mistri_decision_record" ORDER BY record_key`)
          .all() as Array<{
          record_key: string;
          outcome: string;
          outcome_reason: string;
        }>;
      } finally {
        read.close();
      }
    };
    const deadline = Date.now() + 30_000;
    while (!(decided().length === 3 && decided().every((row) => row.outcome_reason !== 'pending'))) {
      if (Date.now() > deadline) throw new Error(`The sweep did not settle: ${JSON.stringify(decided())}\n${log}`);
      await new Promise((done) => setTimeout(done, 200));
    }

    const account = { name: 'Avery Agent', email: 'avery@example.test', password: 'decide-fixture-avery-password' };
    const signed = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(account),
      signal: AbortSignal.timeout(10_000),
    });
    if (!signed.ok) throw new Error(`The decide fixture could not create its account: ${await signed.text()}`);
    return { origin, database, account, decided, stop, log: () => log };
  } catch (error) {
    await stop();
    throw error;
  }
}
