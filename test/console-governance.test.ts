/** The Console's Governance room: only an App's own administrators read it,
 * the audit is the App's command journal (fields named, values never), the
 * authority is authority.lock as sentences, and the accounts are the suite's
 * grants, read under the ledger's own administrator check — or, for a tenant
 * App, its own tenant administration read with the caller's grant. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import { authorityChanges, authoritySentences } from '../packages/mistri/src/server/app/authoritySentences.js';
import { consoleCommandAudit, type ConsoleTenantAccounts } from '../packages/mistri/src/server/console/governance.js';
import type { AdministrationMembershipPage, AdministrationTenantPage } from '../packages/mistri/src/shared/tenantAdministration.js';
import type { ConsoleOperationsOwner } from '../packages/mistri/src/server/console/operations.js';
import { suiteGovernance } from '../packages/mistri/src/server/console/suiteGovernance.js';
import { appRoutes } from '../packages/mistri/src/server/app/apps.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { consoleHostFixture, type ConsoleOperationsBuilder } from './fixtures/consoleHost.js';

const ROLES = ['clerk', 'admin'] as const;
const appDef = (id: string) =>
  parseAppConfig(
    {
      id,
      name: id === 'depot' ? 'Depot' : 'Ledger',
      auth: { signUp: 'invite', defaultRole: 'clerk', roles: { clerk: { read: true, write: ['items'] }, admin: { read: true } } },
      resources: { items: { access: 'write' } },
      views: { items: { kind: 'list', from: 'items' } },
      home: 'items',
    },
    `${id} App`,
  );

/** A journal with `count` receipts by alice and one by bob, each changing one item's fields. */
function journal(path: string, count: number) {
  new DatabaseSync(path).close();
  migrateSqliteCommandJournal(path);
  const db = new DatabaseSync(path);
  // One row per command: the targets are its arrays, each key and change set the exact JSON text.
  const receipt = db.prepare(`INSERT INTO "${COMMAND_JOURNAL_TABLES.receipt}" (id, app_id, store_id, source_id, realm, tenant_id, actor_id,
    command_id, command_version, idempotency_key, fingerprint, result_json, request_id, completed_at, membership_id, membership_version,
    realm_version, roles_json, deployment, target, owners_json, keys_json, changes_json)
    VALUES (?, ?, 'store', 'source', 'tenant', '', ?, ?, 1, ?, 'f', '{}', 'request', ?, '', '', '', '[]', 'production', ?, ?, ?, ?)`);
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
  const record = (
    id: string,
    app: string,
    actor: string,
    command: string,
    key: string,
    completed: string,
    target: string,
    targets: Array<[unknown, unknown]>,
  ) =>
    receipt.run(
      id,
      app,
      actor,
      command,
      key,
      completed,
      target,
      JSON.stringify(targets.map(() => '')),
      JSON.stringify(targets.map(([keyed]) => JSON.stringify(keyed))),
      JSON.stringify(targets.map(([, changes]) => JSON.stringify(changes))),
    );
  for (let index = 0; index < count; index++) {
    const id = `receipt-${String(index).padStart(3, '0')}`;
    record(id, 'depot', 'alice', 'close_item', `key-${index}`, at(index), 'items', [
      [{ id: index }, { state: 'closed-secret', note: 'x' }],
    ]);
  }
  record('receipt-bob', 'depot', 'bob', 'reopen_item', 'key-bob', new Date(Date.UTC(2026, 9, 3, 9)).toISOString(), 'items', [
    [{ id: 7 }, { state: 'open' }],
    [{ id: 8 }, { state: 'open' }],
  ]);
  // Another App's receipts in the same journal are never this App's audit.
  record('receipt-other', 'ledger', 'alice', 'post_entry', 'key-other', at(59), 'entries', [[{ id: 1 }, { amount: 1 }]]);
  db.close();
}

