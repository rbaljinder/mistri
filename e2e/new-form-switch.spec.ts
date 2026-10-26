import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';

/**
 * A flag answered either way (`paid boolean not null default false`) is a
 * switch in an App's default New form, and a switch is a track, not a field:
 * the looks' field rule (a field's height and corners) once reached its
 * input and squashed the track into a rounded square.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-new-form-switch-'));
  const db = join(directory, 'billing.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`
      CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE invoice (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer (id),
        total NUMERIC NOT NULL, paid BOOLEAN NOT NULL DEFAULT false);
      INSERT INTO customer VALUES (1, 'Acme');`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'billing', url: db, writable: true }] }));
  const appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  writeFileSync(
    join(appDirectory, 'app.json'),
    JSON.stringify({
      id: 'billing',
      name: 'Billing',
      connection: 'billing',
      resources: { customer: { access: 'write' }, invoice: { access: 'write' } },
      views: { invoices: { kind: 'list', from: 'invoice', label: 'Invoices', show: ['customer_id', 'total', 'paid'] } },
      home: 'invoices',
      nav: ['invoices'],
    }),
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', appDirectory, '--port', String(port)],
    {
      cwd: resolve('.'),
      env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
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
  });
});

test.afterAll(async () => {
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
  rmSync(directory, { recursive: true, force: true });
});

test("a flag in an App's default New form is a switch's track, not a field's box", async ({ page }) => {
  await page.goto(`${origin}/invoices/new`);
  const flag = page.getByRole('switch', { name: /Paid/i });
  await expect(flag).toBeVisible();
  await expect(flag).not.toBeChecked();
  const track = await flag.evaluate((input) => {
    const style = getComputedStyle(input);
    return { width: input.offsetWidth, height: input.offsetHeight, radius: style.borderTopLeftRadius };
  });
  // features.css draws it 34 by 20 with round ends; a field's 36px height made it taller than wide.
  expect(track.width).toBeGreaterThan(track.height * 1.5);
  expect(track.height).toBeLessThanOrEqual(22);
  expect(track.radius).toBe('999px');
  await flag.click();
  await expect(flag).toBeChecked();
  await expect(page.locator('.insert-switch')).toContainText('Yes');
});
