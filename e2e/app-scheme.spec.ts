import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { expect, test } from './support/harness';

/**
 * An App whose theme says it is dark is sent dark. A first visit used to paint light and flip once the client had
 * learnt the theme (a round trip later), a flash on the very first paint; the server now says the scheme in the page
 * and the boot script stamps it before any style is read. A reader's stored mode still wins where there is a light to
 * prefer: `dark` is only the mode a reader gets until they pick one, `dark-only` has none.
 *
 * A server of its own per theme over a fresh database (listen(0), mkdtemp).
 */
const servers: Record<'night' | 'dusk', { origin: string; child?: ChildProcess; directory: string }> = {
  night: { origin: '', directory: '' },
  dusk: { origin: '', directory: '' },
};

const SCHEME = { night: 'dark-only', dusk: 'dark' } as const;

async function start(name: 'night' | 'dusk') {
  const directory = mkdtempSync(join(tmpdir(), `tablewalk-scheme-${name}-`));
  const db = join(directory, 'yard.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO job VALUES (1, 'Job 1');`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'yard', url: db, writable: true }] }));
  const app = join(directory, 'app');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  mkdirSync(join(app, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(resolve('.'), 'packages', 'mistri'), join(app, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  const light = { ground: '#f6f5f2', surface: '#ffffff', ink: '#16120e', accent: '#1d4ed8' };
  const dark = { ground: '#101114', surface: '#17181c', ink: '#f2f2f2', accent: '#8fb4ff' };
  writeFileSync(
    join(app, 'app.ts'),
    `import { defineApp, defineTheme, listView } from '@mistriwork/mistri/app';
const look = defineTheme({
  id: ${JSON.stringify(name)},
  label: 'Look',
  extends: 'lumen',
  scheme: ${JSON.stringify(SCHEME[name])},
  colors: ${name === 'night' ? `{ dark: ${JSON.stringify(dark)} }` : `{ light: ${JSON.stringify(light)}, dark: ${JSON.stringify(dark)} }`},
});
export default defineApp({
  id: 'yard',
  name: 'Yard',
  connection: 'yard',
  resources: { job: { access: 'write' } },
  views: { jobs: listView('Jobs', 'job') },
  home: 'jobs',
  ui: { customThemes: [look], theme: { preset: ${JSON.stringify(name)} } },
});
`,
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', app, '--port', String(port)],
    {
      cwd: resolve('.'),
      env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout!.on('data', (chunk) => (log += String(chunk)));
  child.stderr!.on('data', (chunk) => (log += String(chunk)));
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`The fixture did not start: ${log}`)), 30_000);
    child.stdout!.on('data', () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`The fixture exited: ${log}`));
    });
  });
  servers[name] = { origin: `http://127.0.0.1:${port}`, child, directory };
}

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  await Promise.all([start('night'), start('dusk')]);
});

test.afterAll(async () => {
  for (const { child, directory } of Object.values(servers)) {
    if (child && child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

/** What the page is before any of the client's script has run: its scripts are refused, the inline boot script is not. */
async function beforeTheClient(page: Page, origin: string, stored?: string) {
  await page.route('**/*', (route) => (route.request().resourceType() === 'script' ? route.abort() : route.continue()));
  if (stored) await page.addInitScript((mode) => localStorage.setItem('mistri.theme', mode), stored);
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? null,
    colorScheme: document.documentElement.style.colorScheme,
    ground: document.documentElement.style.getPropertyValue('--startup-ground'),
  }));
}

for (const name of ['night', 'dusk'] as const) {
  test(`${SCHEME[name]}: the first page is sent dark, before any client script`, async ({ page }) => {
    const html = await (await page.request.get(`${servers[name].origin}/`)).text();
    expect(html).toContain(`<meta name="mistri-scheme" content="${SCHEME[name]}">`);
    const first = await beforeTheClient(page, servers[name].origin);
    expect(first.theme).toBe('dark');
    expect(first.colorScheme).toBe('dark');
    // The startup outline is dark too: the colors of the page the reader is about to be given.
    expect(first.ground).toBe('#191b1d');
  });
}

test('dark: a reader who has picked light (or the system) still gets it; dark-only has no light to pick', async ({ browser }) => {
  for (const [name, mode, expected] of [
    ['dusk', 'light', 'light'],
    ['dusk', 'system', null],
    ['night', 'light', 'dark'],
    ['night', 'system', 'dark'],
  ] as const) {
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    const seen = await beforeTheClient(page, servers[name].origin, mode);
    expect(seen.theme, `${name} with ${mode} stored`).toBe(expected);
    await context.close();
  }
});

test('the client keeps what the server stamped: a dark-only first visit stays dark once the App has drawn', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${servers.night.origin}/`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting', { timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
