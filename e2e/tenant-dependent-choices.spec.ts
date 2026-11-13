/**
 * A choice narrowed by the form's other answers, on a tenant App's public form in the browser
 * (support/tenantPublicFormsServer.ts): the quote form asks a model among the make picked (`where: 'make_id = make'`).
 * The dealer's models arrive with the form, so a change of make narrows them on the page with no request; nothing is
 * offered before a make is, and a pick the new make does not allow is cleared, not carried back. A fresh server per
 * test, on a port of its own, so it runs beside others.
 */
import { expect, test } from './support/harness.js';
import { NORTH, startTenantPublicForms, type TenantPublicFormsApp, via } from './support/tenantPublicFormsServer.js';

test.describe('a choice narrowed by the make picked', () => {
  test.setTimeout(60000);
  let app: TenantPublicFormsApp | undefined;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    app = await startTenantPublicForms({ publicReads: true, models: true });
  });
  test.afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  test('the make narrows the models on the page, and a pick the new make does not allow is cleared', async ({ page }) => {
    await page.goto(`${app!.origin}/yard/form/quote${via(NORTH)}`);
    const make = page.getByRole('radiogroup', { name: /^Make/ });
    const model = page.getByRole('radiogroup', { name: /^Model/ });
    // A choice is a card over its radio: a person picks it by its label.
    const pick = (group: typeof make, name: string) => group.getByText(name, { exact: true }).click();
    await expect(make.getByRole('radio')).toHaveCount(2);
    const models = page.getByRole('radio', { name: /^(Focus|Ranger|Niro|Panda)$/ });
    // Nothing is offered until the make it reads is given.
    await expect(models).toHaveCount(0);

    const asked: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/')) asked.push(path);
    });
    await pick(make, 'Ford');
    await expect(models).toHaveCount(2);
    await expect(page.getByRole('radio', { name: 'Focus' })).toBeVisible();
    const ranger = page.getByRole('radio', { name: 'Ranger' });
    await pick(model, 'Ranger');
    await expect(ranger).toBeChecked();

    await pick(make, 'Kia');
    await expect(models).toHaveCount(1);
    const niro = page.getByRole('radio', { name: 'Niro' });
    await expect(niro).toBeVisible();
    await expect(niro).not.toBeChecked();
    // The other dealer's models are never offered here.
    await expect(page.getByRole('radio', { name: 'Panda' })).toHaveCount(0);

    await pick(make, 'Ford');
    await expect(models).toHaveCount(2);
    await expect(ranger).not.toBeChecked();
    expect(asked, 'the served models are narrowed with no request').toEqual([]);
  });
});
