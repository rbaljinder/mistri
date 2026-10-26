/** Checked authored CTAs across real independent App hosts and their external mounts. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant';

test('notes and headlines use checked mounted links, fresh grants and document navigation', async ({ page, context }) => {
  // Two cold App hosts and five document loads share this journey's budget.
  // CI reaches the final revoked-grant navigation just as the default 40s ends.
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'tw-suite-links-'));
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
      const record = { app: 'beta', kind: 'record', resource: 'note', key: { id: { column: 'id' } } };
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          id,
          name: id,
          resources: { note: {} },
          auth: { providers: ['email'], roles: { reader: { read: true } } },
          views: {
            notes: { kind: 'list', from: 'note', ...(id === 'beta' ? { path: 'work' } : {}), show: ['id', 'body'] },
            ...(id === 'alpha'
              ? {
                  overview: {
                    kind: 'dashboard',
                    label: 'Overview',
                    sections: [
                      {
                        kind: 'note',
                        text: 'Other workspace',
                        action: { label: 'Open Beta workspace', to: { app: 'beta', kind: 'home' } },
                      },
                    ],
                  },
                }
              : {}),
          },
          home: id === 'alpha' ? 'overview' : 'notes',
          nav: id === 'alpha' ? ['overview', 'notes'] : ['notes'],
          pages: {
            note: {
              base: 'note',
              sections:
                id === 'alpha'
                  ? [
                      { kind: 'note', text: 'Read the other App', action: { label: 'Open Beta record', to: record } },
                      {
                        kind: 'headline',
                        show: ['body'],
                        links: [
                          { label: 'Beta headline', to: record },
                          { label: 'Back to notes', to: 'notes' },
                        ],
                      },
                    ]
                  : [{ kind: 'fields', show: ['body'] }],
            },
          },
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
    const environment = { SECRET: 'suite-links-browser-test-secret-longer-than-thirty-two-characters' };
    suite = await startConfiguredSuite(file, environment);
    const origin = suite.publicURL;
    const signup = await page.request.post(`${origin}/tools/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: 'Link Reader', email: 'links@example.test', password: 'links-browser-password-long-enough' },
    });
    expect(signup.status()).toBe(200);
    const subjectId = (await signup.json()).user.id as string;
    for (const appId of ['alpha', 'beta'])
      await changeSuiteGrant(file, { appId, subjectId, roles: ['reader'], expectedRevision: 0 }, environment);
    const resolutions: Array<{ body: unknown; headers: Record<string, string> }> = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/suite/links/resolve'))
        resolutions.push({ body: request.postDataJSON(), headers: request.headers() });
    });
    // Retained source context storage must never be copied into the suite transport.
    await context.addInitScript(() =>
      sessionStorage.setItem(
        'mistri.tenant-context',
        JSON.stringify({ appId: 'alpha', accountId: 'old', tenantId: 'north', tabId: 'old-tab' }),
      ),
    );
    await page.goto(`${origin}/tools/desk`);
    await expect(page.getByRole('link', { name: 'Open Beta workspace', exact: true })).toHaveAttribute('href', '/tools/?app=beta');
    await page.goto(`${origin}/tools/desk/notes/9007199254740993`);
    const link = page.getByRole('link', { name: 'Open Beta record', exact: true });
    await expect(link).toHaveAttribute('href', '/tools/work/9007199254740993');
    await expect(page.getByRole('link', { name: 'Beta headline', exact: true })).toHaveAttribute('href', '/tools/work/9007199254740993');
    // The new tab is waited for by its document request, not as a page: Playwright reports a tab
    // only once it has attached to it, and a tab whose navigation commits during the attach is
    // never reported (a CI timeout in waitForEvent('page'), the tab loaded all the same).
    const target = `${origin}/tools/work/9007199254740993`;
    const requested = context.waitForEvent('request', {
      timeout: 15_000,
      predicate: (sent) => sent.isNavigationRequest() && sent.url() === target,
    });
    await link.click({ modifiers: ['ControlOrMeta'] });
    await requested;
    // Whatever tab the click opened, read the document it asked for in one this test holds.
    for (const other of context.pages()) if (other !== page) await other.close();
    const opened = await context.newPage();
    await opened.goto(target);
    await expect(opened).toHaveURL(target);
    await expect(opened.getByText('beta record', { exact: true }).first()).toBeVisible();
    await opened.close();
    await page.evaluate(() => {
      (window as unknown as { sourceDocument: string }).sourceDocument = 'alpha';
    });
    await link.click();
    await expect(page).toHaveURL(`${origin}/tools/work/9007199254740993`);
    expect(await page.evaluate(() => (window as unknown as { sourceDocument?: string }).sourceDocument)).toBeUndefined();
    await expect(page.getByText('beta record', { exact: true }).first()).toBeVisible();
    expect(resolutions.length).toBeGreaterThan(0);
    expect(resolutions.map((request) => request.body)).toContainEqual({
      sourceApp: 'alpha',
      target: { app: 'beta', kind: 'record', resource: 'note', key: { id: '9007199254740993' } },
    });
    for (const request of resolutions) {
      expect(request.headers['x-mistri-account']).toBe(subjectId);
      expect(Object.keys(request.headers).filter((key) => key.startsWith('x-mistri-') && key !== 'x-mistri-account')).toEqual([]);
      expect(request.body).toMatchObject({ sourceApp: 'alpha', target: { app: 'beta' } });
      expect(JSON.stringify(request.body)).not.toContain('old-tab');
    }
    await changeSuiteGrant(file, { appId: 'beta', subjectId, roles: [], expectedRevision: 1 }, environment);
    const denied = page.waitForResponse((response) => response.url().endsWith('/api/suite/links/resolve') && response.status() === 404);
    await page.goto(`${origin}/tools/desk/notes/9007199254740993`);
    await denied;
    await expect(page.getByRole('link', { name: 'Open Beta record', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Beta headline', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to notes', exact: true })).toBeVisible();
  } finally {
    await suite?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
