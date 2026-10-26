/** Browser acceptance against actual Keystone Apps and a disposable PostgreSQL. */
import { test, expect } from '@playwright/test';
import { createKeystoneFixture } from './keystone-fixture.mjs';

test('credit manager reads the completed provider score and Dealer remains unavailable', async ({ page }) => {
  // A fixture seeds a database and starts two Apps and the job runner before the first page loads.
  test.setTimeout(300_000);
  test.skip(!process.env.TABLEWALK_TEST_PG, 'Set TABLEWALK_TEST_PG to a local disposable database administrator URL.');
  const fixture = await createKeystoneFixture(process.env.TABLEWALK_TEST_PG);
  try {
    const id = await fixture.checkCredit();
    fixture.provider.clock.advance(1000);
    await fetch(`${fixture.provider.url}/dispatch`, { method: 'POST' });
    const result = await (await fetch(`${fixture.provider.url}/checks/${id}`)).json();
    await page.goto(`${fixture.host.url}/lender/`);
    await page.getByLabel('Email', { exact: true }).fill(fixture.lenderEmail);
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 45_000 });
    // The browser's own shared session must observe the callback's committed score.
    const answer = await page.request.post(`${fixture.host.url}/lender/api/query`, {
      headers: { origin: fixture.host.url, 'x-mistri-account': fixture.lenderId },
      data: {
        table: 'underwriting_file',
        columns: ['id', 'score'],
        filter: { groups: [[{ column: 'id', op: '=', value: fixture.file.id }]] },
      },
    });
    expect(answer.status()).toBe(200);
    expect((await answer.json()).rows[0].score).toBe(result.score);
    const denied = await page.request.get(`${fixture.host.url}/dealer/api/schema`, {
      headers: { 'x-mistri-account': fixture.lenderId },
    });
    expect([401, 403, 404]).toContain(denied.status());
  } finally {
    await fixture.close();
  }
});

test('credit manager sees the credit decision in the Workflows room, reads its history and cancels it', async ({ page }) => {
  // A fixture seeds a database and starts two Apps and the job runner before the first page loads.
  test.setTimeout(300_000);
  const slow = expect.configure({ timeout: 45_000 });
  test.skip(!process.env.TABLEWALK_TEST_PG, 'Set TABLEWALK_TEST_PG to a local disposable database administrator URL.');
  const fixture = await createKeystoneFixture(process.env.TABLEWALK_TEST_PG);
  try {
    // Asking for the check starts the workflow, which requests it from the provider and then waits for the callback.
    await fixture.checkCredit();
    await page.goto(`${fixture.host.url}/lender/`);
    await page.getByLabel('Email', { exact: true }).fill(fixture.lenderEmail);
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await slow(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible();
    await page.goto(`${fixture.host.url}/lender/workflows`);
    const row = page.getByRole('row', { name: /creditDecision/ });
    await slow(row).toBeVisible();
    await slow(row).toContainText(fixture.file.application_id);
    await slow(row).toContainText('Waiting');
    await slow(row).toContainText('credit-result');
    await row.getByRole('button', { name: 'creditDecision' }).click();
    // The history: the provider was asked, and the instance is waiting for the callback.
    const steps = page.getByRole('table', { name: 'Steps of this instance' });
    await slow(steps).toContainText('request-check');
    await slow(steps).toContainText('credit-result');
    await slow(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    // Cancel asks twice.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Keep it' }).click();
    await slow(row).toContainText('Waiting');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
    await slow(page.getByText('Cancelled. The instance will not run again.')).toBeVisible();
    await slow(row).toContainText('Cancelled');
  } finally {
    await fixture.close();
  }
});
