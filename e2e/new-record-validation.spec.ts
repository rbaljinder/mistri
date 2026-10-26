// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
import { CRM, expect, type Locator, type Page, SCRATCH, test } from './support/ownServers';
import { startSample } from './support/sampleServer';
import { enableWriteMode, open } from './support/app';
import { scalar } from './support/db';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer', 'crm'] });

// All origins/data come from the disposable harness, never a running preview.
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function fieldError(form: Locator, control: Locator, label: string) {
  await expect(form.getByText(`Fill in ${label}.`, { exact: true })).toHaveCount(1);
  await expect(control).toHaveAttribute('aria-invalid', 'true');
  await expect(control).toHaveAccessibleDescription(`Fill in ${label}.`);
}

async function corrected(form: Locator, control: Locator, label: string) {
  await expect(form.getByText(`Fill in ${label}.`, { exact: true })).toHaveCount(0);
  await expect(control).not.toHaveAttribute('aria-invalid', 'true');
  await expect(control).not.toHaveAttribute('aria-describedby');
}

async function newLead(page: Page, hiddenCompany = false) {
  await page.route(
    (url) => url.pathname === '/api/app',
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      (json.app.resources.lead ??= {}).form = {
        show: hiddenCompany ? ['name'] : ['company', 'name'],
        defaults: { source: 'event', owner_id: 1, email: 'validation@example.test', created_on: '2026-09-04', status: 'new' },
      };
      await route.fulfill({ response, json });
    },
  );
  await page.goto(`${CRM}/lead`);
  await page.getByRole('button', { name: '+ New lead', exact: true }).click();
  return page.locator('.newpanel .insert-form');
}

for (const width of [1440, 390]) {
  test.describe(`${width}px new-record validation`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('Tick quick-add shows one field message, corrects and saves', async ({ page }) => {
      test.setTimeout(45_000);
      const sample = await startSample('tick');
      try {
        await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
        let inserts = 0;
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/insert') inserts++;
        });
        await page.goto(`${sample.origin}/`);
        await page.getByRole('button', { name: '+ Add task', exact: true }).click();
        const form = page.locator('.quick-add form');
        const name = form.getByRole('textbox', { name: 'Name', exact: true });
        const add = form.getByRole('button', { name: 'Add', exact: true });
        await expect(form.locator('.insert-missing:visible')).toHaveCount(0);
        await add.focus();
        await page.keyboard.press('Enter');
        await fieldError(form, name, 'Name');
        await expect(form.locator('.insert-missing:visible')).toHaveCount(1);
        await expect(form.getByRole('alert')).toHaveCount(0);
        await expect(name).toBeFocused();
        await expect(name).toBeInViewport();
        expect(inserts).toBe(0);
        await name.fill('Draft');
        await corrected(form, name, 'Name');
        await name.fill('');
        await fieldError(form, name, 'Name');
        await name.press('Enter');
        expect(inserts).toBe(0);
        const title = `Validation task ${width}`;
        await name.fill(title);
        await corrected(form, name, 'Name');
        await name.press('Enter');
        await expect(form).toHaveCount(0);
        await expect(page.getByRole('checkbox', { name: `Complete ${title}`, exact: true })).toBeVisible();
        expect(inserts).toBe(1);
        expect(scalar(sample.db, `SELECT count(*) FROM task WHERE name='${title}'`)).toBe(1);
      } finally {
        await sample.stop();
      }
    });

    test('App New focuses authored order and retains a server rejection while correcting', async ({ page }) => {
      const form = await newLead(page);
      let inserts = 0;
      await page.route(
        (url) => url.pathname === '/api/insert',
        async (route) => {
          inserts++;
          await route.fulfill({ json: { outcome: 'rejected', errors: [{ message: 'Choose another customer name.' }] } });
        },
      );
      const company = form.getByRole('textbox', { name: 'Company', exact: true });
      const name = form.getByRole('textbox', { name: 'Name', exact: true });
      const add = form.getByRole('button', { name: 'Add', exact: true });
      await add.focus();
      await page.keyboard.press('Enter');
      await fieldError(form, company, 'Company');
      await fieldError(form, name, 'Name');
      await expect(form.locator('.insert-missing:visible')).toHaveCount(2);
      await expect(form.getByRole('alert')).toHaveCount(0);
      await expect(company).toBeFocused();
      await company.fill('Validation company');
      await corrected(form, company, 'Company');
      await fieldError(form, name, 'Name');
      await add.click();
      await expect(name).toBeFocused();
      expect(inserts).toBe(0);
      await name.fill('Validation customer');
      await corrected(form, name, 'Name');
      await add.click();
      const alert = form.getByRole('alert');
      await expect(alert).toHaveText('Choose another customer name.');
      await expect(alert).toBeFocused();
      await expect(alert).toBeInViewport();
      await name.fill('');
      await fieldError(form, name, 'Name');
      await expect(alert).toHaveText('Choose another customer name.');
      await name.fill('Corrected customer');
      await corrected(form, name, 'Name');
      await expect(alert).toHaveText('Choose another customer name.');
      expect(inserts).toBe(1);
    });

    test('App New retains hidden-required configuration feedback after visible correction', async ({ page }) => {
      const form = await newLead(page, true);
      let inserts = 0;
      await page.route(
        (url) => url.pathname === '/api/insert',
        async (route) => {
          inserts++;
          await route.abort();
        },
      );
      const name = form.getByRole('textbox', { name: 'Name', exact: true });
      const add = form.getByRole('button', { name: 'Add', exact: true });
      await add.click();
      await fieldError(form, name, 'Name');
      await expect(name).toBeFocused();
      const alert = form.getByRole('alert');
      await expect(alert).toHaveText(
        'Cannot add this record. Required fields hidden by this form need valid defaults or visible controls: Company.',
      );
      await name.fill('Validation customer');
      await corrected(form, name, 'Name');
      await expect(alert).toBeVisible();
      await add.click();
      await expect(alert).toBeFocused();
      await expect(alert).toBeInViewport();
      await expect(form.locator('.insert-missing:visible')).toHaveCount(0);
      expect(inserts).toBe(0);
    });

    test('Workbench New validates required fields without marking a nullable key', async ({ page }) => {
      await open(page, SCRATCH, 'country');
      await enableWriteMode(page);
      await page.getByRole('button', { name: '+ New row', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'New country', exact: true });
      const code = form.getByRole('textbox', { name: 'code (TEXT)', exact: true });
      const name = form.getByRole('textbox', { name: 'name (TEXT)', exact: true });
      const add = form.getByRole('button', { name: 'Add row', exact: true });
      let inserts = 0;
      await page.route(
        (url) => url.pathname === '/api/insert',
        async (route) => {
          inserts++;
          await route.abort();
        },
      );
      await add.click();
      await fieldError(form, name, 'name');
      await expect(form.locator('.insert-missing:visible')).toHaveCount(1);
      await expect(name).toBeFocused();
      await corrected(form, code, 'code');
      await expect(form.getByRole('alert')).toHaveCount(0);
      await code.fill('ZZ');
      await corrected(form, code, 'code');
      await add.click();
      await expect(name).toBeFocused();
      await expect(name).toBeInViewport();
      await name.fill('Validation country');
      await corrected(form, name, 'name');
      await expect(form.locator('.insert-missing:visible')).toHaveCount(0);
      expect(inserts).toBe(0);
    });
  });
}
