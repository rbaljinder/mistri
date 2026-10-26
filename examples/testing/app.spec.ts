import { test as base, expect } from '@playwright/test';
import { createTestWorkspace, startTestApp } from '@mistriwork/mistri/testing';

const test = base.extend<{ appURL: string }>({
  appURL: async ({ browserName }, use) => {
    if (!browserName) throw new Error('A browser project is required.');
    const workspace = await createTestWorkspace();
    try {
      const database = await workspace.database('business.db', (db) =>
        db.exec(`
        CREATE TABLE application(id INTEGER PRIMARY KEY, status TEXT NOT NULL);
        INSERT INTO application VALUES (1, 'pending');
      `),
      );
      await workspace.write('app/app.json', {
        id: 'credit-desk',
        name: 'Credit desk',
        resources: { application: {} },
        views: { applications: { kind: 'list', from: 'application', label: 'Applications' } },
        home: 'applications',
        nav: ['applications'],
      });
      const host = await startTestApp({ workspace, directory: workspace.path('app'), database });
      await use(host.url);
    } finally {
      await workspace.close();
    }
  },
});

test('credit desk opens its seeded application', async ({ page, appURL }) => {
  await page.goto(appURL);
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'pending', exact: true }).or(page.getByRole('button', { name: 'pending', exact: true })),
  ).toBeVisible();
});
