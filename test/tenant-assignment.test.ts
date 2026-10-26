import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { startTenantAssignment } from '../e2e/support/tenantProofServer.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';

type Fixture = Awaited<ReturnType<typeof startTenantAssignment>>;
type ObjectValue = Record<string, unknown>;
type Reply = { status: number; headers: Headers; body: ObjectValue };
type Context = { appId: string; accountId: string; tenantId: string; tabId: string; context: string; revision: number; expiresAt: number };
type Role = keyof Fixture['accounts'];
const ownerNames = ['app', 'account', 'tenant', 'tab', 'context', 'lease-revision'];
const assertion = (c: Context) => ({ tabId: c.tabId, expectedContext: c.context, expectedRevision: c.revision });
const filter = (column: string, value: string) => ({ groups: [[{ column, op: '=', value }]] });

function object(value: unknown): ObjectValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
function objects(value: unknown): ObjectValue[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}
function noPrivate(reply: Reply) {
  assert.ok(
    !/tenant_id|physical_|__mistri_|approxRows|"(?:sql|params|stack|sessionId|password|token)"/.test(JSON.stringify(reply.body)),
    'response disclosed managed ownership or private implementation data',
  );
}
function denied(reply: Reply) {
  assert.ok(reply.status >= 400 || (Array.isArray(reply.body.errors) && reply.body.errors.length > 0), 'request must be refused');
  noPrivate(reply);
  for (const name of ownerNames) assert.ok(reply.headers.get(`x-mistri-${name}`) === null, `refusal attested ${name}`);
  for (const key of ['rows', 'result', 'receiptId', 'references', 'plans', 'expectedVersion']) {
    assert.equal(key in reply.body, false, `refusal disclosed ${key}`);
  }
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
function owned(reply: Reply, c: Context) {
  assert.equal(reply.status, 200);
  assert.ok(reply.body.errors === undefined || (Array.isArray(reply.body.errors) && reply.body.errors.length === 0));
  const values = [c.appId, c.accountId, c.tenantId, c.tabId, c.context, String(c.revision)];
  // Boolean assertions never print opaque context or native session values.
  ownerNames.forEach((name, i) => assert.ok(reply.headers.get(`x-mistri-${name}`) === values[i], `incorrect ${name} ownership`));
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
function rows(reply: Reply) {
  assert.equal(reply.status, 200);
  return objects(reply.body.rows);
}
const ids = (reply: Reply) =>
  rows(reply)
    .map((row) => row.id)
    .sort();

async function fixture(t: TestContext) {
  const f = await startTenantAssignment();
  t.after(() => f.stop());
  assert.equal(f.appId, 'tenant-ignition-assignment');
  return f;
}
async function login(f: Fixture, role: Role = 'manager') {
  const account = f.accounts[role];
  const response = await fetch(`${f.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, 'native sign-in failed');
  assert.ok(object(object(await response.json()).user).id === account.id, 'native sign-in returned another account');
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie.length > 0, 'native sign-in must issue session cookies');
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const reply = await fetch(f.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: f.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: reply.status, headers: reply.headers, body: object(await reply.json()) };
  };
  const select = (path: string, tenant: string) => `${path}?app=${f.appId}&tenant=${tenant}`;
  const headers = (c: Context) => ({
    'x-mistri-account': c.accountId,
    'x-mistri-tab': c.tabId,
    'x-mistri-context': c.context,
    'x-mistri-lease-revision': String(c.revision),
  });
  const bootstrap = async () => {
    const reply = await call(`/api/tenant/bootstrap?app=${f.appId}`);
    assert.equal(reply.status, 200);
    noPrivate(reply);
    return reply.body;
  };
  const open = async (tenant = 'northstar') => {
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, 'context open failed');
    for (const name of ['appId', 'accountId', 'tenantId', 'tabId', 'context']) assert.equal(typeof reply.body[name], 'string');
    const c = reply.body as Context;
    assert.ok(c.appId === f.appId && c.accountId === account.id && c.tenantId === tenant, 'incorrect context identity');
    assert.equal(c.revision, 1);
    assert.ok(c.expiresAt > Date.now());
    owned(reply, c);
    return c;
  };
  const data = async (path: string, c: Context, body?: unknown) => {
    const reply = await call(select(path, c.tenantId), body, headers(c));
    noPrivate(reply);
    if (reply.status < 400 && (reply.body.errors === undefined || (Array.isArray(reply.body.errors) && reply.body.errors.length === 0)))
      owned(reply, c);
    else denied(reply);
    return reply;
  };
  return { call, select, headers, bootstrap, open, data };
}

// Read-only observations of the same business file witness all seven resources
// and both journal tables. All mutations belong to HTTP or private fixture IPC.
function evidence(f: Fixture) {
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const read = (table: string, order = 'id') =>
      db
        .prepare(`SELECT * FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`} ORDER BY "${order}"`)
        .all()
        .map((row) => ({ ...row }));
    return {
      units: read(`physical_${f.model.unit}`),
      work: read(`physical_${f.model.work}`),
      targets: read(`physical_${f.model.target}`),
      events: read(`physical_${f.model.event}`),
      staff: read(`physical_${f.assignment.staff}`),
      applications: read(`physical_${f.assignment.application}`),
      history: read(`physical_${f.assignment.history}`),
      receipts: read(COMMAND_JOURNAL_TABLES.receipt),
      audits: read(sqliteAuditRows, 'receipt_id'),
    };
  } finally {
    db.close();
  }
}
function command(
  f: Fixture,
  application: string = f.assignmentRows.north.application,
  reviewer: string = f.assignmentRows.north.reviewer,
  idempotencyKey = 'assignment-same-actor-attempt-0001',
) {
  return {
    command: f.assignment.command,
    commandVersion: 1,
    key: { id: application },
    expectedVersion: 0,
    idempotencyKey,
    input: { reviewer, reason: '  A manual reviewer assignment.  ' },
  };
}
function prepare(f: Fixture, application: string = f.assignmentRows.north.application) {
  return { command: f.assignment.command, commandVersion: 1, key: { id: application } };
}
function applied(reply: Reply, application: string, reviewer: string, manager: string) {
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, 'applied');
  const result = object(reply.body.result);
  assert.deepEqual(Object.keys(result).sort(), ['applicationId', 'assignmentId', 'managerId', 'message', 'reviewerId', 'version']);
  assert.equal(typeof result.assignmentId, 'string');
  assert.match(result.assignmentId as string, /^[0-9a-f]{32}$/);
  assert.deepEqual(result, {
    applicationId: application,
    reviewerId: reviewer,
    assignmentId: result.assignmentId,
    managerId: manager,
    version: 1,
    message: 'Reviewer assigned.',
  });
  assert.equal(typeof reply.body.receiptId, 'string');
  return result;
}
function committed(
  f: Fixture,
  before: ReturnType<typeof evidence>,
  reply: Reply,
  input: ReturnType<typeof command>,
  tenant: string,
  manager: string,
) {
  const result = applied(reply, input.key.id, input.input.reviewer, manager),
    after = evidence(f);
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
  assert.equal(typeof history.assigned_on, 'string');
  assert.equal(new Date(String(history.assigned_on)).toISOString(), history.assigned_on);
  const receipt = after.receipts.find((row) => row.id === reply.body.receiptId);
  assert.ok(receipt);
  assert.deepEqual(JSON.parse(String(receipt.result_json)), result);
  assert.equal(receipt.app_id, f.appId);
  assert.equal(receipt.tenant_id, tenant);
  assert.equal(receipt.actor_id, f.accounts.manager.id);
  assert.equal(receipt.command_id, f.assignment.command);
  assert.equal(receipt.command_version, 1);
  assert.equal(receipt.idempotency_key, input.idempotencyKey);
  const audit = after.audits.find((row) => row.receipt_id === receipt.id);
  assert.ok(audit);
  for (const column of ['app_id', 'store_id', 'source_id', 'tenant_id', 'actor_id']) assert.equal(audit[column], receipt[column]);
  assert.equal(audit.membership_version, '1');
  assert.equal(audit.target, f.assignment.application);
  assert.deepEqual(JSON.parse(String(audit.key_json)), input.key);
  assert.deepEqual(JSON.parse(String(audit.roles_json)), ['manager']);
  const changes = objects(JSON.parse(String(audit.changes_json)));
  assert.deepEqual(
    changes.map((change) => [change.operation, change.resource, change.key]),
    [
      ['update', f.assignment.application, input.key],
      ['insert', f.assignment.history, { id: result.assignmentId }],
    ],
  );
  assert.deepEqual(changes[0].before, { reviewer_id: null, status: 'submitted', version: 0 });
  assert.deepEqual(changes[0].after, { reviewer_id: input.input.reviewer, status: 'submitted', version: 1 });
  // Exact whole-store comparison detects stray writes, missing history, or a
  // receipt/audit committed independently of the conditional application update.
  assert.deepEqual(after, {
    ...before,
    applications: before.applications.map((row) =>
      row.id === input.key.id ? { ...row, reviewer_id: input.input.reviewer, version: 1 } : row,
    ),
    history: [...before.history, history].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    receipts: [...before.receipts, receipt].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    audits: [...before.audits, audit].sort((a, b) => String(a.receipt_id).localeCompare(String(b.receipt_id))),
  });
  return after;
}

