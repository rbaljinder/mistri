import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test as base } from './support/harness';
import { fixture } from './support/fixture';

/**
 * One App, two program instances: the config file's "presentation" gives each its own name, logo and theme with no
 * change to the App's source, and the second is served under a base path, where its logo resolves too.
 *
 * Two servers of their own over one fresh database (listen(0), mkdtemp).
 */
let directory = '';
const children: ChildProcess[] = [];
const origins: Record<string, string> = {};

const mark = (colour: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${colour}"/></svg>`;

async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  return port;
}

async function start(
  name: string,
  config: string,
  appDirectory: string,
  extra: string[],
  environment: Record<string, string> = {},
): Promise<void> {
  const port = await freePort();
  origins[name] = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', appDirectory, '--port', String(port), ...extra],
    {
      cwd: resolve('.'),
      env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0', ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(started);
  let log = '';
  for (const stream of [started.stdout!, started.stderr!]) stream.on('data', (chunk) => (log += String(chunk)));
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`The ${name} instance did not start: ${log}`)), 20_000);
    started.stdout!.on('data', () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    });
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`The ${name} instance exited: ${log}`));
    });
  });
}

const test = base.extend<object, { started: void }>({
  started: fixture(
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'mistri-deployment-'));
      const db = join(directory, 'records.db');
      const source = new DatabaseSync(db);
      try {
        source.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY, holder TEXT NOT NULL);
      INSERT INTO account VALUES (1, 'A. Rivera');`);
      } finally {
        source.close();
      }
      const appDirectory = join(directory, 'app');
      mkdirSync(join(appDirectory, 'logos'), { recursive: true });
      writeFileSync(join(appDirectory, 'logos', 'north.svg'), mark('#1f6f5c'));
      writeFileSync(join(appDirectory, 'logos', 'harbor.svg'), mark('#9a3f2b'));
      writeFileSync(
        join(appDirectory, 'app.json'),
        JSON.stringify({
          id: 'bank',
          name: 'Retail Banking',
          connection: 'ledger',
          resources: { account: {} },
          views: { accounts: { kind: 'list', from: 'account', label: 'Accounts', show: ['holder'] } },
          home: 'accounts',
          nav: ['accounts'],
        }),
      );
      const configOf = (file: string, presentation: unknown) => {
        const path = join(directory, file);
        writeFileSync(path, JSON.stringify({ connections: [{ name: 'ledger', url: db }], presentation: { bank: presentation } }));
        return path;
      };
      /* The same App behind a sign-in: a signed-out visit meets the sign-in screen, which wears the deployment too. */
      const guarded = join(directory, 'guarded');
      mkdirSync(guarded);
      writeFileSync(
        join(guarded, 'app.json'),
        JSON.stringify({
          id: 'bank',
          name: 'Retail Banking',
          connection: 'ledger',
          auth: { providers: ['email'], roles: { reader: { read: true } }, store: join(directory, 'sessions.db') },
          resources: { account: {} },
          views: { accounts: { kind: 'list', from: 'account', label: 'Accounts', show: ['holder'] } },
          home: 'accounts',
          nav: ['accounts'],
        }),
      );
      await start('gate', configOf('gate.json', { name: 'Northside Bank' }), guarded, [], {
        BETTER_AUTH_SECRET: 'deployment-presentation-secret-at-least-thirty-two-characters',
      });
      await start(
        'north',
        configOf('north.json', { name: 'Northside Bank', logo: 'logos/north.svg', theme: 'mono', locale: 'en-AU' }),
        appDirectory,
        [],
      );
      await start('harbor', configOf('harbor.json', { name: 'Harbor Credit Union', logo: 'logos/harbor.svg' }), appDirectory, [
        '--base-path',
        '/portal',
      ]);
    },
    async () => {
      for (const child of children) {
        if (child.exitCode !== null) continue;
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
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

test('the first instance wears its own name, mark and theme at the root', async ({ page }) => {
  await page.goto(`${origins.north}/`);
  await expect(page.locator('#home-button .brand-name')).toHaveText('Northside Bank');
  expect(await page.title()).toContain('Northside Bank');
  const image = page.locator('#home-button .brand-mark img');
  await expect(image).toHaveAttribute('src', /^\/_brand\/north-[0-9a-f]{12}\.svg$|^\/bank\/_brand\/north-[0-9a-f]{12}\.svg$/);
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'mono');
});

test('the second is another program from the same App, its mark served under its base path', async ({ page }) => {
  await page.goto(`${origins.harbor}/portal/`);
  await expect(page.locator('#home-button .brand-name')).toHaveText('Harbor Credit Union');
  expect(await page.title()).toContain('Harbor Credit Union');
  const image = page.locator('#home-button .brand-mark img');
  await expect(image).toHaveAttribute('src', /^\/portal\/(bank\/)?_brand\/harbor-[0-9a-f]{12}\.svg$/);
  const src = (await image.getAttribute('src'))!;
  const served = await page.request.get(`${origins.harbor}${src}`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toContain('image/svg+xml');
});

test('the sign-in screen wears the deployment name, not the App one', async ({ page }) => {
  await page.goto(`${origins.gate}/`);
  await expect(page.getByRole('heading', { name: 'Sign in to Northside Bank', exact: true })).toBeVisible();
  expect(await page.title()).toContain('Northside Bank');
  await expect(page.getByText('Retail Banking')).toHaveCount(0);
});
