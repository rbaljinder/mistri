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
import { normalizeFlagSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { createAppAuth, createSuiteAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import {
  createFlagDeployment,
  type FlagControlSession,
  type FlagDeploymentTargetOptions,
} from '../packages/mistri/src/server/flags/deployment.js';
import { createFlagHttp } from '../packages/mistri/src/server/flags/http.js';
import {
  FlagManagementDenied,
  FlagRevisionConflict,
  type FlagHistoryEntry,
  type FlagStore,
} from '../packages/mistri/src/server/flags/store.js';
import { type FlagAuthorityCatalog } from '../packages/mistri/src/server/flags/authority.js';
import { createTenantHostRouter } from '../packages/mistri/src/server/http/tenantHosts.js';
import { createExperimentHttp } from '../packages/mistri/src/server/experiments/http.js';
import {
  ExperimentConflict,
  identifyEpoch,
  type ExperimentEpoch,
  type ExperimentStore,
} from '../packages/mistri/src/server/experiments/contracts.js';
import { buildExperimentResult } from '../packages/mistri/src/server/experiments/results.js';

const binding = { suiteId: 'suite', deploymentId: 'evidence-deployment' };
const scope = { appId: 'target', environment: 'production', tenantId: null };
const allocation = {
  version: 'v1',
  weights: [
    { value: 'a', weight: 50 },
    { value: 'b', weight: 50 },
  ],
};
const catalog: FlagAuthorityCatalog = {
  flags: {
    copy: { type: 'string', default: 'a', variants: ['a', 'b'], safeValue: 'a', owner: 'product', tenantManaged: true },
    hidden: { type: 'string', default: 'PRIVATE_OTHER_OWNER', owner: 'security' },
  },
  roles: ['viewer', 'decider', 'flagreader', 'operator'],
  audiences: {},
  experiments: { copy: allocation },
};
const controls = { flags: catalog.flags, roles: catalog.roles, audiences: catalog.audiences };
const capability = { environments: ['production'], owners: ['product'] };
const roles = {
  viewer: { experiments: [{ ...capability, actions: ['view'] as const }] },
  decider: {
    flags: [{ ...capability, actions: ['manage'] as const }],
    experiments: [{ ...capability, actions: ['manage', 'decide'] as const }],
  },
  flagreader: { flags: [{ ...capability, actions: ['view'] as const }] },
  operator: { flags: [{ ...capability, actions: ['manage'] as const }], experiments: [{ ...capability, actions: ['manage'] as const }] },
};
const declaration: ExperimentEpoch = {
  scope: { appId: 'target', environment: 'production', controlTenantId: null, evaluationTenantId: null },
  flagId: 'copy',
  version: 'v1',
  owner: 'product',
  unit: 'subject',
  control: 'a',
  arms: [
    { id: 'a', value: 'a', weight: 50 },
    { id: 'b', value: 'b', weight: 50 },
  ],
  eligibility: { rollout: 100, audiences: {} },
  startsAtMs: 1000,
  endsAtMs: 2000,
  conversionWindowMs: 100,
  deliveryGraceMs: 50,
  primary: { id: 'submitted', event: 'submitted', eventVersion: 1, unitField: 'actorId' },
  guardrails: [],
};
const epoch = identifyEpoch(binding, declaration);
const body = {
  tenantId: null,
  epochFingerprint: epoch.fingerprint,
  expectedRevision: 1,
  expectedResultRevision: 1,
  winnerVariant: 'b',
  reason: 'Reviewed winner',
};
const resultsPath = `/target/api/experiments/copy/results?epochFingerprint=${epoch.fingerprint}`;
const decisionPath = '/target/api/experiments/copy/decisions';

async function fixture(
  t: TestContext,
  setup: {
    flags?: (store: FlagStore) => FlagStore;
    evidence?: (store: ExperimentStore) => ExperimentStore;
    target?: (target: FlagDeploymentTargetOptions) => FlagDeploymentTargetOptions;
    declaration?: ExperimentEpoch;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-experiment-http-')),
    secret = 'experiment-http-secret-at-least-thirty-two-characters';
  const auth = await createAppAuth(
    {
      path: join(dir, 'app.ts'),
      dir,
      sources: {},
      pages: [],
      app: parseAppConfig(
        {
          id: 'target',
          name: 'Target',
          auth: { store: 'auth.db', signUp: 'open', roles: Object.fromEntries(catalog.roles.map((role) => [role, { read: false }])) },
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'experiments',
      ),
    },
    { baseURL: 'http://localhost:4111', trustedOrigins: ['http://localhost:4111'], environment: { BETTER_AUTH_SECRET: secret } },
  );
  const db = new DatabaseSync(auth.store),
    now = new Date().toISOString();
  t.after(() => {
    auth.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,?,?,?,?,?)').run(
    'subject',
    'Operator',
    'operator@example.test',
    1,
    now,
    now,
    'viewer,decider,flagreader',
    0,
  );
  db.prepare('INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(
    'session',
    'token',
    'subject',
    new Date(Date.now() + 60_000).toISOString(),
    now,
    now,
  );
  const signature = createHmac('sha256', secret).update('token').digest('base64');
  const cookie = `mistri-target.session_token=${encodeURIComponent(`token.${signature}`)}`;
  const declared = setup.declaration ?? declaration,
    registered = identifyEpoch(binding, declared);
  let writes = 0,
    attempts = 0,
    reads = 0,
    flagClosed = 0,
    evidenceClosed = 0;
  let snapshot = normalizeFlagSnapshot(
    {
      ...scope,
      tenantId: declared.scope.controlTenantId,
      revision: 1,
      overrides: {
        copy: { experiment: allocation },
        ...(declared.scope.controlTenantId === null ? { hidden: { value: 'PRIVATE_OTHER_OWNER' } } : {}),
      },
    },
    controls,
  );
  const history: FlagHistoryEntry[] = [];
  const flags: FlagStore = {
    binding: { suiteId: 'suite', deploymentId: 'flags-deployment' },
    async read() {
      return snapshot;
    },
    async history() {
      return { entries: [...history].reverse(), nextBeforeRevision: null };
    },
    async close() {
      flagClosed++;
    },
    async mutate(change, guard) {
      attempts++;
      if (change.expectedRevision !== snapshot.revision) throw new FlagRevisionConflict();
      assert.equal(change.operation, 'decide');
      if (change.operation !== 'decide') throw Error('Unexpected operation');
      const before = snapshot,
        after = normalizeFlagSnapshot(
          {
            ...snapshot,
            revision: snapshot.revision + 1,
            overrides: { ...snapshot.overrides, copy: { value: change.evidence.winnerVariant } },
          },
          controls,
        );
      await guard();
      writes++;
      snapshot = after;
      const entry: FlagHistoryEntry = {
        scope: change.scope,
        revision: after.revision,
        flagId: 'copy',
        operation: 'decide',
        actorId: change.actorId,
        reason: change.reason,
        at: now,
        revertRevision: null,
        before,
        after,
        evidence: change.evidence,
      };
      history.push(entry);
      return entry;
    },
  };
  const result = buildExperimentResult({
    epoch: registered,
    declaration: declared,
    dataRevision: 10,
    evidenceRevision: 1,
    capturedAtMs: 2150,
    delivery: { throughMs: 2150, pending: 0, failed: 0, incomplete: 0 },
    diagnostics: { pendingConversions: 0, unattributedConversions: 0, lateConversions: 0, lateExposures: 0 },
    aggregates: [
      { arm: 'a', exposed: 100, mature: 100, primary: 10, guardrails: [] },
      { arm: 'b', exposed: 100, mature: 100, primary: 50, guardrails: [] },
    ],
  });
  const evidence = {
    binding,
    async readEpoch() {
      return registered;
    },
    async readResults() {
      reads++;
      return result;
    },
    async readDataRevision() {
      return 10;
    },
    async appendDecisionEvidence(_epoch: unknown, input: unknown, guard: () => Promise<void>) {
      await guard();
      return input;
    },
    async close() {
      evidenceClosed++;
    },
  } as unknown as ExperimentStore;
  const base: FlagDeploymentTargetOptions = {
    appId: 'target',
    catalog,
    roles,
    tenantApp: false,
    auth,
    assertCurrent() {},
    experimentEvidence: { epochs: [declared], store: setup.evidence ? setup.evidence(evidence) : evidence },
  };
  const target = setup.target ? setup.target(base) : base;
  if (target.auth !== auth) t.after(() => target.auth.close());
  const options = {
    suiteId: 'suite',
    deploymentId: 'flags-deployment',
    environment: 'production',
    storeUrl: 'postgresql://operator@control/flags',
    targets: [target],
  };
  const deployment = await createFlagDeployment(options, setup.flags ? setup.flags(flags) : flags);
  t.after(() => deployment.close());
  const deployed = deployment.target('target'),
    bound = { host: '127.0.0.1', port: 4111 };
  const http = createExperimentHttp({ target: deployed, bound, mount: '/target' }),
    flagHttp = createFlagHttp({ target: deployed, bound, mount: '/target' });
  function start(path: string, method = 'GET', headers: Record<string, string> = {}, prepare?: (req: IncomingMessage) => void) {
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      url: path,
      method,
      rawHeaders: ['Host', headers.host ?? 'localhost:4111'],
      headers: {
        host: 'localhost:4111',
        origin: 'http://localhost:4111',
        cookie,
        'x-mistri-account': 'subject',
        'content-type': 'application/json',
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
      setHeader(key: string, value: unknown) {
        this.headers[key] = value;
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
    prepare?.(req);
    const done = (path.includes('/api/flags/') ? flagHttp : http)(req, reply as unknown as ServerResponse);
    return { req, stream, reply, done };
  }
  async function call(path: string, method = 'GET', input?: unknown, headers?: Record<string, string>) {
    const value = start(path, method, headers);
    value.stream.end(input === undefined ? undefined : JSON.stringify(input));
    const handled = await value.done;
    return { ...value.reply, handled, body: value.reply.text ? JSON.parse(value.reply.text) : undefined };
  }
  return {
    db,
    deployment,
    target: deployed,
    call,
    start,
    options,
    flags,
    evidence,
    history,
    cookie,
    registered,
    counts: () => ({ writes, attempts, reads, flagClosed, evidenceClosed }),
    setRole(role: string) {
      db.prepare('UPDATE user SET role=? WHERE id=?').run(role, 'subject');
    },
  };
}

test('request-bound native authority separates result view from all three decide powers; history retains only per-flag evidence', async (t) => {
  const f = await fixture(t);
  f.setRole('flagreader');
  assert.equal((await f.call(resultsPath)).status, 403);
  f.setRole('viewer');
  const result = await f.call(resultsPath);
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body.epoch.fingerprint, epoch.fingerprint);
  assert.equal(result.body.statistics.methods.intervalAdjustment, 'Bonferroni');
  assert.equal((await f.call(decisionPath, 'POST', body)).status, 403);
  f.setRole('operator');
  assert.equal((await f.call(decisionPath, 'POST', body)).status, 403);
  f.setRole('decider');
  assert.equal((await f.call(resultsPath)).status, 403);
  const decided = await f.call(decisionPath, 'POST', body);
  assert.equal(decided.status, 200);
  assert.deepEqual(decided.body, { flagId: 'copy', revision: 2, operation: 'decide' });
  f.setRole('flagreader');
  const history = await f.call('/target/api/flags/copy/history');
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.entries[0].evidence, { epochFingerprint: epoch.fingerprint, resultsRevision: 1, winnerVariant: 'b' });
  assert.equal(history.text.includes('PRIVATE_OTHER_OWNER'), false);
  assert.equal(history.text.includes('hidden'), false);
});

test('unconfigured evidence is unavailable; borrowed results store has independent same-suite deployment identity', async (t) => {
  const f = await fixture(t, { target: ({ experimentEvidence: _evidence, ...target }) => target });
  for (const reply of [await f.call(resultsPath), await f.call(decisionPath, 'POST', body)]) {
    assert.equal(reply.status, 503);
    assert.equal(reply.body.code, 'experiments_unavailable');
  }
  assert.equal(f.counts().reads, 0);
  assert.equal(f.counts().attempts, 0);
  const distinct = await fixture(t);
  assert.equal((await distinct.call(resultsPath)).status, 200);
  await distinct.deployment.close();
  assert.equal(distinct.counts().flagClosed, 1);
  assert.equal(distinct.counts().evidenceClosed, 0);
  assert.throws(() =>
    createFlagDeployment(
      {
        ...distinct.options,
        targets: [
          {
            ...distinct.options.targets[0],
            experimentEvidence: {
              epochs: [declaration],
              store: { ...distinct.evidence, binding: { ...binding, suiteId: 'foreign' } },
            },
          },
        ],
      },
      distinct.flags,
    ),
  );
});

test('closed path/query/body selectors reject foreign identity and ambiguous input before evidence or writes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/outside/api/experiments/copy/results')).handled, false);
  assert.equal((await f.call('/target/api/experiments/copy/unknown')).status, 404);
  assert.equal((await f.call(resultsPath, 'POST')).status, 405);
  assert.equal((await f.call(decisionPath)).status, 405);
  for (const path of [
    resultsPath + '&epochFingerprint=' + epoch.fingerprint,
    resultsPath + '&tenant=one&tenant=two',
    resultsPath + '&environment=development',
    '/target/api/experiments/copy/results',
    resultsPath.replace(epoch.fingerprint, 'bad'),
  ]) {
    assert.equal((await f.call(path)).status, 400);
  }
  for (const field of [
    'appId',
    'environment',
    'actorId',
    'owner',
    'roles',
    'requiredCapabilities',
    'flagId',
    'operation',
    'beforeCommit',
    'epochs',
    'store',
  ]) {
    assert.equal((await f.call(decisionPath, 'POST', { ...body, [field]: 'injected' })).status, 400, field);
  }
  for (const patch of [
    { expectedRevision: -1 },
    { expectedResultRevision: 0 },
    { expectedResultRevision: 1.5 },
    { reason: '' },
    { epochFingerprint: 'invalid' },
  ]) {
    assert.equal((await f.call(decisionPath, 'POST', { ...body, ...patch })).status, 400);
  }
  assert.equal((await f.call(decisionPath + '?tenant=one', 'POST', body)).status, 400);
  assert.equal(f.counts().reads, 0);
  assert.equal(f.counts().attempts, 0);
  assert.equal((await f.call(resultsPath.replace(epoch.fingerprint, '0'.repeat(64)))).status, 403);
  assert.equal((await f.call(decisionPath, 'POST', { ...body, tenantId: 'foreign' })).status, 403);
});