test('assignment: native scoped reads, joins, counts and the actual reviewer picker isolate tenants and staff grants', async (t) => {
  const f = await fixture(t),
    a = f.assignment,
    n = f.assignmentRows.north,
    s = f.assignmentRows.south;
  const manager = await login(f),
    member = await login(f, 'member');
  const north = await manager.open(),
    south = await manager.open('riverview'),
    restricted = await member.open();
  const before = evidence(f);
  assert.ok(north.context !== south.context && north.tabId !== south.tabId, 'contexts must be independent');
  for (const [c, expected, prefix] of [
    [north, n, 'Northstar'],
    [south, s, 'Riverview'],
  ] as const) {
    assert.deepEqual(
      rows(
        await manager.data('/api/query', c, {
          table: a.application,
          columns: ['id', 'business_id', 'reviewer_id', 'version'],
          filter: filter('business_id', 'APP-001'),
        }),
      ),
      [{ id: expected.application, business_id: 'APP-001', reviewer_id: null, version: 0 }],
    );
    assert.deepEqual(
      rows(
        await manager.data('/api/view/run', c, {
          view: {
            base: a.application,
            columns: ['id', 'location_id.name', 'lead_id.name'],
            filter: { groups: [[{ path: 'business_id', op: '=', value: 'APP-001' }]] },
          },
        }),
      ),
      [{ id: expected.application, 'location_id.name': `${prefix} main unit`, 'lead_id.name': `${prefix} work` }],
    );
    assert.deepEqual(
      ids(await manager.data('/api/query', c, { table: a.staff })),
      [expected.manager, expected.reviewer, expected.alternateReviewer, expected.wrongRole].sort(),
    );
    assert.equal((await manager.data('/api/count', c, { table: a.staff })).body.count, 4);
    // CommandForm.commandChoices uses /api/run, not an options endpoint.
    const picker = { q: `${a.staff} active = 1 and role = reviewer show id, name sort name`, limit: 20, offset: 0 };
    assert.deepEqual(rows(await manager.data('/api/run', c, picker)), [
      { id: expected.alternateReviewer, name: `${prefix} alternate reviewer` },
      { id: expected.reviewer, name: `${prefix} reviewer` },
    ]);
    for (const search of [prefix === 'Northstar' ? 'Riverview' : 'Northstar', 'other-location', 'inactive', 'clerk']) {
      assert.deepEqual(
        rows(
          await manager.data('/api/run', c, {
            ...picker,
            q: `${a.staff} active = 1 and role = reviewer and name contains ${JSON.stringify(search)} show id, name sort name`,
          }),
        ),
        [],
      );
    }
  }
  assert.deepEqual(
    ids(await manager.data('/api/query', north, { table: f.model.work })),
    [f.rows.north.work, f.rows.north.otherWork].sort(),
  );
  assert.deepEqual(ids(await member.data('/api/query', restricted, { table: f.model.work })), [f.rows.north.work]);
  assert.deepEqual(
    ids(await manager.data('/api/query', north, { table: a.application })),
    [n.application, n.otherApplication, n.closedApplication, n.assignedApplication, n.staleApplication, n.mismatchedLeadApplication].sort(),
  );
  assert.deepEqual(
    ids(await member.data('/api/query', restricted, { table: a.application })),
    [n.application, n.closedApplication, n.assignedApplication, n.staleApplication, n.mismatchedLeadApplication].sort(),
  );
  assert.deepEqual(
    rows(
      await manager.data('/api/query', north, {
        table: a.application,
        columns: ['id', 'business_id', 'location_id', 'lead_id', 'reviewer_id', 'version'],
        filter: filter('id', n.mismatchedLeadApplication),
      }),
    ),
    [
      {
        id: n.mismatchedLeadApplication,
        business_id: 'APP-006',
        location_id: f.rows.north.unit,
        lead_id: f.rows.north.otherWork,
        reviewer_id: null,
        version: 0,
      },
    ],
  );
  assert.deepEqual(
    rows(
      await manager.data('/api/view/run', north, {
        view: {
          base: a.application,
          columns: ['id', 'location_id.name', 'lead_id.name', 'lead_id.location_id'],
          filter: { groups: [[{ path: 'id', op: '=', value: n.mismatchedLeadApplication }]] },
        },
      }),
    ),
    [
      {
        id: n.mismatchedLeadApplication,
        'location_id.name': 'Northstar main unit',
        'lead_id.name': 'Northstar hidden work',
        'lead_id.location_id': f.rows.north.otherUnit,
      },
    ],
  );
  for (const hidden of [n.otherReviewer, n.inactiveReviewer, s.reviewer, s.manager]) {
    assert.deepEqual(rows(await manager.data('/api/query', north, { table: a.staff, filter: filter('id', hidden) })), []);
    assert.equal((await manager.data('/api/count', north, { table: a.staff, filter: filter('id', hidden) })).body.count, 0);
    denied(await manager.data('/api/pages/plan', north, { page: a.staff, key: { id: hidden } }));
    denied(await manager.data('/api/references', north, { table: a.staff, key: { id: hidden } }));
  }
  const schema = objects((await manager.data('/api/schema', north)).body.tables);
  assert.deepEqual(
    schema.map((table) => table.id).sort(),
    [f.model.unit, f.model.work, f.model.target, f.model.event, a.staff, a.application, a.history].sort(),
  );
  const app = object((await manager.data('/api/app', north)).body.app);
  assert.deepEqual(app.writableTables, [f.model.work]);
  assert.deepEqual((app.grantedCommands as string[]).slice().sort(), [f.model.command, a.command].sort());
  const nav = object(object(app.resources)[a.application]);
  const reference = object(objects(nav.actions)[0].command);
  assert.equal(reference.id, a.command);
  assert.equal(reference.version, 1);
  assert.equal(reference.versionField, undefined, 'revision columns are server-owned metadata');
  const fields = objects(reference.input),
    reviewer = fields.find((field) => field.name === 'reviewer');
  assert.ok(reviewer);
  assert.equal(reviewer.from, a.staff);
  assert.equal(reviewer.by, 'id');
  assert.equal(reviewer.labelColumn, 'name');
  assert.equal(reviewer.query, 'active = 1 and role = reviewer');
  assert.equal(reviewer.required, true);
  assert.equal(fields.find((field) => field.name === 'reason')?.maxLength, 500);
  for (const table of schema.map((entry) => String(entry.id))) {
    denied(await manager.data('/api/query', north, { table, columns: ['tenant_id'] }));
  }
  denied(await manager.data('/api/commands/options', north, { ...prepare(f), field: 'reviewer' }));
  assert.deepEqual(evidence(f), before);
});

