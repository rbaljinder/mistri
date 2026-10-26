import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from './support/harness';
import { TMP } from './support/fixtures';

/* The day the Compass database is seeded for, and the instant its server believes it is (embed-react.spec.ts). */
const CRM_TODAY = '2026-09-04';
const CRM_CLOCK = `${CRM_TODAY}T16:00:00.000Z`;
const SECRET = 'portal-embed-secret-for-the-react-host-at-least-32';

/**
 * The host signs its person in through @mistriwork/mistri/react: the Provider is handed `auth.assertion`, which asks the
 * host's own server for a minute-long statement that this is Rita (e2e/support/embedReactHost.ts mints it as the
 * issuer "portal" the config file trusts), posts it to the App's exchange, and the App is drawn signed in as Rita —
 * on one boot read, which carries the first room's answers, rather than a request for each.
 *
 * The host and the handler share an origin here, as a mounted handler puts them, so the exchange sets the App's
 * session cookie. The host is its own process on a free port over a fresh Compass database (mkdtemp), so it runs
 * beside the other parallel specs.
 */
let origin = '';
let child: ChildProcess | undefined;

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(TMP, 'embed-react-signin-'));
  const db = join(directory, 'crm.db');
  execFileSync(process.execPath, [resolve('test/fixtures/databases/crm/make-crm-db.mjs'), db], {
    stdio: 'pipe',
    env: { ...process.env, MISTRI_CRM_TODAY: CRM_TODAY },
  });
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const config = join(directory, 'crm.json');
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { name: 'crm', url: db, writable: true },
        { name: 'portal', kind: 'embed', issuer: 'https://portal.example', secret: '${PORTAL_EMBED_SECRET}', origins: [origin] },
      ],
    }),
  );
  // Compass as it is, with a door: people are signed in, and a host's person reads everything.
  const authoring = join(directory, 'app');
  mkdirSync(authoring);
  const app = join(authoring, 'app.ts');
  writeFileSync(
    app,
    `import { defineApp } from ${JSON.stringify(pathToFileURL(resolve('packages/mistri/schema/app.mjs')).href)};
import compass from ${JSON.stringify(pathToFileURL(resolve('test/fixtures/apps/crm/app.ts')).href)};
export default defineApp({ ...compass, auth: { providers: ['email'], defaultRole: 'rep', store: ${JSON.stringify(join(directory, 'sessions.db'))},
  roles: { rep: { read: true } } } } as never);
`,
  );
  const started = spawn(process.execPath, ['--import', 'tsx', 'e2e/support/embedReactHost.ts', config, String(port), app], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, 'xdg'),
      MISTRI_OPEN: '0',
      MISTRI_CLOCK: CRM_CLOCK,
      BETTER_AUTH_SECRET: 'isolated-react-embed-secret-at-least-thirty-two-characters',
      PORTAL_EMBED_SECRET: SECRET,
      MISTRI_AUTH_ADMIN_EMAIL: '',
      MISTRI_AUTH_ADMIN_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = started;
  let log = '';
  started.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  started.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`The host did not start: ${log}`)), 30_000);
    started.stdout!.on('data', () => {
      if (log.includes('Host listening')) {
        clearTimeout(timer);
        done();
      }
    });
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`The host exited: ${log}`));
    });
  });
});

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
});

test('the Provider signs the host’s person in, and the App boots signed in on one read', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && (url.pathname.startsWith('/api/tw/') || url.pathname === '/host/assertion')) asked.push(url.pathname);
  });
  await page.addInitScript(() => {
    (window as { __signIn?: boolean }).__signIn = true;
  });

  await page.goto(`${origin}/crm/leads`);
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('row', { name: /Margot Fontaine/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^sign in$/i })).toHaveCount(0);

  // One assertion, one exchange, then one boot: the session is made before the boot, so the boot is signed in.
  const count = (path: string) => asked.filter((seen) => seen === path).length;
  expect(count('/host/assertion')).toBe(1);
  expect(count('/api/tw/api/auth/embed/exchange')).toBe(1);
  expect(count('/api/tw/api/embed/boot')).toBe(1);
  expect(asked.indexOf('/api/tw/api/auth/embed/exchange')).toBeLessThan(asked.indexOf('/api/tw/api/embed/boot'));
  // The boot carried who is here and the App: the shell did not ask for them again.
  expect(count('/api/tw/api/whoami')).toBe(0);
  expect(count('/api/tw/api/app')).toBe(0);

  // The session is the App's cookie, out of the page's script, on the handler's path.
  const session = (await page.context().cookies(`${origin}/api/tw/`)).find((cookie) => cookie.name.endsWith('.session_token'));
  expect(session?.httpOnly).toBe(true);
  expect(session?.path).toBe('/api/tw');
  const who = await page.evaluate(async () => (await fetch('/api/tw/api/whoami?app=compass')).json());
  expect(who.signedIn).toBe(true);
  expect(who.who).toBe('rita@portal.example');
});
