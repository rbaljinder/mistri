import { COMPASS, expect, type Page, test } from './support/ownServers';
import { ATELIER_ADMIN, startSample } from './support/sampleServer';
import { inPage, probePage, type Probe } from '../packages/mistri/src/server/build/gradeProbe';
import { TAP } from '../packages/mistri/src/server/build/gradeJudge';

// This worker's own Compass (support/ownServers.ts), and an Atelier of the test's own: the spec runs in the parallel lane.
test.use({ servers: ['crm'], viewport: { width: 390, height: 844 }, hasTouch: true });

/**
 * A form's own controls under a finger, measured by grade's own probe at a phone's width with a coarse pointer. A
 * field report's grade found them under 44px on every form of its App: a reference's picker (its input 23px in a
 * 44px box), a date's calendar button (30×40), a command's choices (a radio's label 16px tall) and a sheet's Close.
 * The chrome around them was made a target in an earlier change (e2e/apps.spec.ts); these are the fields.
 */
async function small(page: Page) {
  const probe = (await page.evaluate(inPage(probePage, { tap: TAP, record: false }))) as Probe;
  return probe.small.map((target) => `${target.what} ${target.width}×${target.height}`);
}

test("a record's New form: its pickers, its dates, its switch and the sheet's Close take a finger", async ({ page }) => {
  await page.goto(`${COMPASS}/tasks/new`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting', '');
  const form = page.locator('.insert-field').first();
  await expect(form).toBeVisible();
  await expect(page.locator('.date-field-trigger').first()).toBeVisible();
  await expect(page.locator('.picker-input').first()).toBeVisible();
  expect(await small(page)).toEqual([]);
  /* The calendar button keeps its place inside its field: its hit area grows round it, not the button out of it. */
  const field = await page.locator('.date-field').first().boundingBox();
  const button = await page.locator('.date-field-trigger').first().boundingBox();
  expect(button!.x + button!.width).toBeLessThanOrEqual(field!.x + field!.width);
  expect(button!.y).toBeGreaterThanOrEqual(field!.y);
});

test("a command's form: its references and its choices take a finger", async ({ page }) => {
  test.setTimeout(120_000);
  const sample = await startSample('atelier');
  try {
    const signIn = async (account: { email: string; password: string }) => {
      const response = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: account,
      });
      expect(response.ok(), await response.text()).toBe(true);
    };
    /* The order desk is staff's: an account made by the administrator, as atelier.spec.ts makes it. */
    const staff = { email: 'phone@atelier.example.test', password: 'disposable-atelier-phone-password' };
    await signIn(ATELIER_ADMIN);
    const made = await page.request.post(`${sample.origin}/api/accounts`, {
      headers: { origin: sample.origin },
      data: { app: 'atelier', operation: 'create', ...staff, name: 'Ines Park', roles: ['staff'] },
    });
    expect(made.ok(), await made.text()).toBe(true);
    await page.context().clearCookies();
    await signIn(staff);
    await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
    await page.goto(`${sample.origin}/new-order`);
    const form = page.getByRole('region', { name: 'New order' });
    await expect(form.getByRole('combobox', { name: 'Customer' })).toBeVisible();
    await expect(form.getByRole('radiogroup').first()).toBeVisible();
    expect(await small(page)).toEqual([]);
  } finally {
    await sample.stop();
  }
});