test('assignment: prepare captures exact visible versions without effects or reserving eligibility', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    n = f.assignmentRows.north,
    before = evidence(f);
  for (const [application, version] of [
    [n.application, 0],
    [n.otherApplication, 0],
    [n.closedApplication, 0],
    [n.assignedApplication, 1],
    [n.staleApplication, 3],
    [n.mismatchedLeadApplication, 0],
  ] as const) {
    assert.deepEqual((await client.data('/api/commands/prepare', c, prepare(f, application))).body, { expectedVersion: version });
    assert.deepEqual(evidence(f), before);
  }
  for (const application of [f.assignmentRows.south.application, 'unknown-application']) {
    denied(await client.data('/api/commands/prepare', c, prepare(f, application)));
  }
  denied(await client.data('/api/commands/prepare', c, { ...prepare(f), commandVersion: 2 }));
  const status = await client.data('/api/commands/status', c, command(f));
  assert.equal(status.body.status, 'not_found');
  assert.equal('result' in status.body, false);
  assert.deepEqual(evidence(f), before);
});

test('assignment: same native actor/key/business ID in two tenants has independent atomic effects and exact durable replay', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    north = await client.open(),
    south = await client.open('riverview');
  const receipts: unknown[] = [];
  for (const [c, expected] of [
    [north, f.assignmentRows.north],
    [south, f.assignmentRows.south],
  ] as const) {
    const before = evidence(f),
      input = command(f, expected.application, expected.reviewer);
    assert.equal((await client.data('/api/commands/prepare', c, prepare(f, expected.application))).body.expectedVersion, 0);
    const first = await client.data('/api/commands/execute', c, input);
    assert.equal(first.body.replayed, false);
    receipts.push(first.body.receiptId);
    const after = committed(f, before, first, input, c.tenantId, expected.manager);
    for (const path of ['/api/commands/execute', '/api/commands/status']) {
      const replay = await client.data(path, c, input);
      applied(replay, expected.application, expected.reviewer, expected.manager);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.receiptId, first.body.receiptId);
      assert.deepEqual(replay.body.result, first.body.result);
      assert.deepEqual(evidence(f), after);
    }
    for (const altered of [
      { ...input, input: { ...input.input, reviewer: expected.alternateReviewer } },
      { ...input, input: { ...input.input, reason: 'A conflicting reason.' } },
      { ...input, expectedVersion: 1 },
    ]) {
      denied(await client.data('/api/commands/execute', c, altered));
      assert.deepEqual(evidence(f), after);
    }
    const result = object(first.body.result);
    const plan = await client.data('/api/pages/plan', c, { page: f.assignment.application, key: input.key });
    const related = objects(plan.body.plans).find((value) => value.kind === 'list' && object(value.view).base === f.assignment.history);
    assert.ok(related);
    const history = rows(await client.data('/api/view/run', c, { view: related.view }));
    assert.equal(history.length, 1);
    assert.equal(history[0].name, 'Reviewer assigned');
    assert.equal(history[0].reason, input.input.reason.trim());
    assert.equal(history[0]['assigned_to.name'], c === north ? 'Northstar reviewer' : 'Riverview reviewer');
    assert.deepEqual(
      ids(await client.data('/api/query', c, { table: f.assignment.history, filter: filter('application_id', input.key.id) })),
      [result.assignmentId],
    );
    const refs = objects((await client.data('/api/references', c, { table: f.assignment.application, key: input.key })).body.references);
    assert.ok(refs.some((ref) => ref.table === f.assignment.history && ref.count === 1));
    assert.deepEqual(evidence(f), after);
  }
  assert.notEqual(receipts[0], receipts[1]);
  const after = evidence(f);
  assert.equal(after.history.length, 2);
  assert.equal(after.receipts.length, 2);
  assert.equal(after.audits.length, 2);
  assert.deepEqual(
    after.receipts.map((row) => [row.tenant_id, row.actor_id, row.idempotency_key]).sort(),
    ['northstar', 'riverview'].map((tenant) => [tenant, f.accounts.manager.id, command(f).idempotencyKey]),
  );
  assert.deepEqual(
    ids(await client.data('/api/query', north, { table: f.assignment.history })),
    after.history.filter((row) => row.tenant_id === 'northstar').map((row) => row.id),
  );
});