test('code epoch declarations are captured before startup awaits and cannot be replaced by later input edits', async (t) => {
  const f = await fixture(t, {
    target: (target) => {
      const mutable = structuredClone(declaration),
        epochs = [mutable];
      queueMicrotask(() => {
        (mutable as { version: string }).version = 'foreign';
        epochs.length = 0;
      });
      return { ...target, experimentEvidence: { ...target.experimentEvidence!, epochs } };
    },
  });
  assert.equal((await f.call(resultsPath)).status, 200);
  assert.equal((await f.call(decisionPath, 'POST', body)).status, 200);
});

test('origin, native account, mapped-host intent and held-request identity changes are fenced', async (t) => {
  const f = await fixture(t);
  const hostile = f.start(decisionPath, 'POST', { origin: 'http://evil.test' });
  await hostile.done;
  assert.equal(hostile.reply.status, 403);
  hostile.stream.destroy();
  assert.equal((await f.call(resultsPath, 'GET', undefined, { 'x-mistri-account': 'other' })).status, 409);
  assert.equal((await f.call(resultsPath, 'GET', undefined, { cookie: '' })).status, 401);
  const router = createTenantHostRouter([{ host: 'shop.example.test', app: 'target', tenant: 'one' }]);
  const mapped = f.start(resultsPath, 'GET', { host: 'shop.example.test', origin: 'https://shop.example.test' }, (req) =>
    assert.equal(router.accept(req), true),
  );
  mapped.stream.end();
  await mapped.done;
  assert.equal(mapped.reply.status, 403);
  const held = f.start(decisionPath, 'POST');
  await new Promise<void>((resolve) => setImmediate(resolve));
  held.req.headers['x-mistri-account'] = 'other';
  held.stream.end(JSON.stringify(body));
  await held.done;
  assert.equal(held.reply.status, 409);
  assert.equal(f.counts().writes, 0);
});

