import { execFile, spawnSync } from 'node:child_process';
import { spawn } from './support/spawned';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { expect, test } from './support/harness';

/**
 * `mistri shot --text`, run as an agent runs it: the same serve, sign-in
 * path and Chromium as the picture, but each page comes back as a few lines
 * of text — title, headings, a table's columns and row count, the actions —
 * and no file is written. Its own database (mkdtemp) and server (a free port).
 */
let directory = '';
let db = '';

test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-shot-text-'));
  db = join(directory, 'tick.db');
  const seeded = spawnSync(process.execPath, [resolve('examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error(seeded.stderr);
  // The smallest App that has a list: what is held is the command, not a sample's design.
  mkdirSync(join(directory, 'app'));
  writeFileSync(join(directory, 'app', 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(directory, 'app', 'app.ts'),
    "export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: { access: 'write' } }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };\n",
  );
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

function shot(
  args: string[],
  { app = join(directory, 'app'), env = {} }: { app?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), 'shot', '--app', app, '--config', `${db}.json`, ...args],
      { timeout: 150_000, killSignal: 'SIGKILL', env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), ...env } },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`mistri shot ${args.join(' ')} did not exit: ${err}`));
          return;
        }
        done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}

test('--text says what a list page shows, writes no file and is far smaller than a picture', async () => {
  test.setTimeout(180_000);
  const out = join(directory, 'never');
  const ran = await shot(['tasks', '--text', '--out', out]);
  expect(ran.code, ran.err).toBe(0);
  const lines = ran.out.trim().split('\n');
  expect(lines[0]).toMatch(/^\/tasks$/);
  expect(ran.out).toMatch(/^ {2}title: .+/m);
  expect(ran.out).toMatch(/^ {2}table: .+ — \d+ rows?$/m);
  expect(ran.out.length).toBeLessThan(4_000);
  expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
});

test('--text on a missing record says the page, not a failure of the command', async () => {
  test.setTimeout(180_000);
  const ran = await shot(['/tasks/999999', '--text']);
  expect(ran.code, ran.err).toBe(0);
  expect(ran.out).toMatch(/^\/tasks\/999999/);
});

test('--as <email> signs in as an account already there, over a copy of its store, the password never said', async () => {
  test.setTimeout(240_000);
  /* An App with sign-in, and its first start's administrator: the account a person already has, in the store a plain
     start keeps under XDG_CONFIG_HOME. */
  const app = join(directory, 'signed');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.ts'),
    "export default { id: 'signed', name: 'Signed', connection: 'tick', resources: { task: {} }, auth: { roles: { clerk: { read: ['task'] } } }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };\n",
  );
  const email = 'owner@example.test';
  const password = `pw-${Math.random().toString(36).slice(2)}-Aa1!`;
  const port = await new Promise<number>((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
  const store = join(directory, 'config', 'mistri', 'auth', 'signed.db');
  const first = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), '--app', app, '--config', `${db}.json`, '--port', String(port)],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, 'config'),
        BETTER_AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
        MISTRI_AUTH_ADMIN_EMAIL: email,
        MISTRI_AUTH_ADMIN_PASSWORD: password,
      },
    },
  );
  /* What the first start said, for a failure to name: it is the only witness to a start that made no account. */
  let said = '';
  first.stdout?.on('data', (chunk) => (said += chunk));
  first.stderr?.on('data', (chunk) => (said += chunk));
  const sessions = () => {
    // The server is writing this store while the test reads it: wait out its write rather than fail the read.
    const file = new DatabaseSync(store, { readOnly: true, timeout: 5_000 });
    try {
      return {
        people: (file.prepare('SELECT count(*) AS n FROM "user" WHERE email = ?').get(email) as { n: number }).n,
        sessions: (file.prepare('SELECT count(*) AS n FROM session').get() as { n: number }).n,
      };
    } finally {
      file.close();
    }
  };
  try {
    /* The store file is there before its first migration has made the tables: read it as nobody until it has. */
    const people = () => {
      try {
        return existsSync(store) ? sessions().people : 0;
      } catch {
        return 0;
      }
    };
    try {
      await expect.poll(people, { timeout: 60_000 }).toBe(1);
    } catch (error) {
      const how = first.exitCode !== null || first.signalCode !== null ? `exited (${first.exitCode ?? first.signalCode})` : 'still running';
      throw new Error(`the first start made no account in 60 s; it is ${how} and said:\n${said.replaceAll(password, '<password>')}`, {
        cause: error,
      });
    }
  } finally {
    first.kill('SIGTERM');
  }
  const before = sessions();

  const signedIn = await shot(['tasks', '--text', '--as', email], { app, env: { MISTRI_AS_PASSWORD: password } });
  expect(signedIn.code, signedIn.err).toBe(0);
  /* The administrator's page, not the sign-in card a signed-out shot gets: the App's own room, since an App never
     draws the Workbench (appState.js), even for an account its roles give no view. */
  expect(signedIn.out).toMatch(/^ {2}title: Tasks · Signed$/m);
  expect(signedIn.out).not.toMatch(/Sign in/);
  expect(signedIn.out + signedIn.err).not.toContain(password);
  // The run signed in to its copy: the store the account lives in has no session it made.
  expect(sessions()).toEqual(before);

  const wrong = await shot(['tasks', '--text', '--as', email], { app, env: { MISTRI_AS_PASSWORD: `${password}x` } });
  expect(wrong.code).toBe(1);
  expect(wrong.err).toContain(`signing in as "${email}" failed`);
  expect(wrong.out + wrong.err).not.toContain(password);

  const unset = await shot(['tasks', '--text', '--as', email], { app, env: { MISTRI_AS_PASSWORD: '' } });
  expect(unset.code).toBe(1);
  expect(unset.err).toContain('MISTRI_AS_PASSWORD');
  const nobody = await shot(['tasks', '--text', '--as', 'nobody@example.test'], { app, env: { MISTRI_AS_PASSWORD: password } });
  expect(nobody.code).toBe(1);
  expect(nobody.err).toContain('no account with that email');
});