test('assignment: stale, assigned, closed, hidden and forged references fail without any database effect', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    n = f.assignmentRows.north,
    before = evidence(f);
  const attempts = [
    ['wrong expected version', { ...command(f), expectedVersion: 1 }, 'stale_record', 'not_applied'],
    ['stale seeded application', command(f, n.staleApplication), 'stale_record', 'not_applied'],
    ['closed application', command(f, n.closedApplication), 'ineligible_state', 'not_applied'],
    ['already assigned application', { ...command(f, n.assignedApplication), expectedVersion: 1 }, 'ineligible_state', 'not_applied'],
    ['other-location application with main reviewer', command(f, n.otherApplication), 'forbidden', 'not_applied'],
    ['other-location application and reviewer', command(f, n.otherApplication, n.otherReviewer), 'forbidden', 'not_applied'],
    // Target admission precedes journal.find: these refusals cannot establish
    // absence of an earlier receipt, even though our fresh store stays unchanged.
    ['cross-tenant application', command(f, f.assignmentRows.south.application, f.assignmentRows.south.reviewer), 'forbidden', 'unknown'],
    ['nonexistent application', command(f, 'unknown-application'), 'forbidden', 'unknown'],
    ['application with readable but wrong-location lead', command(f, n.mismatchedLeadApplication), 'forbidden', 'not_applied'],
    // These targets are visible and their receipt lookup establishes absence;
    // current reviewer eligibility then fails inside the admitted handler.
    ...(
      [
        ['inactive reviewer', n.inactiveReviewer],
        ['wrong-role reviewer', n.wrongRole],
        ['manager as reviewer', n.manager],
        ['other-location reviewer', n.otherReviewer],
        ['cross-tenant reviewer', f.assignmentRows.south.reviewer],
        ['cross-tenant manager as reviewer', f.assignmentRows.south.manager],
        ['nonexistent reviewer', 'unknown-reviewer'],
      ] as const
    ).map(([label, reviewer]) => [label, command(f, n.application, reviewer), 'reviewer_unavailable', 'not_applied'] as const),
  ] as const;
  for (const [index, [label, input, code, outcome]] of attempts.entries()) {
    await t.test(`attempt ${index}: ${label}`, async () => {
      const reply = await client.data('/api/commands/execute', c, { ...input, idempotencyKey: `assignment-rejected-reference-${index}` });
      denied(reply);
      assert.deepEqual({ code: reply.body.code, outcome: reply.body.outcome }, { code, outcome }, `attempt ${index}: ${label}`);
      assert.deepEqual(evidence(f), before, `attempt ${index}: ${label} changed the database`);
    });
  }
});