test('native authority is reobserved after held bodies, results reads and inside the flag commit fence', async (t) => {
  const f = await fixture(t),
    held = f.start(decisionPath, 'POST');
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.setRole('viewer');
  held.stream.end(JSON.stringify(body));
  await held.done;
  assert.equal(held.reply.status, 403);
  assert.equal(f.counts().writes, 0);
  let revoke = () => {};
  const read = await fixture(t, {
    evidence: (store) => ({
      ...store,
      async readResults(...args) {
        const result = await store.readResults(...args);
        revoke();
        return result;
      },
    }),
  });
  revoke = () => read.setRole('decider');
  assert.equal((await read.call(resultsPath)).status, 403);
  const commit = await fixture(t, {
    flags: (store) => ({
      ...store,
      async mutate(...args) {
        revoke();
        return store.mutate(...args);
      },
    }),
  });
  revoke = () => commit.setRole('viewer');
  assert.equal((await commit.call(decisionPath, 'POST', body)).status, 403);
  assert.equal(commit.counts().writes, 0);
  assert.equal(commit.counts().attempts, 1);
});

test('trusted Console fence reaches the final decision transaction and sessions cannot escape request lifetime', async (t) => {
  let inTransaction = false;
  const f = await fixture(t, {
    flags: (store) => ({
      ...store,
      async mutate(...args) {
        inTransaction = true;
        return store.mutate(...args);
      },
    }),
  });
  const req = { headers: { cookie: f.cookie } } as IncomingMessage;
  let escaped: FlagControlSession | undefined,
    checks = 0;
  await assert.rejects(
    f.target.withRequest(
      req,
      'subject',
      () => {},
      (session) => session.decide({ ...body, flagId: 'copy' }, {} as () => void),
    ),
    FlagManagementDenied,
  );
  await assert.rejects(
    f.target.withRequest(
      req,
      'subject',
      () => {},
      (session) => {
        escaped = session;
        return session.decide({ ...body, flagId: 'copy' }, async () => {
          checks++;
          if (inTransaction) {
            await Promise.resolve();
            f.setRole('viewer');
          }
        });
      },
    ),
    FlagManagementDenied,
  );
  assert.ok(checks >= 2);
  assert.equal(f.counts().writes, 0);
  await assert.rejects(escaped!.results({ tenantId: null, flagId: 'copy', epochFingerprint: epoch.fingerprint }), FlagManagementDenied);
});

