import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { TransactionOutcomeUnknown } from '../packages/engine/src/adapters/adapter.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { normalizeFlagCatalog, type FlagOverrideSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { captureAppAuthRuntime, createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { HttpError } from '../packages/engine/src/server/http/reply.js';
import { identifyEpoch, unitKey, type ExperimentStore, type ExposureFact } from '../packages/mistri/src/server/experiments/contracts.js';
import {
  createAssignmentReceiptProvider,
  type TrustedAssignmentInput,
} from '../packages/mistri/src/server/experiments/assignmentReceipt.js';
import {
  createExperimentExposureHttp,
  EXPOSURE_HTTP_LIMITS,
  type ExperimentExposureLease,
  type ExperimentExposureScope,
} from '../packages/mistri/src/server/experiments/exposureHttp.js';

const start = Date.parse('2026-11-01T00:00:00Z'),
  path = '/target/api/experiments/exposures';
async function fixture(t: TestContext, visitor = false, realm: 'app' | 'tenant' | 'platform' = 'tenant') {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-exposure-http-'));
  const secret = 'native-auth-only-secret-not-the-assignment-receipt-key';
  const runtime = await createAppAuth(
    {
      path: join(dir, 'app.ts'),
      dir,
      sources: {},
      pages: [],
      app: parseAppConfig(
        {
          id: 'target',
          name: 'Target',
          auth: { store: 'auth.db', signUp: 'open', roles: { member: { read: true } } },
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'exposure',
      ),
    },
    { baseURL: 'http://localhost:4111', trustedOrigins: ['http://localhost:4111'], environment: { BETTER_AUTH_SECRET: secret } },
  );
  const auth = captureAppAuthRuntime(runtime),
    db = new DatabaseSync(runtime.store),
    date = new Date().toISOString();
  t.after(() => {
    runtime.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const id of ['subject', 'other']) {
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,?,?,?,?,?)').run(
      id,
      id,
      `${id}@example.test`,
      1,
      date,
      date,
      'member',
      0,
    );
  }
  for (const [id, account] of [
    ['session-1', 'subject'],
    ['session-2', 'subject'],
    ['session-other', 'other'],
  ]) {
    db.prepare('INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(
      id,
      id,
      account,
      new Date(Date.now() + 60_000).toISOString(),
      date,
      date,
    );
  }
  const cookie = (token = 'session-1') =>
    `mistri-target.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`)}`;
  const binding = { suiteId: 'suite', deploymentId: 'deployment' },
    key = new Uint8Array(32).fill(9);
  const catalog = normalizeFlagCatalog({
    flags: { copy: { type: 'string', default: 'a', safeValue: 'safe', owner: 'team', variants: ['a', 'b'], tenantManaged: true } },
    roles: ['member'],
    audiences: {},
  });
  const tenantId = realm === 'tenant' ? 'north' : null;
  const scope: ExperimentExposureScope = { appId: 'target', environment: 'production', tenantId, realm: visitor ? 'public' : realm };
  const lease: ExperimentExposureLease | undefined =
    visitor || realm === 'app'
      ? undefined
      : {
          appId: 'target',
          accountId: 'subject',
          tenantId: realm === 'platform' ? '@platform' : 'north',
          tabId: 'tab-one',
          context: 'context-one',
          revision: 1,
          expiresAt: Date.now() + 60_000,
          ...(realm === 'platform' ? { realm: 'platform' as const } : {}),
        };
  const requestPath = `${path}?app=target${realm === 'tenant' ? '&tenant=north' : realm === 'platform' ? '&realm=platform' : ''}`;
  const epoch = identifyEpoch(binding, {
    scope: { appId: 'target', environment: 'production', controlTenantId: null, evaluationTenantId: tenantId },
    flagId: 'copy',
    version: 'v1',
    owner: 'team',
    unit: visitor ? 'visitor' : 'subject',
    control: 'variant-0',
    arms: [
      { id: 'variant-0', value: 'a', weight: 50 },
      { id: 'variant-1', value: 'b', weight: 50 },
    ],
    eligibility: { rollout: 100, audiences: { member: { roles: ['member'], ...(tenantId === null ? {} : { tenants: [tenantId] }) } } },
    startsAtMs: start,
    endsAtMs: start + 3_600_000,
    conversionWindowMs: 3_600_000,
    deliveryGraceMs: 0,
    primary: { id: 'submitted', event: 'submitted', eventVersion: 1, unitField: 'actorId' },
    guardrails: [],
  });
  let now = start + 1000,
    active = true,
    member = true,
    killed = false,
    resolutions = 0,
    attempts = 0,
    before = async () => {},
    after = async () => {};
  let releaseFence = async () => {};
  let ownerScope = scope,
    ownerLease = lease;
  // Represents a proof previously issued by the explicit-interaction owner.
  // Neither this handler nor the assignment receipt provider establishes it.
  const visitorProof = `visitor-proof.${createHmac('sha256', 'separate-visitor-owner-test-key').update('visitor-proof:visitor-opaque').digest('base64url')}`;
  const provider = createAssignmentReceiptProvider({ appId: 'target', environment: 'production', binding, catalog, key, clock: () => now });
  const input = (account = 'subject', session = 'session-1'): TrustedAssignmentInput => {
    const global: FlagOverrideSnapshot = {
      appId: 'target',
      environment: 'production',
      tenantId: null,
      revision: 1,
      overrides: {
        copy: {
          ...(killed ? { disabled: true } : {}),
          experiment: {
            version: 'v1',
            weights: [
              { value: 'b', weight: 50 },
              { value: 'a', weight: 50 },
            ],
          },
        },
      },
    };
    return {
      epoch,
      context: {
        ...(tenantId === null ? {} : { tenantId }),
        roles: ['member'],
        identity: visitor ? { kind: 'visitor', id: 'visitor-opaque' } : { kind: 'subject', id: account },
      },
      proof: visitor ? { kind: 'visitor', id: 'visitor-proof' } : { kind: 'session', id: session },
      snapshots: { global, tenant: tenantId === null ? null : { ...global, tenantId, overrides: {} } },
    };
  };
  const facts = new Map<string, ExposureFact>();
  const store = {
    binding,
    async ingestExposure(reference, fact, guard) {
      attempts++;
      await before();
      await guard();
      const id = unitKey(reference, fact.unit, epoch.declaration.unit),
        existing = facts.get(id);
      if (!existing) facts.set(id, fact);
      await after();
      return { status: existing ? 'duplicate' : 'inserted', dataRevision: facts.size, late: false };
    },
  } satisfies Pick<ExperimentStore, 'binding' | 'ingestExposure'>;
  const pending = new Set<Promise<void>>();
  const http = createExperimentExposureHttp({
    appId: 'target',
    environment: 'production',
    bound: { host: '127.0.0.1', port: 4111 },
    mount: '/target',
    receipts: provider,
    store: store as ExperimentStore,
    async withOwner(req, res, guard, use) {
      const assertCurrent = () => {
        guard();
        auth.assertCurrent();
        if (!active) throw new HttpError(503, 'Retired.');
        if (!member) throw new HttpError(403, 'No membership.');
      };
      assertCurrent();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      pending.add(held);
      try {
        if (visitor) {
          const current = async () => {
            assertCurrent();
            if (req.headers.cookie || req.headers['x-mistri-visitor'] !== visitorProof)
              throw new HttpError(401, 'Explicit visitor proof required.');
          };
          await current();
          await use({
            request: req,
            accountId: null,
            scope: ownerScope,
            current,
            assertCurrent,
            async resolveAssignment(claims) {
              await current();
              assert.equal(claims.epoch.key, epoch.key);
              return provider.resolveAssignment(input());
            },
          });
          await releaseFence();
          await current();
          return;
        }
        const proof = await auth.sessionInstance(req);
        assertCurrent();
        if (!proof) throw new HttpError(401, 'Sign in.');
        const current = async () => {
          assertCurrent();
          await auth.observeSession(proof);
          auth.assertSessionCurrent(proof);
          assertCurrent();
        };
        await current();
        // Deliberately stage unverified headers: transport must replace these
        // from captured owner data, and remove them if the final fence fails.
        res.setHeader('x-mistri-tenant', 'UNVERIFIED_REFLECTION');
        await use({
          request: req,
          accountId: proof.identity.id,
          scope: ownerScope,
          ...(ownerLease ? { lease: { ...ownerLease, accountId: proof.identity.id } } : {}),
          assertCurrent,
          current,
          async resolveAssignment(claims) {
            await current();
            resolutions++;
            assert.equal(claims.epoch.key, epoch.key);
            assert.equal(claims.epoch.fingerprint, epoch.fingerprint);
            const assignment = provider.resolveAssignment(input(proof.identity.id, proof.sessionId));
            await current();
            return assignment;
          },
        });
        await releaseFence();
        await current();
      } finally {
        pending.delete(held);
        release();
      }
    },
  });
  function begin(headers: Record<string, string | undefined> = {}, method = 'POST', url = requestPath) {
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      url,
      method,
      headers: {
        host: 'localhost:4111',
        origin: 'http://localhost:4111',
        cookie: cookie(),
        'x-mistri-app': 'target',
        'x-mistri-account': 'subject',
        'content-type': 'application/json',
        ...(lease
          ? { 'x-mistri-tab': lease.tabId, 'x-mistri-context': lease.context, 'x-mistri-lease-revision': String(lease.revision) }
          : {}),
        ...headers,
      },
      aborted: false,
    }) as unknown as IncomingMessage;
    const reply = {
      status: 0,
      headers: {} as Record<string, unknown>,
      text: '',
      destroyed: false,
      writableEnded: false,
      setHeader(name: string, value: unknown) {
        this.headers[name] = value;
      },
      removeHeader(name: string) {
        delete this.headers[name];
      },
      writeHead(status: number, headers: Record<string, unknown>) {
        this.status = status;
        Object.assign(this.headers, headers);
        return this;
      },
      end(text: string) {
        this.text = text;
        this.writableEnded = true;
      },
    };
    const done = http(req, reply as unknown as ServerResponse);
    return { stream, req, reply, done };
  }
  const call = async (body: unknown, headers?: Record<string, string | undefined>, method?: string, url?: string) => {
    const request = begin(headers, method, url);
    request.stream.end(JSON.stringify(body));
    const handled = await request.done;
    return { ...request.reply, handled, body: request.reply.text ? JSON.parse(request.reply.text) : undefined };
  };
  return {
    db,
    provider,
    cookie,
    visitorProof,
    facts,
    begin,
    call,
    requestPath,
    lease,
    ownerScope: (value: ExperimentExposureScope) => {
      ownerScope = value;
    },
    ownerLease: (value: ExperimentExposureLease | undefined) => {
      ownerLease = value;
    },
    releaseFence: (hook: () => Promise<void>) => {
      releaseFence = hook;
    },
    issue: (session = 'session-1') => provider.issue(provider.resolveAssignment(input('subject', session))),
    attempts: () => attempts,
    resolutions: () => resolutions,
    setTime: (value: number) => {
      now = value;
    },
    kill: () => {
      killed = true;
    },
    revoke: () => {
      member = false;
    },
    before: (hook: () => Promise<void>) => {
      before = hook;
    },
    after: (hook: () => Promise<void>) => {
      after = hook;
    },
    retire: () => {
      active = false;
      return Promise.allSettled([...pending]);
    },
  };
}

test('only actual consumption POST ingests; replay deduplicates and server ingestion time wins', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  f.provider.decode(token);
  assert.equal(f.facts.size, 0);
  assert.equal(f.attempts(), 0);
  assert.equal((await f.call({ receipts: [token] }, undefined, 'GET')).status, 405);
  assert.equal(f.attempts(), 0);
  f.setTime(start + 30_000);
  const reply = await f.call({ receipts: [token, token] });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.outcomes, ['recorded', 'duplicate']);
  assert.deepEqual(reply.body.coverage, { received: 2, recorded: 1, duplicate: 1, failed: 0, unknown: 0, dropped: 0 });
  assert.equal(f.facts.size, 1);
  assert.equal([...f.facts.values()][0].usedAtMs, start + 30_000);
  assert.equal(reply.headers['set-cookie'], undefined);
  assert.equal(reply.headers['cache-control'], 'no-store');
  f.setTime(start + 50_000);
  assert.equal((await f.call({ receipts: [f.issue()] })).body.coverage.duplicate, 1);
  assert.equal([...f.facts.values()][0].usedAtMs, start + 30_000);
  assert.ok(f.resolutions() >= 8);
});

test('real native session/account admission precedes body read and rejects renewed-login receipt reuse', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  const missing = f.begin({ cookie: '' });
  await missing.done;
  assert.equal(missing.reply.status, 401);
  missing.stream.destroy();
  assert.equal((await f.call({ receipts: [token] }, { 'x-mistri-account': 'other' })).status, 409);
  const switched = await f.call({ receipts: [token] }, { cookie: f.cookie('session-other'), 'x-mistri-account': 'other' });
  assert.equal(switched.body.coverage.failed, 1);
  const renewed = await f.call({ receipts: [token] }, { cookie: f.cookie('session-2') });
  assert.equal(renewed.body.coverage.failed, 1);
  assert.equal(f.attempts(), 0);
  assert.equal((await f.call({ receipts: [token] })).body.coverage.recorded, 1);
  assert.equal((await f.call({ receipts: [f.issue('session-2')] }, { cookie: f.cookie('session-2') })).body.coverage.duplicate, 1);
  assert.equal(f.facts.size, 1, 'new session gets its own receipt but does not create a second unit');
});

test('same-origin JSON transport, bounded batches and closed body prevent body authority', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  for (const headers of [
    { origin: 'http://evil.test' },
    { host: 'evil.test', origin: 'http://evil.test' },
    { 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    const request = f.begin(headers);
    await request.done;
    assert.equal(request.reply.status, 403);
    request.stream.destroy();
  }
  for (const body of [
    { receipts: [] },
    { receipts: Array(17).fill(token) },
    { receipts: [token], variant: 'b' },
    { receipts: [token], usedAtMs: 1 },
    { receipts: [token], unit: 'another' },
  ])
    assert.equal((await f.call(body)).status, 400);
  assert.equal((await f.call({ receipts: ['x'.repeat(EXPOSURE_HTTP_LIMITS.bodyBytes)] })).status, 413);
  assert.equal((await f.call({ receipts: [token] }, undefined, 'POST', `${path}?tenant=other`)).status, 400);
  assert.equal((await f.call({ receipts: [token] }, undefined, 'POST', '/elsewhere')).handled, false);
  assert.equal(f.attempts(), 0);
});

test('partial batch accounts for invalid, expired and successful receipts without trusting payload variants', async (t) => {
  const f = await fixture(t),
    expired = f.issue();
  f.setTime(start + 301_000);
  const fresh = f.issue();
  const reply = await f.call({ receipts: [expired, 'tampered', { receipt: fresh, variant: 'b' }, fresh] });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.outcomes, ['failed', 'failed', 'failed', 'recorded']);
  assert.deepEqual(reply.body.coverage, { received: 4, recorded: 1, duplicate: 0, failed: 3, unknown: 0, dropped: 0 });
  assert.equal(f.attempts(), 1);
});

test('current global kill and membership revocation prevent ingestion despite a valid receipt', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  f.kill();
  const killed = await f.call({ receipts: [token] });
  assert.equal(killed.body.coverage.failed, 1);
  assert.equal(f.attempts(), 0);
  const g = await fixture(t),
    held = g.begin(),
    receipt = g.issue();
  await new Promise<void>((resolve) => setImmediate(resolve));
  g.revoke();
  held.stream.end(JSON.stringify({ receipts: [receipt] }));
  await held.done;
  assert.equal(held.reply.status, 403);
  assert.equal(g.facts.size, 0);
});

test('ingestion guard freshly rechecks controls and native session after waiting on the store', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  f.before(async () => {
    f.kill();
  });
  const killed = await f.call({ receipts: [token] });
  assert.equal(killed.body.coverage.recorded, 0);
  assert.equal(f.facts.size, 0);
  const g = await fixture(t),
    other = g.issue();
  g.before(async () => {
    g.db.prepare('DELETE FROM session').run();
  });
  const revoked = await g.call({ receipts: [other] });
  assert.notEqual(revoked.status, 200);
  assert.equal(g.facts.size, 0);
});

test('held body header mutation, session retirement and abort cannot commit or acknowledge', async (t) => {
  for (const mode of ['headers', 'session', 'abort']) {
    const f = await fixture(t),
      token = f.issue(),
      held = f.begin();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (mode === 'headers') held.req.headers['x-mistri-account'] = 'other';
    if (mode === 'session') f.db.prepare('DELETE FROM session').run();
    if (mode === 'abort') Object.assign(held.req, { aborted: true });
    held.stream.end(JSON.stringify({ receipts: [token] }));
    await held.done;
    assert.notEqual(held.reply.status, 200);
    assert.equal(f.facts.size, 0);
  }
});

test('unknown durable outcomes never acknowledge recorded, retry automatically or leak store errors', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  f.after(async () => {
    throw new TransactionOutcomeUnknown(new Error('PRIVATE_STORE_PASSWORD'));
  });
  const reply = await f.call({ receipts: [token, 'bad'] });
  assert.equal(reply.status, 503);
  assert.deepEqual(reply.body.outcomes, ['unknown', 'failed']);
  assert.deepEqual(reply.body.coverage, { received: 2, recorded: 0, duplicate: 0, failed: 1, unknown: 1, dropped: 0 });
  assert.equal(f.facts.size, 1);
  assert.equal(f.attempts(), 1);
  assert.equal(reply.text.includes('PRIVATE_STORE_PASSWORD'), false);
  assert.equal(reply.headers['retry-after'], undefined);
  assert.equal(reply.headers['x-mistri-app'], 'target');
  assert.equal(reply.headers['x-mistri-account'], 'subject');
  assert.equal(reply.headers['x-mistri-tenant'], 'north');
  assert.equal(reply.headers['x-mistri-context'], 'context-one');
});

test('retirement drains accepted ingestion and suppresses late success; remaining batch is dropped honestly', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.after(async () => {
    entered();
    await held;
  });
  const request = f.call({ receipts: [token, token] });
  await waiting;
  let drained = false;
  const closing = f.retire().then(() => {
    drained = true;
  });
  assert.equal(drained, false);
  release();
  const reply = await request;
  await closing;
  assert.notEqual(reply.status, 200);
  assert.equal(reply.body.coverage.recorded, 0);
  assert.equal(reply.body.coverage.unknown, 1);
  assert.equal(reply.body.coverage.dropped, 1);
  assert.equal(f.facts.size, 1);
  assert.equal(drained, true);
});

test('public visitor reporting needs an explicit owner-verified proof and cannot stitch across sign-in', async (t) => {
  const f = await fixture(t, true),
    token = f.issue();
  const headers = { cookie: '', 'x-mistri-account': undefined, 'x-mistri-visitor': f.visitorProof };
  assert.equal((await f.call({ receipts: [token] }, { ...headers, 'x-mistri-visitor': '' })).status, 401);
  assert.equal((await f.call({ receipts: [token] }, { ...headers, 'x-mistri-visitor': 'visitor-proof.forged' })).status, 401);
  const reply = await f.call({ receipts: [token] }, headers);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.coverage.recorded, 1);
  assert.equal(reply.headers['set-cookie'], undefined);
  assert.equal([...f.facts.values()][0].unit.kind, 'visitor');
  assert.equal((await f.call({ receipts: [token] }, { ...headers, cookie: f.cookie(), 'x-mistri-account': 'subject' })).status, 401);
  f.revoke();
  assert.equal((await f.call({ receipts: [token] }, headers)).status, 403);
  assert.equal(f.facts.size, 1);
});

test('closed canonical app/tenant/realm selectors never grant another scope', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  for (const query of [
    '',
    '?app=other&tenant=north',
    '?tenant=north',
    '?app=target&app=target&tenant=north',
    '?app=target&tenant=north&tenant=north',
    '?app=target&tenant=north&realm=platform',
    '?app=target&realm=tenant',
    '?app=target&tenant=',
    '?app=target&tenant=%40platform',
    '?app=target&tenant=%2Fother',
    '?app=target&tenant=north&role=admin',
    '?app=%74arget&tenant=north',
    '?app=target&tenant=north&',
    '?tenant=north&app=target',
    '?app=target&tenant=north#fragment',
  ]) {
    assert.equal((await f.call({ receipts: [token] }, undefined, 'POST', `${path}${query}`)).status, 400, query);
  }
  for (const query of ['?app=target&tenant=south', '?app=target', '?app=target&realm=platform']) {
    assert.equal((await f.call({ receipts: [token] }, undefined, 'POST', `${path}${query}`)).status, 409, query);
  }
  assert.equal((await f.call({ receipts: [token] }, { 'x-mistri-app': 'other' })).status, 409);
  assert.equal((await f.call({ receipts: [token] }, { 'x-mistri-tenant': 'south' })).status, 409);
  assert.equal(f.attempts(), 0);
});

test('scope and complete live lease come from the native owner; header assertions cannot manufacture them', async (t) => {
  for (const defect of ['absent', 'scope', 'app', 'context', 'revision', 'expired']) {
    const f = await fixture(t),
      token = f.issue();
    if (defect === 'absent') f.ownerLease(undefined);
    else if (defect === 'scope') f.ownerScope({ appId: 'target', environment: 'production', tenantId: 'south', realm: 'tenant' });
    else
      f.ownerLease({
        ...f.lease!,
        ...(defect === 'app'
          ? { appId: 'other' }
          : defect === 'context'
            ? { context: 'different' }
            : defect === 'revision'
              ? { revision: 2 }
              : { expiresAt: Date.now() - 1 }),
      });
    const reply = await f.call({ receipts: [token] });
    assert.notEqual(reply.status, 200, defect);
    assert.equal(f.attempts(), 0);
    assert.equal(reply.headers['x-mistri-app'], undefined);
    assert.equal(reply.headers['x-mistri-tenant'], undefined);
  }
  const f = await fixture(t),
    token = f.issue();
  for (const name of ['x-mistri-tab', 'x-mistri-context', 'x-mistri-lease-revision']) {
    const held = f.begin({ [name]: undefined });
    await held.done;
    assert.equal(held.reply.status, 409);
    held.stream.destroy();
  }
  assert.equal(f.attempts(), 0);
  assert.equal(f.provider.decode(token).scope.evaluationTenantId, 'north');
});

test('native App and platform replies attest only their verified account/scope; partial 503 preserves valid coverage headers', async (t) => {
  const app = await fixture(t, false, 'app');
  const a = await app.call({ receipts: [app.issue()] });
  assert.equal(a.status, 200);
  assert.equal(a.headers['x-mistri-app'], 'target');
  assert.equal(a.headers['x-mistri-account'], 'subject');
  assert.equal(a.headers['x-mistri-tenant'], undefined);
  assert.equal(a.headers['x-mistri-context'], undefined);
  const platform = await fixture(t, false, 'platform');
  const p = await platform.call({ receipts: [platform.issue()] });
  assert.equal(p.status, 200);
  assert.equal(p.headers['x-mistri-tenant'], '@platform');
  assert.equal(p.headers['x-mistri-realm'], 'platform');
  const f = await fixture(t),
    token = f.issue();
  let commits = 0;
  f.after(async () => {
    if (++commits === 2) throw new TransactionOutcomeUnknown(new Error('private'));
  });
  const reply = await f.call({ receipts: [token, token] });
  assert.equal(reply.status, 503);
  assert.deepEqual(reply.body.outcomes, ['recorded', 'unknown']);
  assert.deepEqual(reply.body.coverage, { received: 2, recorded: 1, duplicate: 0, failed: 0, unknown: 1, dropped: 0 });
  assert.deepEqual(Object.fromEntries(Object.entries(reply.headers).filter(([name]) => name.startsWith('x-mistri-'))), {
    'x-mistri-app': 'target',
    'x-mistri-account': 'subject',
    'x-mistri-tenant': 'north',
    'x-mistri-tab': 'tab-one',
    'x-mistri-context': 'context-one',
    'x-mistri-lease-revision': '1',
  });
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['set-cookie'], undefined);
});

test('a late native release/account fence suppresses staged success and all ownership headers', async (t) => {
  const f = await fixture(t),
    token = f.issue();
  f.releaseFence(async () => {
    f.db.prepare('DELETE FROM session').run();
  });
  const reply = await f.call({ receipts: [token] });
  assert.notEqual(reply.status, 200);
  assert.equal(f.facts.size, 1, 'a completed transaction cannot be undone by a later account change');
  assert.deepEqual(reply.body.outcomes, ['unknown']);
  assert.equal(reply.body.coverage.recorded, 0);
  for (const name of Object.keys(reply.headers)) assert.equal(name.startsWith('x-mistri-'), false);
});
