import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from './support/harness';
import { TMP } from './support/fixtures';

/**
 * @mistriwork/mistri/react as it ships: the BUILT library (dist/embed), in a host's page, started in a real browser.
 *
 * Every other embed spec takes the library from src/embed through Vite (e2e/support/embedReactHost.ts,
 * ladleHost.ts), so none of them ever ran what a host installs. From 0.9.0 to 0.9.8 that was a library that did not
 * start: Base UI's CommonJS helper (use-sync-external-store) was bundled with its `require("react")` intact, and the
 * Provider drew "… could not start. Calling `require` for "react" in an environment that doesn't expose the
 * `require` function." vite.embed.config.ts says why; scripts/bundle-budget.mjs refuses a require() in the build.
 *
 * The host is the Ladle sample's own server (examples/apps/ladle/host/server.ts) as its README runs it, started
 * through e2e/support/ladleBuiltHost.ts: its page imports `@mistriwork/mistri/react` by name, which an install's exports send to
 * mistri's `dist/embed/react/index.js` (the support file asks this checkout's exports for the same), taken in by the
 * host's bundler (Vite) with React from node_modules. The host is its own process on a free port over a freshly
 * seeded database (mkdtemp), so it runs in the parallel lane. `npm run build` (or scripts/test-e2e.mjs, which builds
 * the embed with the client) makes dist/embed first.
 */
const ADMIN = { email: 'admin@example.test', password: 'ladle-fixture-password' };
const BUILT = resolve('packages/mistri/dist/embed/react/index.js');
let origin = '';
let child: ChildProcess | undefined;

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(BUILT))
    throw new Error(`${BUILT} is missing: build @mistriwork/mistri/react first (npx vite build -c vite.embed.config.ts).`);
  const directory = mkdtempSync(join(TMP, 'embed-built-'));
  const db = join(directory, 'ladle.db');
  execFileSync(process.execPath, [resolve('examples/databases/ladle/seed.mjs'), db], { stdio: 'pipe' });
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(process.execPath, ['--import', 'tsx', 'e2e/support/ladleBuiltHost.ts', `${db}.json`, String(port)], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, 'xdg'),
      MISTRI_OPEN: '0',
      BETTER_AUTH_SECRET: 'isolated-embed-built-secret-at-least-thirty-two-characters',
      MISTRI_AUTH_ADMIN_EMAIL: ADMIN.email,
      MISTRI_AUTH_ADMIN_PASSWORD: ADMIN.password,
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
    const timer = setTimeout(() => fail(new Error(`The host did not start: ${log}`)), 60_000);
    started.stdout!.on('data', () => {
      if (log.includes('Ladle Cooking School on')) {
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

test('the built @mistriwork/mistri/react starts in a host’s page and draws the App', async ({ page }) => {
  const library: string[] = [];
  const failed: string[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.includes('/dist/embed/react/')) library.push(path);
    if (response.status() >= 400) failed.push(`${response.status()} ${path}`);
  });
  const logged: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') logged.push(message.text());
  });

  await page.goto(`${origin}/staff`);
  const embed = page.getByRole('region', { name: 'Ladle staff App' });
  // The sign-in door is the shell's: it drew, so the library started (the chunks past the entry included). The
  // Provider's own failure is waited for too, so a library that does not start fails here with its reason.
  await expect(embed.getByLabel('Email').or(embed.getByText(/could not start/))).toBeVisible();
  await expect(embed).not.toContainText('could not start');
  await expect(embed.getByLabel('Email')).toBeVisible();
  await embed.getByLabel('Email').fill(ADMIN.email);
  await embed.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await embed.getByRole('button', { name: 'Sign in' }).click();
  await expect(embed.getByRole('heading', { level: 1, name: 'Classes' })).toBeVisible();
  await expect(embed.getByRole('row').filter({ hasText: 'Sourdough' }).first()).toBeVisible();
  // A Base UI part, which is what reached use-sync-external-store: the App's menu is drawn with it.
  await embed.getByRole('navigation', { name: 'App menu' }).getByRole('button', { name: 'Bookings' }).click();
  await expect(embed.getByRole('heading', { level: 1, name: 'Bookings' })).toBeVisible();

  // What ran was the build, its entry and its chunks, not src/embed.
  expect(library.some((path) => path.endsWith('/dist/embed/react/index.js'))).toBe(true);
  expect(library.some((path) => path.includes('/dist/embed/react/chunks/'))).toBe(true);
  expect(failed).toEqual([]);
  expect(logged.filter((text) => /require|could not start/i.test(text))).toEqual([]);
});