test('assignment: handler rejects an application whose visible lead moved to another authorized location after prepare', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    n = f.assignmentRows.north,
    input = command(f);
  const before = evidence(f),
    application = before.applications.find((row) => row.id === n.application);
  assert.ok(application);
  const lead = before.work.find((row) => row.id === application.lead_id);
  assert.ok(lead);
  assert.equal(lead.location_id, application.location_id);
  assert.equal((await client.data('/api/commands/prepare', c, prepare(f))).body.expectedVersion, 0);
  // Both locations are readable and lead is generically writable. Exercise a
  // legitimate parent edit, leaving the command-owned application untouched.
  const moved = await client.data('/api/update', c, {
    table: f.model.work,
    key: { id: lead.id },
    expected: { location_id: lead.location_id },
    values: { location_id: f.rows.north.otherUnit },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.affected, 1);
  const incoherent = evidence(f);
  assert.deepEqual(incoherent, {
    ...before,
    work: before.work.map((row) => (row.id === lead.id ? { ...row, location_id: f.rows.north.otherUnit } : row)),
  });
  assert.deepEqual(
    rows(
      await client.data('/api/query', c, { table: f.model.work, columns: ['id', 'location_id'], filter: filter('id', String(lead.id)) }),
    ),
    [{ id: lead.id, location_id: f.rows.north.otherUnit }],
  );
  const refused = await client.data('/api/commands/execute', c, input);
  denied(refused);
  assert.deepEqual({ code: refused.body.code, outcome: refused.body.outcome }, { code: 'forbidden', outcome: 'not_applied' });
  assert.deepEqual(evidence(f), incoherent);
  // Restoring coherence makes the exact attempt eligible, proving the earlier
  // failure neither assigned the application nor reserved an idempotency key.
  const restored = await client.data('/api/update', c, {
    table: f.model.work,
    key: { id: lead.id },
    expected: { location_id: f.rows.north.otherUnit },
    values: { location_id: lead.location_id },
  });
  assert.equal(restored.body.affected, 1);
  assert.deepEqual(evidence(f), before);
  committed(f, before, await client.data('/api/commands/execute', c, input), input, 'northstar', n.manager);
});

