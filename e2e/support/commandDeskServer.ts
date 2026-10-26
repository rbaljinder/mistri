/*
 * A disposable server over the Command desk fixture
 * (test/fixtures/apps/command-desk): real commands, real authentication, a
 * fresh SQLite database per start. The fixture is the test suite's own so that
 * a public sample's reshape cannot break the browser gate, which is how this
 * module came to exist.
 */
import { execFileSync } from 'node:child_process';
import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const COMMAND_APP_ID = 'command-desk-fixture';

const FIXTURE = resolve('test/fixtures/apps/command-desk');

/** The fixture App under a disposable id and its own session store. */
export async function startCommandApp(options: { rowPolicy?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-desk-'));
  let child: ReturnType<typeof spawn> | undefined;
  const stopProcess = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
  const stop = async () => {
    await stopProcess();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    /* The seed migrates the command journal through `@mistriwork/mistri/commands`,
       which only tsx resolves from source, so it runs as its own process
       rather than as an import — the same way sampleServer seeds Forecourt. */
    const database = join(directory, 'reviews.db');
    execFileSync(process.execPath, ['--import', 'tsx', join(FIXTURE, 'seed.mjs'), database], { stdio: 'pipe' });
    const authoring = join(directory, 'app');
    mkdirSync(authoring);
    const app = join(authoring, 'app.ts');
    /* The fixture App under a disposable id, with open sign-up so this module
       can create its two manager accounts; the App itself is invite-only with
       viewer as the default role. The override spreads the App's auth so its
       role grants survive. */
    writeFileSync(
      app,
      `import app from ${JSON.stringify(pathToFileURL(join(FIXTURE, 'app.ts')).href)};
      export default {...app, id: '${COMMAND_APP_ID}',
        auth: {...app.auth, providers:['email'],signUp:'open',defaultRole:'manager',${options.rowPolicy ? "rows:'policy'," : ''}store:${JSON.stringify(join(directory, 'sessions.db'))}}};`,
    );
    const mapping = join(directory, 'staff.json');
    writeFileSync(mapping, '{}', { mode: 0o600 });
    const policy = join(directory, 'policy.mjs');
    /* The desk a manager belongs to is the only desk whose reviewers they see.
       Everything else is readable: the policy is here to prove the picker and
       the query route obey it, not to model an access system. */
    if (options.rowPolicy)
      writeFileSync(
        policy,
        `
      import { readFileSync } from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      const staff = JSON.parse(readFileSync(${JSON.stringify(mapping)}, 'utf8'));
      export default { appId: '${COMMAND_APP_ID}', resolveRows(principal) {
        const db = new DatabaseSync(${JSON.stringify(database)}, {readOnly:true});
        let manager;
        try { manager = db.prepare("SELECT team_id FROM reviewer WHERE id=? AND active=1 AND role='manager'").get(staff[principal.id] ?? -1); }
        finally { db.close(); }
        return {
          review_team:true, loan_application:true, application_document:true, application_review:true,
          loan_decision:true, assignment_history:true,
          reviewer: manager ? {groups:[[{column:'team_id',op:'=',value:manager.team_id}]]} : false,
        };
      }, resultReferences: {assignReviewer: result => [{table:'reviewer',key:{id:result.reviewerId}}]} };
    `,
      );
    const reservation = createServer();
    await new Promise<void>((done, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', done);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
    const origin = `http://127.0.0.1:${port}`;
    const start = async () => {
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'packages/mistri/src/server/index.ts',
          '--config',
          `${database}.json`,
          '--app',
          app,
          '--commands',
          join(FIXTURE, 'commands.ts'),
          ...(options.rowPolicy ? ['--policy', policy] : []),
          '--port',
          String(port),
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: '',
            XDG_CONFIG_HOME: join(directory, 'xdg'),
            MISTRI_OPEN: '0',
            COMMAND_DESK_STAFF_MAP: mapping,
            BETTER_AUTH_SECRET: 'isolated-command-desk-secret-at-least-thirty-two-characters',
            MISTRI_AUTH_ADMIN_EMAIL: '',
            MISTRI_AUTH_ADMIN_PASSWORD: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const running = child;
      let log = '';
      running.stdout!.on('data', (chunk) => {
        log += String(chunk);
      });
      running.stderr!.on('data', (chunk) => {
        log += String(chunk);
      });
      await new Promise<void>((done, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          running.stdout!.off('data', ready);
          running.off('exit', failed);
          running.off('error', finish);
          if (error) reject(error);
          else done();
        };
        const ready = () => {
          if (log.includes('Listening on ')) finish();
        };
        const failed = () => finish(new Error(`Command desk fixture exited: ${log}`));
        const timer = setTimeout(() => finish(new Error(`Command desk fixture startup timed out: ${log}`)), 20_000);
        running.stdout!.on('data', ready);
        running.once('exit', failed);
        running.once('error', finish);
        ready();
      });
    };
    await start();
    const accounts = [];
    for (const name of ['north-manager', 'central-manager']) {
      const credentials = { name, email: `${name}@example.test`, password: `command-fixture-${name}-password` };
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (!response.ok || typeof result.user?.id !== 'string') throw new Error('Command desk fixture could not create its account.');
      accounts.push({ ...credentials, id: result.user.id as string });
    }
    /* The staff map is read once, at registration: the two accounts can only
       be bound to their desks by restarting the server with the map written. */
    await stopProcess();
    writeFileSync(mapping, JSON.stringify({ [accounts[0].id]: 1, [accounts[1].id]: 2 }));
    await start();
    return { origin, database, accounts, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
