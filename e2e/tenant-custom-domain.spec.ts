/**
 * A tenant brings its own domain in a real browser (http/customDomains.ts, TenantDomains.tsx): an admin of north adds
 * one from Settings, is shown the two DNS records to make, points them (the suite's resolver is this spec's table, so
 * no real DNS is asked), runs Check now, and the domain goes live. From then on it serves north and nothing of south:
 * a host sign-in there ends in a session pinned to it, which reads north's items and not south's.
 * Every host resolves to loopback in the browser alone (`--host-resolver-rules`); the suite is this spec's own.
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
import { validateCustomDomains, type DnsRecordType, type DnsResolver } from '../packages/mistri/src/server/http/customDomains';
import { createSuite } from '../packages/mistri/src/server/http/suite';
import { provisionStores } from '../packages/mistri/src/server/maintenance';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp';
import { listTenantHosts, seedTenantHosts } from '../packages/mistri/src/server/tenant/tenantMaintenance';
import { createSqliteTenantAdministration } from '../packages/mistri/src/server/tenant/tenantStore';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStoreContract';
import { parseAppConfig } from '../packages/mistri/src/shared/app';

const appId = 'domain-proof';
/* The deployment's own host is loopback: a suite serves plain HTTP only there. */
const STAFF = 'localhost',
  NORTH = 'north.example.test',
  SOUTH = 'south.example.test',
  /* A public name, as a tenant's own domain would be. */
  SHOP = 'shop.example.com',
  TARGET = 'domains.example.net';
const email = 'olivia@example.test',
  password = 'custom-domain-password-123';

test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${NORTH} 127.0.0.1, MAP ${SOUTH} 127.0.0.1, MAP ${SHOP} 127.0.0.1`] } });

async function openSuite() {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-custom-domain-e2e-'));
  const business = join(directory, 'business.db'),
    store = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  db.exec('CREATE TABLE physical_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  db.exec("INSERT INTO physical_item VALUES ('n1', 'north', 'North lantern'), ('s1', 'south', 'South kettle')");
  const source = { id: 'business', connection: 'fixture-business' };
  const binding = { appId, source, storeId: 'fixture-store' };
  const where = { sqlite: business };
  await provisionStores(where, { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration'] });
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
  /* DNS as a table the spec writes; nothing answers until the admin has been shown what to make. */
  const zone: Record<string, Partial<Record<DnsRecordType, string[]>>> = {};
  const resolver: DnsResolver = { lookup: async (name, type) => zone[name]?.[type] ?? [] };
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Domain proof',
        auth: { store, signUp: 'open', rows: 'tenant', roles: { member: { read: true } } },
        sources: { business: { connection: source.connection } },
        resources: { item: { physical: 'physical_item', owner: 'tenant' } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        nav: ['items'],
      },
      'custom domain e2e fixture',
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
                BETTER_AUTH_SECRET: 'synthetic-custom-domain-e2e-secret-of-thirty-two-chars',
                MISTRI_TEST_AUTH_LIMITS: 'off',
                NODE_ENV: 'test',
              },
            });
            const domains = options.domains?.({ where, owner: binding });
            const owner = await createTenantAuthenticatedHttpServer({
              loaded,
              auth,
              sourceClient: false,
              browser: true,
              mount: { base: basePath, apps: { [appId]: '' } },
              /* A domain added at run time is admitted by asking the suite's router, not by a list fixed at start. */
              bound: {
                host: '127.0.0.1',
                port,
                allowedHosts: options.allowedHosts,
                ...(options.allowsHost ? { allowsHost: options.allowsHost } : {}),
              },
              publicURL: staffOrigin,
              ...(options.hosts.length ? { hosts: options.hosts } : {}),
              ...(options.primaryHost ? { primaryHost: options.primaryHost } : {}),
              ...(options.hostIntent ? { hostIntent: (_app: string, host: string) => options.hostIntent!(host) } : {}),
              ...(options.suiteBase !== undefined ? { suiteBase: options.suiteBase } : {}),
              ...(options.platformHost ? { platformHost: options.platformHost } : {}),
              ...(domains ? { domains } : {}),
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
            return {
              server: owner.server,
              hostSignIn: owner.hostSignIn,
              /* The hosts come from the store's table once a tenant may add one; the configured two are seeded. */
              tenantHosts: {
                list: () => listTenantHosts(where, binding),
                seed: async (hosts: readonly { host: string; tenantId: string }[]) => {
                  await seedTenantHosts(where, binding, { hosts, operator: 'config' });
                },
              },
              ...(domains ? { domains } : {}),
              stop: owner.retire,
              close: async () => {},
            };
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
        customDomains: validateCustomDomains(
          { enabled: true, target: TARGET, editors: ['member'], certificates: 'none' },
          { publicOrigin: staffOrigin },
        ),
        domainSeams: { resolver },
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
  /* Asked from Node, where the browser's host mapping does not reach: loopback, with the host named in the header. */
  const statusOn = (host: string, path: string) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host: `${host}:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  return { port, zone, origin: (host: string) => `http://${host}:${port}`, statusOn, signUp, grant, close };
}