test('stale controls/results and missing latest evidence do not retry; unknown commits stay unknown and acknowledged commits stay successful', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call(decisionPath, 'POST', { ...body, expectedRevision: 0 })).body.code, 'flags_revision_conflict');
  assert.equal((await f.call(decisionPath, 'POST', { ...body, expectedResultRevision: 2 })).body.code, 'experiments_revision_conflict');
  const missing = await fixture(t, {
    evidence: (store) => ({
      ...store,
      async readResults() {
        throw new ExperimentConflict();
      },
    }),
  });
  assert.equal((await missing.call(resultsPath)).status, 409);
  let afterCommit = () => {};
  const committed = await fixture(t, {
    flags: (store) => ({
      ...store,
      async mutate(...args) {
        const result = await store.mutate(...args);
        afterCommit();
        return result;
      },
    }),
  });
  afterCommit = () => committed.setRole('');
  assert.equal((await committed.call(decisionPath, 'POST', body)).status, 200);
  for (const typed of [false, true]) {
    const lost = await fixture(t, {
      flags: (store) => ({
        ...store,
        async mutate(...args) {
          await store.mutate(...args);
          const error = Error('PRIVATE connection lost after COMMIT');
          throw typed ? new TransactionOutcomeUnknown(error) : error;
        },
      }),
    });
    const reply = await lost.call(decisionPath, 'POST', body);
    assert.equal(reply.status, 503);
    assert.equal(reply.body.outcome, 'unknown');
    assert.equal(reply.text.includes('PRIVATE'), false);
    assert.equal(reply.headers['retry-after'], undefined);
    assert.equal(lost.counts().writes, 1);
    assert.equal(lost.counts().attempts, 1);
  }
});

