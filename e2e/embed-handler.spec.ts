import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { TMP } from './support/fixtures';

/* The day the Compass database is seeded for, and the instant its server believes it is — spelled here because
   importing a fixture name reads as addressing the shared CRM server (e2e-lanes.mjs). */
const CRM_TODAY = '2026-09-04';
const CRM_CLOCK = `${CRM_TODAY}T16:00:00.000Z`;

/**
 * Compass mounted in a host's own server under `/crm` (@mistriwork/mistri/handler), walked in a browser: the host's page
 * links into the App, a list opens a record, and the record's verb writes to the database. Every request the page
 * makes is under the mount — the host never sees one meant for tablewalk.
 *
 * The host is its own process on a free port over a fresh Compass database (mkdtemp), so it runs beside the other
 * parallel specs.
 */
let origin = '';
let db = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(TMP, 'embed-handler-'));
  db = join(directory, 'crm.db');
  execFileSync(process.execPath, [resolve('test/fixtures/databases/crm/make-crm-db.mjs'), db], {
    stdio: 'pipe',
    env: { ...process.env, MISTRI_CRM_TODAY: CRM_TODAY },
  });
  const config = join(directory, 'crm.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'crm', url: db, writable: true }] }));
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(process.execPath, ['--import', 'tsx', 'e2e/support/embedHost.ts', config, String(port)], {
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0', MISTRI_CLOCK: CRM_CLOCK },
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

const statusOf = (id: number) => {
  const handle = new DatabaseSync(db, { readOnly: true, timeout: 5000 });
  try {
    return (handle.prepare('SELECT status FROM lead WHERE id = ?').get(id) as { status: string }).status;
  } finally {
    handle.close();
  }
};

test('a mounted App is walked from the host’s page: list, record, and a verb that writes', async ({ page }) => {
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname !== '/' && !url.pathname.startsWith('/crm')) outside.push(url.pathname);
  });

  await page.goto(`${origin}/`);
  await page.getByRole('link', { name: 'Leads' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Leads');
  expect(new URL(page.url()).pathname).toBe('/crm/leads');

  // The first tab, New, is where the list opens, newest first: Margot Fontaine (127) heads it.
  await expect(page.getByRole('tab', { name: /^New/ })).toHaveAttribute('aria-selected', 'true');
  await page
    .getByRole('row', { name: /Margot Fontaine/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Margot Fontaine');
  // The record's own address, said under the mount.
  await expect.poll(() => new URL(page.url()).pathname).toBe('/crm/leads/127');

  await page.getByRole('button', { name: 'Start working', exact: true }).first().click();
  await expect.poll(() => statusOf(127)).toBe('working');
  await expect(page.getByRole('button', { name: 'Start working', exact: true })).toHaveCount(0);

  // A reload of the record's address is the host handing it over again.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Margot Fontaine');
  expect(outside).toEqual([]);
});
