import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';

/* The Workbench pager steps by key (pageStep.ts): Next asks for the rows
   after the last one on screen, Previous for those before the first, Last
   for the list's end; the page box asks by offset. What it asked is read off
   the requests, and what it drew off the grid. */
test.describe('the pager steps by key', () => {
  let directory = '',
    origin = '',
    child: ChildProcess | undefined;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    directory = mkdtempSync(join(tmpdir(), 'tablewalk-keyset-pager-'));
    const file = join(directory, 'ledger.db'),
      db = new DatabaseSync(file);
    db.exec(`CREATE TABLE entry (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, memo TEXT NOT NULL);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 95)
      INSERT INTO entry SELECT i, (i * 7) % 13, 'entry ' || i FROM n;`);
    db.close();
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', file, '--port', String(port)], {
      env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), TABLEWALK_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout!.on('data', (chunk) => {
      log += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      log += String(chunk);
    });
    const deadline = Date.now() + 15_000;
    while (!log.includes('Listening on ')) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`the server did not start: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  test.afterAll(async () => {
    child?.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
  });

  test('Next, Previous and Last read by key and draw the pages an offset would', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
    const asked: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/run') && request.method() === 'POST') asked.push(JSON.parse(request.postData() ?? '{}'));
    });
    await page.goto(origin);
    await page.getByRole('combobox', { name: 'Query' }).fill('entry sort amount');
    await page.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByText('rows 1–20 of 95')).toBeVisible();
    const memos = () =>
      page
        .locator('tbody tr[data-row-key] td')
        .filter({ hasText: /^entry \d+$/ })
        .allInnerTexts();
    const first = await memos();

    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('rows 21–40 of 95')).toBeVisible();
    expect(asked.at(-1)).toMatchObject({ offset: 20, after: { amount: expect.any(Number), id: expect.any(Number) } });
    const second = await memos();
    expect(second).not.toEqual(first);

    await page.getByRole('button', { name: 'Last page' }).click();
    await expect(page.getByText('rows 81–95 of 95')).toBeVisible();
    expect(asked.at(-1)).toMatchObject({ offset: 80, limit: 15, end: true });

    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.getByText('rows 61–80 of 95')).toBeVisible();
    expect(asked.at(-1)).toMatchObject({ offset: 60, before: { amount: expect.any(Number), id: expect.any(Number) } });

    // A page named by number is read by offset, and is the same page the steps reached.
    const box = page.getByRole('spinbutton', { name: 'Page number' });
    await box.fill('2');
    await expect(page.getByText('rows 21–40 of 95')).toBeVisible();
    const last = asked.at(-1)!;
    expect(last.offset).toBe(20);
    expect(last.after ?? last.before ?? last.end).toBeUndefined();
    expect(await memos()).toEqual(second);
  });
});
