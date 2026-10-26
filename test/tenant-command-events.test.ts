import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { startTenantAssignment } from '../e2e/support/tenantProofServer.js';
import { COMMAND_EVENT_TABLES as eventTables } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { COMMAND_JOURNAL_TABLES as journalTables } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows, sqliteBatchRows } from './support/commandTargets.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { defineCommand, defineCommands, getCommandEvents } from '../packages/mistri/src/server/commands/businessCommands.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { tenantAssignmentCommands } from './support/tenantAssignmentFixture.js';
import { tenantAssignmentEventApp, tenantAssignmentEventCommands, type TenantEventsFixture } from './support/tenantAssignmentEvents.js';
import { serveTenantProof } from './support/tenantProofFixture.js';

type Fixture = Awaited<ReturnType<typeof startTenantAssignment>>;
type Row = Record<string, unknown>;
type Reply = { status: number; headers: Headers; body: Row };
type Context = { appId: string; accountId: string; tenantId: string; tabId: string; context: string; revision: number };
const reason = 'Synthetic private assignment note: proof-only@example.test';
const manifest = [{ name: 'application.reviewer-assigned', version: 1 }];
const ownerHeaders = ['app', 'account', 'tenant', 'tab', 'context', 'lease-revision'];
const object = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Row;
};
const objects = (value: unknown): Row[] => {
  assert.ok(Array.isArray(value), 'expected rows');
  return value.map(object);
};
function privateResponse(reply: Reply) {
  assert.ok(
    !/physical_|__mistri_|tenant_id|"(?:sql|params|stack|sessionId|password|token|payloadJson|envelopeVersion)"/.test(
      JSON.stringify(reply.body),
    ),
    'response disclosed private storage, credentials or an event envelope',
  );
}
function owned(reply: Reply, c: Context) {
  assert.equal(reply.status, 200);
  assert.ok(reply.body.errors === undefined || (Array.isArray(reply.body.errors) && reply.body.errors.length === 0));
  const expected = [c.appId, c.accountId, c.tenantId, c.tabId, c.context, String(c.revision)];
  ownerHeaders.forEach((name, index) => assert.ok(reply.headers.get(`x-mistri-${name}`) === expected[index], `incorrect ${name} owner`));
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
function denied(reply: Reply) {
  assert.ok(reply.status >= 400 || (Array.isArray(reply.body.errors) && reply.body.errors.length > 0), 'request must be refused');
  privateResponse(reply);
  for (const name of ownerHeaders) assert.ok(reply.headers.get(`x-mistri-${name}`) === null, 'refusal must not attest authority');
  for (const key of ['result', 'receiptId', 'rows', 'expectedVersion']) assert.equal(key in reply.body, false, `refusal disclosed ${key}`);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
async function fixture(t: TestContext, tenantEvents: TenantEventsFixture = true) {
  const f = await startTenantAssignment({ tenantEvents });
  t.after(() => f.stop());
  return f;
}
async function login(f: Fixture, role: keyof Fixture['accounts'] = 'manager') {
  const account = f.accounts[role];
  const response = await fetch(`${f.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, 'native sign-in failed');
  assert.ok(object(object(await response.json()).user).id === account.id, 'native account mismatch');
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);
  assert.ok(cookies.length > 0, 'native sign-in must issue a cookie');
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const response = await fetch(f.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: f.origin,
        cookie: cookies.join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    const secrets = [f.database, account.password, ...cookies.flatMap((cookie) => [cookie, cookie.slice(cookie.indexOf('=') + 1)])];
    // Check before parsing or any deep assertion could print server content.
    assert.ok(
      secrets.every((secret) => !text.includes(secret)),
      'response exposed a cookie, credential or database path',
    );
    const reply = { status: response.status, headers: response.headers, body: object(JSON.parse(text)) };
    privateResponse(reply);
    return reply;
  };
  const select = (path: string, tenant: string) => `${path}?app=${f.appId}&tenant=${tenant}`;
  const open = async (tenant = 'northstar') => {
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, 'context open failed');
    const c = reply.body as Context;
    assert.ok(c.appId === f.appId && c.accountId === account.id && c.tenantId === tenant, 'context identity mismatch');
    assert.equal(typeof c.tabId, 'string');
    assert.equal(typeof c.context, 'string');
    assert.equal(c.revision, 1);
    owned(reply, c);
    return c;
  };
  const data = async (path: string, c: Context, body?: unknown) => {
    const reply = await call(select(path, c.tenantId), body, {
      'x-mistri-account': c.accountId,
      'x-mistri-tab': c.tabId,
      'x-mistri-context': c.context,
      'x-mistri-lease-revision': String(c.revision),
    });
    if (reply.status < 400 && (reply.body.errors === undefined || (Array.isArray(reply.body.errors) && !reply.body.errors.length)))
      owned(reply, c);
    else denied(reply);
    return reply;
  };
  return { open, data, call, select };
}

/** Every observation opens an independent read-only connection and takes one
 * snapshot of ALL business resources and the receipt/audit/event companions. */
function evidence(f: Fixture) {
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    db.exec('BEGIN');
    const read = (table: string, order = 'id') =>
      db
        .prepare(`SELECT * FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`} ORDER BY "${order}" LIMIT 100`)
        .all()
        .map((row) => ({ ...row }));
    return {
      units: read('physical_location'),
      leads: read('physical_lead'),
      followUps: read('physical_follow_up'),
      activities: read('physical_activity'),
      staff: read('physical_review_staff'),
      applications: read('physical_loan_application'),
      history: read('physical_assignment_history'),
      receipts: read(journalTables.receipt),
      audits: read(sqliteAuditRows, 'receipt_id'),
      meta: read(eventTables.meta, 'singleton'),
      batches: read(sqliteBatchRows, 'receipt_id'),
      events: read(eventTables.event, 'event_id'),
    };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
function command(
  f: Fixture,
  application: string = f.assignmentRows.north.application,
  reviewer: string = f.assignmentRows.north.reviewer,
  idempotencyKey = 'tenant-assignment-event-attempt-0001',
) {
  return {
    command: 'assignReviewer',
    commandVersion: 2,
    key: { id: application },
    expectedVersion: 0,
    idempotencyKey,
    input: { reviewer, reason },
  };
}
function prepare(input: ReturnType<typeof command>) {
  return { command: input.command, commandVersion: input.commandVersion, key: input.key };
}
const ordered = (rows: Row[], key = 'id') => [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
function committed(
  f: Fixture,
  before: ReturnType<typeof evidence>,
  reply: Reply,
  input: ReturnType<typeof command>,
  tenant = 'northstar',
  manager: string = f.assignmentRows.north.manager,
) {
  assert.equal(reply.body.status, 'applied');
  const result = object(reply.body.result),
    after = evidence(f);
  assert.equal(typeof reply.body.receiptId, 'string');
  assert.match(String(result.assignmentId), /^[a-f0-9]{32}$/);
  assert.deepEqual(result, {
    applicationId: input.key.id,
    reviewerId: input.input.reviewer,
    assignmentId: result.assignmentId,
    managerId: manager,
    version: input.expectedVersion + 1,
    message: 'Reviewer assigned.',
  });
  const original = before.applications.find((row) => row.id === input.key.id);
  assert.ok(original);
  const history = after.history.find((row) => row.id === result.assignmentId);
  assert.ok(history);
  assert.deepEqual(history, {
    id: result.assignmentId,
    tenant_id: tenant,
    location_id: original.location_id,
    application_id: input.key.id,
    assigned_to: input.input.reviewer,
    assigned_by: manager,
    name: 'Reviewer assigned',
    reason: input.input.reason.trim(),
    assigned_on: history.assigned_on,
  });
  assert.equal(new Date(String(history.assigned_on)).toISOString(), history.assigned_on);
  const receipt = after.receipts.find((row) => row.id === reply.body.receiptId);
  assert.ok(receipt);
  assert.deepEqual(JSON.parse(String(receipt.result_json)), result);
  assert.deepEqual(
    [
      receipt.app_id,
      receipt.store_id,
      receipt.source_id,
      receipt.tenant_id,
      receipt.actor_id,
      receipt.command_id,
      receipt.command_version,
      receipt.idempotency_key,
    ],
    [f.appId, 'cross-app-proof', 'business', tenant, f.accounts.manager.id, 'assignReviewer', 2, input.idempotencyKey],
  );
  assert.equal(typeof receipt.request_id, 'string');
  assert.ok(String(receipt.request_id).length > 0);
  assert.equal(new Date(String(receipt.completed_at)).toISOString(), receipt.completed_at);
  const audit = after.audits.find((row) => row.receipt_id === receipt.id);
  assert.ok(audit);
  for (const name of ['app_id', 'store_id', 'source_id', 'tenant_id', 'actor_id']) assert.equal(audit[name], receipt[name]);
  assert.equal(audit.membership_id, `manager:${tenant}`);
  assert.equal(audit.membership_version, '1');
  assert.equal(audit.target, 'loan_application');
  assert.deepEqual(JSON.parse(String(audit.key_json)), input.key);
  assert.deepEqual(JSON.parse(String(audit.roles_json)), ['manager']);
  const changes = objects(JSON.parse(String(audit.changes_json)));
  assert.deepEqual(
    changes.map((change) => [change.operation, change.resource, change.key]),
    [
      ['update', 'loan_application', input.key],
      ['insert', 'assignment_history', { id: result.assignmentId }],
    ],
  );
  assert.deepEqual(changes[0].before, { reviewer_id: original.reviewer_id, status: original.status, version: original.version });
  assert.deepEqual(changes[0].after, { reviewer_id: input.input.reviewer, status: 'submitted', version: result.version });
  const batch = after.batches.find((row) => row.receipt_id === receipt.id);
  assert.ok(batch);
  const event = after.events.find((row) => row.receipt_id === receipt.id);
  assert.ok(event);
  assert.deepEqual(after.meta, [{ singleton: 1, version: 1, app_id: f.appId, store_id: 'cross-app-proof', source_id: 'business' }]);
  assert.deepEqual(JSON.parse(String(batch.manifest_json)), manifest);
  assert.equal(batch.event_count, 1);
  assert.equal(event.ordinal, 0);
  assert.match(String(event.event_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const envelope = object(JSON.parse(String(event.envelope_json)));
  assert.deepEqual(envelope, {
    envelopeVersion: 2,
    eventId: event.event_id,
    ordinal: 0,
    ...manifest[0],
    appId: f.appId,
    storeId: 'cross-app-proof',
    sourceId: 'business',
    scope: 'tenant',
    tenantId: tenant,
    actorId: f.accounts.manager.id,
    commandId: 'assignReviewer',
    commandVersion: 2,
    resource: 'loan_application',
    key: input.key,
    receiptId: receipt.id,
    requestId: receipt.request_id,
    occurredAt: receipt.completed_at,
    correlationId: receipt.request_id,
    causation: { kind: 'command', receiptId: receipt.id },
    payloadJson: envelope.payloadJson,
  });
  assert.deepEqual(JSON.parse(String(envelope.payloadJson)), {
    applicationId: input.key.id,
    reviewerId: input.input.reviewer,
    assignmentId: result.assignmentId,
    version: input.expectedVersion + 1,
  });
  assert.ok(
    !String(event.envelope_json).includes(reason) && !String(event.envelope_json).includes(f.database),
    'event must exclude free text and physical paths',
  );
  assert.equal(
    batch.digest,
    createHash('sha256')
      .update(canonicalCommandJson({ manifest, events: [envelope] }, 1048576))
      .digest('hex'),
  );
  // Exact whole-store delta catches extra rows, repeated handlers, cross-tenant
  // writes or independently committed receipt/audit/batch fragments.
  assert.deepEqual(after, {
    ...before,
    applications: before.applications.map((row) =>
      row.id === input.key.id ? { ...row, reviewer_id: input.input.reviewer, version: result.version } : row,
    ),
    history: ordered([...before.history, history]),
    receipts: ordered([...before.receipts, receipt]),
    audits: ordered([...before.audits, audit], 'receipt_id'),
    batches: ordered([...before.batches, batch], 'receipt_id'),
    events: ordered([...before.events, event], 'event_id'),
  });
  return after;
}

test('tenant events: opt-in clones the checked assignment reference and keeps original commands at version 1', async () => {
  const { commands: _commands, ...original } = await loadApp(resolve('test/fixtures/apps/tenant-ignition/assignment'), {
    commands: defineCommands({
      ...tenantAssignmentCommands({}),
      recordFollowUp: defineCommand({
        source: 'business',
        target: 'follow_up',
        input: { body: { type: 'textarea', max: 500 } },
        handle: () => undefined,
      }),
    }),
  });
  const before = structuredClone(original),
    clone = tenantAssignmentEventApp(original);
  assert.deepEqual(original, before);
  assert.notEqual(clone.app, original.app);
  const refs = (loaded: typeof original) =>
    Object.values(loaded.app.resources ?? {}).flatMap((resource) =>
      (resource.actions ?? []).flatMap((action) => (action.command ? [action.command] : [])),
    );
  assert.deepEqual(
    refs(clone),
    refs(original).map((ref) => (ref.id === 'assignReviewer' ? { ...ref, version: 2 } : ref)),
  );
  assert.deepEqual({ ...clone, app: { ...clone.app, resources: original.app.resources } }, original);
  const v1 = tenantAssignmentCommands({ manager: ['northstar-manager'] });
  const v2 = tenantAssignmentEventCommands({ manager: ['northstar-manager'] });
  assert.equal(v1.assignReviewer.version, 1);
  assert.equal(getCommandEvents(v1.assignReviewer), undefined);
  assert.equal(v2.assignReviewer.version, 2);
  assert.deepEqual(getCommandEvents(v2.assignReviewer)?.expectation, manifest);
});

test('tenant events: native manager commits the exact assignment/history/receipt/audit/event batch; duplicate sessions and status preserve IDs', async (t) => {
  const f = await fixture(t),
    first = await login(f),
    second = await login(f),
    c = await first.open(),
    other = await second.open();
  const input = command(f),
    before = evidence(f);
  const app = object((await first.data('/api/app', c)).body.app);
  const application = object(object(app.resources).loan_application);
  const action = objects(application.actions).find((action) => object(action.command).id === 'assignReviewer');
  assert.ok(action);
  assert.equal(object(action.command).version, 2);
  assert.equal((await first.data('/api/commands/prepare', c, prepare(input))).body.expectedVersion, 0);
  assert.deepEqual(evidence(f), before);
  const replies = await Promise.all([first.data('/api/commands/execute', c, input), second.data('/api/commands/execute', other, input)]);
  assert.deepEqual(replies.map((reply) => reply.body.replayed).sort(), [false, true]);
  assert.equal(replies[0].body.receiptId, replies[1].body.receiptId);
  assert.deepEqual(replies[0].body.result, replies[1].body.result);
  const saved = committed(f, before, replies[0], input);
  for (const path of ['/api/commands/execute', '/api/commands/status']) {
    const replay = await second.data(path, other, input);
    assert.deepEqual(replay.body, { ...replies[0].body, replayed: true });
    assert.deepEqual(evidence(f), saved);
  }
  const visible = await first.data('/api/query', c, {
    table: 'loan_application',
    columns: ['id', 'reviewer_id', 'version'],
    filter: { groups: [[{ column: 'id', op: '=', value: input.key.id }]] },
  });
  assert.deepEqual(visible.body.rows, [{ id: input.key.id, reviewer_id: input.input.reviewer, version: 1 }]);
  const history = await first.data('/api/query', c, {
    table: 'assignment_history',
    columns: ['id', 'application_id', 'assigned_to', 'reason'],
  });
  assert.deepEqual(history.body.rows, [
    { id: object(replies[0].body.result).assignmentId, application_id: input.key.id, assigned_to: input.input.reviewer, reason },
  ]);
  assert.deepEqual(evidence(f), saved);
});

test('tenant events: identical actor/idempotency key has separate tenant batches; foreign targets and other actors cannot recover them', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    north = await client.open(),
    south = await client.open('riverview');
  const input = command(f),
    before = evidence(f);
  const northReply = await client.data('/api/commands/execute', north, input);
  const northSaved = committed(f, before, northReply, input);
  for (const path of ['/api/commands/execute', '/api/commands/status']) {
    denied(await client.data(path, south, input));
    assert.deepEqual(evidence(f), northSaved);
  }
  for (const role of ['member', 'viewer'] as const) {
    const stranger = await login(f, role),
      context = await stranger.open();
    for (const path of ['/api/commands/prepare', '/api/commands/execute', '/api/commands/status']) {
      denied(await stranger.data(path, context, path.endsWith('/prepare') ? prepare(input) : input));
      assert.deepEqual(evidence(f), northSaved);
    }
    denied(await stranger.data('/api/commands/status', north, input));
    denied(await stranger.data('/api/commands/execute', { ...context, accountId: f.accounts.manager.id }, input));
    assert.deepEqual(evidence(f), northSaved);
  }
  const southInput = command(f, f.assignmentRows.south.application, f.assignmentRows.south.reviewer);
  const southReply = await client.data('/api/commands/execute', south, southInput);
  const saved = committed(f, northSaved, southReply, southInput, 'riverview', f.assignmentRows.south.manager);
  assert.notEqual(southReply.body.receiptId, northReply.body.receiptId);
  assert.equal(new Set(saved.events.map((row) => row.event_id)).size, 2);
  assert.deepEqual(saved.events.map((row) => object(JSON.parse(String(row.envelope_json))).tenantId).sort(), ['northstar', 'riverview']);
});

test('tenant events: invalid input, forged provenance and ineligible assignments leave every business/journal/event row unchanged', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    before = evidence(f),
    input = command(f),
    n = f.assignmentRows.north;
  const malformed = [
    ...['', '   ', 'x'.repeat(501), null].map((reason) => ({ ...input, input: { ...input.input, reason } })),
    ...['', null, { id: n.reviewer }].map((reviewer) => ({ ...input, input: { ...input.input, reviewer } })),
    ...['tenantId', 'actorId', 'eventId', 'payloadJson'].map((field) => ({ ...input, input: { ...input.input, [field]: 'forged' } })),
    { ...input, actorId: f.accounts.manager.id },
    { ...input, tenantId: 'riverview' },
    { ...input, commandVersion: 1 },
  ];
  for (const [index, bad] of malformed.entries())
    await t.test(`invalid request ${index}`, async () => {
      denied(await client.data('/api/commands/execute', c, { ...bad, idempotencyKey: `event-invalid-request-${index}` }));
      assert.deepEqual(evidence(f), before);
    });
  const ineligible = [
    [command(f, n.closedApplication), 'ineligible_state', 'not_applied'],
    [{ ...command(f), expectedVersion: 1 }, 'stale_record', 'not_applied'],
    [command(f, n.application, n.inactiveReviewer), 'reviewer_unavailable', 'not_applied'],
    [command(f, n.application, n.wrongRole), 'reviewer_unavailable', 'not_applied'],
    [command(f, n.application, f.assignmentRows.south.reviewer), 'reviewer_unavailable', 'not_applied'],
    [command(f, f.assignmentRows.south.application), 'forbidden', 'unknown'],
  ] as const;
  for (const [index, [bad, code, outcome]] of ineligible.entries())
    await t.test(`business refusal ${index}`, async () => {
      const reply = await client.data('/api/commands/execute', c, { ...bad, idempotencyKey: `event-ineligible-request-${index}` });
      denied(reply);
      assert.deepEqual({ code: reply.body.code, outcome: reply.body.outcome }, { code, outcome });
      assert.deepEqual(evidence(f), before);
    });
  committed(f, before, await client.data('/api/commands/execute', c, input), input);
});

test('tenant events: native membership revocation blocks prepared execution and historical recovery while retaining the other tenant', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    north = await client.open(),
    south = await client.open('riverview');
  const input = command(f),
    first = await client.data('/api/commands/execute', north, input);
  assert.equal(first.body.status, 'applied');
  const pending = {
    ...command(f, f.assignmentRows.north.staleApplication, f.assignmentRows.north.reviewer, 'event-prepared-before-revocation'),
    expectedVersion: 3,
  };
  assert.equal((await client.data('/api/commands/prepare', north, prepare(pending))).body.expectedVersion, 3);
  const before = evidence(f);
  await f.revoke(f.accounts.manager.id, 'northstar');
  denied(await client.data('/api/commands/execute', north, pending));
  for (const path of ['/api/commands/execute', '/api/commands/status']) denied(await client.data(path, north, input));
  denied(await client.call(client.select('/api/tenant/context/open', 'northstar'), {}));
  assert.deepEqual(evidence(f), before);
  const southInput = command(f, f.assignmentRows.south.application, f.assignmentRows.south.reviewer);
  committed(
    f,
    before,
    await client.data('/api/commands/execute', south, southInput),
    southInput,
    'riverview',
    f.assignmentRows.south.manager,
  );
});

test('tenant events: current historical reviewer visibility still gates replay and never regenerates the stored batch', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    input = command(f);
  const first = await client.data('/api/commands/execute', c, input);
  assert.equal(first.body.status, 'applied');
  await f.setStaffState(f.assignmentRows.north.reviewer, { active: 0 });
  const hidden = evidence(f),
    fresh = await client.open();
  for (const path of ['/api/commands/execute', '/api/commands/status']) {
    denied(await client.data(path, fresh, input));
    assert.deepEqual(evidence(f), hidden);
  }
  await f.setStaffState(f.assignmentRows.north.reviewer, { active: 1 });
  const visible = evidence(f),
    replay = await client.data('/api/commands/status', fresh, input);
  assert.deepEqual(replay.body, { ...first.body, replayed: true });
  assert.deepEqual(evidence(f), visible);
  assert.deepEqual(visible.events, hidden.events);
  assert.deepEqual(visible.batches, hidden.batches);
});

test('tenant events: event insertion failure rolls back staged business/history/receipt/audit/batch; exact retry commits once', async (t) => {
  const f = await fixture(t, 'insert-failure'),
    client = await login(f),
    c = await client.open(),
    input = command(f),
    before = evidence(f);
  assert.equal((await client.data('/api/commands/prepare', c, prepare(input))).body.expectedVersion, 0);
  const failed = await client.data('/api/commands/execute', c, input);
  denied(failed);
  assert.equal(failed.body.outcome, 'not_applied');
  assert.deepEqual(evidence(f), before);
  const missing = await client.data('/api/commands/status', c, input);
  assert.equal(missing.body.status, 'not_found');
  assert.equal('receiptId' in missing.body, false);
  assert.deepEqual(evidence(f), before);
  const first = await client.data('/api/commands/execute', c, input);
  assert.equal(first.body.replayed, false);
  const saved = committed(f, before, first, input);
  assert.deepEqual((await client.data('/api/commands/status', c, input)).body, { ...first.body, replayed: true });
  assert.deepEqual(evidence(f), saved);
});

test('tenant events: altered persisted payload refuses native replay/status without repair or replacement IDs', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    input = command(f);
  const first = await client.data('/api/commands/execute', c, input);
  assert.equal(first.body.status, 'applied');
  const saved = evidence(f),
    event = saved.events[0],
    envelope = object(JSON.parse(String(event.envelope_json)));
  const altered = canonicalCommandJson(
    {
      ...envelope,
      payloadJson: canonicalCommandJson({
        ...object(JSON.parse(String(envelope.payloadJson))),
        reviewerId: f.assignmentRows.north.alternateReviewer,
      }),
    },
    131072,
  );
  // Operator-style corruption is confined to this generated business file.
  // DDL and real-host checks stay intact; only the saved association is damaged.
  const db = new DatabaseSync(f.database);
  try {
    db.prepare(`UPDATE "${eventTables.event}" SET envelope_json=? WHERE event_id=?`).run(altered, String(event.event_id));
  } finally {
    db.close();
  }
  const damaged = evidence(f);
  for (const path of ['/api/commands/execute', '/api/commands/status']) {
    const reply = await client.data(path, c, input);
    denied(reply);
    assert.equal(reply.body.outcome, 'unknown');
    assert.deepEqual(evidence(f), damaged);
  }
  const repair = new DatabaseSync(f.database);
  try {
    repair
      .prepare(`UPDATE "${eventTables.event}" SET envelope_json=? WHERE event_id=?`)
      .run(String(event.envelope_json), String(event.event_id));
  } finally {
    repair.close();
  }
  assert.deepEqual((await client.data('/api/commands/status', c, input)).body, { ...first.body, replayed: true });
  assert.deepEqual(evidence(f), saved);
});

test('tenant events: a version-1 non-event command still executes in the provisioned host without acquiring a batch', async (t) => {
  const f = await fixture(t),
    client = await login(f, 'member'),
    c = await client.open(),
    before = evidence(f);
  const input = {
    command: 'recordFollowUp',
    commandVersion: 1,
    key: { id: f.rows.north.target },
    expectedVersion: 0,
    idempotencyKey: 'non-event-followup-in-event-store',
    input: { body: 'Synthetic follow-up.' },
  };
  const first = await client.data('/api/commands/execute', c, input);
  assert.equal(first.body.status, 'applied');
  const saved = evidence(f);
  assert.equal(saved.receipts.length, 1);
  assert.equal(saved.receipts[0].command_version, 1);
  assert.equal(saved.audits.length, 1);
  assert.equal(saved.activities.length, before.activities.length + 1);
  assert.deepEqual(saved.applications, before.applications);
  assert.deepEqual(saved.history, before.history);
  assert.deepEqual(saved.events, []);
  assert.deepEqual(saved.batches, []);
  for (const path of ['/api/commands/execute', '/api/commands/status']) {
    assert.deepEqual((await client.data(path, c, input)).body, { ...first.body, replayed: true });
    assert.deepEqual(evidence(f), saved);
  }
});

test('tenant events: missing event storage refuses actual native-host startup and does not provision or mutate assignment state', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-event-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  const environment = {
    BETTER_AUTH_SECRET: 'disposable-tenant-event-startup-secret-at-least-thirty-two-characters',
    MISTRI_AUTH_ADMIN_EMAIL: '',
    MISTRI_AUTH_ADMIN_PASSWORD: '',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  let refused = false;
  try {
    Object.assign(process.env, environment);
    await serveTenantProof({
      directory,
      port,
      appId: 'tenant-ignition-assignment',
      tenantProof: 'ignition',
      tenantAssignment: true,
      tenantEvents: 'missing-store',
    }).catch((error) => {
      // A failed assertion must not print an arbitrary provider error/path.
      assert.ok(error instanceof TenantContextError, 'expected native tenant enrollment refusal');
      refused = true;
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.ok(refused, 'missing event storage must prevent host startup');
  const db = new DatabaseSync(join(directory, 'business.db'), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE substr(name,1,18)='__mistri_event_'").get()?.n, 0);
    for (const table of ['physical_assignment_history', journalTables.receipt, sqliteAuditRows]) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`).get()?.n, 0);
    }
    assert.deepEqual(
      { ...db.prepare("SELECT reviewer_id,version FROM physical_loan_application WHERE id='northstar-application'").get() },
      { reviewer_id: null, version: 0 },
    );
  } finally {
    db.close();
  }
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
});
