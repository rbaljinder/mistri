/**
 * Composite tenant foreign keys (G17), as a dialect matrix
 * (support/tenantDialects.ts): SQLite always, PostgreSQL live-gated, on a
 * database of this suite's own. A ticket's team is `(tenant_id, team_id)`
 * into `team (tenant_id, id)`, so the database itself keeps a reference inside
 * its tenant — the shape a multi-tenant schema uses to make that a constraint
 * rather than a convention.
 *
 * What is proved:
 * - Reading. The tenant realm never sees `tenant_id`, so the composite key
 *   leaves its catalog; its other leg is still a link, because `team.id` is
 *   unique alone and `tenant_id` is NOT NULL (shared/declaredReferences.ts
 *   impliedEdges). A member's ticket carries its team's name, through the same
 *   tenant predicate as the ticket.
 * - Writing. A reference to another tenant's row is refused through every
 *   door: a generic insert and update, an import, a command's insert and
 *   update, the same through an API token, and a public form, and nothing
 *   lands. The database's composite constraint is what answers first, so a
 *   raw insert is refused too; the scoped writer's parent check
 *   (scopedTransaction.ts) asks the same question of the stored row under the
 *   tenant's guards, for a key the database would only check at commit.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantApiRequest, withTenantApiRequests } from '../packages/mistri/src/server/tenant/tenantApiRequest.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { accessibleSchema } from '../packages/mistri/src/server/app/appAccess.js';
import { impliedEdges } from '../packages/engine/src/shared/declaredReferences.js';
import { referenceProjection } from '../packages/engine/src/shared/referenceModel.js';
import { tryResolvePath } from '../packages/engine/src/shared/viewPaths.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const DATABASE = `composite_keys_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'desk', source: { id: 'business', connection: 'desk-db' }, storeId: 'composite-store' };
const NORTH = 'north-intake-AAAAAAAAAAAAAAAA',
  SOUTH = 'south-intake-BBBBBBBBBBBBBBBB';
/* `UNIQUE (tenant_id, id)` is what the composite key points at; `team.id`
   stays the primary key, unique alone, which is what lets its leg be a link. */
