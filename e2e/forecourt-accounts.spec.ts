import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

test.describe('Forecourt account workflows', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(120_000);
  test.beforeEach(async () => {
    sample = await startSample('forecourt');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  for (const width of [1440, 390]) {
    test(`${width}px: private inquiries and a shortlist shared across account sessions`, async ({ browser, page }) => {
      await page.setViewportSize({ width, height: 900 });
      const password = 'disposable-shopper-browser-password';
      const email = 'shopper-a@example.test';
      const signup = await page.request.post(`${sample.origin}/api/auth/sign-up/email`, {
        headers: { origin: sample.origin },
        data: { name: 'Shopper A', email, password },
      });
      expect(signup.ok(), await signup.text()).toBe(true);
      await page.goto(`${sample.origin}/@vehicle~1`);
      // Save asks nothing, so it runs on one click with no dialog (df773272), and its notice says so.
      await page.getByRole('button', { name: 'Save vehicle', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('Vehicle saved.');
      await expect(page.getByRole('dialog', { name: 'Save vehicle' })).toHaveCount(0);
      if (width === 390) {
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Send account inquiry', exact: true }).click();
      } else await page.getByRole('button', { name: 'Send account inquiry', exact: true }).click();
      const inquiry = page.getByRole('dialog', { name: 'Send account inquiry' });
      await inquiry.getByLabel('Your name', { exact: false }).fill('Shopper A inquiry');
      await inquiry.getByLabel('Email', { exact: false }).fill(email);
      await inquiry.getByLabel('Your question', { exact: false }).fill('Is this vehicle available for a test drive?');
      await inquiry.getByRole('button', { name: 'Send account inquiry', exact: true }).click();
      await expect(inquiry.getByRole('status')).toHaveAttribute('data-phase', 'success');
      await inquiry.getByRole('button', { name: 'Done', exact: true }).click();
      await page.goto(`${sample.origin}/inquiries`);
      await expect(page.getByText('Shopper A inquiry', { exact: true }).filter({ visible: true }).first()).toBeVisible();
      const title = String(scalar(sample.db, 'SELECT title FROM vehicle WHERE id = 1'));
      await page.goto(`${sample.origin}/shortlist`);
      await expect(page.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();

      const second = await browser.newContext({ viewport: { width, height: 900 } });
      const other = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const again = await second.newPage();
        const login = await again.request.post(`${sample.origin}/api/auth/sign-in/email`, {
          headers: { origin: sample.origin },
          data: { email, password },
        });
        expect(login.ok(), await login.text()).toBe(true);
        await again.goto(`${sample.origin}/shortlist`);
        await expect(again.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();
        const stranger = await other.newPage();
        const otherSignup = await stranger.request.post(`${sample.origin}/api/auth/sign-up/email`, {
          headers: { origin: sample.origin },
          data: { name: 'Shopper B', email: 'shopper-b@example.test', password },
        });
        expect(otherSignup.ok(), await otherSignup.text()).toBe(true);
        await stranger.goto(`${sample.origin}/shortlist`);
        await expect(stranger.getByRole('heading', { name: 'My shortlist', exact: true })).toBeVisible();
        await expect(stranger.getByText(title, { exact: true })).toHaveCount(0);
        await expect(stranger.getByText('Your shortlist is empty', { exact: true })).toBeVisible();
        await stranger.getByRole('link', { name: 'Browse vehicles', exact: true }).click();
        await expect(stranger).toHaveURL(/\/vehicles$/);
        await expect(stranger.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();
        await stranger.goto(`${sample.origin}/inquiries`);
        await expect(stranger.getByRole('heading', { name: 'Inquiries', exact: true })).toBeVisible();
        await expect(stranger.getByText('Shopper A inquiry', { exact: true })).toHaveCount(0);

        const id = Number(scalar(sample.db, 'SELECT id FROM saved_vehicle WHERE vehicle_id = 1'));
        await again.goto(`${sample.origin}/@saved-vehicle~${id}`);
        await expect(again.getByRole('heading', { name: title, exact: true })).toBeVisible();
        // Remove asks nothing either: one click (df773272), and the command's own notice.
        await again.getByRole('button', { name: 'Remove from shortlist', exact: true }).click();
        await expect(again.locator('#toast')).toContainText('Vehicle removed from your shortlist.');
        await expect(again.getByRole('dialog', { name: 'Remove from shortlist' })).toHaveCount(0);
        await page.reload();
        await expect(page.getByRole('heading', { name: 'My shortlist', exact: true })).toBeVisible();
        await expect(page.getByText(title, { exact: true })).toHaveCount(0);
        await expect(page.getByText('Your shortlist is empty', { exact: true })).toBeVisible();
        expect(scalar(sample.db, 'SELECT active FROM saved_vehicle WHERE id = ?', id)).toBe(0);
      } finally {
        await second.close();
        await other.close();
      }
    });
  }
});
