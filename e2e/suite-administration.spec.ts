/** An App administrator manages stable-subject access through the real suite. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant';

test('phone-sized chooser manages grants, preserves conflicting edits, and issues/revokes subject invitations', async ({
  page,
  browser,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-administration-browser-'));
  let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  const recipientContext = await browser.newContext();
  try {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const apps = [];
    for (const id of ['alpha', 'beta']) {
      const home = join(dir, id);
      mkdirSync(home);
      const db = new DatabaseSync(join(home, 'data.db'));
      db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY)');
      db.close();
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          id,
          name: id,
          resources: { note: {} },
          auth: { providers: ['email'], roles: { reader: { read: true } } },
          views: { notes: { kind: 'list', from: 'note' } },
          home: 'notes',
        }),
      );
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: join(home, 'data.db') }] }));
      apps.push({ id, directory: `./${id}`, config: `./${id}/connections.json`, mount: id === 'alpha' ? '/' : '/beta' });
    }
    const file = join(dir, 'suite.json'),
      environment = { SECRET: 'test-browser-suite-secret-longer-than-thirty-two-characters' };
    writeFileSync(
      file,
      JSON.stringify({
        port,
        basePath: '/tools',
        apps,
        identity: {
          id: 'shared',
          name: 'Shared Suite',
          store: './identity.db',
          grants: './grants.db',
          environment: { BETTER_AUTH_SECRET: 'SECRET' },
        },
      }),
    );
    suite = await startConfiguredSuite(file, environment);
    const origin = suite.publicURL;
    const adminResponse = await page.request.post(`${origin}/tools/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: 'Admin', email: 'admin@example.test', password: 'test-password-long-enough' },
    });
    expect(adminResponse.status()).toBe(200);
    const admin = (await adminResponse.json()).user.id;
    const targetResponse = await recipientContext.request.post(`${origin}/tools/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: 'Target', email: 'target@example.test', password: 'test-password-long-enough' },
    });
    expect(targetResponse.status()).toBe(200);
    const target = (await targetResponse.json()).user.id;
    const grant = (subjectId: string, roles: string[], expectedRevision: number) =>
      changeSuiteGrant(file, { appId: 'alpha', subjectId, roles, expectedRevision }, environment);
    await grant(admin, ['admin'], 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/tools/_mistri/apps`);
    await expect(page.getByRole('link', { name: 'Manage access for alpha', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage access for beta', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Manage access for alpha', exact: true }).click();
    await page.getByLabel('Subject account ID', { exact: true }).fill(target);
    await expect(page.getByRole('button', { name: 'Save App access', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Load access', exact: true }).click();
    await expect(page.locator('#management-current')).toContainText('current revision 0');
    await page.getByRole('checkbox', { name: 'reader', exact: true }).check();
    await page.getByRole('button', { name: 'Save App access', exact: true }).click();
    await expect(page.locator('#management-current')).toContainText('current revision 1');
    await expect(page.locator('#management-message')).toHaveText('App access saved.');
    await page.getByRole('checkbox', { name: 'admin', exact: true }).check();
    await grant(target, [], 1);
    await page.getByRole('button', { name: 'Save App access', exact: true }).click();
    await expect(page.locator('#management-message')).toContainText('Your selected roles are preserved');
    await expect(page.getByRole('checkbox', { name: 'admin', exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Save App access', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Load access', exact: true }).click();
    await expect(page.locator('#management-current')).toContainText('current revision 2');
    await expect(page.getByRole('checkbox', { name: 'admin', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'reader', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Save App access', exact: true }).click();
    await expect(page.locator('#management-current')).toContainText('current revision 3');
    await page.getByRole('button', { name: 'Revoke App access', exact: true }).click();
    await expect(page.locator('#management-current')).toContainText('current revision 4');
    await expect(page.getByRole('button', { name: 'Create invitation', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'reader', exact: true }).check();
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(page.getByLabel('Invitation link', { exact: true })).toHaveValue(new RegExp('/tools/_mistri/apps#invite=alpha\\.'));
    const firstLink = await page.getByLabel('Invitation link', { exact: true }).inputValue();
    await expect(page.locator('#management-message')).toHaveText('Invitation created. Copy the link now.');
    await page.getByRole('button', { name: 'Copy invitation link', exact: true }).click();
    await expect(page.locator('#management-message')).toHaveText(/Invitation link copied\.|Copy the selected invitation link\./);
    // Reload recovers pending invitation IDs without recovering their tokens.
    await page.reload();
    await page.getByLabel('Subject account ID', { exact: true }).fill(target);
    await page.getByRole('button', { name: 'Load access', exact: true }).click();
    await expect(page.locator('#management-invitations')).toContainText('Pending');
    await expect(page.getByLabel('Invitation link', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
    await expect(page.locator('#management-invitations')).toContainText('Revoked');
    const recipient = await recipientContext.newPage();
    await recipient.goto(firstLink);
    await recipient.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await expect(recipient.locator('#status')).toContainText('unavailable');
    await expect(recipient.getByRole('link', { name: 'alpha', exact: true })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'reader', exact: true }).check();
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(page.getByLabel('Invitation link', { exact: true })).toBeVisible();
    const secondLink = await page.getByLabel('Invitation link', { exact: true }).inputValue();
    await expect(page.locator('#management-message')).toHaveText('Invitation created. Copy the link now.');
    await recipient.goto(secondLink);
    await recipient.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await expect(recipient.getByRole('link', { name: 'alpha', exact: true })).toHaveAttribute('href', '/tools/?app=alpha');
    await expect(recipient.getByRole('link', { name: 'Manage access for alpha', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Load access', exact: true }).click();
    await expect(page.locator('#management-invitations')).toContainText('Accepted');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Sign out of the suite', exact: true }).click();
    await expect(page.locator('#management')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally {
    await recipientContext.close();
    await suite?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
