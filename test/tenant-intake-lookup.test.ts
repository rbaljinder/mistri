/**
 * A public form's lookup in a tenant App (tenant/tenantIntake.ts, tenantReadSource.ts `bindIntakeReads`), as a
 * dialect matrix: SQLite always, PostgreSQL live-gated, on a database of this suite's own.
 *
 * What is proved: the lookup reads what a visitor may see — the `auth.public` grant, narrowed by the policy's
 * `resolvePublicRows` and fenced to the dealer the address placed the submission with — never the command's own
 * read list and never another dealer's rows. A submission the lender triages finds nothing, and answers as a placed
 * one does. Check refuses a lookup the visitor's grant cannot carry: an App with no `auth.public`, a table it does
 * not open, a `byKey` table.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { intakeCommandProblem, tenantFormLookupProblems } from '../packages/mistri/src/server/tenant/tenantIntakePages.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';
import { parseTestApp } from './support/commandCatalog.js';

const DATABASE = `intake_lookup_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'intake-lookup-store' };
const NORTH = 'north-intake-AAAAAAAAAAAAAAAA',
  SOUTH = 'south-intake-BBBBBBBBBBBBBBBB',
  UNKNOWN = 'unknown-intake-FFFFFFFFFFFFFF';

const SCHEMA = {
  tables: ['intake_submission', 'lead', 'make', 'dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT, public_address TEXT);
    CREATE TABLE make (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, shown INTEGER NOT NULL);
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT NOT NULL,
      shown INTEGER NOT NULL, note TEXT);
    CREATE TABLE intake_submission (id TEXT PRIMARY KEY NOT NULL, reference TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL, intake_address text, public_address text);
    CREATE TABLE public.make (id text PRIMARY KEY, name text NOT NULL, shown integer NOT NULL);
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), reference text NOT NULL,
      shown integer NOT NULL, note text);
    CREATE TABLE public.intake_submission (id text PRIMARY KEY, reference text NOT NULL);`,
};
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors', '${NORTH}', 'north-public'), ('south', 'South Auto', '${SOUTH}', 'south-public');
    INSERT INTO make VALUES ('toyota', 'Toyota', 1), ('hidden', 'Hidden', 0);
    INSERT INTO lead VALUES ('n1', 'north', 'N-shown', 1, 'north private'), ('n2', 'north', 'N-hidden', 0, 'north private'),
      ('s1', 'south', 'S-shown', 1, 'south private');`;
const OWNERSHIP = {
  dealer: { kind: 'platform' },
  make: { kind: 'global', access: 'read-only' },
  lead: { kind: 'tenant', column: 'tenant_id' },
  intake_submission: { kind: 'platform' },
} as const;

const input = { name: { label: 'Name', type: 'text', max: 80 } } as const;
const manifest = (pub: unknown = { read: ['lead', 'make'], fields: { lead: { read: ['id', 'reference', 'shown'] } } }) => ({
  id: binding.appId,
  name: 'Lending',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    make: { owner: 'global' },
    lead: { access: 'write', owner: 'tenant' },
    intake_submission: { access: 'write', owner: 'platform' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
    ...(pub === null ? {} : { public: pub }),
  },
  views: {
    leads: { kind: 'list', from: 'lead', roles: ['staff'] },
    triage: { kind: 'list', from: 'intake_submission' },
    apply: { kind: 'form', label: 'Apply for financing', public: true, command: { id: 'apply', version: 1, input } },
  },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['triage'] },
  ],
  home: 'leads',
});

/* What each lookup saw, in order: the references and makes it could read, and whether a private column reached it. */
const seen: Array<{ leads: string[]; makes: string[]; note: boolean; owner: boolean }> = [];
const apply = (sources: Record<string, string[]>) =>
  defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    write: ['intake_submission'],
    public: true,
    input,
    sources,
    output: shape({ reference: text() }),
    async lookup({ sources: read }) {
      const leads = await read.business.lead.where().limit(50);
      const makes = sources.business.includes('make') ? await read.business.make.where().limit(50) : [];
      return {
        leads: leads.map((row) => String(row.reference)).sort(),
        makes: makes.map((row) => String(row.name)).sort(),
        note: leads.some((row) => 'note' in row),
        /* The ownership column is the platform's, never a visitor's to read (tenantVisibleFields). */
        owner: leads.some((row) => 'tenant_id' in row),
      };
    },
    async handle({ db, intake, lookup }, value) {
      seen.push(lookup as (typeof seen)[number]);
      const reference = `IGN-${value.name}`;
      // Unpublished, so a later lookup sees the same rows; the lender keeps what it triages.
      if (intake === 'tenant') await db.lead.insert({ id: randomUUID(), reference, shown: 0 });
      else await db.intake_submission.insert({ id: randomUUID(), reference });
      return { reference };
    },
  });
const registry = defineCommands({ apply: apply({ business: ['lead', 'make'] }) });
const everything = { dealer: true, make: true, lead: true, intake_submission: true };
const policy = () =>
  defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: OWNERSHIP,
    resolveMembershipRows: () => everything,
    resolveRows: () => everything,
    resolvePlatformRows: () => everything,
    resultReferences: { apply: () => [] },
    intake: { address: 'intake_address' },
    public: { address: 'public_address' },
    // Asks for every lead that is shown: the runtime adds the dealer the address placed the submission with.
    resolvePublicRows: () => ({
      lead: { groups: [[{ column: 'shown', op: '=', value: 1 }]] },
      make: { groups: [[{ column: 'shown', op: '=', value: 1 }]] },
    }),
  });

