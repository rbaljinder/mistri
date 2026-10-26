import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { TMP } from './support/fixtures';

/**
 * Ladle, the general-path sample (examples/apps/ladle): a cooking school's own React site, served by its own Node
 * server, with the staff App embedded under /staff through @mistriwork/mistri/react and the school's own JSON route beside the
 * handler. Walked as a visitor and then a member of staff: the public schedule (the host's route, drawn by the host),
 * the staff desk inside the site's header, sign-in, and a guest checked in on the free-form check-in page.
 *
 * The host is its own process on a free port over a freshly seeded database (mkdtemp), so it runs beside the other
 * parallel specs. Its page takes @mistriwork/mistri/react from source (e2e/support/ladleHost.ts), so nothing is built first.
 */
const ADMIN = { email: 'admin@example.test', password: 'ladle-fixture-password' };
let origin = '';
let db = '';
let child: ChildProcess | undefined;

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(TMP, 'ladle-'));
  db = join(directory, 'ladle.db');
  // The schedule is counted from today, so tonight's class is tonight whenever this runs.
  execFileSync(process.execPath, [resolve('examples/databases/ladle/seed.mjs'), db], { stdio: 'pipe' });
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(process.execPath, ['--import', 'tsx', 'e2e/support/ladleHost.ts', `${db}.json`, String(port)], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, 'xdg'),
      MISTRI_OPEN: '0',
      BETTER_AUTH_SECRET: 'isolated-ladle-secret-at-least-thirty-two-characters',
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

const bookingStatus = (guest: string) => {
  const handle = new DatabaseSync(db, { readOnly: true, timeout: 5000 });
  try {
    return (handle.prepare('SELECT status FROM booking WHERE guest_name = ?').get(guest) as { status: string }).status;
  } finally {
    handle.close();
  }
};

test('the school’s site, its own schedule route, and the staff App embedded under its header', async ({ page }) => {
  // The public side is the host's alone: its page, its JSON, and no request of tablewalk's.
  const tablewalk: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) tablewalk.push(url.pathname);
  });
  await page.goto(`${origin}/`);
  const header = page.locator('header.site-header');
  await expect(header.getByRole('link', { name: 'Ladle Cooking School' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Cook something new this week' })).toBeVisible();
  const schedule = page.getByRole('list', { name: 'Upcoming classes' });
  await expect(schedule.getByRole('heading', { name: 'Dumplings from scratch' })).toBeVisible();
  // Sourdough has 8 seats and parties of 1, 2 and 4: one left, as the host's own query counts them.
  await expect(schedule.getByRole('listitem').filter({ hasText: 'Sourdough' })).toContainText('1 seat left');
  await expect(schedule.getByRole('listitem').filter({ hasText: 'Sourdough' })).toContainText('$95');
  expect(tablewalk).toEqual([]);

  // The staff desk: the site's header stays, and the App draws inside the frame below it.
  await header.getByRole('link', { name: 'Staff desk' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/staff/);
  const embed = page.getByRole('region', { name: 'Ladle staff App' });
  await embed.getByLabel('Email').fill(ADMIN.email);
  await embed.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await embed.getByRole('button', { name: 'Sign in' }).click();
  await expect(embed.getByRole('heading', { level: 1, name: 'Classes' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Staff desk' })).toHaveAttribute('aria-current', 'page');
  // The boundary: the header is the host's, outside tablewalk's root; the App's heading is inside it.
  expect(await header.evaluate((node) => node.closest('.tw-root') === null)).toBe(true);
  expect(await embed.getByRole('heading', { level: 1, name: 'Classes' }).evaluate((node) => node.closest('.tw-root') !== null)).toBe(true);
  // The host's type does not reach the App's heading: the site's serif is on the host's headings alone.
  expect(await embed.getByRole('heading', { level: 1, name: 'Classes' }).evaluate((node) => getComputedStyle(node).fontFamily)).not.toMatch(
    /Georgia/,
  );

  // The free-form page: tonight's class, a guest checked in, the blocks beside the page's own list.
  await embed.getByRole('navigation', { name: 'App menu' }).getByRole('button', { name: 'Check-in' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/staff/check-in');
  await embed.getByRole('button', { name: /^Fresh pasta by hand/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('class')).toBe('2');
  await expect(embed.getByRole('button', { name: 'Still expected: 8' })).toBeVisible();
  await embed.getByRole('button', { name: 'Check in Morgan Lee' }).click();
  await expect(embed.getByText('Morgan Lee is checked in.')).toBeVisible();
  await expect.poll(() => bookingStatus('Morgan Lee')).toBe('checked_in');
  await expect(embed.getByRole('button', { name: 'Check in Morgan Lee' })).toHaveCount(0);
  // The platform's blocks on the same page read the same rows: the metrics move, and the arrival is listed.
  await expect(embed.getByRole('button', { name: 'Arrived: 2' })).toBeVisible();
  await expect(embed.getByRole('button', { name: 'Still expected: 6' })).toBeVisible();
  await expect(embed.getByRole('row', { name: /Morgan Lee/ })).toBeVisible();
});
