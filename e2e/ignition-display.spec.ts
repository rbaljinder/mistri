/**
 * What a tenant App says, on the sample that is one: its records by their
 * names, never their opaque composite keys, its tabs by their names, the
 * counts it declares as rollups — each read in the reader's own context —
 * and a phone's bar in one row.
 *
 * Every reference asserted here is also a leg of a composite key that keeps
 * it inside its dealership (`(tenant_id, vehicle_id)`), which is exactly what
 * used to make the page draw `north-motors:vehicle:0001` instead of a name.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from './support/harness';
import { DEALERS, IGNITION_SKIP, startIgnition, type IgnitionFixture } from './support/ignitionServer';
import { enter, LENDER, openRoom, openRow } from './support/ignitionSession';

/**
 * Every opaque tenant key on the page: `north-motors:vehicle:0001`. A QR code's text is not one: the vehicle's `id` is
 * declared `format: 'qr'`, a code to scan with its value said under it on purpose.
 */
const keysOnPage = async (page: Page) => {
  const said = await page.evaluate(() => {
    const clone = document.querySelector('#content')!.cloneNode(true) as HTMLElement;
    for (const code of clone.querySelectorAll('.qr-value-text')) code.remove();
    return clone.textContent ?? '';
  });
  return said.match(/\b[a-z]+(?:-[a-z]+)*:[a-z_]+:\d+/g) ?? [];
};