async function enrolled(t: TestContext, dialect: TenantDialect, pub?: unknown) {
  const engine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  let service: TenantEnrollment<object> | undefined;
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
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  service = await createTenantEnrollment<object>({
    app: parseTestApp(manifest(pub), 'lending.ts'),
    policy: policy(),
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['staff', 'manager'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: () => null,
  });
  const submit = (address: unknown, name: string) =>
    service!.deployment.submitIntake({ form: 'apply', address, input: { name }, submission: randomUUID() });
  return { submit };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`public intake lookups on ${dialect}`, { skip }, () => {
    test("a lookup reads what a visitor of the placed dealer may see: the public grant's rows and columns, that dealer's only", async (t) => {
      const f = await enrolled(t, dialect);
      seen.length = 0;
      await f.submit(NORTH, 'Ada');
      await f.submit(SOUTH, 'Bea');
      assert.deepEqual(seen, [
        // `N-hidden` is north's, and the policy does not publish it; `S-shown` is south's.
        { leads: ['N-shown'], makes: ['Toyota'], note: false, owner: false },
        { leads: ['S-shown'], makes: ['Toyota'], note: false, owner: false },
      ]);
    });

    test('a lookup under a grant with no `fields` rule still never reads the tenant owner column', async (t) => {
      const f = await enrolled(t, dialect, { read: ['lead', 'make'] });
      seen.length = 0;
      await f.submit(NORTH, 'Ada');
      // With no rule every column the grant opens is read, as a public read reads them: all but the ownership column.
      assert.deepEqual(seen, [{ leads: ['N-shown'], makes: ['Toyota'], note: true, owner: false }]);
    });

    test('a submission the lender triages finds nothing, and answers as a placed one does', async (t) => {
      const f = await enrolled(t, dialect);
      seen.length = 0;
      const placed = await f.submit(NORTH, 'Same');
      const triaged = await f.submit(UNKNOWN, 'Same');
      assert.deepEqual(seen[1], { leads: [], makes: [], note: false, owner: false });
      const shapeOf = (answer: unknown) => JSON.stringify(answer, (key, value) => (key === 'receiptId' ? '' : value));
      assert.equal(shapeOf(triaged), shapeOf(placed));
    });
  });

test('check refuses a public form whose lookup the visitor grant cannot carry, with the reason', () => {
  const problems = (pub: unknown, sources: Record<string, string[]> = { business: ['lead', 'make'] }) =>
    tenantFormLookupProblems(parseTestApp(manifest(pub), 'lending.ts'), defineCommands({ apply: apply(sources) }), binding.source.id);
  assert.deepEqual(problems({ read: ['lead', 'make'] }), []);
  assert.match(problems(null).join('\n'), /Public form "apply" runs "apply", which .*auth\.public/);
  assert.match(problems({ read: ['lead'] }).join('\n'), /Public form "apply" runs "apply", which .*"make"/);
  assert.match(problems({ read: ['lead', 'make'], byKey: ['lead'] }).join('\n'), /Public form "apply" runs "apply", which .*byKey/);
  assert.match(problems({ read: ['lead', 'make'] }, { desk: ['contacts'] }).join('\n'), /source "desk", not the App's own "business"/);
});

test('check refuses a public form whose command mints a capability link, by name, and not one that only names a link', () => {
  type Handle = Parameters<typeof defineCommand>[0]['handle'];
  type Link = { link: (name: string) => Promise<unknown> };
  const command = (handle: unknown) =>
    defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: ['intake_submission'],
      public: true,
      input,
      output: shape({ reference: text() }),
      handle: handle as Handle,
    } as never);
  const app = () => parseTestApp(manifest(), 'lending.ts');
  const problems = (handle: unknown) => tenantFormLookupProblems(app(), defineCommands({ apply: command(handle) }), binding.source.id);
  const destructured = async ({ link }: Link) => {
    await link('status');
    return { reference: 'x' };
  };
  const member = async (context: Link) => {
    await context.link('status');
    return { reference: 'x' };
  };
  assert.match(
    problems(destructured).join('\n'),
    /Public form "apply" runs "apply", which mints a capability link .*only lets a member or a service.*: a tenant App cannot take that command's signed-out submissions/,
  );
  assert.match(problems(member).join('\n'), /mints a capability link/);
  // A handler that names a link without minting one, or reads one off another object, is not refused.
  assert.deepEqual(
    problems(async () => ({ reference: 'https://example.test'.link('x') })),
    [],
  );
  assert.deepEqual(
    problems(async () => ({ reference: 'no link(s) here' })),
    [],
  );
  // The page and the bind rule say the same, so a form's command and a page's are held alike.
  const kindOf = (table: string) => (table === 'intake_submission' ? 'platform' : 'tenant');
  assert.match(intakeCommandProblem(app(), command(destructured), binding.source.id, kindOf) ?? '', /^mints a capability link/);
});