test('assignment: strict input and envelope reject actor/tenant injection, unbounded reasons and malformed reviewer keys', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    input = command(f),
    before = evidence(f);
  const forged = [
    ...['', '   ', 'x'.repeat(501), null, 7].map((reason) => ({ ...input, input: { ...input.input, reason } })),
    ...['', ' ', 7, null, { id: f.assignmentRows.north.reviewer }].map((reviewer) => ({ ...input, input: { ...input.input, reviewer } })),
    ...['actorId', 'managerId', 'staffId', 'tenantId', 'tenant_id'].map((field) => ({
      ...input,
      input: { ...input.input, [field]: f.assignmentRows.south.manager },
    })),
    { ...input, actorId: f.accounts.manager.id },
    { ...input, tenantId: 'riverview' },
    { ...input, commandVersion: 2 },
    { ...input, expectedVersion: -1 },
    { ...input, key: { id: input.key.id, tenant_id: 'northstar' } },
    { ...input, key: { business_id: 'APP-001' } },
    { ...input, input: { reviewer: input.input.reviewer } },
  ];
  for (const value of forged) {
    denied(await client.data('/api/commands/execute', c, value));
    assert.deepEqual(evidence(f), before);
  }
  const bounded = { ...input, input: { ...input.input, reason: 'x'.repeat(500) } };
  committed(f, before, await client.data('/api/commands/execute', c, bounded), bounded, 'northstar', f.assignmentRows.north.manager);
});

test('assignment: concurrent duplicate delivery has one effect and fresh competing attempts have one winner', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    north = await client.open(),
    south = await client.open('riverview');
  const duplicate = command(f),
    before = evidence(f);
  const deliveries = await Promise.all([
    client.data('/api/commands/execute', north, duplicate),
    client.data('/api/commands/execute', north, duplicate),
  ]);
  assert.deepEqual(deliveries.map((reply) => reply.body.replayed).sort(), [false, true]);
  assert.equal(deliveries[0].body.receiptId, deliveries[1].body.receiptId);
  assert.deepEqual(deliveries[0].body.result, deliveries[1].body.result);
  const afterDuplicate = committed(f, before, deliveries[0], duplicate, 'northstar', f.assignmentRows.north.manager);
  const s = f.assignmentRows.south;
  const attempts = [
    command(f, s.application, s.reviewer, 'assignment-race-first-attempt-0001'),
    command(f, s.application, s.alternateReviewer, 'assignment-race-second-attempt-0001'),
  ];
  for (const input of attempts)
    assert.equal((await client.data('/api/commands/prepare', south, prepare(f, input.key.id))).body.expectedVersion, 0);
  const replies = await Promise.all(attempts.map((input) => client.data('/api/commands/execute', south, input)));
  const winners = replies.map((reply, index) => ({ reply, index })).filter(({ reply }) => reply.body.status === 'applied');
  assert.equal(winners.length, 1);
  const winner = winners[0],
    loserIndex = 1 - winner.index;
  denied(replies[loserIndex]);
  assert.equal(replies[loserIndex].body.outcome, 'not_applied');
  const after = committed(f, afterDuplicate, winner.reply, attempts[winner.index], 'riverview', s.manager);
  const missing = await client.data('/api/commands/status', south, attempts[loserIndex]);
  assert.equal(missing.body.status, 'not_found');
  assert.equal('receiptId' in missing.body, false);
  const recovered = await client.data('/api/commands/status', south, attempts[winner.index]);
  assert.equal(recovered.body.receiptId, winner.reply.body.receiptId);
  assert.deepEqual(evidence(f), after);
});

