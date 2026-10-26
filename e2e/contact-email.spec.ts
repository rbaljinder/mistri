import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { scalar } from './support/db';

/**
 * Mail to an address a record holds (`notify.via` email), end to end: a
 * person marks a contact ready in the list, the server mails the address the
 * record holds through its `log:` transport, the link at the foot of that
 * mail stops the next one, and the second change is held back as opted out.
 *
 * A server of its own over a fresh App directory and database (listen(0),
 * mkdtemp), so it runs beside the other parallel specs. The send loop looks
 * every ten seconds, so each mail is waited for.
 */
const SECRET = 'a-links-secret-for-the-contact-email-browser-spec';
const ADMIN = {
  email: 'admin@desk.example.test',
  password: 'disposable-desk-admin-password',
};
const MESSAGES = '__mistri_integration_message';

let origin = '';
let directory = '';
let db = '';
let log = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-contact-email-browser-'));
  db = join(directory, 'desk.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`
      CREATE TABLE contact (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_ok INTEGER NOT NULL DEFAULT 0);
      INSERT INTO contact VALUES (1, 'Ann Lee', 'open', 'ann@example.test', 1);`);
  } finally {
    source.close();
  }
  const config = join(directory, 'desk.json');
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { name: 'desk', url: db, writable: true },
        {
          name: 'mail',
          kind: 'email',
          url: 'log:',
          from: 'Desk <no-reply@desk.example.test>',
          links: { secret: '${MAIL_LINK_SECRET}' },
        },
      ],
    }),
  );
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'app.ts'),
    `export default {
  id: 'desk',
  name: 'Desk',
  connection: 'desk',
  auth: { providers: ['email'], roles: { admin: { read: true, write: true } } },
  resources: {
    contact: {
      access: 'write',
      notify: [{ on: { changes: 'status' }, when: 'status = ready', title: 'Contact {name} is ready.',
        send: { channel: 'email', to: 'email', consent: 'email_ok' } }],
    },
  },
  views: { contacts: { kind: 'list', from: 'contact', label: 'Contacts', show: ['name', 'status', 'email'], editable: ['status'] } },
  home: 'contacts',
  nav: ['contacts'],
};
`,
  );
  const environment = {
    ...process.env,
    DATABASE_URL: '',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
    MISTRI_OPEN: '0',
    MAIL_LINK_SECRET: SECRET,
    BETTER_AUTH_SECRET: 'disposable-contact-email-browser-secret-at-least-thirty-two-characters',
    MISTRI_AUTH_ADMIN_EMAIL: ADMIN.email,
    MISTRI_AUTH_ADMIN_PASSWORD: ADMIN.password,
  };
  // The notification and integrations stores are provisioned once, with the server stopped, as the docs say.
  execFileSync(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', 'migrate', 'stores', 'up', '--app', app, '--config', config],
    {
      cwd: resolve('.'),
      env: environment,
      stdio: 'pipe',
    },
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', app, '--port', String(port)],
    {
      cwd: resolve('.'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child = started;
  started.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  started.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Desk did not start: ${log}`)), 30_000);
    const ready = () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    };
    started.stdout!.on('data', ready);
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`Desk exited: ${log}`));
    });
  });
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child!.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
  rmSync(directory, { recursive: true, force: true });
});

/** The contact mail the `log:` transport wrote, one JSON line each. */
function mailTo(address: string): Array<{ subject: string; text: string; unsubscribe?: string }> {
  return log
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [
          JSON.parse(line) as {
            to?: unknown;
            subject?: string;
            text?: string;
            unsubscribe?: string;
          },
        ];
      } catch {
        return [];
      }
    })
    .filter((message) => JSON.stringify(message.to ?? '').includes(address) && /is ready/.test(message.subject ?? ''))
    .map((message) => ({
      subject: message.subject!,
      text: message.text ?? '',
      unsubscribe: message.unsubscribe,
    }));
}

async function setStatus(page: Page, status: string) {
  const row = page.getByRole('row').filter({
    has: page.getByRole('gridcell', { name: 'Ann Lee', exact: true }),
  });
  await row.getByRole('button', { name: 'Edit Status' }).click();
  await row.getByRole('textbox', { name: 'Status' }).fill(status);
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast').getByText('Saved Status.')).toBeVisible();
  await expect.poll(() => scalar(db, 'SELECT status FROM contact WHERE id = 1')).toBe(status);
}

test('a contact marked ready is mailed, and the link in that mail stops the next one', async ({ page }) => {
  test.setTimeout(90_000);
  const signedIn = await page.request.post(`${origin}/api/auth/sign-in/email`, {
    headers: { origin },
    data: ADMIN,
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  await page.goto(`${origin}/contacts`);
  await expect(page.getByRole('gridcell', { name: 'Ann Lee', exact: true })).toBeVisible();

  await setStatus(page, 'ready');
  await expect.poll(() => mailTo('ann@example.test').length, { timeout: 30_000 }).toBe(1);
  const [sent] = mailTo('ann@example.test');
  expect(sent.subject).toBe('Contact Ann Lee is ready.');
  expect(sent.text).toContain('You get this because Desk has your address on file for a contact.');
  // The link is this server's, and its token is signed with the secret's value, not the reference to it.
  const link = /To stop these emails: (\S+)/.exec(sent.text)![1];
  expect(link).toBe(sent.unsubscribe);
  const at = new URL(link);
  expect([at.port, at.pathname]).toEqual([new URL(origin).port, '/api/mail/unsubscribe']);
  const [payload, signature] = at.searchParams.get('token')!.split('.');
  expect(signature).toBe(createHmac('sha256', SECRET).update(`mistri.unsubscribe.v1\n${payload}`).digest('base64url'));

  // The link asks first; the button stops the mail.
  await page.goto(`${origin}${at.pathname}${at.search}`);
  await expect(page.getByRole('heading', { name: 'Stop these emails?' })).toBeVisible();
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page.getByRole('heading', { name: 'You are unsubscribed' })).toBeVisible();

  // Marked ready again: queued, then held back as opted out, and nothing more reaches the address.
  await page.goto(`${origin}/contacts`);
  await setStatus(page, 'open');
  await setStatus(page, 'ready');
  await expect
    .poll(() => scalar(db, `SELECT count(*) FROM ${MESSAGES} WHERE state = 'suppressed' AND reason = 'opted_out'`), { timeout: 30_000 })
    .toBe(1);
  expect(mailTo('ann@example.test')).toHaveLength(1);
});
