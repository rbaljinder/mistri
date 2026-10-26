import { expect, test } from './support/harness';
import { FORECOURT_STAFF, startSample } from './support/sampleServer';
import { scalar } from './support/db';

/**
 * Thread and Forecourt served from `mistri build` output instead of their
 * source: the server says it serves a build and watches nothing, the API
 * answers, the App paints, and Forecourt's public inquiry runs through the
 * bundled command and lands in the database.
 */
for (const name of ['thread', 'forecourt'] as const) {
  test.describe(`${name}, served from its build`, () => {
    let sample: Awaited<ReturnType<typeof startSample>>;
    // The build typechecks the App first, and Forecourt's seed draws its photos.
    test.setTimeout(120_000);
    /* The hook needs its own budget: `test.setTimeout` in describe scope reaches
       the tests, never the hooks, so the build ran on the config's 40 s while
       this line claimed to give it two minutes. It only started failing when a
       second worker began competing for the CPU the build wants — the parallel
       lane exposed it rather than caused it. */
    test.beforeAll(async () => {
      test.setTimeout(180_000);
      sample = await startSample(name, { built: true });
    });
    test.afterAll(async () => {
      await sample?.stop();
    });

    test('the API answers and the App paints', async ({ page }) => {
      expect(sample.log()).toMatch(/a build by mistri [\d.]+(?:-[\w.]+)?, served as built: no reload/);
      const api = await page.request.get(`${sample.origin}/api/app`);
      expect(api.ok()).toBe(true);
      expect((await api.json()).app.id).toBe(name);
      await page.goto(`${sample.origin}/`);
      await expect(page.locator('body')).toHaveClass(/app-mode/);
      if (name === 'thread') await expect(page.locator('.board-card').first()).toBeVisible();
      else await expect(page.getByRole('heading', { level: 1, name: 'Find a car you will love driving' })).toBeVisible();
    });

    if (name === 'forecourt')
      test('public intake and staff follow-up run the bundled commands', async ({ page }) => {
        const reference = String(scalar(sample.db, "SELECT stock_ref FROM vehicle WHERE status != 'sold' ORDER BY id LIMIT 1"));
        await page.goto(`${sample.origin}/form/inquire?stock_ref=${reference}`);
        await expect(page.getByLabel('Stock number')).toHaveValue(reference);
        await page.getByLabel('Your name').fill('Robin Built');
        await page.getByLabel('Email').fill('robin@example.test');
        await page.getByLabel('Your question').fill('Is it still available this weekend?');
        await page.getByRole('button', { name: 'Send inquiry' }).click();
        await expect(page.getByText('Inquiry recorded')).toBeVisible();
        expect(Number(scalar(sample.db, "SELECT COUNT(*) FROM inquiry WHERE stock_ref = ? AND name = 'Robin Built'", reference))).toBe(1);
        await page.goto(`${sample.origin}/sign-in`);
        await page.getByLabel('Email').fill(FORECOURT_STAFF.email);
        await page.getByLabel('Password').fill(FORECOURT_STAFF.password);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByText('Robin Built').filter({ visible: true }).first()).toBeVisible();
        const id = Number(scalar(sample.db, "SELECT id FROM inquiry WHERE name = 'Robin Built'"));
        await page.goto(`${sample.origin}/@inquiry~${id}`);
        await page.getByRole('button', { name: 'Close inquiry', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Close inquiry' });
        await dialog.getByLabel('Resolution', { exact: false }).fill('Availability confirmed by phone.');
        await dialog.getByRole('button', { name: 'Close inquiry', exact: true }).click();
        await expect(dialog.getByRole('status')).toHaveAttribute('data-phase', 'success');
        await dialog.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(page.locator('[data-timeline-row]').filter({ hasText: 'Availability confirmed by phone.' })).toBeVisible();
        expect(scalar(sample.db, 'SELECT status FROM inquiry WHERE id = ?', id)).toBe('closed');
      });
  });
}