test('assignment: generic insert/update/delete cannot bypass command ownership on any protected resource', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    n = f.assignmentRows.north;
  const input = command(f);
  applied(await client.data('/api/commands/execute', c, input), n.application, n.reviewer, n.manager);
  const before = evidence(f);
  for (const [table, originals] of [
    [f.model.unit, before.units],
    [f.model.target, before.targets],
    [f.model.event, before.events],
    [f.assignment.staff, before.staff],
    [f.assignment.application, before.applications],
    [f.assignment.history, before.history],
  ] as const) {
    const original = originals.find((row) => row.tenant_id === 'northstar');
    assert.ok(original);
    const { tenant_id: _owner, ...values } = original;
    const inserts = { ...values, id: `generic-bypass-${table}`, ...('business_id' in values ? { business_id: `BYPASS-${table}` } : {}) };
    for (const [path, body] of [
      ['/api/insert', { table, values: inserts }],
      ['/api/update', { table, key: { id: original.id }, values: { name: 'Generic bypass' } }],
      ['/api/delete', { table, key: { id: original.id }, confirm: true }],
    ] as const) {
      denied(await client.data(path, c, body));
      assert.deepEqual(evidence(f), before);
    }
  }
  for (const values of [
    { reviewer_id: n.alternateReviewer, version: 2 },
    { status: 'submitted', reviewer_id: null, version: 0 },
  ]) {
    denied(await client.data('/api/update', c, { table: f.assignment.application, key: input.key, values }));
    assert.deepEqual(evidence(f), before);
  }
});

for (const role of ['member', 'viewer'] as const) {
  test(`assignment: native ${role} has no assignment command authority`, async (t) => {
    const f = await fixture(t),
      client = await login(f, role),
      c = await client.open(),
      before = evidence(f);
    const app = object((await client.data('/api/app', c)).body.app);
    assert.deepEqual(app.grantedCommands, role === 'member' ? [f.model.command] : []);
    assert.deepEqual(app.writableTables, role === 'member' ? [f.model.work] : []);
    assert.deepEqual(ids(await client.data('/api/query', c, { table: f.model.work })), [f.rows.north.work]);
    for (const [path, body] of [
      ['/api/commands/prepare', prepare(f)],
      ['/api/commands/execute', command(f)],
      ['/api/commands/status', command(f)],
    ] as const) {
      denied(await client.data(path, c, body));
      assert.deepEqual(evidence(f), before);
    }
    denied(await client.data('/api/commands/execute', { ...c, accountId: f.accounts.manager.id }, command(f)));
    assert.deepEqual(evidence(f), before);
    const manager = await login(f),
      managed = await manager.open(),
      n = f.assignmentRows.north;
    applied(await manager.data('/api/commands/execute', managed, command(f)), n.application, n.reviewer, n.manager);
    const saved = evidence(f);
    for (const path of ['/api/commands/status', '/api/commands/execute']) denied(await client.data(path, c, command(f)));
    assert.deepEqual(evidence(f), saved);
    if (role === 'viewer') {
      assert.deepEqual((await client.bootstrap()).memberships, [{ tenantId: 'northstar' }]);
      denied(await client.call(client.select('/api/tenant/context/open', 'riverview'), {}));
    }
  });
}

for (const role of ['member', 'manager'] as const) {
  test(`assignment: existing recordFollowUp remains executable by ${role}`, async (t) => {
    const f = await fixture(t),
      client = await login(f, role),
      c = await client.open(),
      before = evidence(f);
    const input = {
      command: f.model.command,
      commandVersion: 1,
      key: { id: f.rows.north.target },
      expectedVersion: 0,
      idempotencyKey: 'assignment-existing-follow-up-0001',
      input: { body: 'Existing follow-up still works.' },
    };
    const reply = await client.data('/api/commands/execute', c, input);
    assert.equal(reply.body.status, 'applied');
    assert.equal(object(reply.body.result).targetId, f.rows.north.target);
    const after = evidence(f);
    assert.deepEqual(after.applications, before.applications);
    assert.deepEqual(after.staff, before.staff);
    assert.deepEqual(after.history, before.history);
    assert.equal(after.events.length, before.events.length + 1);
    assert.equal(after.receipts.length, 1);
    assert.equal(after.audits.length, 1);
    assert.equal(after.receipts[0].actor_id, f.accounts[role].id);
  });
}

