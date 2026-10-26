/** One suite login on a phone, with only explicitly granted App links. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant';

test('suite chooser signs in once, reveals only granted Apps and signs out everywhere', async ({ page, playwright }) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-chooser-'));
  let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  try {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const apps = [];
    for (const id of ['alpha', 'beta']) {
      const home = join(dir, id);
      mkdirSync(home);
      const db = new DatabaseSync(join(home, 'business.db'));
      db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)');
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
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: join(home, 'business.db') }] }));
      apps.push({ id, directory: `./${id}`, config: `./${id}/connections.json`, mount: `/${id}` });
    }
    const file = join(dir, 'suite.json');
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
    const environment = { SECRET: 'test-suite-secret-longer-than-thirty-two-characters' };
    suite = await startConfiguredSuite(file, environment);
    const origin = suite.publicURL;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/tools/_mistri/apps`);
    await page.getByLabel('Name (for a new account)').fill('Suite Reader');
    await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
    await page.getByLabel('Password', { exact: true }).fill('test-password-long-enough');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByText('No App access has been granted yet.', { exact: false })).toBeVisible();
    const subjectId = (await page.locator('#account').textContent())!;
    await changeSuiteGrant(file, { appId: 'alpha', subjectId, roles: ['reader'], expectedRevision: 0 }, environment);
    await page.reload();
    await expect(page.getByRole('link', { name: 'alpha', exact: true })).toHaveAttribute('href', '/tools/alpha/');
    await expect(page.getByRole('link', { name: 'beta', exact: true })).toHaveCount(0);
    await page.getByLabel('Default App', { exact: true }).selectOption('alpha');
    await page.getByRole('button', { name: 'Save default App', exact: true }).click();
    await expect(page.locator('#preference-status')).toContainText('Default App saved.');
    await page.reload();
    await expect(page.getByLabel('Default App', { exact: true })).toHaveValue('alpha');
    const preference = await page.request.get(`${origin}/tools/api/suite/preferences`, { headers: { 'x-mistri-account': subjectId } });
    expect(await preference.json()).toMatchObject({ defaultApp: 'alpha', revision: 1 });
    const alpha = await page.request.get(`${origin}/tools/alpha/api/schema`);
    expect(alpha.status()).toBe(200);
    const beta = await page.request.get(`${origin}/tools/beta/api/schema`);
    expect(beta.status()).toBe(401);
    const administrator = await playwright.request.newContext({ extraHTTPHeaders: { origin } });
    try {
      const account = await administrator.post(`${origin}/tools/api/auth/sign-up/email`, {
        data: { name: 'App Administrator', email: 'admin@example.test', password: 'test-administrator-password' },
      });
      expect(account.status()).toBe(200);
      const { user } = await account.json();
      await changeSuiteGrant(file, { appId: 'beta', subjectId: user.id, roles: ['admin'], expectedRevision: 0 }, environment);
      const issued = await administrator.post(`${origin}/tools/beta/api/suite/invitations/issue`, {
        headers: { 'x-mistri-account': user.id },
        data: { subjectId, roles: ['reader'], expectedRevision: 0, expiresAt: Date.now() + 60000 },
      });
      expect(issued.status()).toBe(200);
      const invitation = await issued.json();
      await page.goto(`${origin}${invitation.acceptUrl}`);
      await expect(page.getByRole('link', { name: 'beta', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
      await expect(page.getByRole('link', { name: 'beta', exact: true })).toHaveAttribute('href', '/tools/beta/');
      expect(page.url()).not.toContain('#');
      await expect(page.getByLabel('Default App', { exact: true })).toHaveValue('alpha');
      await page.getByLabel('Default App', { exact: true }).selectOption('');
      await page.getByRole('button', { name: 'Save default App', exact: true }).click();
      await expect(page.locator('#preference-status')).toContainText('Default App saved.');
      const ask = await page.request.get(`${origin}/tools/api/suite/preferences`, { headers: { 'x-mistri-account': subjectId } });
      expect(await ask.json()).toMatchObject({ defaultApp: null, revision: 2 });
    } finally {
      await administrator.dispose();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Sign out of the suite', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect((await page.request.get(`${origin}/tools/alpha/api/schema`)).status()).toBe(401);
    expect((await page.request.get(`${origin}/tools/beta/api/schema`)).status()).toBe(401);
  } finally {
    await suite?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