async function setup(t: Parameters<typeof consoleHostFixture>[0], receipts = 3) {
  const build: ConsoleOperationsBuilder = async ({ auth, dir, grants }) => {
    const owners: ConsoleOperationsOwner[] = [];
    for (const id of ['depot', 'ledger']) {
      const app = appDef(id);
      const path = join(dir, `${id}-journal.db`);
      journal(path, id === 'depot' ? receipts : 0);
      const report = authorityReport(app);
      owners.push({
        appId: id,
        name: app.name,
        app: () => app,
        auth: auth(id, ROLES),
        governance: {
          audit: consoleCommandAudit(id, () => [{ name: 'main', url: path }]),
          authority: () => ({ report, locked: true, startedAt: Date.UTC(2026, 9, 9) }),
          // The start before granted clerk no writes: this start's lock adds them.
          previousAuthority: async () => ({ report: report.replace(/^role clerk write items.*\n/m, ''), at: Date.UTC(2026, 9, 1) }),
          access: (accountId) =>
            grants.listAccess(
              { appId: id, actorId: accountId, declaredRoles: [...ROLES] },
              { administratorRevision: grants.read(accountId, id).revision },
            ),
          accessAudit: (accountId, query) =>
            grants.listAccessChanges(
              { appId: id, actorId: accountId, declaredRoles: [...ROLES] },
              { administratorRevision: grants.read(accountId, id).revision },
              query,
            ),
          email: async (account) => (['alice', 'bob'].includes(account) ? `${account}@example.test` : null),
          accountOf: async (email) => (email === 'bob@example.test' ? 'bob' : null),
          // The link is the reader's own address: the room hands over the administrator's roles in this App.
          recordHref: (resource, key, roles) =>
            roles?.includes('admin') ? `/tools/${id}/${resource}/${(key as { id: number }).id}` : undefined,
          manageHref: `/tools/_mistri/apps#manage=${id}`,
        },
      });
    }
    return owners;
  };
  const f = await consoleHostFixture(t, false, 0, build);
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  return f;
}

test('only an App administrator reads its governance; one App never reaches another', async (t) => {
  const f = await setup(t);
  assert.deepEqual((await f.call('/api/console/governance')).json().apps, [], 'the Console grant alone opens no App');
  f.grant('depot', ['clerk']);
  assert.deepEqual((await f.call('/api/console/governance')).json().apps, [], 'a role that is not admin opens nothing');
  for (const view of ['audit', 'authority', 'accounts']) {
    const refused = await f.call(`/api/console/governance/depot/${view}`);
    assert.equal(refused.response.status, 403, view);
    assert.deepEqual(refused.json(), { ok: false, code: 'not_granted' });
  }
  f.grant('depot', ['admin']);
  assert.deepEqual((await f.call('/api/console/governance')).json().apps, [
    { id: 'depot', name: 'Depot', views: ['audit', 'authority', 'accounts'] },
  ]);
  assert.equal((await f.call('/api/console/governance/ledger/audit')).json().code, 'not_granted');
  assert.equal((await f.call('/api/console/governance/nowhere/audit')).json().code, 'not_granted');
  assert.equal((await f.call('/api/console/governance/depot/audit', {})).response.status, 405, 'the room changes nothing');
  assert.equal((await f.call('/api/console/governance/depot/authority?x=1')).response.status, 400);
  f.grant('mistri-console', []);
  assert.equal((await f.call('/api/console/governance')).response.status, 403, 'Console admission still gates the room');
});

test('the audit is the journal: who, which command, a link to the record, which fields and never their values', async (t) => {
  const f = await setup(t, 52);
  f.grant('depot', ['admin']);
  const first = await f.call('/api/console/governance/depot/audit');
  assert.equal(first.response.status, 200, first.text);
  const page = first.json();
  assert.equal(page.rows.length, 50);
  // A grant change is in the same feed, newest first: alice was made the App's administrator just now.
  assert.deepEqual(page.rows[0], {
    kind: 'access',
    id: page.rows[0].id,
    at: page.rows[0].at,
    who: { id: 'operator', email: null },
    subject: { id: 'alice', email: 'alice@example.test' },
    before: [],
    after: ['admin'],
  });
  assert.ok(Date.now() - Date.parse(page.rows[0].at) < 60_000);
  assert.deepEqual(page.rows[1], {
    id: 'receipt-bob',
    at: '2026-10-03T09:00:00.000Z',
    who: { id: 'bob', email: 'bob@example.test' },
    command: 'reopen_item',
    version: 1,
    resource: 'items',
    href: '/tools/depot/items/7',
    fields: ['state'],
    targets: 2,
    database: 'main',
  });
  assert.deepEqual(page.rows[2].fields, ['note', 'state']);
  assert.doesNotMatch(first.text, /closed-secret|post_entry|key-1/, 'no value, idempotency key or other App leaves');
  const older = (await f.call(`/api/console/governance/depot/audit?before=${encodeURIComponent(page.next)}`)).json();
  assert.deepEqual(
    older.rows.map((row: { id: string }) => row.id),
    ['receipt-003', 'receipt-002', 'receipt-001', 'receipt-000'],
  );
  assert.equal(older.next, undefined);
  const operator = (await f.call('/api/console/governance/depot/audit?who=operator')).json();
  assert.deepEqual(
    operator.rows.map((row: { kind?: string; subject?: { id: string } }) => [row.kind, row.subject?.id]),
    [['access', 'alice']],
    'who filters role changes by who made them',
  );
  const bob = (await f.call('/api/console/governance/depot/audit?who=bob%40example.test')).json();
  assert.deepEqual(
    bob.rows.map((row: { id: string }) => row.id),
    ['receipt-bob'],
  );
  assert.deepEqual((await f.call('/api/console/governance/depot/audit?who=nobody%40example.test')).json().rows, []);
  const command = (await f.call('/api/console/governance/depot/audit?what=reopen_item')).json();
  assert.equal(command.rows.length, 1);
  assert.equal(command.rows[0].kind, undefined, 'a command or resource filter names only commands');
  assert.equal((await f.call('/api/console/governance/depot/audit?what=items')).json().rows.length, 50, 'a resource matches its targets');
  const day = (await f.call('/api/console/governance/depot/audit?from=2026-10-03&to=2026-10-03')).json();
  assert.deepEqual(
    day.rows.map((row: { id: string }) => row.id),
    ['receipt-bob'],
  );
  for (const bad of ['from=yesterday', 'from=2026-10-04&to=2026-10-03', 'what=a%20b', 'before=x', 'who=a&who=b'])
    assert.equal((await f.call(`/api/console/governance/depot/audit?${bad}`)).response.status, 400, bad);
});