for (const subject of ['manager', 'reviewer'] as const) {
  test(`assignment: ${subject} activity and role are rechecked after prepare on the actual writer`, async (t) => {
    const f = await fixture(t),
      client = await login(f),
      c = await client.open(),
      n = f.assignmentRows.north;
    const staff = n[subject],
      original = evidence(f);
    for (const state of [{ active: 0 as const }, { role: 'clerk' as const }]) {
      assert.equal((await client.data('/api/commands/prepare', c, prepare(f))).body.expectedVersion, 0);
      await f.setStaffState(staff, state);
      const changed = evidence(f);
      assert.deepEqual(changed, { ...original, staff: original.staff.map((row) => (row.id === staff ? { ...row, ...state } : row)) });
      denied(await client.data('/api/commands/execute', c, command(f)));
      assert.deepEqual(evidence(f), changed);
      await f.setStaffState(staff, { active: 1, role: subject });
      assert.deepEqual(evidence(f), original);
    }
    committed(f, original, await client.data('/api/commands/execute', c, command(f)), command(f), 'northstar', n.manager);
  });

  test(`assignment: deactivating historical ${subject} denies exact receipt recovery and duplicate execution`, async (t) => {
    const f = await fixture(t),
      client = await login(f),
      c = await client.open(),
      n = f.assignmentRows.north,
      input = command(f);
    const first = await client.data('/api/commands/execute', c, input);
    applied(first, n.application, n.reviewer, n.manager);
    await f.setStaffState(n[subject], { active: 0 });
    const changed = evidence(f),
      fresh = await client.open();
    for (const context of [c, fresh]) {
      assert.deepEqual(rows(await client.data('/api/query', context, { table: f.assignment.staff, filter: filter('id', n[subject]) })), []);
      for (const path of ['/api/commands/status', '/api/commands/execute']) {
        denied(await client.data(path, context, input));
        assert.deepEqual(evidence(f), changed);
      }
    }
    await f.setStaffState(n[subject], { active: 1 });
    const restored = evidence(f),
      recovered = await client.data('/api/commands/status', fresh, input);
    assert.equal(recovered.body.replayed, true);
    assert.equal(recovered.body.receiptId, first.body.receiptId);
    assert.deepEqual(recovered.body.result, first.body.result);
    assert.deepEqual(evidence(f), restored);
  });
}

test('assignment: membership version/unit shift invalidates prepared authority and denies historical dependencies in a fresh context', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    old = await client.open(),
    n = f.assignmentRows.north,
    input = command(f);
  applied(await client.data('/api/commands/execute', old, input), n.application, n.reviewer, n.manager);
  const pending = { ...command(f, n.staleApplication), expectedVersion: 3, idempotencyKey: 'assignment-before-membership-shift-0001' };
  assert.equal((await client.data('/api/commands/prepare', old, prepare(f, pending.key.id))).body.expectedVersion, 3);
  const before = evidence(f);
  await f.shift(f.accounts.manager.id, 'northstar');
  denied(await client.data('/api/query', old, { table: f.assignment.application }));
  denied(await client.data('/api/commands/execute', old, pending));
  denied(await client.call(client.select('/api/tenant/context/renew', 'northstar'), assertion(old)));
  const fresh = await client.open();
  assert.deepEqual(ids(await client.data('/api/query', fresh, { table: f.model.work })), [f.rows.north.otherWork]);
  assert.deepEqual(ids(await client.data('/api/query', fresh, { table: f.assignment.application })), [n.otherApplication]);
  assert.deepEqual(ids(await client.data('/api/query', fresh, { table: f.assignment.staff })), [n.otherReviewer]);
  for (const c of [old, fresh])
    for (const path of ['/api/commands/status', '/api/commands/execute']) denied(await client.data(path, c, input));
  denied(await client.data('/api/commands/execute', fresh, pending));
  // Other-location work/staff visibility does not invent a native actor binding.
  denied(await client.data('/api/commands/execute', fresh, command(f, n.otherApplication, n.otherReviewer)));
  denied(await client.data('/api/references', fresh, { table: f.assignment.application, key: input.key }));
  assert.deepEqual(evidence(f), before);
});

test('assignment: membership revocation denies renew/reopen/recovery while the same native account retains its other tenant', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    north = await client.open(),
    south = await client.open('riverview');
  const input = command(f),
    n = f.assignmentRows.north,
    s = f.assignmentRows.south;
  applied(await client.data('/api/commands/execute', north, input), n.application, n.reviewer, n.manager);
  const before = evidence(f);
  await f.revoke(f.accounts.manager.id, 'northstar');
  for (const path of ['/api/commands/status', '/api/commands/execute']) denied(await client.data(path, north, input));
  denied(await client.call(client.select('/api/tenant/context/renew', 'northstar'), assertion(north)));
  denied(await client.call(client.select('/api/tenant/context/open', 'northstar'), {}));
  assert.deepEqual((await client.bootstrap()).memberships, [{ tenantId: 'riverview' }]);
  assert.deepEqual(ids(await client.data('/api/query', south, { table: f.assignment.application })), [s.application]);
  denied(await client.data('/api/commands/status', south, input));
  assert.deepEqual(evidence(f), before);
  const southInput = command(f, s.application, s.reviewer);
  committed(f, before, await client.data('/api/commands/execute', south, southInput), southInput, 'riverview', s.manager);
});