const SCHEMA = {
  tables: ['ck_ticket', 'ck_team', 'ck_inbox', 'ck_dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;
    CREATE TABLE ck_dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
    CREATE TABLE ck_team (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES ck_dealer(id), name TEXT NOT NULL,
      UNIQUE (tenant_id, id));
    CREATE TABLE ck_ticket (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES ck_dealer(id), title TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, team_id TEXT, FOREIGN KEY (tenant_id, team_id) REFERENCES ck_team (tenant_id, id));
    CREATE TABLE ck_inbox (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.ck_dealer (id text PRIMARY KEY, name text NOT NULL, intake_address text);
    CREATE TABLE public.ck_team (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.ck_dealer(id), name text NOT NULL,
      UNIQUE (tenant_id, id));
    CREATE TABLE public.ck_ticket (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.ck_dealer(id), title text NOT NULL,
      version integer NOT NULL DEFAULT 0, team_id text, FOREIGN KEY (tenant_id, team_id) REFERENCES public.ck_team (tenant_id, id));
    CREATE TABLE public.ck_inbox (id text PRIMARY KEY, title text NOT NULL);`,
};
const ROWS = `
    INSERT INTO ck_dealer VALUES ('north', 'North Motors', '${NORTH}'), ('south', 'South Auto', '${SOUTH}');
    INSERT INTO ck_team VALUES ('n-team', 'north', 'North desk'), ('s-team', 'south', 'SOUTH_DESK');
    INSERT INTO ck_ticket VALUES ('n1', 'north', 'North ticket', 0, 'n-team'), ('s1', 'south', 'South ticket', 0, 's-team');`;
const OWNERSHIP = {
  dealer: { kind: 'platform' },
  team: { kind: 'tenant', column: 'tenant_id' },
  ticket: { kind: 'tenant', column: 'tenant_id' },
  inbox: { kind: 'platform' },
} as const;

const reportInput = {
  title: { label: 'Title', type: 'text', max: 80 },
  team: { label: 'Team', type: 'text', max: 32, optional: true },
} as const;
const openInput = { id: { type: 'text' }, team: { type: 'text' } } as const;
const assignInput = { team: { label: 'Team', type: 'text' } } as const;
const manifest = (dialect: TenantDialect) => ({
  id: binding.appId,
  name: 'Desk',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { physical: physical(dialect, 'ck_dealer'), owner: 'platform' },
    team: { physical: physical(dialect, 'ck_team'), owner: 'tenant' },
    ticket: {
      physical: physical(dialect, 'ck_ticket'),
      access: 'write',
      owner: 'tenant',
      actions: { assign: { label: 'Assign', command: { id: 'assign', version: 1, target: 'ticket', input: assignInput } } },
    },
    inbox: { physical: physical(dialect, 'ck_inbox'), access: 'write', owner: 'platform' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Head office' } },
    roles: {
      staff: {
        realm: 'tenant',
        read: true,
        write: ['ticket'],
        fields: { ticket: { read: ['id', 'title', 'version', 'team_id'], write: ['id', 'title', 'team_id'] } },
        commands: ['assign', 'open'],
      },
      manager: { realm: 'platform', read: true },
    },
  },
  views: {
    tickets: { kind: 'list', from: 'ticket' },
    triage: { kind: 'list', from: 'inbox' },
    'new-ticket': { kind: 'form', label: 'New ticket', command: { id: 'open', version: 1, input: openInput } },
    report: { kind: 'form', label: 'Report a fault', public: true, command: { id: 'report', version: 1, input: reportInput } },
  },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['tickets', 'new-ticket'] },
    { id: 'office', label: 'Head office', realm: 'platform', children: ['triage'] },
  ],
  home: 'tickets',
});
const physical = (dialect: TenantDialect, name: string) => (dialect === 'postgres' ? `public.${name}` : name);

const output = shape({ id: text() });
const registry = defineCommands({
  assign: defineCommand({
    source: 'business',
    target: 'ticket',
    read: ['team'],
    input: assignInput,
    output,
    async handle({ db, record }, input) {
      await db.ticket.update(record, { team_id: input.team, version: Number(record.version) + 1 });
      return { id: String(record.id) };
    },
  }),
  open: defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    read: ['team'],
    input: openInput,
    output,
    async handle({ db }, input) {
      await db.ticket.insert({ id: input.id, title: `Opened ${input.id}`, version: 0, team_id: input.team });
      return { id: input.id };
    },
  }),
  report: defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    read: ['team'],
    write: ['inbox'],
    public: true,
    input: reportInput,
    output: shape({ reference: text(), message: literal('Report received.') }),
    async handle({ db, intake }, input) {
      const id = randomUUID();
      if (intake === 'tenant') await db.ticket.insert({ id, title: input.title, version: 0, team_id: input.team ?? null });
      else await db.inbox.insert({ id, title: input.title });
      return { reference: id, message: 'Report received.' };
    },
  }),
});
const everything = { dealer: true, team: true, ticket: true, inbox: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: OWNERSHIP,
  resolveMembershipRows: () => everything,
  resolveRows: () => everything,
  resolvePlatformRows: () => everything,
  intake: { address: 'intake_address' },
  resultReferences: { assign: () => [], open: () => [], report: () => [] },
});

type Request = { readonly cookie?: string };
const alice: Request = { cookie: 'alice' };
const north = ['north'];

async function enrolled(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  let service: TenantEnrollment<Request> | undefined;
  t.after(async () => {
    try {
      await service?.retire();
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'north-alice',
      roles: ['staff'],
      status: 'active',
      validUntil: 1_000_000,
      expectedVersion: null,
    });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  service = await createTenantEnrollment<Request>({
    app: parseTestApp(manifest(dialect), 'desk.ts'),
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['staff', 'manager'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: withTenantApiRequests((request: Request) => (request.cookie === 'alice' ? { id: 'alice', who: 'Alice' } : null)),
  });
  const deployment = service.deployment;
  // An API token's request: Alice's membership, acting under the token's role alone.
  const api = createTenantApiRequest(async () => ({ id: 'alice', who: 'Alice' }), ['staff']) as Request;
  let attempt = 0;
  const execute = (request: Request, command: 'assign' | 'open', key: Record<string, string>, input: Record<string, string>, version = 0) =>
    deployment.execute(request, north, {
      command,
      commandVersion: 1,
      key,
      expectedVersion: version,
      idempotencyKey: `${command}-attempt-${String(++attempt).padStart(4, '0')}`,
      input,
    });
  const submit = (address: string, input: Record<string, string>) =>
    deployment.submitIntake({ form: 'report', address, input, submission: randomUUID() });
  const tickets = async () => (await engine.all('SELECT id, tenant_id, team_id FROM ck_ticket ORDER BY id')).map((row) => ({ ...row }));
  return { engine, deployment, api, execute, submit, tickets };
}

/* Refused before anything applied, whichever door: a write's failure or a command's. */
const notApplied = (error: unknown) =>
  (error instanceof TenantWriteFailure || error instanceof BusinessCommandExecutionError) && error.outcome === 'not_applied';

/* ---------- the catalog alone ---------- */

const column = (name: string, patch: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'text',
  nullable: false,
  primaryKey: false,
  ...patch,
});
const catalog = (patch: { teamKey?: string[]; tenantNullable?: boolean } = {}): DatabaseSchema => ({
  label: 'desk',
  dialect: 'postgres',
  readAt: '2026-10-09T00:00:00.000Z',
  tables: [
    {
      id: 'team',
      name: 'team',
      schema: 'public',
      isView: false,
      columns: ['tenant_id', 'id', 'name'].map((name) => column(name, { primaryKey: (patch.teamKey ?? ['id']).includes(name) })),
    },
    {
      id: 'ticket',
      name: 'ticket',
      schema: 'public',
      isView: false,
      columns: [
        column('id', { primaryKey: true }),
        column('tenant_id', { nullable: patch.tenantNullable ?? false }),
        column('team_id', { nullable: true, references: { table: 'team', column: 'id' } }),
      ],
    },
  ],
  foreignKeys: [
    {
      name: 'ticket_team',
      from: { table: 'ticket', columns: ['tenant_id', 'team_id'] },
      to: { table: 'team', columns: ['tenant_id', 'id'] },
    },
  ],
});
const edges = (schema: DatabaseSchema) => schema.foreignKeys.map((fk) => `${fk.from.columns.join('+')}->${fk.to.columns.join('+')}`);

test('a composite key implies a leg only where that leg names one row, and only for a reader who cannot read it whole', () => {
  assert.deepEqual(edges({ ...catalog(), foreignKeys: impliedEdges(catalog()) }), ['team_id->id']);
  // Not unique alone: `id` could be any tenant's, so the leg would not name one row.
  assert.deepEqual(impliedEdges(catalog({ teamKey: ['tenant_id', 'id'] })), []);
  // A nullable other leg: a row with no tenant is matched by no composite, and must not be by its leg.
  assert.deepEqual(impliedEdges(catalog({ tenantNullable: true })), []);
  const all = new Set(['team', 'ticket']);
  const access = (fields?: Map<string, { read: Set<string>; write: Set<string> }>) => ({
    readable: all,
    writable: new Set<string>(),
    ...(fields ? { fields } : {}),
  });
  // A reader who reads `tenant_id` keeps the composite itself, and gets no second edge beside it.
  assert.deepEqual(edges(accessibleSchema(catalog(), access())), ['tenant_id+team_id->tenant_id+id']);
  const hidden = (columns: string[]) => ({ read: new Set(columns), write: new Set<string>() });
  const tenant = accessibleSchema(
    catalog(),
    access(
      new Map([
        ['ticket', hidden(['id', 'team_id'])],
        ['team', hidden(['id', 'name'])],
      ]),
    ),
  );
  assert.deepEqual(edges(tenant), ['team_id->id']);
  assert.deepEqual(tenant.tables.find((table) => table.id === 'ticket')?.columns.find((item) => item.name === 'team_id')?.references, {
    table: 'team',
    column: 'id',
  });
  // A reader who cannot read the target's `id` gets neither edge, nor the link on the column.
  const blind = accessibleSchema(
    catalog(),
    access(
      new Map([
        ['ticket', hidden(['id', 'team_id'])],
        ['team', hidden(['name'])],
      ]),
    ),
  );
  assert.deepEqual(edges(blind), []);
  assert.equal(blind.tables.find((table) => table.id === 'ticket')?.columns.find((item) => item.name === 'team_id')?.references, undefined);
});

test("an App's catalog reads a composite key's other leg as a reference: its path, its label and its type", () => {
  /* `ticket (tenant_id, team_id) REFERENCES team (tenant_id, id)` alone keeps a ticket's team in its tenant; the
     checker, the generated types and a reader who reads `tenant_id` whole all still read `team_id` as the team. */
  const { schema } = appResourceCatalog(catalog());
  assert.ok(tryResolvePath(schema, 'ticket', 'team_id.name').resolved, 'team_id.name is a path');
  assert.deepEqual(
    [
      ...referenceProjection(
        schema,
        schema.tables.find((table) => table.id === 'ticket')!,
        ['team_id'],
        true,
      ).labels,
    ],
    [['team_id', 'team_id.name']],
  );
  assert.match(typesForSchema(schema, 'desk'), /team_id: "team"/);
  /* Beside a single key of its own, a tenant reader — who cannot read `tenant_id`, so loses the composite — keeps
     the column's link, and its cells draw the team's name, not its id. */
  const both = catalog();
  both.foreignKeys.push({
    name: 'ticket_team_id',
    from: { table: 'ticket', columns: ['team_id'] },
    to: { table: 'team', columns: ['id'] },
  });
  const hidden = (columns: string[]) => ({ read: new Set(columns), write: new Set<string>() });
  const tenant = accessibleSchema(both, {
    readable: new Set(['team', 'ticket']),
    writable: new Set<string>(),
    fields: new Map([
      ['ticket', hidden(['id', 'team_id'])],
      ['team', hidden(['id', 'name'])],
    ]),
  });
  const ticket = tenant.tables.find((table) => table.id === 'ticket')!;
  assert.deepEqual(ticket.columns.find((item) => item.name === 'team_id')?.references, { table: 'team', column: 'id' });
  assert.equal(referenceProjection(tenant, ticket, ['team_id'], true).labels.get('team_id'), 'team_id.name');
  // The database's own evidence is unchanged: the leg is the App's reading, never a key the database has.
  assert.deepEqual(
    schema.foreignKeys.filter((fk) => !fk.declared).map((fk) => fk.from.columns.join('+')),
    ['tenant_id+team_id'],
  );
});

/* ---------- through every door, on each engine ---------- */

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`composite tenant foreign keys on ${dialect}`, { skip }, () => {
    test("the tenant realm keeps the key's own leg as a link and a label, inside its tenant", async (t) => {
      const f = await enrolled(t, dialect);
      const { schema, rows } = await f.deployment.withContext(alice, north, async (context) => ({
        schema: context.schema as DatabaseSchema,
        rows: (
          await context.data.runView(
            {
              id: 'tickets',
              name: 'Tickets',
              base: 'ticket',
              columns: [{ path: 'id' }, { path: 'team_id.name', alias: 'team' }],
              orderBy: [{ path: 'id', direction: 'asc' }],
              limit: 100,
            },
            0,
          )
        ).rows,
      }));
      const ticket = schema.tables.find((table) => table.id === 'ticket');
      assert.ok(ticket);
      assert.equal(
        ticket.columns.some((column) => column.name === 'tenant_id'),
        false,
        'the tenant column is not the realm’s',
      );
      assert.deepEqual(
        schema.foreignKeys
          .filter((fk) => fk.from.table === 'ticket' && fk.to.table === 'team')
          .map((fk) => [fk.from.columns.join('+'), fk.to.columns.join('+')]),
        [['team_id', 'id']],
        'the composite key leaves with its tenant leg; its own leg stays a link',
      );
      assert.deepEqual(ticket.columns.find((column) => column.name === 'team_id')?.references, { table: 'team', column: 'id' });
      assert.equal(referenceProjection(schema, ticket, ['team_id'], true).labels.get('team_id'), 'team_id.name');
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [{ id: 'n1', team: 'North desk' }],
      );
      assert.doesNotMatch(JSON.stringify({ schema, rows }), /SOUTH_|tenant_id/);
    });

    test("every write door refuses a reference to another tenant's row, and admits its own", async (t) => {
      const f = await enrolled(t, dialect);
      const before = await f.tickets();
      const refusals: Array<[string, () => Promise<unknown>]> = [
        [
          'generic insert',
          () => f.deployment.insert(alice, north, { table: 'ticket', values: { id: 'x1', title: 'Planted', team_id: 's-team' } }),
        ],
        ['generic update', () => f.deployment.update(alice, north, { table: 'ticket', key: { id: 'n1' }, values: { team_id: 's-team' } })],
        [
          'import',
          () =>
            f.deployment.importRows(alice, north, {
              inserts: [
                { table: 'ticket', values: { id: 'x2', title: 'Imported', team_id: 'n-team' } },
                { table: 'ticket', values: { id: 'x3', title: 'Imported across', team_id: 's-team' } },
              ],
              trial: false,
            }),
        ],
        [
          'import trial',
          () =>
            f.deployment.importRows(alice, north, {
              inserts: [{ table: 'ticket', values: { id: 'x4', title: 'Tried', team_id: 's-team' } }],
              trial: true,
            }),
        ],
        ['command insert', () => f.execute(alice, 'open', {}, { id: 'x5', team: 's-team' })],
        ['command update', () => f.execute(alice, 'assign', { id: 'n1' }, { team: 's-team' })],
        [
          'API insert',
          () => f.deployment.insert(f.api, north, { table: 'ticket', values: { id: 'x6', title: 'By token', team_id: 's-team' } }),
        ],
        ['API command', () => f.execute(f.api, 'open', {}, { id: 'x7', team: 's-team' })],
        ['public form', () => f.submit(NORTH, { title: 'Reported', team: 's-team' })],
      ];
      for (const [door, attempt] of refusals) await assert.rejects(attempt(), notApplied, `${door} is refused`);
      assert.deepEqual(await f.tickets(), before, 'nothing landed, and nothing moved');
      // The same doors, each pointing at its own tenant's team.
      await f.deployment.insert(alice, north, { table: 'ticket', values: { id: 'y1', title: 'Mine', team_id: 'n-team' } });
      await f.deployment.importRows(alice, north, {
        inserts: [{ table: 'ticket', values: { id: 'y2', title: 'Imported', team_id: 'n-team' } }],
        trial: false,
      });
      await f.execute(alice, 'open', {}, { id: 'y3', team: 'n-team' });
      await f.execute(f.api, 'open', {}, { id: 'y4', team: 'n-team' });
      await f.submit(NORTH, { title: 'Reported', team: 'n-team' });
      await f.deployment.update(alice, north, { table: 'ticket', key: { id: 'y1' }, values: { team_id: null } });
      await f.execute(alice, 'assign', { id: 'n1' }, { team: 'n-team' });
      const landed = (await f.tickets()).filter((row) => row.tenant_id === 'north');
      assert.equal(landed.length, 6);
      assert.ok(landed.every((row) => row.team_id === 'n-team' || (row.id === 'y1' && row.team_id === null)));
      assert.deepEqual(
        (await f.tickets()).filter((row) => row.team_id === 's-team'),
        [{ id: 's1', tenant_id: 'south', team_id: 's-team' }],
      );
    });

    test('the database refuses the same reference on its own', async (t) => {
      const f = await enrolled(t, dialect);
      await assert.rejects(f.engine.exec("INSERT INTO ck_ticket VALUES ('raw', 'north', 'Raw', 0, 's-team')"));
      await assert.rejects(f.engine.exec("UPDATE ck_ticket SET team_id = 's-team' WHERE id = 'n1'"));
      assert.deepEqual(await f.tickets(), [
        { id: 'n1', tenant_id: 'north', team_id: 'n-team' },
        { id: 's1', tenant_id: 'south', team_id: 's-team' },
      ]);
    });
  });
