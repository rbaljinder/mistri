/**
 * Sign-in on a tenant's own host in a real browser (auth/hostHandoff.ts): the trip from a mapped host to the
 * deployment's own and back, through the custom domain's confirm page, ends in a session that counts on that host and
 * on no other — not on another tenant's host and not on the deployment's own, even when its cookie is carried there.
 * The tenant hosts resolve to loopback in the browser alone (`--host-resolver-rules`); the suite is this spec's own.
 */
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { withFreePort } from './support/freePort';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth';
import { createSuite } from '../packages/mistri/src/server/http/suite';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStoreContract';
import { parseAppConfig } from '../packages/mistri/src/shared/app';

const appId = 'host-proof';
/* The deployment's own host is loopback: a suite serves plain HTTP only there. */
const STAFF = 'localhost',
  NORTH = 'north.example.test',
  SOUTH = 'south.example.test';
const email = 'olivia@example.test',
  password = 'host-sign-in-password-123';

test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${NORTH} 127.0.0.1, MAP ${SOUTH} 127.0.0.1`] } });

async function openSuite() {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-host-sign-in-e2e-'));
  const business = join(directory, 'business.db'),
    store = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  db.exec('CREATE TABLE physical_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  const source = { id: 'business', connection: 'fixture-business' };
  const binding = { appId, source, storeId: 'fixture-store' };
  provisionSqliteTenantStore(business, binding);
  const maintenance = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
  });
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Host proof',
        auth: { store, signUp: 'open', rows: 'tenant', roles: { member: { read: true } } },
        sources: { business: { connection: source.connection } },
        resources: { item: { physical: 'physical_item', owner: 'tenant' } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        nav: ['items'],
      },
      'host e2e fixture',
    ),
  };
  let auth: AppAuthRuntime | undefined;
  const opened = await withFreePort(async (port) => {
    const staffOrigin = `http://${STAFF}:${port}`;
    const suite = await createSuite(
      [
        {
          id: appId,
          public: true,
          open: async (basePath, options) => {
            auth = await createAppAuth(loaded, {
              baseURL: `${staffOrigin}${basePath}`,
              listenHost: '127.0.0.1',
              trustedOrigins: [staffOrigin],
              environment: {
                BETTER_AUTH_SECRET: 'synthetic-host-sign-in-e2e-secret-of-thirty-two-characters',
                MISTRI_TEST_AUTH_LIMITS: 'off',
                NODE_ENV: 'test',
              },
            });
            const owner = await createTenantAuthenticatedHttpServer({
              loaded,
              auth,
              sourceClient: false,
              browser: true,
              mount: { base: basePath, apps: { [appId]: '' } },
              bound: { host: '127.0.0.1', port, allowedHosts: options.allowedHosts },
              publicURL: staffOrigin,
              ...(options.hosts.length ? { hosts: options.hosts } : {}),
              ...(options.hostIntent ? { hostIntent: (_app: string, host: string) => options.hostIntent!(host) } : {}),
              ...(options.suiteBase !== undefined ? { suiteBase: options.suiteBase } : {}),
              ...(options.platformHost ? { platformHost: options.platformHost } : {}),
              enrollment: {
                policy: defineAppTenantPolicy({
                  kind: 'tenant',
                  appId,
                  storeId: binding.storeId,
                  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
                  resolveMembershipRows: () => ({ item: true }),
                  resolveRows: () => ({ item: true }),
                }),
                source: { ...source, existingPath: business },
                deployment: 'browser-generation',
                roles: ['member'],
                maxLifetimeMs: 60000,
              },
            });
            return { server: owner.server, hostSignIn: owner.hostSignIn, stop: owner.retire, close: async () => {} };
          },
        },
      ],
      {
        mounts: { [appId]: '' },
        publicOrigin: staffOrigin,
        hosts: [
          { host: NORTH, app: appId, tenant: 'north' },
          { host: SOUTH, app: appId, tenant: 'south' },
        ],
      },
    );
    suite.server.listen(port, '127.0.0.1');
    try {
      await once(suite.server, 'listening');
    } catch (error) {
      await suite.close().catch(() => {});
      throw error;
    }
    return { suite, port };
  });
  const { suite, port } = opened;
  /* The account is made over the wire as the staff host's own sign-up form would; the browser does the rest. */
  const signUp = () =>
    new Promise<{ accountId: string; cookies: string[] }>((resolve, reject) => {
      const body = JSON.stringify({ name: 'Olivia', email, password });
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/auth/sign-up/email',
          headers: {
            host: `${STAFF}:${port}`,
            origin: `http://${STAFF}:${port}`,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () =>
            res.statusCode === 200
              ? resolve({
                  accountId: String((JSON.parse(text) as { user: { id: string } }).user.id),
                  cookies: ((res.headers['set-cookie'] as string[] | undefined) ?? []).map((line) => line.split(';')[0]),
                })
              : reject(new Error(`sign-up answered ${res.statusCode}`)),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const grant = (accountId: string, tenantId: string) =>
    maintenance((admin) =>
      admin.putMembership({
        tenantId,
        accountId,
        membershipId: `${tenantId}-${accountId}`,
        status: 'active',
        roles: ['member'],
        validUntil: Date.now() + 120_000,
        expectedVersion: null,
      }),
    );
  const close = async () => {
    try {
      suite.server.closeAllConnections();
      await suite.close();
    } finally {
      auth?.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
  return { port, origin: (host: string) => `http://${host}:${port}`, signUp, grant, close };
}

test('a session signed in on a tenant host counts there, and is refused on another tenant host and on the staff host', async ({
  page,
  browser,
}) => {
  const suite = await openSuite();
  try {
    const olivia = await suite.signUp();
    await suite.grant(olivia.accountId, 'north');
    await suite.grant(olivia.accountId, 'south');
    // Signed in on the deployment's own host already, as a person arriving from it would be.
    await page.context().addCookies(
      olivia.cookies.map((pair) => {
        const at = pair.indexOf('=');
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: suite.origin(STAFF) };
      }),
    );
    const whoami = `/api/whoami?app=${appId}`;

    // On north, the host's sign-in goes to the staff host, which asks by the host's name before it hands anything over.
    await page.goto(`${suite.origin(NORTH)}/_mistri/sign-in?to=${encodeURIComponent(whoami)}`);
    expect(new URL(page.url()).host).toBe(`${STAFF}:${suite.port}`);
    await expect(page.getByRole('heading', { name: `Continue to ${NORTH}?` })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${suite.origin(NORTH)}${whoami}`);
    const onNorth = JSON.parse((await page.locator('body').textContent()) ?? '{}') as Record<string, unknown>;
    expect(onNorth.signedIn).toBe(true);
    expect(onNorth.pinned).toBe(true);

    // The session north was handed, carried by hand to south and to the staff host: it counts on neither.
    const pinned = (await page.context().cookies(suite.origin(NORTH))).filter((cookie) => cookie.name.includes('session_token'));
    expect(pinned.length).toBeGreaterThan(0);
    const carried = await browser.newContext();
    try {
      for (const host of [SOUTH, STAFF])
        await carried.addCookies(pinned.map((cookie) => ({ name: cookie.name, value: cookie.value, url: suite.origin(host) })));
      const elsewhere = await carried.newPage();
      for (const host of [SOUTH, STAFF]) {
        const answer = await elsewhere.goto(`${suite.origin(host)}${whoami}`);
        expect(answer?.status(), host).toBe(200);
        expect(((await answer!.json()) as { signedIn?: unknown }).signedIn, host).toBe(false);
      }
      // And on north itself, carried the same way, it still counts: the refusals above are the host's, not the copy's.
      await carried.addCookies(pinned.map((cookie) => ({ name: cookie.name, value: cookie.value, url: suite.origin(NORTH) })));
      const home = await elsewhere.goto(`${suite.origin(NORTH)}${whoami}`);
      expect(((await home!.json()) as { signedIn?: unknown }).signedIn).toBe(true);
    } finally {
      await carried.close();
    }
  } finally {
    await suite.close();
  }
});
