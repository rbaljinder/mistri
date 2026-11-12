import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { expect, test as base } from './support/harness';
import { fixture } from './support/fixture';
import { scalar } from './support/db';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';

/**
 * A capability link opened the way its holder opens one: from a page on
 * another site — a mail reader, a chat — with no session of the App's. The
 * token's GET sets the link's cookie and sends the browser on to the link's
 * own address; SameSite=Lax is what lets that cookie ride the cross-site
 * navigation, and the link page draws the record's shown columns and runs
 * its declared command with the session in a header.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let db = '';
let directory = '';
let child: ChildProcess | undefined;
let linkUrl = '';

/* A page on another site, answered by the browser itself: nothing of it reaches the App's server. */
const ELSEWHERE = 'https://mail.example.test/inbox';

const test = base.extend<object, { started: void }>({
  started: fixture(
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'mistri-capability-links-'));
      db = join(directory, 'intake.db');
      const source = new DatabaseSync(db);
      try {
        source.exec(`
      CREATE TABLE application (id INTEGER PRIMARY KEY, applicant TEXT NOT NULL, status TEXT NOT NULL, note TEXT);
      INSERT INTO application VALUES (1, 'Ada Byron', 'submitted', 'kept to the office'), (2, 'Bea Lin', 'submitted', NULL);`);
      } finally {
        source.close();
      }
      migrateSqliteCommandJournal(db);
      const config = join(directory, 'connections.json');
      writeFileSync(config, JSON.stringify({ connections: [{ name: 'intake-db', url: db, writable: true }] }));
      const appDirectory = join(directory, 'app');
      mkdirSync(appDirectory);
      writeFileSync(
        join(appDirectory, 'app.json'),
        JSON.stringify({
          id: 'intake',
          name: 'Intake',
          sources: { main: { connection: 'intake-db', default: true } },
          resources: {
            application: {
              access: 'write',
              actions: { invite: { label: 'Invite', command: 'invite' } },
              links: { status: { show: ['applicant', 'status'], says: { status: { submitted: 'Received' } }, commands: ['withdraw'] } },
            },
          },
          auth: {
            providers: ['email'],
            signUp: 'open',
            defaultRole: 'clerk',
            store: join(directory, 'sessions.db'),
            roles: { clerk: { read: true, commands: ['invite'] } },
          },
          views: { applications: { kind: 'list', from: 'application' } },
          home: 'applications',
          nav: ['applications'],
        }),
      );
      // .mts: no package.json above a temporary folder says it holds ES modules.
      const commands = join(directory, 'commands.mts');
      const entry = JSON.stringify(pathToFileURL(resolve('packages/mistri/src/server/commands.ts')).href);
      writeFileSync(
        commands,
        `import { defineCommand, defineCommands, shape, text } from ${entry};
        export default defineCommands({
          invite: defineCommand({ source: 'main', target: 'application', output: shape({ link: text() }),
            async handle({ link }) { return { link: await link('status') }; } }),
          withdraw: defineCommand({ source: 'main', target: 'application', input: { reason: { type: 'text', optional: true } },
            async handle({ tx, record }, input) {
              await tx.update({ table: 'application', key: { id: Number(record.id) }, values: { status: 'withdrawn', note: input.reason ?? null } });
            } }),
        });`,
      );
      const reservation = createServer();
      await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((done) => reservation.close(() => done()));
      origin = `http://127.0.0.1:${port}`;
      const started = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'packages/mistri/src/server/index.ts',
          '--config',
          config,
          '--app',
          appDirectory,
          '--commands',
          commands,
          '--port',
          String(port),
        ],
        {
          cwd: resolve('.'),
          env: {
            ...process.env,
            DATABASE_URL: '',
            XDG_CONFIG_HOME: join(directory, 'xdg'),
            MISTRI_OPEN: '0',
            BETTER_AUTH_SECRET: 'isolated-capability-links-secret-at-least-thirty-two',
            // A link's MAC is keyed by the form key: without one the App refuses to start.
            MISTRI_FORM_KEY: 'isolated-capability-links-form-key-at-least-thirty-two',
            MISTRI_AUTH_ADMIN_EMAIL: '',
            MISTRI_AUTH_ADMIN_PASSWORD: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child = started;
      let log = '';
      started.stdout!.on('data', (chunk) => {
        log += String(chunk);
      });
      started.stderr!.on('data', (chunk) => {
        log += String(chunk);
      });
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`The fixture did not start: ${log}`)), 20_000);
        const ready = () => {
          if (log.includes('Listening on ')) {
            clearTimeout(timer);
            done();
          }
        };
        started.stdout!.on('data', ready);
        started.once('exit', () => {
          clearTimeout(timer);
          fail(new Error(`The fixture exited: ${log}`));
        });
        ready();
      });
      /* A clerk signs up and mints the link through the command API: the minting answer is the one place,
         besides an effect's delivery, that says the URL. */
      const signedUp = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Clerk', email: 'clerk@example.test', password: 'capability-links-clerk-password' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!signedUp.ok) throw new Error(`The clerk could not sign up: ${signedUp.status}`);
      const cookie = signedUp.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const headers = { origin, cookie, 'content-type': 'application/json' };
      const prepared = await fetch(`${origin}/api/commands/prepare?app=intake`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: 'invite', commandVersion: 1, key: { id: 1 } }),
        signal: AbortSignal.timeout(10_000),
      });
      const preparation = (await prepared.json()) as { expectedVersion?: unknown };
      if (!prepared.ok) throw new Error(`The invite did not prepare: ${prepared.status} ${JSON.stringify(preparation)}`);
      const executed = await fetch(`${origin}/api/commands/execute?app=intake`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'invite',
          commandVersion: 1,
          key: { id: 1 },
          expectedVersion: preparation.expectedVersion,
          idempotencyKey: 'capability-link-invite-1',
          input: {},
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const answer = await executed.text();
      if (!executed.ok) throw new Error(`The invite did not run: ${executed.status} ${answer}`);
      linkUrl = /http:\/\/[^"]+\/l\/mstl1\.[A-Za-z0-9_.-]+/.exec(answer)?.[0] ?? '';
      if (!linkUrl) throw new Error(`The minting answer said no link: ${answer}`);
    },
    async () => {
      if (child && child.exitCode === null) {
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
    },
  ),
});

