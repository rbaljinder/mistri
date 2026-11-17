/**
 * Tenant custom domains, phase D3 (docs/tenant-domains.md §4–5): the suite's `customDomains` validated, DNS read over
 * DoH with no system resolver, the check's state machine (pending → verified → live, three failures in 72 hours →
 * suspended, a pass restores), the service a Domains panel and the CLI share, and the suite's own parts: the daily
 * recheck, the 301 from a platform subdomain to a primary custom domain, and Caddy's `/_mistri/tls-allowed`. A suite
 * with no `customDomains` has none of it. Every resolver and certificate provider here is a fake: nothing leaves the box.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { hostRefusal } from '../packages/engine/src/server/http/trust.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import {
  certificateRequested,
  createTenantDomains,
  CustomDomainRefusal,
  customHostRefusal,
  dohResolver,
  nextHostState,
  PENDING_EXPIRY_MS,
  SUSPEND_WINDOW_MS,
  validateCustomDomains,
  verifyCustomDomain,
  type CertificateState,
  type DnsRecordType,
  type DnsResolver,
  type HostCertificates,
  type TenantDomainsService,
  type TenantDomainsStore,
} from '../packages/mistri/src/server/http/customDomains.js';
import { getTenantHostIntent, validateTenantDomain } from '../packages/mistri/src/server/http/tenantHosts.js';
import {
  addCustomTenantHost,
  listTenantHosts,
  putTenant,
  recordTenantHostCheck,
  seedTenantHosts,
} from '../packages/mistri/src/server/tenant/tenantMaintenance.js';
import type { TenantHostRow } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';

const binding = { appId: 'store', source: { id: 'business', connection: 'db' }, storeId: 'store-tenants' };
const STAFF = 'https://staff.yourapp.test';
const DOMAIN = validateTenantDomain('yourapp.test', STAFF)!;
const HOUR = 60 * 60 * 1000;
const operator = 'ops';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
/** A raw request, so the Host header is whatever the test says (fetch would not let it be a name that does not resolve). */
function raw(port: number, host: string, path = '/', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; head: string; body: string }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('HTTP test timed out.')));
    socket.on('error', reject);
    socket.on('data', (data) => (answer += data));
    socket.on('end', () => {
      const split = answer.indexOf('\r\n\r\n');
      resolve({ status: Number(/^HTTP\/1.1 (\d+)/.exec(answer)?.[1] ?? 0), head: answer.slice(0, split), body: answer.slice(split + 4) });
    });
    const extra = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`));
  });
}
const header = (head: string, name: string) => new RegExp(`^${name}: (.*)$`, 'im').exec(head)?.[1]?.trim();

async function store(t: TestContext, owner: typeof binding = binding) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-custom-domains-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'business.db');
  new DatabaseSync(path).close();
  await maintenance.provisionStores({ sqlite: path }, { app: { tenant: owner }, only: ['tenant-store', 'tenant-administration'] });
  const where = { sqlite: path };
  return { path, where, rows: () => listTenantHosts(where, owner) };
}

/** DNS as a table the test writes: `zone['shop.example.com'].CNAME = ['acme.yourapp.test']`. */
function fakeDns() {
  const zone: Record<string, Partial<Record<DnsRecordType, string[]>>> = {};
  let down = false;
  const asked: string[] = [];
  const resolver: DnsResolver = {
    async lookup(name, type) {
      asked.push(`${type} ${name}`);
      if (down) return 'unavailable';
      return zone[name]?.[type] ?? [];
    },
  };
  return {
    zone,
    asked,
    resolver,
    setDown: (value: boolean) => (down = value),
    point(host: string, token: string, target: string) {
      zone[`_mistri-verify.${host}`] = { TXT: [token] };
      zone[host] = { CNAME: [target] };
    },
  };
}

/** A certificate provider that says what the test says, and remembers what it was asked. */
function fakeCertificates(state: { next: CertificateState; failRelease?: boolean }) {
  const calls: string[] = [];
  /** Whose domain each call said it was, in order. */
  const tenants: string[] = [];
  const certificates: HostCertificates = {
    async request(host, tenantId) {
      calls.push(`request ${host}`);
      tenants.push(tenantId);
      return state.next;
    },
    async status(host, tenantId) {
      calls.push(`status ${host}`);
      tenants.push(tenantId);
      return state.next;
    },
    async release(host, tenantId) {
      calls.push(`release ${host}`);
      tenants.push(tenantId);
      if (state.failRelease) throw new Error('provider down');
    },
  };
  return { calls, tenants, certificates };
}

test('customDomains validation: opt-in, a target or tenantDomain to point at, a bounded limit, a known provider', () => {
  const context = { tenantDomain: DOMAIN, publicOrigin: STAFF };
  assert.equal(validateCustomDomains(undefined, context), undefined);
  assert.equal(validateCustomDomains({ enabled: false }, context), undefined);
  assert.deepEqual(validateCustomDomains({ enabled: true }, context), { limit: 2, certificates: 'none' });
  assert.deepEqual(validateCustomDomains({ enabled: true, limit: 5, certificates: 'caddy', editors: ['owner'] }, context), {
    limit: 5,
    certificates: 'caddy',
    editors: ['owner'],
  });
  assert.throws(() => validateCustomDomains({ enabled: true }, { tenantDomain: DOMAIN }), /publicOrigin/);
  assert.throws(() => validateCustomDomains({ enabled: true }, { publicOrigin: STAFF }), /target|tenantDomain/);
  assert.equal(validateCustomDomains({ enabled: true, target: 'edge.yourapp.test' }, { publicOrigin: STAFF })?.target, 'edge.yourapp.test');
  for (const bad of [
    { enabled: 'yes' },
    { enabled: true, limit: 0 },
    { enabled: true, limit: 101 },
    { enabled: true, limit: 1.5 },
    { enabled: true, certificates: 'letsencrypt' },
    { enabled: true, editors: [] },
    { enabled: true, surprise: 1 },
    [],
    'on',
  ])
    assert.throws(() => validateCustomDomains(bad, context), Error, JSON.stringify(bad));
});

test('DoH asks 1.1.1.1 first and 8.8.8.8 when it fails; NXDOMAIN is an empty answer, both failing is unavailable', async () => {
  const urls: string[] = [];
  const answers: Response[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    const next = answers.shift();
    if (!next) throw new Error('network');
    return next;
  }) as unknown as typeof fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/dns-json' } });
  const resolver = dohResolver(fetcher);

  answers.push(
    json({
      Status: 0,
      Answer: [
        { type: 16, data: '"mv-abc" "def"' },
        { type: 5, data: 'ignored.' },
      ],
    }),
  );
  assert.deepEqual(await resolver.lookup('_mistri-verify.shop.example.com', 'TXT'), ['mv-abcdef']);
  assert.match(urls[0]!, /^https:\/\/1\.1\.1\.1\/dns-query\?name=_mistri-verify\.shop\.example\.com&type=TXT$/);

  urls.length = 0;
  answers.push(json({ Status: 2 }), json({ Status: 0, Answer: [{ type: 5, data: 'Acme.YourApp.test.' }] }));
  assert.deepEqual(await resolver.lookup('shop.example.com', 'CNAME'), ['acme.yourapp.test']);
  assert.match(urls[0]!, /^https:\/\/1\.1\.1\.1\//);
  assert.match(urls[1]!, /^https:\/\/8\.8\.8\.8\/resolve\?/);

  answers.push(json({ Status: 3 }));
  assert.deepEqual(await resolver.lookup('nothing.example.com', 'A'), []);

  urls.length = 0;
  answers.push(json({}, 500));
  assert.equal(await resolver.lookup('shop.example.com', 'A'), 'unavailable');
  assert.equal(urls.length, 2, 'both resolvers, and nothing else');
});

test('verifying wants the token and a CNAME at a target; an apex may answer with the target’s own addresses', async () => {
  const dns = fakeDns();
  const targets = ['acme.yourapp.test'];
  assert.equal(await verifyCustomDomain(dns.resolver, 'shop.example.com', 'mv-1', targets), 'failed');
  dns.point('shop.example.com', 'mv-1', 'acme.yourapp.test');
  assert.equal(await verifyCustomDomain(dns.resolver, 'shop.example.com', 'mv-1', targets), 'ok');
  assert.equal(await verifyCustomDomain(dns.resolver, 'shop.example.com', 'mv-2', targets), 'failed', 'another row’s token');
  dns.zone['shop.example.com'] = { CNAME: ['someone-else.test'] };
  assert.equal(await verifyCustomDomain(dns.resolver, 'shop.example.com', 'mv-1', targets), 'failed');

  dns.zone['_mistri-verify.example.com'] = { TXT: ['mv-apex'] };
  dns.zone['example.com'] = { A: ['203.0.113.7'] };
  dns.zone['acme.yourapp.test'] = { A: ['203.0.113.7'], AAAA: [] };
  assert.equal(await verifyCustomDomain(dns.resolver, 'example.com', 'mv-apex', targets), 'ok');
  dns.zone['example.com'] = { A: ['203.0.113.7', '198.51.100.1'] };
  assert.equal(await verifyCustomDomain(dns.resolver, 'example.com', 'mv-apex', targets), 'failed', 'one address elsewhere');

  dns.setDown(true);
  assert.equal(await verifyCustomDomain(dns.resolver, 'shop.example.com', 'mv-1', targets), 'unavailable');
});

test('the check’s states: verified until the certificate is active, three failures in 72 hours suspend, a pass restores', () => {
  const at = 1_000_000_000_000;
  assert.deepEqual(nextHostState({ status: 'pending', checkedAt: null, failures: 0 }, 'ok', 'pending', at), {
    status: 'verified',
    checkedAt: at,
    failures: 0,
    unavailableSince: null,
  });
  assert.equal(nextHostState({ status: 'verified', checkedAt: at, failures: 0 }, 'ok', 'active', at).status, 'live');
  assert.equal(
    nextHostState({ status: 'live', checkedAt: at, failures: 0 }, 'ok', 'pending', at).status,
    'live',
    'a live host is not demoted by a renewal',
  );
  // A pending domain serves nothing, so a failure there counts toward nothing.
  assert.deepEqual(nextHostState({ status: 'pending', checkedAt: at, failures: 0 }, 'failed', undefined, at + HOUR), {
    status: 'pending',
    checkedAt: at + HOUR,
    failures: 0,
    unavailableSince: null,
  });
  let row = { status: 'live' as const, checkedAt: at, failures: 0 } as {
    status: 'live' | 'suspended';
    checkedAt: number | null;
    failures: number;
  };
  for (const [day, expected] of [
    [1, 'live'],
    [2, 'live'],
    [3, 'suspended'],
  ] as const) {
    row = nextHostState(row, 'failed', undefined, at + day * 24 * HOUR) as typeof row;
    assert.equal(row.status, expected, `failure ${day}`);
  }
  assert.equal(nextHostState(row, 'ok', 'active', at + 4 * 24 * HOUR).status, 'live', 'a pass restores it');
  // Failures spread wider than the window start the streak over.
  const sparse = nextHostState({ status: 'live', checkedAt: at, failures: 2 }, 'failed', undefined, at + 73 * HOUR);
  assert.deepEqual([sparse.status, sparse.failures], ['live', 1]);
});

test('a claim refuses a malformed, special, platform or held name, and says nothing about who holds it', () => {
  const context = {
    staffHost: 'staff.yourapp.test',
    tenantDomain: DOMAIN,
    target: 'edge.yourapp.test',
    held: (host: string) => host === 'taken.example.com',
  };
  for (const bad of [
    '',
    'Shop.Example.com',
    'https://shop.example.com',
    'shop.example.com:443',
    '*.example.com',
    '203.0.113.7',
    'example',
    'a..b.com',
  ])
    assert.match(customHostRefusal(bad, context) ?? '', /Enter a domain name/, bad);
  for (const special of ['printer.local', 'box.localhost', 'x.internal', 'hidden.onion', '1.2.3.4.in-addr.arpa'])
    assert.match(customHostRefusal(special, context) ?? '', /not a public domain/, special);
  assert.match(customHostRefusal('staff.yourapp.test', context) ?? '', /platform's own/);
  assert.match(customHostRefusal('edge.yourapp.test', context) ?? '', /platform's own/);
  assert.match(customHostRefusal('acme.yourapp.test', context) ?? '', /under yourapp\.test/);
  assert.match(customHostRefusal('taken.example.com', context) ?? '', /already taken/);
  assert.doesNotMatch(customHostRefusal('taken.example.com', context)!, /acme|store|tenant/i);
  assert.equal(customHostRefusal('shop.example.com', context), undefined);
});

/** The service over one SQLite tenant store, with the held-by check reading a router over the same table. */
async function service(
  t: TestContext,
  options: {
    limit?: number;
    certificate?: { next: CertificateState; failRelease?: boolean };
    snapshot?: (appId: string) => readonly TenantHostRow[] | undefined;
  } = {},
) {
  const s = await store(t);
  const dns = fakeDns();
  const cert = fakeCertificates(options.certificate ?? { next: 'active' });
  /* Rows are stamped with the real time when made, so the service's clock starts there and a test moves it. */
  const clock = { now: Date.now() };
  const warnings: string[] = [];
  const config = validateCustomDomains(
    { enabled: true, ...(options.limit ? { limit: options.limit } : {}) },
    { tenantDomain: DOMAIN, publicOrigin: STAFF },
  )!;
  const domains = createTenantDomains(
    { where: s.where, owner: binding },
    {
      config,
      certificates: cert.certificates,
      resolver: dns.resolver,
      staffHost: 'staff.yourapp.test',
      tenantDomain: DOMAIN,
      // Every row in any state, across the App's table: the same reading the suite gives it.
      heldBy: async (host) => {
        const row = (await s.rows()).find((each) => each.host === host);
        return row ? { app: row.app, tenant: row.tenantId } : undefined;
      },
      ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      now: () => clock.now,
      warn: (message) => warnings.push(message),
    },
  );
  for (const tenantId of ['acme', 'bright'])
    await putTenant(s.where, binding, { tenantId, status: 'active', expectedVersion: null, operator, tenantDomain: DOMAIN });
  return { s, dns, cert, domains, warnings, clock };
}

test('adding: a pending row with its own random token, the limit counted, and another tenant’s or a held name refused', async (t) => {
  const { domains, s } = await service(t);
  const added = await domains.add('acme', 'Shop.Example.com.', 'admin@acme');
  assert.equal(added.host, 'shop.example.com', 'trimmed, lowercased, the trailing dot dropped');
  assert.equal(added.status, 'pending');
  assert.equal(added.claimed, true);
  assert.deepEqual(added.records?.cname, { type: 'CNAME', name: 'shop.example.com', value: 'acme.yourapp.test' });
  assert.equal(added.records?.txt.name, '_mistri-verify.shop.example.com');
  assert.equal(added.records?.apex, false);

  const second = await domains.add('acme', 'example.com', 'admin@acme');
  assert.equal(second.records?.apex, true);
  const tokens = [added.records!.txt.value, second.records!.txt.value];
  assert.notEqual(tokens[0], tokens[1], 'a token per row');
  for (const token of tokens) assert.ok(token.length >= 20, `token ${token} carries enough randomness`);

  await assert.rejects(
    domains.add('acme', 'third.example.com', 'admin@acme'),
    (error: CustomDomainRefusal) => error instanceof CustomDomainRefusal,
  );
  // Bright's own add of a name acme holds is the same "taken" as any held name: whose it is never shows.
  await assert.rejects(domains.add('bright', 'shop.example.com', 'admin@bright'), /already taken/);
  await assert.rejects(domains.add('bright', 'acme.yourapp.test', 'admin@bright'), /under yourapp\.test/);
  await assert.rejects(domains.add('bright', 'staff.yourapp.test', 'admin@bright'), /platform's own/);

  // A tenant cannot check, remove or make primary another's domain, and the refusal is the same as for no domain at all.
  for (const act of [
    () => domains.check('bright', 'shop.example.com', 'admin@bright'),
    () => domains.remove('bright', 'shop.example.com', 'admin@bright'),
    () => domains.primary('bright', 'shop.example.com', 'admin@bright'),
  ])
    await assert.rejects(
      act(),
      (error: CustomDomainRefusal) => error.status === 404 && /not one of this organization's domains/.test(error.message),
    );
  await assert.rejects(domains.check('bright', 'nobody.example.com', 'admin@bright'), (error: CustomDomainRefusal) => error.status === 404);
  assert.deepEqual(
    (await domains.list('bright')).map((row) => row.host),
    ['bright.yourapp.test'],
    'bright lists only its own',
  );
  assert.equal((await s.rows()).filter((row) => row.kind === 'custom').length, 2);
});

test('check now: pending → verified while the certificate is issued → live; remove releases it, even when release fails', async (t) => {
  const state = { next: 'pending' as CertificateState, failRelease: false };
  const { domains, dns, cert, s, warnings } = await service(t, { certificate: state });
  const added = await domains.add('acme', 'shop.example.com', 'admin@acme');
  const failed = await domains.check('acme', 'shop.example.com', 'admin@acme');
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.status, 'pending');
  assert.equal(cert.calls.length, 0, 'no certificate before DNS points here');

  dns.point('shop.example.com', added.records!.txt.value, 'acme.yourapp.test');
  dns.setDown(true);
  const unavailable = await domains.check('acme', 'shop.example.com', 'admin@acme');
  assert.deepEqual([unavailable.outcome, unavailable.status], ['unavailable', 'pending']);
  dns.setDown(false);

  const verified = await domains.check('acme', 'shop.example.com', 'admin@acme');
  assert.deepEqual([verified.outcome, verified.status], ['ok', 'verified']);
  assert.deepEqual(cert.calls, ['request shop.example.com']);
  state.next = 'active';
  const live = await domains.check('acme', 'shop.example.com', 'admin@acme');
  assert.deepEqual([live.outcome, live.status], ['ok', 'live']);

  await domains.primary('acme', 'shop.example.com', 'admin@acme');
  assert.equal((await s.rows()).find((row) => row.host === 'shop.example.com')?.primary, true);

  state.failRelease = true;
  await domains.remove('acme', 'shop.example.com', 'admin@acme');
  assert.ok(cert.calls.includes('release shop.example.com'));
  assert.ok(
    warnings.some((message) => message.includes('shop.example.com')),
    'a failed release is said, and the removal stands',
  );
  assert.equal(
    (await s.rows()).some((row) => row.host === 'shop.example.com'),
    false,
  );
  // The subdomain, the operator's, is not the tenant's to remove.
  await assert.rejects(domains.remove('acme', 'acme.yourapp.test', 'admin@acme'));
});

/** A suite of one tenant App over a real store, with the domains seams faked. */
async function suiteWith(t: TestContext, customDomains: unknown) {
  const s = await store(t);
  const dns = fakeDns();
  const cert = fakeCertificates({ next: 'active' });
  let clock = Date.now();
  let domains: TenantDomainsService | undefined;
  let offered: ((store: TenantDomainsStore) => TenantDomainsService) | undefined;
  const open = async (
    _base: string,
    options: {
      allowedHosts: readonly string[];
      allowsHost?: (host: string) => boolean;
      domains?: (store: TenantDomainsStore) => TenantDomainsService;
    },
  ) => {
    offered = options.domains;
    domains = options.domains?.({ where: s.where, owner: binding });
    return {
      server: createServer((req, res) => {
        if (
          hostRefusal(req, {
            host: '127.0.0.1',
            port: 4111,
            allowedHosts: options.allowedHosts,
            ...(options.allowsHost ? { allowsHost: options.allowsHost } : {}),
          })
        ) {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ intent: getTenantHostIntent(req) }));
      }),
      tenantHosts: {
        list: () => listTenantHosts(s.where, binding),
        seed: async (hosts: readonly { host: string; tenantId: string }[]) => {
          await seedTenantHosts(s.where, binding, { hosts, operator: 'config' });
        },
      },
      ...(domains ? { domains } : {}),
      stop: async () => {},
      close: async () => {},
    };
  };
  const config = validateCustomDomains(customDomains, { tenantDomain: DOMAIN, publicOrigin: STAFF });
  for (const tenantId of ['acme', 'bright'])
    await putTenant(s.where, binding, { tenantId, status: 'active', expectedVersion: null, operator, tenantDomain: DOMAIN });
  const suite = await createSuite(
    [{ id: 'store', public: true, open }],
    {
      publicOrigin: STAFF,
      tenantDomain: DOMAIN,
      ...(config ? { customDomains: config } : {}),
      domainSeams: { resolver: dns.resolver, certificates: cert.certificates, now: () => clock },
    },
    { route: () => undefined, close: () => {} },
  );
  t.after(() => suite.close());
  const port = await listen(suite.server);
  return {
    s,
    dns,
    cert,
    suite,
    port,
    offered: () => offered,
    domains: () => domains!,
    advance: (ms: number) => (clock += ms),
    /** Adds and verifies a domain for a tenant, so it is live. */
    async liveDomain(tenantId: string, host: string) {
      const added = await domains!.add(tenantId, host, `admin@${tenantId}`);
      dns.point(host, added.records!.txt.value, `${tenantId}.yourapp.test`);
      const checked = await domains!.check(tenantId, host, `admin@${tenantId}`);
      assert.equal(checked.status, 'live');
      await suite.refreshHosts();
    },
  };
}

test('a live custom domain serves its tenant only; the daily check suspends it after three failures and a pass restores it', async (t) => {
  const f = await suiteWith(t, { enabled: true, certificates: 'caddy' });
  assert.equal((await raw(f.port, 'shop.example.com')).status, 403, 'not before it is verified');
  await f.liveDomain('acme', 'shop.example.com');
  const served = await raw(f.port, 'shop.example.com', '/api/whoami');
  assert.equal(served.status, 200);
  assert.deepEqual(JSON.parse(served.body.slice(served.body.indexOf('{'), served.body.lastIndexOf('}') + 1)).intent, {
    host: 'shop.example.com',
    app: 'store',
    tenant: 'acme',
  });

  // DNS moves away. A check within the day is not due; each day's is, and the third failure suspends.
  f.dns.zone['shop.example.com'] = { CNAME: ['elsewhere.example.net'] };
  await f.suite.recheckDomains();
  assert.equal((await f.s.rows()).find((row) => row.host === 'shop.example.com')?.failures, 0, 'not due yet');
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warned.push(String(message));
  t.after(() => (console.warn = warn));
  for (let day = 1; day <= 3; day++) {
    f.advance(24 * HOUR);
    await f.suite.recheckDomains();
  }
  console.warn = warn;
  const row = (await f.s.rows()).find((each) => each.host === 'shop.example.com')!;
  assert.deepEqual([row.status, row.failures], ['suspended', 3]);
  assert.ok(
    warned.some((message) => /shop\.example\.com.*suspended/.test(message)),
    'the suspension is said',
  );
  assert.equal((await raw(f.port, 'shop.example.com')).status, 403, 'a suspended host is refused at once in this process');
  assert.equal((await raw(f.port, 'acme.yourapp.test', '/api/whoami')).status, 200, 'the subdomain keeps serving');

  // DNS comes back: the next pass restores it.
  f.dns.zone['shop.example.com'] = { CNAME: ['acme.yourapp.test'] };
  f.advance(24 * HOUR);
  await f.suite.recheckDomains();
  assert.equal((await f.s.rows()).find((each) => each.host === 'shop.example.com')?.status, 'live');
  assert.equal((await raw(f.port, 'shop.example.com', '/api/whoami')).status, 200);

  // Removed, it stops at once.
  await f.domains().remove('acme', 'shop.example.com', 'admin@acme');
  assert.equal((await raw(f.port, 'shop.example.com')).status, 403);
  assert.ok(f.cert.calls.includes('release shop.example.com'));
});

test('a transition to suspended or back to live is logged once; a domain that stays in a state logs nothing more', async (t) => {
  const f = await suiteWith(t, { enabled: true, certificates: 'caddy' });
  await f.liveDomain('acme', 'shop.example.com');
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void said.push(String(message));
  t.after(() => (console.warn = warn));
  const mine = () => said.filter((message) => message.includes('shop.example.com'));
  f.dns.zone['shop.example.com'] = { CNAME: ['elsewhere.example.net'] };
  for (let day = 1; day <= 3; day++) {
    f.advance(24 * HOUR);
    await f.suite.recheckDomains();
  }
  assert.equal(mine().filter((message) => /suspended/.test(message)).length, 1, 'the suspension is said once');
  // Still suspended across more ticks, and more than once in a day: nothing new.
  for (let tick = 0; tick < 3; tick++) {
    f.advance(24 * HOUR);
    await f.suite.recheckDomains();
    await f.suite.recheckDomains();
  }
  assert.equal(mine().length, 1, 'staying suspended says nothing more');
  assert.ok(!/token|_mistri-verify/.test(mine()[0]), 'no token or record value in the line');

  f.dns.zone['shop.example.com'] = { CNAME: ['acme.yourapp.test'] };
  f.advance(24 * HOUR);
  await f.suite.recheckDomains();
  assert.equal(mine().filter((message) => /live again/.test(message)).length, 1, 'the restore is said once');
  for (let tick = 0; tick < 2; tick++) {
    f.advance(24 * HOUR);
    await f.suite.recheckDomains();
  }
  assert.equal(mine().length, 2, 'staying live says nothing more');
});

test('a repointed domain is not another tenant’s: its row stays where it was claimed, and no other tenant may take it', async (t) => {
  const f = await suiteWith(t, { enabled: true });
  await f.liveDomain('acme', 'shop.example.com');
  // The name's DNS now points at bright's subdomain, with acme's token still there: it is still acme's, nobody else's.
  f.dns.zone['shop.example.com'] = { CNAME: ['bright.yourapp.test'] };
  await assert.rejects(f.domains().add('bright', 'shop.example.com', 'admin@bright'), /already taken/);
  await assert.rejects(
    f.domains().check('bright', 'shop.example.com', 'admin@bright'),
    (error: CustomDomainRefusal) => error.status === 404,
  );
  const served = await raw(f.port, 'shop.example.com', '/api/whoami');
  assert.equal(JSON.parse(served.body.slice(served.body.indexOf('{'), served.body.lastIndexOf('}') + 1)).intent.tenant, 'acme');
});

test('a primary custom domain: pages on the subdomain move to it for good; API calls, assets and the staff host stay', async (t) => {
  const f = await suiteWith(t, { enabled: true });
  await f.liveDomain('acme', 'shop.example.com');
  const html = { accept: 'text/html,application/xhtml+xml' };
  // Not primary yet: the subdomain answers itself.
  assert.equal((await raw(f.port, 'acme.yourapp.test', '/orders?x=1', html)).status, 200);
  await f.domains().primary('acme', 'shop.example.com', 'admin@acme');
  await f.suite.refreshHosts();
  const moved = await raw(f.port, 'acme.yourapp.test', '/orders?x=1', html);
  assert.equal(moved.status, 301);
  assert.equal(header(moved.head, 'location'), 'https://shop.example.com/orders?x=1');
  for (const path of ['/api/whoami', '/_mistri/sign-in', '/assets/app.js'])
    assert.notEqual((await raw(f.port, 'acme.yourapp.test', path, html)).status, 301, path);
  assert.notEqual((await raw(f.port, 'acme.yourapp.test', '/orders')).status, 301, 'no Accept: text/html, not a page');
  assert.notEqual((await raw(f.port, 'shop.example.com', '/orders', html)).status, 301, 'the primary itself');
  assert.notEqual((await raw(f.port, 'bright.yourapp.test', '/orders', html)).status, 301, 'another tenant');
  assert.notEqual((await raw(f.port, 'staff.yourapp.test', '/', html)).status, 301, 'the staff host');
});

test('tls-allowed answers Caddy with a status and nothing else: yes only for a verified or live custom domain', async (t) => {
  const f = await suiteWith(t, { enabled: true, certificates: 'caddy' });
  const ask = (domain: string, host = 'staff.yourapp.test') =>
    raw(f.port, host, `/_mistri/tls-allowed?domain=${encodeURIComponent(domain)}`);
  const added = await f.domains().add('acme', 'shop.example.com', 'admin@acme');
  await f.suite.refreshHosts();
  for (const domain of ['shop.example.com', 'acme.yourapp.test', 'staff.yourapp.test', 'nobody.example.com', '']) {
    const answer = await ask(domain);
    assert.equal(answer.status, 404, `${domain}: pending, the operator's or unknown`);
    assert.equal(answer.body, '');
  }
  f.dns.point('shop.example.com', added.records!.txt.value, 'acme.yourapp.test');
  await f.domains().check('acme', 'shop.example.com', 'admin@acme');
  await f.suite.refreshHosts();
  const yes = await ask('SHOP.example.com');
  assert.equal(yes.status, 200);
  assert.equal(yes.body, '');
  assert.equal(header(yes.head, 'content-length'), '0');
  // Asked on a tenant's own host it is not the question at all: that host's App answers, not the suite.
  assert.notEqual((await ask('shop.example.com', 'shop.example.com')).body, '');
});

