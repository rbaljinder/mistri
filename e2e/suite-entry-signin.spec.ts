/** Entry continuation is a fixed, once-only root navigation after sign-in. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { suiteChooserPage } from '../packages/mistri/src/server/auth/suiteChooser';
import { openSuiteIdentity } from '../packages/mistri/src/server/auth/suiteIdentity';
import { createSuite } from '../packages/mistri/src/server/http/suite';
import { parseAppConfig } from '../packages/mistri/src/shared/app';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps';

/** Real redirects and native cookies: fulfilled Playwright redirects can leave
 * interception and attempt DNS for the fake origin. Only the child document
 * contents are fixture pages; entry, sign-in, grants and preferences are real. */
async function openEntrySuite() {
  const temporaryRoot = join(tmpdir(), 'opencode');
  mkdirSync(temporaryRoot, { recursive: true });
  const dir = mkdtempSync(join(temporaryRoot, 'tw-suite-entry-browser-'));
  let identity: Awaited<ReturnType<typeof openSuiteIdentity>> | undefined;
  let suite: Awaited<ReturnType<typeof createSuite>> | undefined;
  try {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    const businessPath = join(dir, 'business.db'),
      db = new DatabaseSync(businessPath);
    try {
      db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY)');
    } finally {
      db.close();
    }
    const deployments = ['lender', 'benefits'].map((id) => {
      const app: LoadedApp = {
        path: join(dir, id),
        pages: [],
        sources: {},
        app: parseAppConfig(
          {
            id,
            name: id === 'lender' ? 'Lender' : 'Benefits',
            resources: { note: {} },
            auth: { providers: ['email'], roles: { reader: { read: true } } },
            views: { notes: { kind: 'list', from: 'note' } },
            home: 'notes',
          },
          'entry browser fixture',
        ),
      };
      return {
        app,
        basePath: id === 'lender' ? '/tools' : '/tools/benefits',
        environment: {},
        connections: [{ name: 'data', url: businessPath }],
      };
    });
    identity = await openSuiteIdentity(
      {
        port,
        basePath: '/tools',
        apps: [],
        identity: {
          id: 'shared',
          name: 'Suite',
          store: join(dir, 'identity.db'),
          grants: join(dir, 'grants.db'),
          environment: { BETTER_AUTH_SECRET: 'test-entry-browser-secret-longer-than-thirty-two-characters' },
        },
      },
      deployments,
    );
    const owner = identity;
    suite = await createSuite(
      deployments.map((item) => ({
        id: item.app.app.id,
        open: async (basePath: string) => {
          const auth = owner.forApp(item.app, basePath);
          return {
            server: createServer((req, res) => {
              void auth
                .session(req)
                .then((principal) => {
                  if (!principal) {
                    res.writeHead(401).end('App access unavailable.');
                    return;
                  }
                  res
                    .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
                    .end(`<h1>${item.app.app.name} home</h1>`);
                })
                .catch(() => {
                  if (!res.headersSent) res.writeHead(503).end('App access unavailable.');
                  else res.destroy();
                });
            }),
            stop: async () => {},
            close: async () => {},
          };
        },
      })),
      { base: '/tools', mounts: { lender: '/', benefits: '/benefits' } },
      owner,
    );
    let rootRequests = 0;
    suite.server.on('request', (req) => {
      if (req.method === 'GET' && req.url?.split('?')[0] === '/tools/') rootRequests++;
    });
    await new Promise<void>((resolve) => suite!.server.listen(port, '127.0.0.1', resolve));
    return {
      origin: `http://127.0.0.1:${port}`,
      rootRequests: () => rootRequests,
      grant(subjectId: string, appId: string, roles: string[]) {
        owner.grants.change({
          subjectId,
          appId,
          roles,
          actorId: 'operator',
          declaredRoles: ['reader', 'admin'],
          expectedRevision: owner.grants.read(subjectId, appId).revision,
        });
      },
      async close() {
        try {
          await suite!.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      if (suite) await suite.close();
      else identity?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}

for (const destination of ['preferred', 'explicit-root', 'ask', 'revoked'] as const) {
  test(`signed-out root resumes ${destination} after shared sign-in without chooser loops`, async ({ page }) => {
    const suite = await openEntrySuite(),
      { origin } = suite;
    try {
      const account = await page.request.post(`${origin}/tools/api/auth/sign-up/email`, {
        headers: { origin },
        data: { name: 'Reader', email: 'reader@example.test', password: 'test-password-long-enough' },
      });
      expect(account.status()).toBe(200);
      const accountId = (await account.json()).user.id;
      suite.grant(accountId, 'lender', ['reader']);
      suite.grant(accountId, 'benefits', ['reader']);
      const headers = { origin, 'x-mistri-account': accountId };
      const saved = await page.request.post(`${origin}/tools/api/suite/preferences`, {
        headers,
        data: { defaultApp: destination === 'ask' ? null : 'benefits', expectedRevision: 0 },
      });
      expect(saved.status()).toBe(200);
      const preference = await saved.json();
      if (destination === 'revoked') suite.grant(accountId, 'benefits', []);
      expect((await page.request.post(`${origin}/tools/api/auth/sign-out`, { headers, data: {} })).status()).toBe(200);
      expect((await page.request.get(`${origin}/tools/api/suite/apps`)).status()).toBe(401);
      await page.goto(`${origin}/tools/${destination === 'explicit-root' ? '?app=lender' : ''}`);
      await expect(page).toHaveURL(`${origin}/tools/_mistri/apps?entry=1${destination === 'explicit-root' ? '&app=lender' : ''}`);
      await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
      await page.getByLabel('Password', { exact: true }).fill('test-password-long-enough');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      if (destination === 'explicit-root') await expect(page.getByRole('heading', { name: 'Lender home' })).toBeVisible();
      else if (destination === 'preferred') await expect(page.getByRole('heading', { name: 'Benefits home' })).toBeVisible();
      else {
        await expect(page).toHaveURL(`${origin}/tools/_mistri/apps`);
        await expect(page.locator('#account')).toHaveText(accountId);
      }
      expect(suite.rootRequests()).toBe(2);
      const after = await page.request.get(`${origin}/tools/api/suite/preferences`, { headers });
      expect(after.status()).toBe(200);
      expect(await after.json()).toEqual(preference);
    } finally {
      await suite.close();
    }
  });
}

test('an invitation selected during a delayed sign-in retires the old root continuation', async ({ page }) => {
  const origin = 'http://suite.test';
  let signedIn = false,
    rootRequests = 0,
    release!: () => void,
    arrived!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    signingIn = new Promise<void>((resolve) => {
      arrived = resolve;
    });
  await page.route(`${origin}/tools/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/tools/api/auth/sign-in/email') {
      arrived();
      await held;
      signedIn = true;
      return route.fulfill({ json: {} });
    }
    if (url.pathname === '/tools/api/suite/apps')
      return route.fulfill({
        status: signedIn ? 200 : 401,
        json: signedIn ? { accountId: 'reader', apps: [], preference: { defaultApp: null, revision: 0 } } : {},
      });
    if (url.pathname === '/tools/') rootRequests++;
    return route.fulfill({ contentType: 'text/html', body: suiteChooserPage('Suite', '/tools', 'fixture', 'lender') });
  });
  try {
    await page.goto(`${origin}/tools/_mistri/apps?entry=1`);
    await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
    await page.getByLabel('Password', { exact: true }).fill('test-password-long-enough');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await signingIn;
    const invitation = `#invite=benefits.${'A'.repeat(43)}`;
    await page.evaluate((hash) => {
      location.hash = hash;
    }, invitation);
    await expect(page.locator('#status')).toHaveText('Sign in to accept your App invitation.');
    release();
    await expect(page.locator('#account')).toHaveText('reader');
    await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/tools/_mistri/apps?entry=1${invitation}`);
    expect(rootRequests).toBe(0);
  } finally {
    release();
  }
});

for (const suffix of [
  '',
  '?entry=1&app=benefits',
  '?entry=1&app=lender&app=lender',
  '?entry=1&entry=1',
  '?entry=1&returnTo=https://evil.test',
  '?entry=1#manage=lender',
  `?entry=1#invite=benefits.${'A'.repeat(43)}`,
]) {
  test(`chooser sign-in stays explicit for ${suffix || 'direct chooser'}`, async ({ page }) => {
    const origin = 'http://suite.test';
    let signedIn = false,
      rootRequests = 0;
    await page.route(`${origin}/tools/**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/tools/api/auth/sign-in/email') {
        signedIn = true;
        return route.fulfill({ json: {} });
      }
      if (url.pathname === '/tools/api/suite/apps')
        return route.fulfill({
          status: signedIn ? 200 : 401,
          json: signedIn
            ? {
                accountId: 'reader',
                apps: [{ id: 'lender', name: 'Lender', href: '/tools/?app=lender', manageHref: '/tools/_mistri/apps#manage=lender' }],
                preference: { defaultApp: 'lender', revision: 1 },
              }
            : {},
        });
      if (url.pathname === '/tools/') rootRequests++;
      return route.fulfill({ contentType: 'text/html', body: suiteChooserPage('Suite', '/tools', 'fixture', 'lender') });
    });
    await page.goto(`${origin}/tools/_mistri/apps${suffix}`);
    await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
    await page.getByLabel('Password', { exact: true }).fill('test-password-long-enough');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#account')).toHaveText('reader');
    await expect(page).toHaveURL(`${origin}/tools/_mistri/apps${suffix}`);
    if (suffix.includes('#manage')) await expect(page.locator('#management')).toBeVisible();
    if (suffix.includes('#invite')) await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeVisible();
    expect(rootRequests).toBe(0);
  });
}