test.describe('Ignition says names', () => {
  test.skip(IGNITION_SKIP !== false, String(IGNITION_SKIP));
  test.setTimeout(120_000);
  let app: IgnitionFixture;
  test.beforeAll(async () => {
    // Two databases seeded and a server started: the setting above times the tests, not this hook (Playwright).
    test.setTimeout(120_000);
    app = await startIgnition();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test("a dealership's vehicle counts its own applications, and a document is named in words", async ({ page }) => {
    await enter(page, app, app.account('dealer_admin', DEALERS.north).email, DEALERS.north);
    await openRoom(page, 'vehicle');
    await openRow(page, 'DEMO-STOCK-1001');
    // The rollup, counted in this dealership's context, agrees with the list of the same rows beside it.
    const rows = page.locator('.page-section tbody tr');
    await expect(rows.first()).toBeVisible();
    const said = async () => Number(/(\d+)\s+applications?\b/.exec(await page.locator('.page-head-facts').innerText())?.[1] ?? -1);
    await expect.poll(said).toBeGreaterThan(0);
    await expect(rows).toHaveCount(await said());
    expect(await keysOnPage(page)).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'the bar is one row within the phone').toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1280, height: 900 });
    /* Back at a desk the phone's Menu can still be on screen for a moment, and openRoom would take the desk for a
       phone whose Menu then goes away: wait for the sidebar the desk draws. */
    await expect(page.locator('.sidebar')).toBeVisible();
    await openRoom(page, 'loan_application');
    await openRow(page, 'AL-1001');
    await page.setViewportSize({ width: 390, height: 844 });
    // On a phone the documents are cards, titled by their names: the category's word, not its stored code.
    await expect(page.locator('.record-summaries').getByText('Identity', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('identity', { exact: true })).toHaveCount(0);
  });

  test('the lender names each dealership, calls a tab by its name, and a card does not repeat the heading', async ({ page }) => {
    await enter(page, app, app.account('manager').email, LENDER);
    await openRoom(page, 'loan_application');
    await page.getByRole('tab', { name: /^Decided/ }).click();
    await expect(page.locator('#content tbody')).toContainText('Demo Harbor Auto');
    await openRow(page, 'AL-1006');
    await expect(page.locator('nav.crumbs')).toContainText('Applications · Decided');
    await expect(page.locator('.page-head-facts')).toContainText('Demo Harbor Auto');
    // The review file is named by this application's reference: the card says its facts, not "AL-1006" again.
    const card = page.locator('.page-current');
    await expect(card).toContainText('North review desk');
    await expect(card).not.toContainText('AL-1006');
    await expect(card.getByRole('button', { name: 'View review file' })).toBeVisible();
    expect(await keysOnPage(page)).toEqual([]);

    // Each dealership's applications in flight, counted across the platform realm.
    await openRoom(page, 'dealer');
    await expect(page.locator('#content thead')).toContainText('In flight');

    // On a phone the context is the account menu's first item, keeping its name, and entering a dealer is the context dialog's.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(page.locator('.tenant-support-entry')).toBeHidden();
    await expect(page.locator('.tenant-control-trigger')).toBeHidden();
    await page.getByRole('button', { name: /^Account/ }).click();
    await page.locator('.account-menu-context').click();
    await expect(page.getByRole('dialog', { name: 'Choose a dealer' }).getByRole('button', { name: 'Enter dealer' })).toBeVisible();
  });

  test("each context is called by its dealership's name, the book breaks down by name, and a list's tab is its canonical address in both realms", async ({
    page,
  }) => {
    const both = [...app.accounts.values()].find((entry) => entry.roles.length === 2)!;
    await enter(page, app, both.email, DEALERS.north);
    await expect(page.locator('.tenant-control-trigger')).toHaveText(/Dealer: Demo North Motors/);
    await page.locator('.tenant-control-trigger').click();
    const context = page.getByRole('dialog', { name: 'Choose a dealer' });
    await expect(context.getByRole('list', { name: 'Available dealers' }).getByRole('button')).toHaveText([
      /Demo Harbor Auto/,
      /Demo North Motors/,
    ]);
    await expect(context).not.toContainText(DEALERS.north);
    await page.keyboard.press('Escape');

    // A dealership's tab and search are its list's parameters, its selector after them, and a reload opens the same.
    await openRoom(page, 'loan_application');
    await page.getByRole('tab', { name: /^Decided/ }).click();
    await expect(page).toHaveURL(/\/applications\?tab=decided&tenant=north-motors$/);
    await page.reload();
    await page.getByRole('list', { name: 'Available dealers' }).locator(`button[data-tenant="${DEALERS.north}"]`).click();
    await expect(page.getByRole('tab', { name: /^Decided/ })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page).toHaveURL(/\/applications\?tab=decided&tenant=north-motors$/);

    await page.context().clearCookies();
    await enter(page, app, app.account('manager').email, LENDER);
    // The portfolio's book, by dealership: each by name, none by the id its rows are grouped on.
    const content = page.locator('#content');
    await expect(content.locator('.page-breakdown-rows').first()).toContainText('Demo North Motors');
    for (const dealer of [DEALERS.north, DEALERS.harbor, DEALERS.valley]) await expect(content).not.toContainText(dealer);
    await page.getByRole('button', { name: 'Enter dealer', exact: true }).click();
    const enterDialog = page.getByRole('dialog', { name: 'Enter a dealer' });
    await expect(enterDialog.getByRole('radio', { name: 'Demo Harbor Auto', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await openRoom(page, 'loan_application');
    await page.getByRole('tab', { name: /^Awaiting a decision/ }).click();
    await expect(page).toHaveURL(/\/all-applications\?tab=awaiting_a_decision&realm=platform$/);
    await page.getByRole('searchbox').first().fill('AL-10');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/all-applications\?tab=awaiting_a_decision&search=AL-10&realm=platform$/);
  });

  /* `mistri shot` on a tenant App: a fresh account in shot's own store,
     granted the role in the context named, chooses that context in every tab. */
  test('shot signs in to a dealership, or to the lender, and shoots the rooms of that realm', async () => {
    test.setTimeout(240_000);
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-ignition-shot-'));
    const reader = join(directory, 'real-config');
    try {
      const shot = (args: string[]) =>
        new Promise<{ code: number; out: string; err: string }>((done, reject) => {
          execFile(
            process.execPath,
            [
              '--import',
              'tsx',
              resolve('packages/mistri/src/server/index.ts'),
              'shot',
              '--app',
              'test/fixtures/apps/ignition',
              '--config',
              app.config,
              '--policy',
              'test/fixtures/apps/ignition/tenant-policy.ts',
              '--commands',
              'test/fixtures/apps/ignition/commands.ts',
              '--jobs',
              'test/fixtures/apps/ignition/jobs.ts',
              ...args,
            ],
            { timeout: 200_000, killSignal: 'SIGKILL', env: { ...process.env, ...app.env, XDG_CONFIG_HOME: reader } },
            (error, out, err) => {
              if (error && (error as { killed?: boolean }).killed) {
                reject(new Error(`shot did not exit: ${err}`));
                return;
              }
              done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
            },
          );
        });
      const dealer = await shot(['--as', 'dealer_admin', '--tenant', DEALERS.north, 'inventory', '--out', join(directory, 'dealer')]);
      expect(dealer.code, dealer.err).toBe(0);
      const lender = await shot(['--as', 'manager', 'dealers', '--out', join(directory, 'lender')]);
      expect(lender.code, lender.err).toBe(0);
      for (const file of [...dealer.out.trim().split('\n'), ...lender.out.trim().split('\n')]) {
        // A drawn room, not a chooser or a blank window: a few kilobytes is the empty page.
        expect(readFileSync(file).length, file).toBeGreaterThan(20_000);
      }
      const refused = await shot(['--as', 'dealer_admin', 'inventory']);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(/--tenant <id> says which one/);
      expect(existsSync(reader), "the reader's own config directory is never written").toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
