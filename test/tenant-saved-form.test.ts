/**
 * A form saved on every step, on a tenant App, as a dialect matrix
 * (support/tenantDialects.ts): SQLite always, PostgreSQL live-gated, on a
 * database of this suite's own.
 *
 * A lender (the platform realm) above its partners (tenants). Each step and the
 * submit is its own public submission, resolved from its address every time
 * (tenant/tenantIntake.ts). What is proved: a draft lives in the place its
 * first step resolved to — a partner's rows with the owner injected, or the
 * lender's triage — and every later step and the submit find it only there:
 * the applicant's token is bound to that place as well as to its root, so the
 * same token under another partner's address, under none, or forged, is the one
 * "can no longer be continued" answer and writes nothing. A step's handler
 * reads and writes only its own application's rows: another partner's lead by
 * a forged id, a child row planted under it, and another partner's child are
 * refused, and nothing they tried stays.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { DRAFT_GONE, storedInstant } from '../packages/mistri/src/server/forms/savedForms.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { provisionPostgresRecordHistory } from '../packages/mistri/src/adapters/history/postgresRecordHistory.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { provisionPostgresInbox } from '../packages/mistri/src/adapters/inbox/postgresInbox.js';
import { tenantInbox } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';
import { parseTestApp } from './support/commandCatalog.js';

const DATABASE = `saved_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'saved-store' };
const NORTH = 'north-intake-AAAAAAAAAAAAAAAA',
  SOUTH = 'south-intake-BBBBBBBBBBBBBBBB',
  UNKNOWN = 'unknown-intake-FFFFFFFFFFFFFF';

/* The root in each place keeps the resume columns; each has one child table.
   A tenant child's key into its root is composite, so it cannot leave its tenant. */
const TABLES = ['intake_co_applicant', 'lead_co_applicant', 'intake_submission', 'lead', 'partner'];
const DDL = (text: string, key: string) => `
    CREATE TABLE partner (id ${key}, name ${text} NOT NULL, intake_address ${text});
    CREATE TABLE lead (id ${key}, tenant_id ${text} NOT NULL REFERENCES partner(id), reference ${text}, name ${text}, income ${text},
      status ${text} NOT NULL, resume_token_hash ${text}, resume_expires_at ${text}, resume_progress ${text}, watcher ${text},
      UNIQUE (tenant_id, reference), UNIQUE (tenant_id, id));
    CREATE TABLE lead_co_applicant (id ${key}, tenant_id ${text} NOT NULL REFERENCES partner(id), lead_id ${text} NOT NULL, name ${text} NOT NULL,
      FOREIGN KEY (tenant_id, lead_id) REFERENCES lead(tenant_id, id));
    CREATE TABLE intake_submission (id ${key}, reference ${text} UNIQUE, name ${text}, income ${text}, status ${text} NOT NULL,
      resume_token_hash ${text}, resume_expires_at ${text}, resume_progress ${text});
    CREATE TABLE intake_co_applicant (id ${key}, submission_id ${text} NOT NULL REFERENCES intake_submission(id), name ${text} NOT NULL);`;
const ROWS = `
    INSERT INTO partner VALUES ('north', 'North Partners', '${NORTH}'), ('south', 'South Partners', '${SOUTH}');
    INSERT INTO lead VALUES ('south-lead', 'south', 'IGN-SOUTH', 'South applicant', '1000', 'new', NULL, NULL, NULL, NULL);
    INSERT INTO lead_co_applicant VALUES ('south-co', 'south', 'south-lead', 'South co-applicant');`;
const OWNERSHIP = {
  partner: { kind: 'platform' },
  lead: { kind: 'tenant', column: 'tenant_id' },
  lead_co_applicant: { kind: 'tenant', column: 'tenant_id' },
  intake_submission: { kind: 'platform' },
  intake_co_applicant: { kind: 'platform' },
} as const;

