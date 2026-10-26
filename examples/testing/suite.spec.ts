/** Shared suite login in a browser, on a desk and a phone: the landing rules, the chooser and a journey
 * across two Apps on one sign-in. Each test owns its suite, databases, accounts and grants. */
import { test as base, expect, type Page } from '@playwright/test';
import { createTestWorkspace, startTestSuite } from '@mistriwork/mistri/testing';

const PASSWORD = 'suite-fixture-password-long-enough';
const APPS = { desk: { name: 'Front desk', role: 'clerk' }, ledger: { name: 'Ledger', role: 'auditor' } } as const;
const note = (id: keyof typeof APPS) => `${APPS[id].name} note`;

interface Suite {
  url: string;
  chooser: string;
}
const test = base.extend<{ suite: Suite }>({
  suite: async ({ browserName }, use) => {
    if (!browserName) throw new Error('A browser project is required.');
    const workspace = await createTestWorkspace();
    try {
      const apps = [];
      for (const [id, { name, role }] of Object.entries(APPS)) {
        const database = await workspace.database(`apps/${id}/business.db`, (db) => {
          db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
          db.prepare('INSERT INTO note VALUES (1, ?)').run(`${name} note`);
        });
        await workspace.write(`apps/${id}/app.json`, {
          id,
          name,
          resources: { note: {} },
          auth: { providers: ['email'], roles: { [role]: { read: ['note'] } } },
          views: { notes: { kind: 'list', from: 'note', show: ['body'] } },
          home: 'notes',
        });
        await workspace.write(`apps/${id}/connections.json`, { connections: [{ name: 'data', url: database }] });
        apps.push({ id, directory: `./apps/${id}`, config: `./apps/${id}/connections.json`, mount: `/${id}` });
      }
      const host = await startTestSuite({
        workspace,
        environment: { SECRET: 'suite-fixture-secret-longer-than-thirty-two-characters' },
        configuration: {
          apps,
          identity: {
            id: 'fixture',
            name: 'Fixture suite',
            store: './identity.db',
            grants: './grants.db',
            environment: { BETTER_AUTH_SECRET: 'SECRET' },
            // An auditor starts in the Ledger; anyone else granted the desk starts there.
            landing: [{ app: 'ledger', roles: ['auditor'] }, { app: 'desk' }],
          },
        },
      });
      // Accounts and grants go through the suite's real maintenance and grant paths.
      const grants: Record<string, Partial<Record<keyof typeof APPS, string>>> = {
        auditor: { desk: 'clerk', ledger: 'auditor' },
        clerk: { desk: 'clerk' },
        newcomer: {},
      };
      for (const [name, granted] of Object.entries(grants)) {
        const subjectId = await host.account({ name, email: `${name}@example.test`, password: PASSWORD });
        for (const [appId, role] of Object.entries(granted)) await host.grant({ appId, subjectId, roles: [role], expectedRevision: 0 });
      }
      await use({ url: host.url, chooser: `${host.url}/_mistri/apps` });
    } finally {
      await workspace.close();
    }
  },
});
test.setTimeout(90_000);
const ready = expect.configure({ timeout: 30_000 });

async function signIn(page: Page, who: string) {
  await page.getByLabel('Email', { exact: true }).fill(`${who}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
const sees = (page: Page, id: keyof typeof APPS) => page.getByText(note(id), { exact: true }).filter({ visible: true });

test('the suite address lands each account by its grants, and the chooser says when there is none', async ({ page, suite }) => {
  await page.goto(suite.url);
  await expect(page).toHaveURL(`${suite.chooser}?entry=1`);
  await signIn(page, 'auditor');
  await ready(sees(page, 'ledger')).toBeVisible();
  await expect(page).toHaveURL(/\/ledger\//);

  await page.context().clearCookies();
  await page.goto(suite.url);
  await signIn(page, 'clerk');
  await ready(sees(page, 'desk')).toBeVisible();
  await expect(page).toHaveURL(/\/desk\//);

  await page.context().clearCookies();
  await page.goto(suite.url);
  await signIn(page, 'newcomer');
  await expect(page.getByText('No App access has been granted yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out of the suite', exact: true })).toBeVisible();
  // On a phone (the mobile project) the chooser must not scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('one sign-in carries across Apps, another App’s page names what is missing, and signing out ends both', async ({ page, suite }) => {
  await page.goto(`${suite.url}/ledger/notes`);
  await signIn(page, 'auditor');
  await ready(sees(page, 'ledger')).toBeVisible();
  // The journey: to the chooser, then into the other App, with no second sign-in.
  await page.goto(suite.chooser);
  await page.getByRole('link', { name: APPS.desk.name, exact: true }).click();
  await ready(sees(page, 'desk')).toBeVisible();
  expect((await page.request.get(`${suite.url}/ledger/api/schema`)).status()).toBe(200);

  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await page.request.get(`${suite.url}/ledger/api/schema`)).status()).toBe(401);

  // A clerk following a Ledger link is told so, and its rows never draw.
  await page.goto(`${suite.url}/ledger/notes`);
  await signIn(page, 'clerk');
  await expect(page).toHaveURL(`${suite.chooser}?next=%2Fledger%2Fnotes`);
  await expect(page.getByRole('alert')).toHaveText(/Your account has no access to Ledger\./);
  await expect(page.getByText(note('ledger'))).toHaveCount(0);
});