test('an admin adds a domain, makes the records it shows, checks it, and the domain serves that tenant alone', async ({ page }) => {
  const suite = await openSuite();
  try {
    const olivia = await suite.signUp();
    await suite.grant(olivia.accountId, 'north');
    await suite.grant(olivia.accountId, 'south');
    await page.context().addCookies(
      olivia.cookies.map((pair) => {
        const at = pair.indexOf('=');
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: suite.origin(STAFF) };
      }),
    );

    // Before it is added and checked, the domain answers nothing of the App's.
    expect(await suite.statusOn(SHOP, `/api/whoami?app=${appId}`)).toBe(403);

    // On the deployment's own host, in north's lease, the Domains section of Settings.
    await page.goto(`${suite.origin(STAFF)}/settings`);
    await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'north', exact: true }).click();
    const domains = page.getByRole('region', { name: 'Domains' });
    await expect(domains).toBeVisible();
    await expect(domains.getByText(NORTH)).toBeVisible();
    await domains.getByLabel('Domain', { exact: true }).fill(SHOP);
    await domains.getByRole('button', { name: 'Add domain' }).click();
    await expect(domains.getByText('Waiting for DNS')).toBeVisible();

    // The two records it asks for, read off the page as the admin would copy them.
    await expect(domains.getByText(`_mistri-verify.${SHOP}`)).toBeVisible();
    await expect(domains.getByText(TARGET, { exact: true })).toBeVisible();
    await expect(domains.getByRole('button', { name: 'Copy the TXT value' })).toBeVisible();
    const token = (await domains.getByText(/^mistri-[\w-]{24,}$/).textContent())?.trim() ?? '';
    expect(token).toMatch(/^mistri-[\w-]{24,}$/);

    // A row may be checked once every 30 seconds, so the one check waits until the records exist (the not-found
    // answer is held by the unit tests, which have no such wait).
    suite.zone[`_mistri-verify.${SHOP}`] = { TXT: [token] };
    suite.zone[SHOP] = { CNAME: [TARGET] };
    await domains.getByRole('button', { name: 'Check now' }).click();
    await expect(domains.getByText('Both records were found.')).toBeVisible();
    await expect(domains.getByText('Live', { exact: true })).toBeVisible();

    // The live domain's own sign-in, through the staff host's confirm page, ends pinned to it, in north.
    const whoami = `/api/whoami?app=${appId}`;
    await expect.poll(() => suite.statusOn(SHOP, whoami), { timeout: 10_000 }).toBe(200);
    await page.goto(`${suite.origin(SHOP)}/_mistri/sign-in?to=${encodeURIComponent('/')}`);
    await expect(page.getByRole('heading', { name: `Continue to ${SHOP}?` })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL((url) => url.host === `${SHOP}:${suite.port}`);
    await expect(page.getByText('North lantern')).toBeVisible();
    await expect(page.getByText('South kettle')).toHaveCount(0);
    const onShop = (await (await page.goto(`${suite.origin(SHOP)}${whoami}`))!.json()) as Record<string, unknown>;
    expect(onShop.signedIn).toBe(true);
    expect(onShop.pinned).toBe(true);
    // Asked for south by name, the domain does not hand it over: Olivia is a member of south too, yet north is the
    // only tenant it offers, and nothing of south's is drawn.
    await page.goto(`${suite.origin(SHOP)}/items?tenant=south`);
    const tenants = page.getByRole('list', { name: 'Available tenants' });
    await expect(tenants.getByRole('button')).toHaveCount(1);
    await expect(tenants.getByRole('button', { name: 'north', exact: true })).toBeVisible();
    await expect(page.getByText('South kettle')).toHaveCount(0);
  } finally {
    await suite.close();
  }
});
