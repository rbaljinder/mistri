import { DEMO, expect, type Page, SCRATCH, test, WIDE } from './support/ownServers';
import { open } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

async function choose(page: Page, id: string) {
  await page.getByRole('button', { name: 'Database connection' }).click();
  await page.getByRole('option', { name: new RegExp(`^${id} `) }).click();
}

async function followHistory(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function hold(page: Page, endpoint: string, id: string) {
  let release!: () => void;
  let began!: () => void;
  let finished!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route(`**/api/connections/${endpoint}`, async (route) => {
    if (route.request().postDataJSON().id !== id) {
      await route.continue();
      return;
    }
    began();
    await blocked;
    try {
      await route.fulfill({ response: await route.fetch() });
    } finally {
      finished();
    }
  });
  return {
    started,
    release,
    settle: async () => {
      release();
      await delivered;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    },
  };
}

for (const scenario of ['picker-picker', 'history-picker', 'picker-history', 'return-current']) {
  test(`latest connection intent wins: ${scenario}`, async ({ page }) => {
    await open(page, DEMO, 'customer');
    const held = await hold(page, 'select', WIDE);
    try {
      if (scenario === 'history-picker') await followHistory(page, `/${WIDE}/ticket`);
      else await choose(page, WIDE);
      await held.started;
      const target = scenario === 'return-current' ? DEMO : SCRATCH;
      if (scenario === 'picker-history' || scenario === 'return-current') await followHistory(page, `/${target}/invoice`);
      else await choose(page, target);
      await expect(page.getByRole('button', { name: 'Database connection' })).toContainText(target);
      await expect.poll(() => new URL(page.url()).pathname).toMatch(new RegExp(`^/${target}(?:/|$)`));
      if (scenario === 'return-current') await expect(page.getByRole('combobox', { name: 'Query' })).toHaveValue('invoice');
      const settledUrl = page.url();
      await held.settle();
      await expect(page.getByRole('button', { name: 'Database connection' })).toContainText(target);
      expect(page.url()).toBe(settledUrl);
      await expect(page.locator('#db-label')).toContainText(target);
    } finally {
      held.release();
    }
  });
}

test('late schema refresh cannot replace the selected database schema', async ({ page }) => {
  await open(page, DEMO, 'customer');
  const held = await hold(page, 'refresh', DEMO);
  try {
    await page.getByRole('button', { name: 'Database connection' }).click();
    await page.getByRole('option', { name: /Re-read the schema/ }).click();
    await held.started;
    await choose(page, WIDE);
    await expect(page.getByRole('button', { name: 'Database connection' })).toContainText(WIDE);
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/${WIDE}`);
    await held.settle();
    await expect(page.locator('#db-label')).toContainText(WIDE);
    await expect(page.getByRole('navigation', { name: 'Tables' }).getByRole('button', { name: 'ticket', exact: true })).toBeVisible();
    await expect(page.getByText(/Schema re-read/)).toHaveCount(0);
  } finally {
    held.release();
  }
});

test('a failed newer switch finishes loading the connection that remains selected', async ({ page }) => {
  await open(page, DEMO, 'customer');
  let release!: () => void;
  let began!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let first = true;
  /* The switch's own per-connection load, held on its first ask (app.js, the
     `initConnections` callback): the Workbench's layouts. It was the App
     definition (`/api/app`) until the Workbench stopped asking for one. */
  await page.route('**/api/layouts?conn=wide', async (route) => {
    if (first) {
      first = false;
      began();
      await blocked;
    }
    await route.continue();
  });
  await page.route('**/api/connections/select', async (route) => {
    if (route.request().postDataJSON().id === SCRATCH) await route.fulfill({ status: 503, json: { error: 'Scratch unavailable' } });
    else await route.continue();
  });
  try {
    await choose(page, WIDE);
    await started;
    await choose(page, SCRATCH);
    await expect(page.locator('.toast-message').filter({ hasText: /^Scratch unavailable$/ })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/${WIDE}`);
    await expect(page.getByRole('navigation', { name: 'Tables' }).getByRole('button', { name: 'ticket', exact: true })).toBeVisible();
    const arrived = page.waitForResponse((response) => response.url().includes('/api/layouts?conn=wide'));
    release();
    await arrived;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(new URL(page.url()).pathname).toBe(`/${WIDE}`);
    await expect(page.getByRole('button', { name: 'Database connection' })).toContainText(WIDE);
  } finally {
    release();
  }
});