test('suite target grant remains required beyond native login and is fenced during held bodies', async (t) => {
  let granted = false,
    revision = 1;
  const f = await fixture(t, {
    target: (target) => ({
      ...target,
      auth: createSuiteAppAuth(target.auth, {
        appId: 'target',
        spec: target.auth.spec,
        roles: catalog.roles,
        basePath: '/target',
        suiteBase: '',
        grant: () => ({ revision, roles: granted ? ['viewer', 'decider'] : [] }),
      }),
    }),
  });
  assert.equal((await f.call(resultsPath)).status, 401);
  granted = true;
  revision++;
  assert.equal((await f.call(resultsPath)).status, 200);
  const held = f.start(decisionPath, 'POST');
  await new Promise<void>((resolve) => setImmediate(resolve));
  granted = false;
  revision++;
  held.stream.end(JSON.stringify(body));
  await held.done;
  assert.notEqual(held.reply.status, 200);
  assert.equal(f.counts().writes, 0);
});

test('tenant decisions require exact current target membership; native roles cannot supply global platform powers', async (t) => {
  let member = true;
  const f = await fixture(t, {
    declaration: { ...declaration, scope: { ...declaration.scope, controlTenantId: 'one', evaluationTenantId: 'one' } },
    target: (target) => ({
      ...target,
      tenantApp: true,
      roles: Object.fromEntries(Object.entries(roles).map(([key, value]) => [key, { ...value, realm: 'tenant' }])),
      observeMembership: (_scope, accountId) =>
        !member
          ? null
          : {
              record: {
                appId: 'target',
                accountId,
                tenantId: 'one',
                tenantStatus: 'active',
                tenantVersion: '1',
                membershipId: 'membership',
                membershipVersion: '1',
                status: 'active',
                roles: ['viewer', 'decider'],
                validUntil: Date.now() + 60_000,
              },
              assertCurrent() {},
            },
    }),
  });
  const path = resultsPath.replace(epoch.fingerprint, f.registered.fingerprint);
  assert.equal((await f.call(path + '&tenant=one')).status, 200);
  assert.equal((await f.call(path + '&tenant=two')).status, 403);
  assert.equal((await f.call(path)).status, 403);
  member = false;
  assert.equal((await f.call(decisionPath, 'POST', { ...body, tenantId: 'one', epochFingerprint: f.registered.fingerprint })).status, 403);
  member = true;
  assert.equal((await f.call(decisionPath, 'POST', { ...body, tenantId: 'one', epochFingerprint: f.registered.fingerprint })).status, 200);
});

test('bounded bodies, session loss and retirement cannot commit; deployment drains borrowed evidence work', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call(decisionPath, 'POST', { ...body, reason: 'x'.repeat(70_000) })).status, 413);
  const held = f.start(decisionPath, 'POST');
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.db.prepare('DELETE FROM session').run();
  held.stream.end(JSON.stringify(body));
  await held.done;
  assert.notEqual(held.reply.status, 200);
  assert.equal(f.counts().writes, 0);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = await fixture(t, {
    evidence: (store) => ({
      ...store,
      async readResults(...args) {
        entered();
        await wait;
        return store.readResults(...args);
      },
    }),
  });
  const read = pending.call(resultsPath);
  await ready;
  const closing = pending.deployment.close();
  assert.equal(pending.counts().flagClosed, 0);
  release();
  assert.notEqual((await read).status, 200);
  await closing;
  assert.equal(pending.counts().flagClosed, 1);
  assert.equal(pending.counts().evidenceClosed, 0);
});
