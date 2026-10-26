/** Isolated real-App navigation targets. Intentionally separate from shared preview listeners. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';

test('grouped nav targets navigate fresh documents at target mounts and disappear after revoke', async ({ page, context }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-nav-targets-'));
  let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  try {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const apps = [];
    for (const id of ['alpha', 'beta']) {
      const home = join(directory, id);
      mkdirSync(home);
      const db = new DatabaseSync(join(home, 'business.db'));
      db.exec('CREATE TABLE note(id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)');
      db.prepare('INSERT INTO note VALUES (?, ?)').run('9007199254740993', `${id} record`);
      db.close();
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          id,
          name: id,
          resources: { note: {} },
          auth: { providers: ['email'], roles: { reader: { read: true } } },
          views: { notes: { kind: 'list', from: 'note', path: 'work', show: ['body'] } },
          home: 'notes',
          nav:
            id === 'alpha'
              ? [
                  'notes',
                  {
                    id: 'other',
                    label: 'Other workspace',
                    children: [
                      { label: 'Lender file', to: { app: 'beta', kind: 'record', resource: 'note', key: { id: '9007199254740993' } } },
                    ],
                  },
                ]
              : ['notes'],
          ui: { shell: { placement: 'top' } },
          pages: { note: { base: 'note', sections: [{ kind: 'fields', show: ['body'] }] } },
        }),
      );
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: join(home, 'business.db') }] }));
      apps.push({ id, directory: `./${id}`, config: `./${id}/connections.json`, mount: id === 'alpha' ? '/desk' : '/' });
    }
    const file = join(directory, 'suite.json');
    writeFileSync(
      file,
      JSON.stringify({
        port,
        basePath: '/tools',
        apps,
        identity: {
          id: 'shared',
          name: 'Shared',
          store: './identity.db',
          grants: './grants.db',
          environment: { BETTER_AUTH_SECRET: 'SECRET' },
        },
      }),
    );
    const environment = { SECRET: 'nav-target-browser-test-secret-longer-than-thirty-two-characters' };
    suite = await startConfiguredSuite(file, environment);
    const origin = suite.publicURL;
    const signup = await page.request.post(`${origin}/tools/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: 'Nav Reader', email: 'nav@example.test', password: 'nav-browser-password-long-enough' },
    });
    expect(signup.status()).toBe(200);
    const subjectId = (await signup.json()).user.id as string;
    for (const appId of ['alpha', 'beta'])
      await changeSuiteGrant(file, { appId, subjectId, roles: ['reader'], expectedRevision: 0 }, environment);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${origin}/tools/desk`);
    const menu = page.getByRole('button', { name: 'Other workspace', exact: true });
    await page.keyboard.press('Escape');
    await menu.click();
    const link = page.getByRole('menuitem', { name: 'Lender file', exact: true });
    await expect(link).toHaveAttribute('href', '/tools/work/9007199254740993');
    await expect(link).not.toHaveAttribute('aria-current');
    // The new tab is waited for by its document request, not as a page: a tab whose navigation commits while
    // Playwright attaches is never reported as one (suite-links.spec.ts says more).
    const target = `${origin}/tools/work/9007199254740993`;
    const requested = context.waitForEvent('request', {
      timeout: 15_000,
      predicate: (sent) => sent.isNavigationRequest() && sent.url() === target,
    });
    await link.click({ modifiers: ['ControlOrMeta'] });
    await requested;
    for (const other of context.pages()) if (other !== page) await other.close();
    await page.keyboard.press('Escape');
    await menu.click();
    await page.evaluate(() => {
      (window as unknown as { sourceDocument: boolean }).sourceDocument = true;
    });
    await link.click();
    await expect(page).toHaveURL(`${origin}/tools/work/9007199254740993`);
    expect(await page.evaluate(() => (window as unknown as { sourceDocument?: boolean }).sourceDocument)).toBeUndefined();
    await expect(page.getByText('beta record', { exact: true }).first()).toBeVisible();
    await changeSuiteGrant(file, { appId: 'beta', subjectId, roles: [], expectedRevision: 1 }, environment);
    const denied = page.waitForResponse((response) => response.url().endsWith('/api/suite/links/resolve') && response.status() === 404);
    await page.goto(`${origin}/tools/desk`);
    await denied;
    await expect(menu).toHaveCount(0);
    await expect(link).toHaveCount(0);
    await expect(page.locator('.tn-wide [data-table]')).toHaveCount(1);
  } finally {
    await suite?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
