import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { TMP } from './support/fixtures';

/* The day the Compass database is seeded for, and the instant its server believes it is — spelled here because
   importing a fixture name reads as addressing the shared CRM server (e2e-lanes.mjs). */
const CRM_TODAY = '2026-09-04';
const CRM_CLOCK = `${CRM_TODAY}T16:00:00.000Z`;

/**
 * Compass's Pipeline: the open deals as lanes of the stage machine. A card goes only where one of its stage's verbs
 * leads — dragged, with Alt+→, or from its ⋯ menu's "Move to" — and a lane it may not enter is dimmed while it is
 * dragged, nothing moving as it is. The database is asked what was written.
 *
 * A server of its own over a fresh Compass database (listen(0), mkdtemp), so it runs beside the other parallel specs.
 */
let origin = '';
let db = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(TMP, 'compass-pipeline-'));
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
  const started = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'packages/mistri/src/server/index.ts',
      '--config',
      config,
      '--app',
      'test/fixtures/apps/crm',
      '--port',
      String(port),
    ],
    {
      env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0', MISTRI_CLOCK: CRM_CLOCK },
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
    const timer = setTimeout(() => fail(new Error(`Compass did not start: ${log}`)), 20_000);
    started.stdout!.on('data', () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    });
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`Compass exited: ${log}`));
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

function read<T>(sql: string, ...values: Array<string | number>): T[] {
  const handle = new DatabaseSync(db, { readOnly: true, timeout: 5000 });
  try {
    return handle.prepare(sql).all(...values) as T[];
  } finally {
    handle.close();
  }
}
const stageOf = (id: number) => read<{ stage: string }>('SELECT stage FROM opportunity WHERE id = ?', id)[0]?.stage;
const lane = (page: Page, label: string) =>
  page.locator('.triage-lane').filter({ has: page.locator('.triage-lane-label', { hasText: new RegExp(`^${label}$`) }) });
/** A prospecting deal drawn on the board whose name is its own, so its card is found by its title. */
async function prospect(page: Page, skip = 0) {
  const titles = await lane(page, 'Prospecting').locator('.triage-card-title').allTextContents();
  const own = titles.filter((name) => read<{ id: number }>('SELECT id FROM opportunity WHERE name = ?', name).length === 1);
  const name = own[skip];
  return { name, id: read<{ id: number }>('SELECT id FROM opportunity WHERE name = ?', name)[0].id };
}

test('a card is dragged only into a stage its verbs lead to; the others dim and nothing moves', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/pipeline`);
  await expect(lane(page, 'Prospecting').locator('.triage-card').first()).toBeVisible();
  const deal = await prospect(page);
  const card = page.locator('.triage-card', { hasText: deal.name }).first();
  await expect(card).toBeVisible();
  const negotiation = lane(page, 'Negotiation');
  const qualification = lane(page, 'Qualification');
  const lanesBefore = await page
    .locator('.triage-board > .triage-lane')
    .evaluateAll((all) => all.map((each) => each.getBoundingClientRect().toJSON()).filter((box) => box.width > 0));

  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const shut = (await negotiation.boundingBox())!;
  await page.mouse.move(shut.x + shut.width / 2, shut.y + 60, { steps: 8 });
  await expect(negotiation).toHaveClass(/is-shut/);
  await expect(negotiation).toHaveAttribute('aria-disabled', 'true');
  await expect(qualification).not.toHaveClass(/is-shut/);
  await expect(negotiation).not.toHaveClass(/is-over/);
  // Dimming is colour and cursor only: every lane stands where it stood (the drag's copy carries unsized shells of them).
  expect(
    await page
      .locator('.triage-board > .triage-lane')
      .evaluateAll((all) => all.map((each) => each.getBoundingClientRect().toJSON()).filter((box) => box.width > 0)),
  ).toEqual(lanesBefore);
  const open = (await qualification.boundingBox())!;
  await page.mouse.move(open.x + open.width / 2, open.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => stageOf(deal.id)).toBe('qualification');
  await expect(qualification.locator('.triage-card', { hasText: deal.name })).toBeVisible();
  await expect(page.locator('.triage-lane.is-shut')).toHaveCount(0);
});

test('without a pointer: the ⋯ menu offers only the stages its verbs lead to, and Alt+→ takes the next of them', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/pipeline`);
  await expect(lane(page, 'Prospecting').locator('.triage-card').first()).toBeVisible();
  const deal = await prospect(page, 1);
  const card = page.locator('.triage-card', { hasText: deal.name }).first();
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: `Actions for ${deal.name}` }).click();
  const moves = page.getByRole('group', { name: 'Move to' }).getByRole('menuitem');
  await expect(moves).toHaveText(['Qualification']);
  await page.keyboard.press('Escape');
  await card.locator('.triage-card-open').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => stageOf(deal.id)).toBe('qualification');
  await expect(lane(page, 'Qualification').locator('.triage-card', { hasText: deal.name }).locator('.triage-card-open')).toBeFocused();
});

/* A desk narrower than four lanes at 15rem (a side menu beside a 1280 window, or a 1024 one): the lanes give way
   together rather than push the last one, its sum and any folded strip past the edge behind the fade (G188), and a
   lane's head keeps its name, count, sum and + inside the lane. A phone still swipes one lane at a time. */
test('at a narrow desk every lane and its head stand inside the board, which does not scroll sideways', async ({ page }) => {
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${origin}/pipeline`);
    await expect(lane(page, 'Negotiation').locator('.triage-card').first()).toBeVisible();
    const board = await page.locator('.triage-board').evaluate((element) => {
      const edge = element.getBoundingClientRect().right;
      return {
        scrolls: element.scrollWidth > element.clientWidth,
        past: [...element.querySelectorAll(':scope > .triage-lane')].filter((one) => one.getBoundingClientRect().right > edge).length,
        heads: [...element.querySelectorAll('.triage-lane-head')].filter((head) => head.scrollWidth > head.clientWidth).length,
      };
    });
    expect(board, `${width}`).toEqual({ scrolls: false, past: 0, heads: 0 });
  }
});