test('tls-allowed is not served unless the provider is caddy', async (t) => {
  const f = await suiteWith(t, { enabled: true, certificates: 'none' });
  await f.liveDomain('acme', 'shop.example.com');
  // The suite does not answer it: the request goes on to the staff host's App, which says so in its own body.
  const answer = await raw(f.port, 'staff.yourapp.test', '/_mistri/tls-allowed?domain=shop.example.com');
  assert.match(answer.body, /\{/);
});

test('with no customDomains nothing changes: no domain service, no tls-allowed, no move to a custom domain', async (t) => {
  const f = await suiteWith(t, undefined);
  assert.equal(f.offered(), undefined);
  assert.equal(f.domains(), undefined);
  // A custom row written by hand (as an operator might) is still served when live, but never moved to or offered to Caddy.
  await seedTenantHosts(f.s.where, binding, { hosts: [{ host: 'shop.example.com', tenantId: 'acme' }], operator: 'config' });
  await f.suite.refreshHosts();
  assert.match((await raw(f.port, 'staff.yourapp.test', '/_mistri/tls-allowed?domain=shop.example.com')).body, /\{/);
  assert.equal((await raw(f.port, 'acme.yourapp.test', '/orders', { accept: 'text/html' })).status, 200);
  await f.suite.recheckDomains();
  assert.equal((await raw(f.port, 'acme.yourapp.test', '/api/whoami')).status, 200);
});

/* ---------- review fixes: expiry, release, unavailable, duplicates ---------- */

test('a claim still pending after seven days is dropped by the hourly job, and its name is free again; a verified one stays', async (t) => {
  const { domains, dns, s, clock } = await service(t);
  const old = await domains.add('acme', 'old.example.com', 'admin@acme');
  const kept = await domains.add('acme', 'kept.example.com', 'admin@acme');
  dns.point('kept.example.com', kept.records!.txt.value, 'acme.yourapp.test');
  assert.equal((await domains.check('acme', 'kept.example.com', 'admin@acme')).status, 'live');
  const [made] = (await s.rows()).filter((row) => row.host === 'old.example.com');
  assert.equal(PENDING_EXPIRY_MS, 7 * 24 * HOUR);
  assert.equal(old.expiresAt, made!.createdAt + PENDING_EXPIRY_MS, 'the panel is told when it ends');
  assert.equal(
    (await domains.list('acme')).find((row) => row.host === 'kept.example.com')?.expiresAt,
    undefined,
    'only a pending claim expires',
  );

  clock.now += PENDING_EXPIRY_MS - HOUR;
  assert.deepEqual((await domains.recheckDue(23 * HOUR)).expired, [], 'not yet');
  assert.ok((await s.rows()).some((row) => row.host === 'old.example.com'));

  clock.now += 2 * HOUR;
  const swept = await domains.recheckDue(23 * HOUR);
  assert.deepEqual(swept.expired, [{ host: 'old.example.com', tenantId: 'acme' }]);
  const rows = await s.rows();
  assert.equal(
    rows.some((row) => row.host === 'old.example.com'),
    false,
    'the unproven claim no longer holds the name',
  );
  assert.equal(rows.find((row) => row.host === 'kept.example.com')?.status, 'live');
  // Another tenant can claim it now; and a pending claim that was dropped had no certificate to release.
  await domains.add('bright', 'old.example.com', 'admin@bright');
});

test('removing a pending claim never asks the provider to release a certificate; a verified one releases it, tagged with its tenant', async (t) => {
  const { domains, dns, cert } = await service(t);
  await domains.add('acme', 'pending.example.com', 'admin@acme');
  await domains.remove('acme', 'pending.example.com', 'admin@acme');
  assert.deepEqual(cert.calls, [], 'a name nobody proved is not a certificate this tenant ever asked for');

  const added = await domains.add('acme', 'proven.example.com', 'admin@acme');
  dns.point('proven.example.com', added.records!.txt.value, 'acme.yourapp.test');
  await domains.check('acme', 'proven.example.com', 'admin@acme');
  await domains.remove('acme', 'proven.example.com', 'admin@acme');
  assert.deepEqual(cert.calls, ['request proven.example.com', 'release proven.example.com']);
  assert.ok(
    cert.tenants.every((tenant) => tenant === 'acme'),
    'every call says whose domain it is',
  );

  for (const [row, expected] of [
    [{ kind: 'custom', source: 'claimed', status: 'pending' }, false],
    [{ kind: 'custom', source: 'claimed', status: 'verified' }, true],
    [{ kind: 'custom', source: 'claimed', status: 'live' }, true],
    [{ kind: 'custom', source: 'claimed', status: 'suspended' }, true],
    [{ kind: 'custom', source: 'operator', status: 'live' }, false],
    [{ kind: 'subdomain', source: 'claimed', status: 'live' }, false],
  ] as const)
    assert.equal(certificateRequested(row), expected, JSON.stringify(row));
});

test('a plain list is served from the router’s snapshot, and a change’s own reply reads the table', async (t) => {
  const rows: TenantHostRow[] = [];
  const { domains, s } = await service(t, { snapshot: (app) => (app === 'store' ? rows : undefined) });
  rows.push(
    Object.freeze({
      host: 'snapshot-only.example.com',
      tenantId: 'acme',
      app: 'store',
      kind: 'custom',
      status: 'live',
      primary: false,
      source: 'claimed',
      verifyToken: 'tok',
      checkedAt: null,
      failures: 0,
      createdAt: 1,
      unavailableSince: null,
    } as TenantHostRow),
  );
  assert.deepEqual(
    (await domains.list('acme')).map((row) => row.host),
    ['snapshot-only.example.com'],
    'no transaction is opened to answer a GET',
  );
  assert.deepEqual(
    (await domains.list('acme', true)).map((row) => row.host),
    ['acme.yourapp.test'],
    'fresh reads the table',
  );
  assert.equal(
    (await s.rows()).some((row) => row.host === 'snapshot-only.example.com'),
    false,
  );
});

test('answers that are only "unavailable" are noted once, and after 72 hours of nothing else they count as failures and suspend', async (t) => {
  const { domains, dns, s, warnings, clock } = await service(t);
  const added = await domains.add('acme', 'shop.example.com', 'admin@acme');
  dns.point('shop.example.com', added.records!.txt.value, 'acme.yourapp.test');
  assert.equal((await domains.check('acme', 'shop.example.com', 'admin@acme')).status, 'live');
  const row = async () => (await s.rows()).find((each) => each.host === 'shop.example.com')!;
  const start = clock.now;

  dns.setDown(true);
  assert.equal((await domains.check('acme', 'shop.example.com', 'admin@acme')).outcome, 'unavailable');
  assert.equal((await row()).unavailableSince, start, 'the streak begins');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /shop\.example\.com/);
  assert.doesNotMatch(warnings[0]!, new RegExp(added.records!.txt.value), 'the warning carries no token');

  clock.now = start + 40 * HOUR;
  await domains.check('acme', 'shop.example.com', 'admin@acme');
  const midway = await row();
  assert.deepEqual([midway.status, midway.failures, midway.unavailableSince], ['live', 0, start]);
  assert.equal(warnings.length, 1, 'said once, not at every check');

  // Past the window every check is a failure, on the existing path: the third suspends.
  const seen: string[] = [];
  for (const hours of [73, 74, 75]) {
    clock.now = start + hours * HOUR;
    await domains.check('acme', 'shop.example.com', 'admin@acme');
    seen.push((await row()).status);
  }
  assert.deepEqual(seen, ['live', 'live', 'suspended']);
  assert.equal((await row()).unavailableSince, start);

  // A real answer ends the streak: a pass restores it and clears the note.
  dns.setDown(false);
  clock.now = start + 80 * HOUR;
  await domains.check('acme', 'shop.example.com', 'admin@acme');
  const restored = await row();
  assert.deepEqual([restored.status, restored.failures, restored.unavailableSince], ['live', 0, null]);
  // And any other answer mid-streak (here a failure) starts over rather than being counted with it.
  dns.setDown(true);
  clock.now += HOUR;
  await domains.check('acme', 'shop.example.com', 'admin@acme');
  assert.equal((await row()).unavailableSince, clock.now);
  dns.setDown(false);
  dns.zone['shop.example.com'] = { CNAME: ['elsewhere.example.net'] };
  clock.now += HOUR;
  await domains.check('acme', 'shop.example.com', 'admin@acme');
  const failed = await row();
  assert.deepEqual([failed.failures, failed.unavailableSince], [1, null]);
  assert.ok(SUSPEND_WINDOW_MS === 72 * HOUR);
});

test('tls-allowed says yes when any App holds the name verified or live, whichever table is read first', async (t) => {
  const second = { ...binding, appId: 'store2', storeId: 'store-tenants-2' };
  const [one, two] = [await store(t), await store(t, second)];
  for (const [where, owner] of [
    [one.where, binding],
    [two.where, second],
  ] as const)
    await putTenant(where, owner, { tenantId: 'acme', status: 'active', expectedVersion: null, operator, tenantDomain: DOMAIN });
  const config = validateCustomDomains({ enabled: true, certificates: 'caddy' }, { tenantDomain: DOMAIN, publicOrigin: STAFF });
  const open = (s: { where: { sqlite: string } }, owner: typeof binding) => async () => ({
    server: createServer((_req, res) => res.writeHead(200).end('{}')),
    tenantHosts: { list: () => listTenantHosts(s.where, owner), seed: async () => {} },
    stop: async () => {},
    close: async () => {},
  });
  const suite = await createSuite(
    [
      { id: 'store', public: true, open: open(one, binding) },
      { id: 'store2', public: true, open: open(two, second) },
    ],
    {
      publicOrigin: STAFF,
      tenantDomain: DOMAIN,
      customDomains: config!,
      domainSeams: { resolver: fakeDns().resolver, certificates: fakeCertificates({ next: 'active' }).certificates },
    },
    { route: () => undefined, close: () => {} },
  );
  t.after(() => suite.close());
  const port = await listen(suite.server);
  const ask = async (domain: string) => (await raw(port, 'staff.yourapp.test', `/_mistri/tls-allowed?domain=${domain}`)).status;
  const claim = async (s: typeof one, owner: typeof binding, host: string, verified: boolean) => {
    await addCustomTenantHost(s.where, owner, { tenantId: 'acme', host, operator, limit: 5 });
    if (!verified) return;
    const read = (await listTenantHosts(s.where, owner)).find((row) => row.host === host)!;
    await recordTenantHostCheck(s.where, owner, {
      tenantId: 'acme',
      host,
      operator,
      read,
      next: { status: 'verified', checkedAt: 1, failures: 0, unavailableSince: null },
    });
  };
  // The same name held pending by one App and verified by the other, both ways round: the proven one decides.
  await claim(one, binding, 'dup-a.example.com', false);
  await claim(two, second, 'dup-a.example.com', true);
  await claim(one, binding, 'dup-b.example.com', true);
  await claim(two, second, 'dup-b.example.com', false);
  await claim(one, binding, 'both-pending.example.com', false);
  await claim(two, second, 'both-pending.example.com', false);
  await suite.refreshHosts();
  assert.equal(await ask('dup-a.example.com'), 200);
  assert.equal(await ask('dup-b.example.com'), 200);
  assert.equal(await ask('both-pending.example.com'), 404, 'pending in every table is still no');
});
