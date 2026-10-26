import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { captureAppFlagValues } from '../packages/mistri/src/shared/appFlagValues.js';
import { normalizeFlagCatalog } from '../packages/mistri/src/shared/appFlags.js';
import { createComposedFlagEvaluator } from '../packages/mistri/src/server/flags/request.js';
import { createFlagValuesHttp, type FlagValuesCapture } from '../packages/mistri/src/server/flags/valuesHttp.js';
import { HttpError } from '../packages/engine/src/server/http/reply.js';
import { createAssignmentReceiptProvider } from '../packages/mistri/src/server/experiments/assignmentReceipt.js';
import { identifyEpoch } from '../packages/mistri/src/server/experiments/contracts.js';

const catalog = normalizeFlagCatalog({
  flags: {
    release: { type: 'boolean', default: false, owner: 'PRIVATE_OWNER', tenantManaged: true },
    copy: { type: 'string', default: 'a', variants: ['a', 'b'], owner: 'PRIVATE_OWNER' },
  },
  roles: ['PRIVATE_ROLE'],
  audiences: { PRIVATE_AUDIENCE: { roles: ['PRIVATE_ROLE'] } },
});
function evaluation(tenantId: string | null = null) {
  const scope = { appId: 'desk', environment: 'production', tenantId };
  return createComposedFlagEvaluator({
    catalog,
    scope,
    context: {},
    snapshots: {
      global: { ...scope, tenantId: null, revision: 7, overrides: { release: { value: true }, copy: { rollout: 50, value: 'b' } } },
      tenant: tenantId === null ? null : { ...scope, revision: 2, overrides: { release: { value: false } } },
    },
  });
}
function request(url = '/api/flags/evaluate?app=desk', method = 'GET') {
  const req = { url, method, headers: { host: 'localhost:4111', origin: 'http://localhost:4111' }, aborted: false } as IncomingMessage;
  const reply = {
    status: 0,
    text: '',
    destroyed: false,
    writableEnded: false,
    headers: {} as Record<string, unknown>,
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
  return { req, reply, res: reply as unknown as ServerResponse };
}
const base = { appId: 'desk', environment: 'production', bound: { host: '127.0.0.1', port: 4111 } };
function capture(req: IncomingMessage, tenantId: string | null = null): FlagValuesCapture {
  return {
    request: req,
    tenantId,
    flagIds: ['release', 'copy'],
    evaluation: evaluation(tenantId),
    current: async () => {},
    assertCurrent() {},
  };
}

test('evaluated DTO is closed immutable serializable data, including bounded diagnostics and the atomic version pair', () => {
  const input = { values: { enabled: false, object: { list: [1, null, { value: 'a' }] } }, version: { global: 3, tenant: null } };
  const got = captureAppFlagValues(input);
  input.values.object.list.push('mutation' as never);
  assert.equal(Object.isFrozen(got.values.object), true);
  assert.equal(JSON.stringify(got).includes('mutation'), false);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  let invoked = false;
  for (const invalid of [
    undefined,
    { ...input, roles: [] },
    { ...input, values: { x: null } },
    { ...input, values: { x: [] } },
    { ...input, version: { global: -1, tenant: null } },
    { ...input, version: { global: 1, tenant: null, owner: 'leak' } },
    { ...input, diagnostics: ['private_detail'] },
    { ...input, values: { x: NaN } },
    { ...input, values: circular },
    {
      ...input,
      values: {
        get x() {
          invoked = true;
          return true;
        },
      },
    },
    { ...input, values: { x: 'a'.repeat(4097) } },
    { ...input, values: { x: new Date() } },
    { ...input, values: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${i}`, true])) },
    { ...input, values: { x: { sparse: Array(2) } } },
    { ...input, values: { x: { [Symbol()]: true } } },
  ]) {
    assert.throws(() => captureAppFlagValues(invalid));
  }
  assert.equal(invoked, false);
});

test('anonymous evaluated reads use the supplied snapshot once, default without identity, and expose no control graph', async () => {
  let admitted = 0,
    evaluations = 0,
    currents = 0;
  const http = createFlagValuesHttp({
    ...base,
    async withCapture(req, _res, guard, use) {
      admitted++;
      guard();
      const c = capture(req),
        original = c.evaluation;
      await use({
        ...c,
        current: async () => {
          currents++;
        },
        evaluation: {
          ...original,
          evaluate(id) {
            evaluations++;
            return original.evaluate(id);
          },
        },
      });
    },
  });
  const f = request();
  assert.equal(await http(f.req, f.res), true);
  assert.equal(admitted, 1);
  assert.equal(evaluations, 2);
  assert.equal(currents, 2);
  assert.equal(f.reply.status, 200);
  assert.deepEqual(JSON.parse(f.reply.text), {
    values: { release: true, copy: 'a' },
    version: { global: 7, tenant: null },
    diagnostics: ['missing_identity'],
  });
  assert.equal(f.reply.headers['cache-control'], 'no-store');
  assert.equal(f.reply.headers['x-mistri-app'], 'desk');
  assert.equal(f.reply.headers['set-cookie'], undefined);
  assert.doesNotMatch(f.reply.text, /PRIVATE|rollout|allocation|experimentVersion|reason|revision|environment/);
});

test('transport refuses selector overrides, duplicate queries, request bodies and methods before host capture', async () => {
  let calls = 0;
  const http = createFlagValuesHttp({
    ...base,
    async withCapture() {
      calls++;
    },
  });
  for (const query of [
    'roles=admin',
    'audiences=beta',
    'values=true',
    'environment=staging',
    'app=other',
    'app=desk&app=desk',
    'tenant=x&realm=platform',
    'tenant=@platform',
    'realm=tenant',
    'tenant=',
  ]) {
    const f = request(`/api/flags/evaluate?${query}`);
    await http(f.req, f.res);
    assert.equal(f.reply.status, 400, query);
  }
  const post = request(undefined, 'POST');
  await http(post.req, post.res);
  assert.equal(post.reply.status, 405);
  const body = request();
  body.req.headers['content-length'] = '1';
  await http(body.req, body.res);
  assert.equal(body.reply.status, 400);
  assert.equal(calls, 0);
  const management = request('/api/flags/release');
  assert.equal(await http(management.req, management.res), false);
});

test('the trusted App mount reserves evaluate before the management flag-id route', async () => {
  const http = createFlagValuesHttp({
    ...base,
    mount: '/desk',
    async withCapture(req, _res, _guard, use) {
      await use(capture(req));
    },
  });
  const mounted = request('/desk/api/flags/evaluate?app=desk');
  assert.equal(await http(mounted.req, mounted.res), true);
  assert.equal(mounted.reply.status, 200);
  const outside = request('/other/api/flags/evaluate');
  assert.equal(await http(outside.req, outside.res), false);
});

test('ordinary read denial is preserved and verified active tenant must agree with the exact request and fixed App/environment', async () => {
  const denied = createFlagValuesHttp({
    ...base,
    async withCapture() {
      throw new HttpError(403, 'Private membership details');
    },
  });
  const f = request();
  await denied(f.req, f.res);
  assert.equal(f.reply.status, 403);
  assert.doesNotMatch(f.reply.text, /membership/);
  for (const mutate of [
    (c: FlagValuesCapture) => ({ ...c, request: request().req }),
    (c: FlagValuesCapture) => ({ ...c, tenantId: 'south' }),
    (c: FlagValuesCapture) => ({ ...c, evaluation: { ...c.evaluation, scope: { ...c.evaluation.scope, appId: 'other' } } }),
    (c: FlagValuesCapture) => ({ ...c, evaluation: { ...c.evaluation, scope: { ...c.evaluation.scope, environment: 'staging' } } }),
  ]) {
    const http = createFlagValuesHttp({
      ...base,
      async withCapture(req, _res, _guard, use) {
        await use(mutate(capture(req, 'north')));
      },
    });
    const f = request('/api/flags/evaluate?app=desk&tenant=north');
    await http(f.req, f.res);
    assert.equal(f.reply.status, 409);
  }
  const http = createFlagValuesHttp({
    ...base,
    async withCapture(req, _res, _guard, use) {
      await use(capture(req, 'north'));
    },
  });
  const good = request('/api/flags/evaluate?app=desk&tenant=north');
  await http(good.req, good.res);
  assert.deepEqual(JSON.parse(good.reply.text).version, { global: 7, tenant: 2 });
  assert.equal(JSON.parse(good.reply.text).values.release, false);
  const missing = request();
  await http(missing.req, missing.res);
  assert.equal(missing.reply.status, 409);
});

test('request mutation, abort, account/tenant retirement during final evidence wait never sends evaluated values', async () => {
  for (const mode of ['header', 'abort', 'retire'] as const) {
    let release!: () => void,
      entered!: () => void,
      active = true,
      checks = 0;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const http = createFlagValuesHttp({
      ...base,
      async withCapture(req, _res, _guard, use) {
        await use({
          ...capture(req),
          async current() {
            if (++checks === 2) {
              entered();
              await gate;
            }
          },
          assertCurrent() {
            if (!active) throw new HttpError(409, 'Retired.');
          },
        });
      },
    });
    const f = request(),
      done = http(f.req, f.res);
    await waiting;
    if (mode === 'header') f.req.headers['x-mistri-context'] = 'new-context';
    else if (mode === 'abort') Object.assign(f.req, { aborted: true });
    else active = false;
    release();
    await done;
    assert.notEqual(f.reply.status, 200);
    assert.doesNotMatch(f.reply.text, /"values"|PRIVATE/);
  }
});

test('optional request-owned issuance projects opaque matching receipts without recording exposure or leaking assignment context', async () => {
  const now = Date.now(),
    binding = { suiteId: 'suite', deploymentId: 'production' };
  const epoch = identifyEpoch(binding, {
    scope: { appId: 'desk', environment: 'production', controlTenantId: null, evaluationTenantId: null },
    flagId: 'copy',
    version: 'v1',
    owner: 'PRIVATE_OWNER',
    unit: 'subject',
    control: 'variant-0',
    arms: [
      { id: 'variant-0', value: 'a', weight: 50 },
      { id: 'variant-1', value: 'b', weight: 50 },
    ],
    eligibility: { rollout: 100, audiences: {} },
    startsAtMs: now - 1000,
    endsAtMs: now + 3600000,
    conversionWindowMs: 3600000,
    deliveryGraceMs: 0,
    primary: { id: 'converted', event: 'converted', eventVersion: 1, unitField: 'actorId' },
    guardrails: [],
  });
  const context = { identity: { kind: 'subject' as const, id: 'PRIVATE_SUBJECT' } };
  const snapshots = {
    global: {
      appId: 'desk',
      environment: 'production',
      tenantId: null,
      revision: 1,
      overrides: {
        copy: {
          experiment: {
            version: 'v1',
            weights: [
              { value: 'a', weight: 50 },
              { value: 'b', weight: 50 },
            ],
          },
        },
      },
    },
    tenant: null,
  };
  const receipts = createAssignmentReceiptProvider({
    appId: 'desk',
    environment: 'production',
    binding,
    catalog,
    key: new Uint8Array(32).fill(11),
    clock: () => now,
  });
  const assignment = receipts.resolveAssignment({ epoch, context, snapshots, proof: { kind: 'session', id: 'PRIVATE_SESSION' } });
  const evaluated = createComposedFlagEvaluator({
    catalog,
    context,
    scope: { appId: 'desk', environment: 'production', tenantId: null },
    snapshots,
  });
  let issued = 0;
  const http = createFlagValuesHttp({
    ...base,
    async withCapture(req, _res, _guard, use) {
      await use({
        ...capture(req),
        evaluation: evaluated,
        async issueAssignmentReceipt(id, decision) {
          assert.equal(id, 'copy');
          assert.equal(decision.reason, 'experiment');
          issued++;
          return { receipt: receipts.issue(assignment), value: decision.value };
        },
      });
    },
  });
  const f = request();
  await http(f.req, f.res);
  assert.equal(f.reply.status, 200);
  assert.equal(issued, 1);
  const payload = captureAppFlagValues(JSON.parse(f.reply.text));
  assert.equal(receipts.verify(payload.assignmentReceipts!.copy, assignment).claims.unit.id, 'PRIVATE_SUBJECT');
  assert.equal(payload.assignmentReceipts!.release, undefined);
  assert.doesNotMatch(f.reply.text, /PRIVATE|session|unit|epoch|variant-/);
  assert.equal(f.reply.headers['cache-control'], 'no-store');
  assert.equal(f.reply.headers['set-cookie'], undefined);
});

test('receipt issuer is never called for ordinary/default decisions; mismatched issuance and retirement fail closed', async () => {
  const unused = createFlagValuesHttp({
    ...base,
    async withCapture(req, _res, _guard, use) {
      await use({
        ...capture(req),
        async issueAssignmentReceipt() {
          assert.fail('Not an experiment decision.');
        },
      });
    },
  });
  const passive = request();
  await unused(passive.req, passive.res);
  assert.equal(passive.reply.status, 200);
  for (const failure of ['mismatch', 'retired']) {
    let active = true;
    const http = createFlagValuesHttp({
      ...base,
      async withCapture(req, _res, _guard, use) {
        const original = capture(req);
        await use({
          ...original,
          evaluation: {
            ...original.evaluation,
            evaluate: () => ({ value: 'a', reason: 'experiment', revision: 1, diagnostics: [], variant: 0, experimentVersion: 'v1' }),
          },
          assertCurrent() {
            if (!active) throw new HttpError(409, 'Retired.');
          },
          async issueAssignmentReceipt() {
            if (failure === 'retired') active = false;
            return { receipt: `ar1.${'a'.repeat(64)}`, value: 'b' };
          },
        });
      },
    });
    const f = request();
    await http(f.req, f.res);
    assert.notEqual(f.reply.status, 200);
    assert.doesNotMatch(f.reply.text, /assignmentReceipts|ar1\./);
  }
});

test('a failing native release fence after the values callback never publishes its buffered success', async () => {
  const http = createFlagValuesHttp({
    ...base,
    async withCapture(req, res, _guard, use) {
      await use(capture(req));
      assert.equal(res.writableEnded, false);
      throw new HttpError(403, 'Final membership fence failed.');
    },
  });
  const f = request();
  await http(f.req, f.res);
  assert.equal(f.reply.status, 403);
  assert.equal('values' in JSON.parse(f.reply.text), false);
});