test('authority is the lock in plain English, and a change says what a role can now do', async (t) => {
  const f = await setup(t);
  f.grant('depot', ['admin']);
  const read = await f.call('/api/console/governance/depot/authority');
  assert.equal(read.response.status, 200, read.text);
  const body = read.json();
  assert.equal(body.locked, true);
  assert.equal(body.startedAt, '2026-10-09T00:00:00.000Z');
  const clerk = body.groups.find((group: { group: string }) => group.group === 'role:clerk');
  assert.deepEqual(
    clerk.sentences.map((sentence: { text: string }) => sentence.text),
    ['Role `clerk` can read `items`.', 'Role `clerk` can write `items`.'],
  );
  assert.deepEqual(body.changes, [
    { change: 'added', group: 'role:clerk', text: 'Role `clerk` can now write `items`.', fact: 'role clerk write items' },
  ]);
  assert.equal(body.since, '2026-10-01T00:00:00.000Z');
});

test('sentences for a lock diff: capabilities gained and lost, a setting changed, an unknown fact kept verbatim', () => {
  const before = [
    'auth default-role clerk — the App',
    'role agent read incident — the App',
    'role agent fields incident write priority — the App',
    'public read article — the App',
  ].join('\n');
  const after = [
    '# a comment is never a fact',
    'auth default-role viewer — the App',
    'role agent read incident — features "triage"',
    'role agent fields incident write state — the App',
    'something new entirely — the App',
  ].join('\n');
  assert.deepEqual(
    authorityChanges(before, after).map(({ change, text, was }) => (was ? [change, text, was] : [change, text])),
    [
      ['changed', 'A new account gets role `viewer`.', 'A new account gets role `clerk`.'],
      ['added', 'Role `agent` can now update `incident.state`.'],
      ['added', 'Now: something new entirely'],
      ['removed', 'Role `agent` can no longer update `incident.priority`.'],
      ['removed', 'Anyone, signed in or not, can no longer read `article`.'],
    ],
    'who contributes a fact is not a change of authority',
  );
  assert.deepEqual(authoritySentences(after)[1], {
    fact: 'role agent read incident',
    group: 'role:agent',
    text: 'Role `agent` can read `incident`.',
    by: ['features "triage"'],
  });
});