const field = (label: string) => ({ label, type: 'text', max: 80 }) as const;
const manifest = () => ({
  id: binding.appId,
  name: 'Lending',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    partner: { owner: 'platform' },
    // The partner's desk is told of a submitted application, in that partner's own inbox; a draft tells nobody.
    lead: {
      access: 'write',
      owner: 'tenant',
      notify: [{ on: 'update', to: 'watcher', when: 'status = new', title: 'Application {reference} received' }],
    },
    lead_co_applicant: { access: 'write', owner: 'tenant' },
    intake_submission: { access: 'write', owner: 'platform' },
    intake_co_applicant: { access: 'write', owner: 'platform' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Partner', profile: 'partner', platform: { label: 'Lender' } },
    roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
  },
  views: {
    leads: { kind: 'list', from: 'lead' },
    triage: { kind: 'list', from: 'intake_submission' },
    apply: {
      kind: 'form',
      label: 'Apply for financing',
      public: true,
      resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
      draft: { status: 'draft' },
      steps: [
        { id: 'about', label: 'About you', command: { id: 'about', version: 1, input: { name: field('Name') } } },
        { id: 'income', label: 'Income', command: { id: 'income', version: 1, input: { income: field('Income') } } },
        { id: 'co', label: 'Co-applicant', command: { id: 'co', version: 1, input: { co_name: field('Co-applicant') } } },
      ],
      command: { id: 'finish', version: 1, input: { note: { ...field('Note'), optional: true } } },
    },
  },
  nav: [
    { id: 'partners', label: 'Partner', realm: 'tenant', children: ['leads'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['triage'] },
  ],
  home: 'leads',
});

/* What the co-applicant step does, set per test: its own work, or a reach for another partner's rows. */
let mode: 'own' | 'forge-root' | 'plant-child' | 'other-child' | 'read-other' = 'own';
const seen: number[] = [];
const ALL = ['lead', 'lead_co_applicant', 'intake_submission', 'intake_co_applicant'];
const saved = shape({ message: literal('Saved.') });
const rootOf = (intake: unknown) => (intake === 'tenant' ? 'lead' : 'intake_submission');
const childOf = (intake: unknown) => (intake === 'tenant' ? 'lead_co_applicant' : 'intake_co_applicant');
const registry = defineCommands({
  about: defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    public: true,
    read: ALL,
    write: ALL,
    output: saved,
    input: { name: field('Name') },
    async handle({ tx, draft, intake }, value) {
      const table = rootOf(intake);
      if (draft!.root) await tx.update({ table, key: { ...draft!.root }, values: { name: value.name } });
      else
        await tx.insert({
          table,
          values: {
            id: randomUUID(),
            name: value.name,
            ...draft!.start,
            ...(intake === 'tenant' ? { watcher: 'desk@example.invalid' } : {}),
          },
        });
      return { message: 'Saved.' as const };
    },
  }),
  income: defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    public: true,
    read: ALL,
    write: ['lead', 'intake_submission'],
    output: saved,
    input: { income: field('Income') },
    async handle({ tx, draft, intake }, value) {
      await tx.update({ table: rootOf(intake), key: { ...draft!.root! }, values: { income: value.income } });
      return { message: 'Saved.' as const };
    },
  }),
  co: defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    public: true,
    read: ALL,
    write: ALL,
    output: saved,
    input: { co_name: field('Co-applicant') },
    async handle({ tx, draft, intake }, value) {
      const child = childOf(intake);
      if (mode === 'forge-root') await tx.update({ table: 'lead', key: { id: 'south-lead' }, values: { name: 'Taken over' } });
      else if (mode === 'plant-child')
        await tx.insert({ table: 'lead_co_applicant', values: { id: randomUUID(), lead_id: 'south-lead', name: 'Planted' } });
      else if (mode === 'other-child')
        await tx.update({ table: 'lead_co_applicant', key: { id: 'south-co' }, values: { name: 'Renamed' } });
      else if (mode === 'read-other') {
        seen.push(
          (await tx.query({ table: 'lead', limit: 10, offset: 0 })).rows.length,
          (await tx.query({ table: 'lead_co_applicant', limit: 10, offset: 0 })).rows.length,
        );
      }
      await tx.insert({ table: child, values: { id: randomUUID(), name: value.co_name } });
      void draft;
      return { message: 'Saved.' as const };
    },
  }),
  finish: defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    public: true,
    read: ALL,
    write: ['lead', 'intake_submission'],
    input: { note: { ...field('Note'), optional: true } },
    output: shape({ reference: text(), message: literal('Application received.') }),
    async handle({ tx, draft, intake }) {
      const reference = `IGN-${randomBytes(4).toString('hex')}`;
      await tx.update({
        table: rootOf(intake),
        key: { ...draft!.root! },
        values: { status: intake === 'tenant' ? 'new' : 'triage', reference },
      });
      return { reference, message: 'Application received.' as const };
    },
  }),
});
const everything = Object.fromEntries(TABLES.map((table) => [table, true]));
const policy = () =>
  defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: OWNERSHIP,
    resolveMembershipRows: () => everything,
    resolveRows: () => everything,
    resolvePlatformRows: () => everything,
    intake: { address: 'intake_address' },
    resultReferences: { about: () => [], income: () => [], co: () => [], finish: () => [] },
  });