test('a link opened from another site lands on its record through the Lax cookie, and runs its declared command', async ({ page }) => {
  await page.route(ELSEWHERE, (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Inbox</title><a href="${linkUrl}">Check your application</a>` }),
  );
  await page.goto(ELSEWHERE);
  // The App's address as the server says it (its own name for itself, which need not be the address this spec dialed).
  const app = new URL(linkUrl).origin;
  const landed = page.waitForURL(new RegExp(`^${app}/l/[A-Za-z0-9_-]{22}$`));
  await page.getByRole('link', { name: 'Check your application' }).click();
  await landed;
  // The token is gone from the address bar; the record is drawn in its shown columns and its says, and nothing else.
  expect(page.url()).not.toContain('mstl1.');
  await expect(page.locator('dd')).toHaveText(['Ada Byron', 'Received']);
  await expect(page.locator('main')).not.toContainText('kept to the office');
  // The cookie's path is the link door's own, so it is asked of the page's address rather than the origin's root.
  const link = (await page.context().cookies(page.url())).find((cookie) => cookie.name.startsWith('mstl_'));
  expect(link?.sameSite).toBe('Lax');
  expect(link?.httpOnly).toBe(true);

  const form = page.locator('form[data-command="withdraw"]');
  await form.getByLabel('Reason').fill('Found another bank');
  await form.getByRole('button').click();
  await expect(form.locator('[data-say]')).toHaveText('Done.');
  await expect.poll(() => scalar(db, 'SELECT status FROM application WHERE id = 1')).toBe('withdrawn');
  expect(scalar(db, 'SELECT note FROM application WHERE id = 1')).toBe('Found another bank');
  // The other record was not touched.
  expect(scalar(db, 'SELECT status FROM application WHERE id = 2')).toBe('submitted');
});
