// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
import { CRM, DEMO, expect, test, WIDE } from './support/ownServers';
import { dataRows } from './support/app';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer', 'crm'] });

test('the latest record click wins while both await the same page registry', async ({ page }) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(/\/api\/pages\?/, async (route) => {
    requested();
    await paused;
    await route.continue();
  });
  try {
    await page.goto(`${CRM}/lead`);
    await started;
    const rows = dataRows(page);
    await expect(rows.nth(1)).toBeVisible();
    // A lead's name cell also draws its initials and email; the heading says the name.
    const latestName = await rows.nth(1).locator('td').first().locator('.avatar-text').innerText();
    await rows.first().click();
    await rows.nth(1).click();
    await expect(page.locator('.applist-title')).toBeVisible();
    release();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(latestName);
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/leads\/\d+$/);
  } finally {
    release();
  }
});

test('a late page registry response cannot replace the new connection menu', async ({ page }) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(/\/api\/pages\?/, async (route) => {
    const connection = new URL(route.request().url()).searchParams.get('conn');
    if (connection === DEMO) {
      requested();
      await paused;
    }
    await route.fulfill({
      json: {
        pages: [
          {
            id: `config:${connection}`,
            name: `${connection} overview`,
            base: connection === WIDE ? 'ticket' : 'customer',
            source: 'config',
            sections: [],
          },
        ],
      },
    });
  });
  try {
    await page.goto(`/${DEMO}`);
    await started;
    await page.getByRole('button', { name: 'Database connection' }).click();
    await page.getByRole('option', { name: /^wide / }).click();
    await expect(page.locator('#db-label')).toContainText(WIDE);
    await expect(page.getByText(`${WIDE} overview`, { exact: true }).first()).toBeVisible();
    const arrived = page.waitForResponse((response) => response.url().includes(`/api/pages?conn=${DEMO}`));
    release();
    await arrived;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText(`${WIDE} overview`, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(`${DEMO} overview`, { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`/${WIDE}`);
  } finally {
    release();
  }
});

for (const origin of ['table', 'record'])
  test(`a pending ${origin}-to-page action cannot navigate after switching connections`, async ({ page }) => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route(/\/api\/pages\?/, async (route) => {
      if (new URL(route.request().url()).searchParams.get('conn') === DEMO) {
        requested();
        await paused;
      }
      await route.fulfill({ json: { pages: [] } });
    });
    try {
      await page.goto(`/${DEMO}/customer`);
      await started;
      if (origin === 'record') await dataRows(page).first().click();
      await page.getByRole('button', { name: origin === 'record' ? 'As a page →' : 'Page →', exact: true }).click();
      await page.getByRole('button', { name: 'Database connection' }).click();
      await page.getByRole('option', { name: /^wide / }).click();
      await expect(page.locator('#db-label')).toContainText(WIDE);
      const arrived = page.waitForResponse((response) => response.url().includes(`/api/pages?conn=${DEMO}`));
      release();
      await arrived;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(new URL(page.url()).pathname).toBe(`/${WIDE}`);
      await expect(page.locator('.page-title')).toHaveCount(0);
    } finally {
      release();
    }
  });