type Request = { readonly cookie?: string };
const token = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const gone = (error: unknown) =>
  error instanceof BusinessCommandExecutionError && error.code === 'not_found' && error.reason === DRAFT_GONE;
const refused = (code: string) => (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === code;

/* The lead's page shows its history, so the store is provisioned and each step's writes are recorded. */
const pages = () =>
  parsePagesConfig(
    { pages: [{ id: 'lead', label: 'Lead', base: 'lead', sections: [{ kind: 'fields', show: ['name'] }, { kind: 'history' }] }] },
    'saved fixture',
  );

async function enrolled(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: TABLES,
    database: DATABASE,
    sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;${DDL('TEXT', 'TEXT PRIMARY KEY NOT NULL')}${ROWS}`,
    postgres:
      DDL('text', 'text PRIMARY KEY').replaceAll('CREATE TABLE ', 'CREATE TABLE public.').replaceAll('REFERENCES ', 'REFERENCES public.') +
      ROWS,
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  if (dialect === 'postgres') {
    await provisionPostgresRecordHistory(engine.url);
    await provisionPostgresInbox(engine.url);
  } else {
    provisionSqliteRecordHistory(engine.path);
    provisionSqliteInbox(engine.path);
  }
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  let service: TenantEnrollment<Request> | undefined;
  t.after(async () => {
    try {
      await service?.retire();
    } finally {
      await engine.close();
    }
  });
  service = await createTenantEnrollment<Request>({
    app: parseTestApp(manifest(), 'lending.ts'),
    pages: pages(),
    policy: policy(),
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['staff', 'manager'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: () => null,
  });
  const deployment = service.deployment;
  const step = (address: unknown, id: string, phase: 'start' | 'step' | 'submit', hash: string, input: Record<string, unknown>) =>
    deployment.submitIntake({ form: 'apply', address, input, submission: randomUUID(), draft: { phase, step: id, token: hash } });
  /** A whole application through one address: every step, then the submit. */
  const apply = async (address: unknown, hash = token()) => {
    await step(address, 'about', 'start', hash, { name: 'Ada' });
    await step(address, 'income', 'step', hash, { income: '5000' });
    await step(address, 'co', 'step', hash, { co_name: 'Grace' });
    return { hash, result: await step(address, 'submit', 'submit', hash, {}) };
  };
  const resume = (address: unknown, hash: string) => deployment.resumeIntake({ form: 'apply', address, token: hash });
  const rows = (sql: string) => engine.all(sql);
  return { engine, deployment, step, apply, resume, rows };
}

test("a draft's expiry reads as its moment however the engine answers it", () => {
  const at = Date.UTC(2026, 9, 9, 9, 21, 53, 123);
  // PostgreSQL's text for a timestamptz carries an hour-only offset JavaScript's parser refuses.
  for (const text of [
    '2026-10-09 05:21:53.123-04',
    '2026-10-09 09:21:53.123',
    '2026-10-09T09:21:53.123Z',
    '2026-10-09T14:51:53.123+05:30',
  ]) {
    assert.equal(storedInstant(text), at, text);
  }
  assert.equal(storedInstant(new Date(at)), at);
  assert.ok(Number.isNaN(storedInstant('not a moment')));
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a saved form on a tenant App, on ${dialect}`, { skip }, () => {
    test('a draft lands in the partner its address names, its steps stay there, and the submit finishes it there', async (t) => {
      mode = 'own';
      const f = await enrolled(t, dialect);
      const hash = token();
      await f.step(NORTH, 'about', 'start', hash, { name: 'Ada' });
      await f.step(NORTH, 'income', 'step', hash, { income: '5000' });
      assert.deepEqual(await f.resume(NORTH, hash), ['about', 'income']);
      // The root's hash is not the cookie's: it is bound to the place, so no row holds the raw one.
      assert.deepEqual(await f.rows(`SELECT count(*) AS n FROM lead WHERE resume_token_hash = '${hash}'`).then((r) => Number(r[0].n)), 0);
      await f.step(NORTH, 'co', 'step', hash, { co_name: 'Grace' });
      const done = await f.step(NORTH, 'submit', 'submit', hash, {});
      assert.match(String((done.result as { reference: string }).reference), /^IGN-/);
      assert.deepEqual(await f.rows("SELECT tenant_id, name, income, status, resume_token_hash FROM lead WHERE tenant_id = 'north'"), [
        { tenant_id: 'north', name: 'Ada', income: '5000', status: 'new', resume_token_hash: null },
      ]);
      assert.deepEqual(
        await f.rows("SELECT c.tenant_id, c.name FROM lead_co_applicant c JOIN lead l ON l.id = c.lead_id WHERE l.tenant_id = 'north'"),
        [{ tenant_id: 'north', name: 'Grace' }],
      );
      assert.deepEqual(await f.rows('SELECT count(*) AS n FROM intake_submission').then((r) => Number(r[0].n)), 0);
      // Each step is its own receipt, in the partner's namespace.
      assert.deepEqual(
        await f
          .rows(`SELECT realm, tenant_id, count(*) AS n FROM "${journal.receipt}" GROUP BY realm, tenant_id`)
          .then((r) => r.map((row) => ({ ...row, n: Number(row.n) }))),
        [{ realm: 'tenant', tenant_id: 'north', n: 4 }],
      );
      // The submit told the partner's desk, in the partner's own inbox; the drafting steps told nobody.
      const told = (namespace: string) => f.deployment.inbox.readInbox({ app: namespace, recipient: 'desk@example.invalid', limit: 10 });
      assert.deepEqual(
        (await told(tenantInbox(binding.appId, 'north'))).map((notice) => [notice.resource, notice.title.startsWith('Application IGN-')]),
        [['lead', true]],
      );
      for (const other of [binding.appId, tenantInbox(binding.appId, 'south')]) assert.deepEqual(await told(other), []);
      // Submitted, the token names nothing, anywhere.
      await assert.rejects(f.step(NORTH, 'income', 'step', hash, { income: '1' }), gone);
      assert.deepEqual(await f.resume(NORTH, hash), []);
    });

    test("an unplaced draft is the lender's, answered exactly as a placed one", async (t) => {
      mode = 'own';
      const f = await enrolled(t, dialect);
      const placed = await f.apply(NORTH),
        unplaced = await f.apply(undefined),
        unknown = await f.apply(UNKNOWN);
      for (const answer of [placed.result, unplaced.result, unknown.result]) {
        assert.deepEqual(Object.keys(answer).sort(), [
          'command',
          'commandVersion',
          'key',
          'receiptId',
          'replayed',
          'resource',
          'result',
          'status',
        ]);
        assert.equal(answer.status, 'applied');
      }
      assert.deepEqual(await f.rows('SELECT status, name, income FROM intake_submission ORDER BY status'), [
        { status: 'triage', name: 'Ada', income: '5000' },
        { status: 'triage', name: 'Ada', income: '5000' },
      ]);
      assert.deepEqual(await f.rows('SELECT count(*) AS n FROM intake_co_applicant').then((r) => Number(r[0].n)), 2);
    });

    test("the token is bound to its partner: under another partner's address, under none, or forged, it continues nothing", async (t) => {
      mode = 'own';
      const f = await enrolled(t, dialect);
      const north = token();
      await f.step(NORTH, 'about', 'start', north, { name: 'Ada' });
      const before = await f.rows('SELECT id, tenant_id, name, income, status FROM lead ORDER BY id');
      for (const address of [SOUTH, undefined, UNKNOWN]) {
        await assert.rejects(f.step(address, 'income', 'step', north, { income: '9' }), gone, String(address));
        await assert.rejects(f.step(address, 'submit', 'submit', north, {}), gone, String(address));
        assert.deepEqual(await f.resume(address, north), [], String(address));
      }
      await assert.rejects(f.step(NORTH, 'income', 'step', token(), { income: '9' }), gone, 'a forged token');
      assert.deepEqual(await f.rows('SELECT id, tenant_id, name, income, status FROM lead ORDER BY id'), before);
      assert.deepEqual(await f.rows('SELECT count(*) AS n FROM intake_submission').then((r) => Number(r[0].n)), 0);
      // A second applicant with the same cookie value under another partner is another draft, in that partner.
      await f.step(SOUTH, 'about', 'start', north, { name: 'Other' });
      assert.deepEqual(await f.resume(NORTH, north), ['about']);
      assert.deepEqual(await f.resume(SOUTH, north), ['about']);
      assert.deepEqual(await f.rows("SELECT tenant_id, name FROM lead WHERE status = 'draft' ORDER BY tenant_id"), [
        { tenant_id: 'north', name: 'Ada' },
        { tenant_id: 'south', name: 'Other' },
      ]);
    });

    test("a step reads and writes only its own application: another partner's rows by forged ids are refused, and nothing stays", async (t) => {
      const f = await enrolled(t, dialect);
      const hash = token();
      try {
        mode = 'own';
        await f.step(NORTH, 'about', 'start', hash, { name: 'Ada' });
        await f.step(NORTH, 'income', 'step', hash, { income: '5000' });
        const south = await f.rows("SELECT * FROM lead WHERE tenant_id = 'south'"),
          southChildren = await f.rows("SELECT * FROM lead_co_applicant WHERE tenant_id = 'south'");
        for (const attempt of ['forge-root', 'plant-child', 'other-child'] as const) {
          mode = attempt;
          await assert.rejects(f.step(NORTH, 'co', 'step', hash, { co_name: 'Mallory' }), refused('forbidden'), attempt);
        }
        // What it may read is its own application: the root, and no child yet.
        mode = 'read-other';
        seen.length = 0;
        await f.step(NORTH, 'co', 'step', hash, { co_name: 'Grace' });
        assert.deepEqual(seen, [1, 0]);
        assert.deepEqual(await f.rows("SELECT * FROM lead WHERE tenant_id = 'south'"), south);
        assert.deepEqual(await f.rows("SELECT * FROM lead_co_applicant WHERE tenant_id = 'south'"), southChildren);
        assert.deepEqual(await f.rows("SELECT name FROM lead_co_applicant WHERE tenant_id = 'north'"), [{ name: 'Grace' }]);
        assert.deepEqual(await f.resume(NORTH, hash), ['about', 'income', 'co']);
      } finally {
        mode = 'own';
      }
    });

    test("a draft's history is its partner's: every step recorded under the lead's key and owner, by the form", async (t) => {
      mode = 'own';
      const f = await enrolled(t, dialect);
      const hash = token();
      await attributeWrites({ via: 'form' }, async () => {
        await f.step(NORTH, 'about', 'start', hash, { name: 'Ada' });
        await f.step(NORTH, 'income', 'step', hash, { income: '5000' });
      });
      const [lead] = await f.rows("SELECT id FROM lead WHERE tenant_id = 'north' AND status = 'draft'");
      const stored = (await f.rows('SELECT resource, key_json, kind, via FROM "__mistri_history_change" ORDER BY id')).map((row) => ({
        resource: String(row.resource).replace(/^public\./, ''),
        key: JSON.parse(String(row.key_json)),
        kind: row.kind,
        via: row.via,
      }));
      const key = { id: String(lead.id), tenant_id: 'north' };
      // The start's insert and its progress, the step's update and its progress: all the lead's, all the partner's.
      assert.ok(stored.length >= 2);
      for (const row of stored) assert.deepEqual(row, { ...row, resource: 'lead', key, via: 'form' });
      assert.deepEqual(
        stored.map((row) => row.kind).filter((kind, i, all) => all.indexOf(kind) === i),
        ['insert', 'update'],
      );
    });

    test('a saved form runs only as its steps and its submit, in order, each with its draft', async (t) => {
      mode = 'own';
      const f = await enrolled(t, dialect);
      const hash = token();
      // Without a draft, as a later step starting one, or a step the form does not have.
      await assert.rejects(
        f.deployment.submitIntake({ form: 'apply', address: NORTH, input: {}, submission: randomUUID() }),
        refused('forbidden'),
      );
      await assert.rejects(f.step(NORTH, 'income', 'start', hash, { income: '1' }), refused('forbidden'));
      await assert.rejects(f.step(NORTH, 'nope', 'step', hash, { income: '1' }), refused('forbidden'));
      await assert.rejects(f.step(NORTH, 'about', 'start', 'not-a-hash', { name: 'Ada' }), refused('invalid_input'));
      await f.step(NORTH, 'about', 'start', hash, { name: 'Ada' });
      // The submit before every step is saved is refused, and changes nothing.
      await assert.rejects(f.step(NORTH, 'submit', 'submit', hash, {}), refused('ineligible_state'));
      assert.deepEqual(await f.rows("SELECT status FROM lead WHERE tenant_id = 'north'"), [{ status: 'draft' }]);
    });
  });