test("accounts are the App's grants and their changes, read under the ledger's administrator check", async (t) => {
  const f = await setup(t);
  f.grant('depot', ['clerk'], 'bob');
  f.grant('depot', ['admin']);
  const read = await f.call('/api/console/governance/depot/accounts');
  assert.equal(read.response.status, 200, read.text);
  const body = read.json();
  assert.deepEqual(body.accounts, [
    { id: 'alice', email: 'alice@example.test', roles: ['admin'], revision: 1 },
    { id: 'bob', email: 'bob@example.test', roles: ['clerk'], revision: 1 },
  ]);
  assert.equal(body.more, false);
  const changes = body.changes
    .map((change: { subject: { id: string }; actor: { id: string; email: string | null }; before: string[]; after: string[] }) => [
      change.subject.id,
      change.actor,
      change.before,
      change.after,
    ])
    .sort((a: string[], b: string[]) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(changes, [
    ['alice', { id: 'operator', email: null }, [], ['admin']],
    ['bob', { id: 'operator', email: null }, [], ['clerk']],
  ]);
  assert.equal(body.manageHref, '/tools/_mistri/apps#manage=depot');
  // Losing the admin role closes the view at once.
  f.grant('depot', ['clerk']);
  assert.equal((await f.call('/api/console/governance/depot/accounts')).response.status, 403);
});

test("a tenant App's accounts are its own tenant administration, read with the caller's grant and nothing else", async (t) => {
  const asked: string[] = [];
  const build: ConsoleOperationsBuilder = async ({ auth }) => {
    const app = appDef('dealers');
    // The administration port as the tenant App answers it: alice holds a grant over north's staff roles; bob holds none.
    const tenantAccounts: ConsoleTenantAccounts = {
      open: async (_request, accountId) => (asked.push(`open ${accountId}`), accountId === 'alice' ? { context: 'ctx' } : null),
      tenants: async (_request, input) => {
        asked.push(`tenants ${input.context}`);
        return {
          items: [
            {
              tenantId: 'north',
              name: 'North Motors',
              tenant: { status: 'active', version: '1' },
              capabilities: [{ operation: 'revokeMembership', roles: ['staff'] }],
            },
            { tenantId: 'south', tenant: null, capabilities: [{ operation: 'setAssistant', roles: [] }] },
          ],
          next: null,
        } as unknown as AdministrationTenantPage;
      },
      memberships: async (_request, input) => {
        asked.push(`memberships ${input.tenantId} ${input.operation}`);
        if (input.tenantId !== 'north' || input.operation !== 'revokeMembership') throw new Error('not reached');
        return {
          items: [
            {
              membershipId: 'm1',
              tenantId: 'north',
              accountId: 'bob',
              status: 'active',
              version: '1',
              roles: ['staff'],
              validUntil: Date.UTC(2027, 0, 1),
            },
          ],
          next: null,
        } as unknown as AdministrationMembershipPage;
      },
      href: '/dealers/',
      supportSessions: true,
      apiTokens: false,
    };
    return [
      {
        appId: 'dealers',
        name: 'Dealers',
        app: () => app,
        auth: auth('dealers', ROLES),
        governance: { email: async (account) => `${account}@example.test`, tenantAccounts },
      },
    ];
  };
  const f = await consoleHostFixture(t, false, 0, build);
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  f.grant('mistri-console', ['admitted'], 'bob');

  // No suite role stands in: the App's own administration grant is what admits, and only to the accounts view.
  assert.deepEqual((await f.call('/api/console/governance')).json().apps, [{ id: 'dealers', name: 'Dealers', views: ['accounts'] }]);
  assert.deepEqual((await f.call('/api/console/governance', undefined, 'bob')).json().apps, [], 'no administration grant, no tenant App');
  assert.equal((await f.call('/api/console/governance/dealers/accounts', undefined, 'bob')).response.status, 403);
  assert.equal((await f.call('/api/console/governance/dealers/audit')).response.status, 404);

  const list = await f.call('/api/console/governance/dealers/accounts');
  assert.equal(list.response.status, 200, list.text);
  assert.deepEqual(list.json(), {
    ok: true,
    tenants: [
      { id: 'north', name: 'North Motors', status: 'active', members: true },
      { id: 'south', status: null, members: false },
    ],
    href: '/dealers/',
    supportSessions: true,
    apiTokens: false,
  });
  const north = (await f.call('/api/console/governance/dealers/accounts?tenant=north')).json();
  assert.deepEqual(north.chosen, {
    id: 'north',
    members: [{ id: 'bob', email: 'bob@example.test', status: 'active', roles: ['staff'], validUntil: '2027-01-01T00:00:00.000Z' }],
  });
  assert.ok(asked.includes('memberships north replaceMembership') && asked.includes('memberships north revokeMembership'));
  // A tenant the grant does not reach is refused like one that is not there; members without a tenant is malformed.
  assert.deepEqual((await f.call('/api/console/governance/dealers/accounts?tenant=south')).json(), { ok: false, code: 'not_granted' });
  assert.equal((await f.call('/api/console/governance/dealers/accounts?members=x')).response.status, 400);
});

test("a record's link is the address the administrator reading the room is served, not the whole App's first", () => {
  const loaded = {
    path: 'depot.ts',
    sources: {},
    pages: [],
    app: parseAppConfig(
      {
        id: 'depot',
        name: 'Depot',
        auth: { signUp: 'invite', defaultRole: 'clerk', roles: { clerk: { read: true }, admin: { read: true } } },
        resources: { items: {} },
        views: { desk: { kind: 'list', from: 'items', roles: ['clerk'] }, items: { kind: 'list', from: 'items', roles: ['admin'] } },
        nav: ['desk', 'items'],
        home: 'items',
      },
      'depot App',
    ),
  };
  const schema = {
    tables: [{ id: 'items', name: 'items', kind: 'table', columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }] }],
  } as unknown as DatabaseSchema;
  const governance = suiteGovernance({
    app: loaded as never,
    book: appRoutes(loaded, schema),
    bookFor: (roles) => appRoutes(loaded, schema, undefined, roles),
    tables: schema.tables,
    basePath: '/tools/depot',
    startedAt: 0,
    audit: async () => [],
  });
  assert.equal(governance.recordHref?.('items', { id: 7 }), '/tools/depot/desk/7');
  assert.equal(governance.recordHref?.('items', { id: 7 }, ['admin']), '/tools/depot/items/7');
});
