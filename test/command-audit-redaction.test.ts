/**
 * What the command audit keeps of a write, and what it redacts.
 *
 * The receipt's `changes_json` is read by operators, MCP agents
 * and retention work outside every role's column ceiling, so a public
 * form's audit row records the write's shape — operation, resource, record
 * key, column names — and never what the applicant typed, unless the command
 * opts out. A signed-in command keeps full values; `audit: { redact: [...] }`
 * redacts only the columns it names. The receipt, its fingerprint and replay
 * are the same whatever the audit keeps. SQLite always; PostgreSQL when
 * TABLEWALK_TEST_PG names a disposable database (it drops and recreates
 * `public.enrolment` and the command journal there).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { isRuntimeTable, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES as tables, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { BusinessCommandExecutionError, executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { validateBusinessCommandReferences } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import {
  AUDIT_REDACTED,
  BusinessCommandDefinitionError,
  defineCommand,
  defineCommands,
  type BusinessCommandAudit,
  type BusinessCommandContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { publicPrincipal } from '../packages/mistri/src/server/commands/formHttp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { liveSkip } from './live.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { parseTestApp } from './support/commandCatalog.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const APP = 'enrolments';
const CONNECTION = 'private-enrolments';
const clerk = { id: 'account-clerk', appId: APP, roles: ['clerk'] };
const applicant = (form = 'apply') => publicPrincipal(APP, form);
const now = () => new Date('2026-09-10T09:00:00Z');

type Row = Record<string, unknown>;
interface Change {
  operation: string;
  resource: string;
  key: Row;
  before?: Row;
  after?: Row;
}
interface Engine {
  name: 'sqlite' | 'postgres';
  /** A fresh enrolment table and journal, one row (id 1) already present; its registry URL. */
  reset(): Promise<string>;
  rows(sql: string): Promise<Row[]>;
  table: (name: string) => string;
  close(): Promise<void>;
}

/* Declared once: each public form draws the list its command registers with. */
const enrolInput = {
  name: { label: 'Name', type: 'text', max: 60 },
  email: { label: 'Email', type: 'text', max: 120 },
} as const;
const formFor = (command: string) => ({
  kind: 'form',
  label: 'Enrol',
  public: true,
  description: 'Say hello.',
  submitLabel: 'Send',
  done: { title: 'Thanks' },
  command: { id: command, version: 1, input: enrolInput },
  steps: [{ id: 'who', label: 'Who', fields: ['name', 'email'] }],
});

const referenceOutput = shape({ reference: text() });
const noteInput = { email: { label: 'Email', type: 'text', max: 120 } } as const;
const versionOutput = { parse: (value: unknown) => ({ version: (value as { version: number }).version }) };

let references = 0;
async function enrol(context: BusinessCommandContext, input: { name: string; email: string }) {
  const reference = `ENR-${String(++references).padStart(4, '0')}`;
  await context.tx.insert({ table: 'enrolment', values: { name: input.name, email: input.email, reference } });
  return { reference };
}
/* An update of the target and an insert beside it, so a column list is seen
   to redact in every image and every resource, and nothing else. */
async function note(context: BusinessCommandContext, input: { email: string }) {
  const current = context.record!,
    version = Number(current.version) + 1;
  // `expected` names exactly the touched columns, as the adapter requires.
  await context.tx.update({
    table: 'enrolment',
    key: { id: Number(current.id) },
    expected: { email: current.email as string, status: current.status as string, version: version - 1 },
    values: { email: input.email, status: 'noted', version },
  });
  await context.tx.insert({
    table: 'enrolment',
    values: { name: 'Copy of one', email: 'copy@example.invalid', reference: `COPY-${version}` },
  });
  return { version };
}

function commandsFor(noteAudit?: BusinessCommandAudit) {
  return defineCommands({
    enrol: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'enrolment',
      read: ['enrolment'],
      write: ['enrolment'],
      public: true,
      input: enrolInput,
      output: referenceOutput,
      handle: enrol,
    }),
    enrolOpen: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'enrolment',
      read: ['enrolment'],
      write: ['enrolment'],
      public: true,
      audit: { redact: [] },
      input: enrolInput,
      output: referenceOutput,
      handle: enrol,
    }),
    note: defineCommand({
      source: 'main',
      target: 'enrolment',
      ...(noteAudit ? { audit: noteAudit } : {}),
      input: noteInput,
      output: versionOutput,
      handle: note,
    }),
    noteMasked: defineCommand({
      source: 'main',
      target: 'enrolment',
      audit: { redact: ['email'] },
      input: noteInput,
      output: versionOutput,
      handle: note,
    }),
  });
}

async function bound(engine: Engine, noteAudit?: BusinessCommandAudit) {
  const url = await engine.reset();
  const registry = new Registry();
  const app = parseTestApp(
    {
      id: APP,
      name: 'Enrolments',
      sources: { main: { connection: CONNECTION } },
      resources: { enrolment: { access: 'write', ...(engine.name === 'postgres' ? { physical: 'public.enrolment' } : {}) } },
      auth: { roles: { clerk: { read: true, commands: ['note', 'noteMasked'] } } },
      views: { enrolments: { kind: 'list', from: 'enrolment' }, apply: formFor('enrol'), open: formFor('enrolOpen') },
      home: 'enrolments',
    },
    'audit redaction fixture',
  );
  registry.add({ id: CONNECTION, name: 'Private enrolments', url, writable: true, source: 'config' });
  const commands = commandsFor(noteAudit);
  const resources = await loadAppRuntimeResources(registry, app, CONNECTION);
  validateBusinessCommandReferences(app, commands, resources);
  const binding = bindBusinessCommands({
    app,
    registry: commands,
    resources,
    writableConnection: (id) => registry.configOf(id)?.writable === true,
  });
  return { binding, close: () => registry.closeAll() };
}

// Idempotency keys are 16 to 128 characters; the prefix keeps the short names readable.
const submission = (key: string, input: Row = {}, command = 'enrol') => ({
  command,
  commandVersion: 1,
  key: {},
  expectedVersion: 0,
  idempotencyKey: `audit-redaction-${key}`,
  input: { name: 'Mara Alder', email: 'mara@example.invalid', ...input },
});
const noting = (key: string, command = 'note') => ({
  command,
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  idempotencyKey: `audit-redaction-${key}`,
  input: { email: 'new@example.invalid' },
});

async function audits(engine: Engine): Promise<(Row & { changes: Change[] })[]> {
  return (await engine.rows(`SELECT * FROM ${auditRows(engine.name)} a ORDER BY receipt_id, ordinal`)).map((row) => ({
    ...row,
    changes: JSON.parse(String(row.changes_json)) as Change[],
  }));
}
const auditOf = async (engine: Engine, receiptId: string) => {
  const found = (await audits(engine)).filter((row) => row.receipt_id === receiptId);
  assert.equal(found.length, 1);
  return found[0];
};
const redactedImage = (columns: string[]) => Object.fromEntries(columns.map((column) => [column, AUDIT_REDACTED]));
const ids = (key: Row) => Object.fromEntries(Object.entries(key).map(([column, value]) => [column, Number(value)]));

function scenarios(engine: () => Engine) {
  test("a public form's command audits keys and column names, never the applicant's values", async () => {
    const e = engine();
    const f = await bound(e);
    try {
      const result = await executeBusinessCommand(f.binding, applicant(), submission('submission-0001'), { now });
      const audit = await auditOf(e, result.receiptId);
      assert.equal(audit.actor_id, 'public:apply');
      assert.equal(audit.key_json, '{}');
      assert.equal(audit.changes.length, 1);
      const [change] = audit.changes;
      assert.deepEqual(
        { ...change, key: ids(change.key) },
        { operation: 'insert', resource: 'enrolment', key: { id: 2 }, after: redactedImage(['email', 'name', 'reference']) },
      );
      assert.doesNotMatch(JSON.stringify(audit), /Mara Alder|mara@example\.invalid|ENR-/);
      // The values are where they belong: in the table, under its ceilings.
      assert.deepEqual(
        (await e.rows(`SELECT name, email FROM ${e.table('enrolment')} WHERE id = 2`)).map((row) => ({ ...row })),
        [{ name: 'Mara Alder', email: 'mara@example.invalid' }],
      );
    } finally {
      await f.close();
    }
  });

  test('the receipt and replay are unaffected: the same key replays its reference, other input conflicts', async () => {
    const e = engine();
    const f = await bound(e);
    try {
      const first = await executeBusinessCommand(f.binding, applicant(), submission('submission-0002'), { now });
      const receipt = (await e.rows(`SELECT * FROM ${e.table(tables.receipt)} WHERE id = '${first.receiptId}'`))[0];
      assert.deepEqual(JSON.parse(String(receipt.result_json)), first.result);
      assert.match((first.result as { reference: string }).reference, /^ENR-\d{4}$/);
      const replay = await executeBusinessCommand(f.binding, applicant(), submission('submission-0002'), { now });
      assert.deepEqual({ ...replay, replayed: false }, { ...first });
      assert.equal(replay.replayed, true);
      await assert.rejects(
        executeBusinessCommand(f.binding, applicant(), submission('submission-0002', { name: 'Someone Else' })),
        (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'idempotency_conflict',
      );
      assert.equal((await audits(e)).length, 1, 'a replay writes no second audit row');
    } finally {
      await f.close();
    }
  });

  test('a public command that opts out with redact: [] keeps full values', async () => {
    const e = engine();
    const f = await bound(e);
    try {
      const result = await executeBusinessCommand(f.binding, applicant('open'), submission('submission-0003', {}, 'enrolOpen'), { now });
      const [change] = (await auditOf(e, result.receiptId)).changes;
      assert.deepEqual(change.after, {
        email: 'mara@example.invalid',
        name: 'Mara Alder',
        reference: (result.result as { reference: string }).reference,
      });
    } finally {
      await f.close();
    }
  });

  test('a signed-in command keeps full values; a column list redacts only those columns, in every image and resource', async () => {
    const e = engine();
    let f = await bound(e);
    try {
      const full = await executeBusinessCommand(f.binding, clerk, noting('note-0001'), { now });
      const plain = (await auditOf(e, full.receiptId)).changes;
      assert.equal(plain.length, 2);
      assert.deepEqual(
        { ...plain[0], key: ids(plain[0].key) },
        {
          operation: 'update',
          resource: 'enrolment',
          key: { id: 1 },
          before: { email: 'first@example.invalid', status: 'new', version: 0 },
          after: { email: 'new@example.invalid', status: 'noted', version: 1 },
        },
      );
      assert.deepEqual(plain[1].after, { email: 'copy@example.invalid', name: 'Copy of one', reference: 'COPY-1' });
      await f.close();

      f = await bound(e);
      const masked = await executeBusinessCommand(f.binding, clerk, noting('note-0002', 'noteMasked'), { now });
      const changes = (await auditOf(e, masked.receiptId)).changes;
      assert.deepEqual(
        { ...changes[0], key: ids(changes[0].key) },
        {
          operation: 'update',
          resource: 'enrolment',
          key: { id: 1 },
          before: { email: AUDIT_REDACTED, status: 'new', version: 0 },
          after: { email: AUDIT_REDACTED, status: 'noted', version: 1 },
        },
      );
      assert.deepEqual(changes[1].after, { email: AUDIT_REDACTED, name: 'Copy of one', reference: 'COPY-1' });
      assert.doesNotMatch(JSON.stringify(changes), /@example\.invalid/);
    } finally {
      await f.close();
    }
  });

  test('redaction changes the audit and nothing else: the same request leaves the same receipt', async () => {
    const e = engine();
    const receipts: Row[] = [];
    const audited: Change[][] = [];
    for (const noteAudit of [undefined, { redact: 'values' as const }]) {
      const f = await bound(e, noteAudit);
      try {
        const result = await executeBusinessCommand(f.binding, clerk, noting('note-0003'), { now, requestId: 'fixed-request' });
        // The audit is the receipt's own changes_json: kept apart, as what redaction is meant to change.
        const {
          id: _id,
          changes_json: _changes,
          ...receipt
        } = (await e.rows(`SELECT * FROM ${e.table(tables.receipt)} WHERE id = '${result.receiptId}'`))[0];
        receipts.push(receipt);
        audited.push((await auditOf(e, result.receiptId)).changes);
        // A replay of the redacted row passes the journal's own validation.
        assert.equal((await executeBusinessCommand(f.binding, clerk, noting('note-0003'), { now })).replayed, true);
      } finally {
        await f.close();
      }
    }
    assert.deepEqual(receipts[1], receipts[0], 'fingerprint, result, request and time are the same');
    assert.equal(audited[0][0].after!.email, 'new@example.invalid');
    assert.deepEqual(audited[1][0].after, redactedImage(['email', 'status', 'version']));
    assert.deepEqual(audited[1][0].before, redactedImage(['email', 'status', 'version']));
    assert.deepEqual(ids(audited[1][0].key), { id: 1 }, 'record keys are identity, always kept');
  });
}

describe('the audit option on defineCommand', () => {
  const base = {
    source: 'main',
    target: 'enrolment',
    read: ['enrolment'],
    write: ['enrolment'],
    input: noteInput,
    output: versionOutput,
    handle: note,
  };

  test('takes redact: "values" or a list of distinct column names, captured and frozen', () => {
    const values = defineCommand({ ...base, audit: { redact: 'values' } });
    assert.deepEqual(values.audit, { redact: 'values' });
    assert.ok(Object.isFrozen(values.audit));
    const declared = ['email', 'phone'];
    const listed = defineCommand({ ...base, audit: { redact: declared } });
    declared.push('name');
    assert.deepEqual(listed.audit, { redact: ['email', 'phone'] }, "a copy, not the caller's array");
    assert.ok(Object.isFrozen(listed.audit!.redact));
    assert.deepEqual(defineCommand({ ...base, audit: { redact: [] } }).audit, { redact: [] });
    assert.deepEqual(defineCommand({ ...base, audit: {} }).audit, {});
    assert.equal(Object.hasOwn(defineCommand(base), 'audit'), false);
  });

  test('refuses anything else, by rule', () => {
    const refused = (audit: unknown, message: RegExp) =>
      assert.throws(
        () => defineCommand({ ...base, audit } as never),
        (error: unknown) => error instanceof BusinessCommandDefinitionError && message.test(error.message),
        JSON.stringify(audit),
      );
    refused(null, /Command audit must be a plain object/);
    refused('values', /Command audit must be a plain object/);
    refused({ redact: 'values', keep: true }, /unknown option: keep/);
    refused({ redact: 'all' }, /"values" or a list of column names/);
    refused({ redact: 'email' }, /"values" or a list of column names/);
    refused({ redact: ['email', 'email'] }, /duplicate column/);
    refused({ redact: ['lead.email'] }, /unqualified column names/);
    refused({ redact: [''] }, /unqualified column names/);
    refused({ redact: [1] }, /unqualified column names/);
    refused(Object.create({ redact: 'values' }), /must not inherit configuration/);
  });
});

describe('the command audit on SQLite', () => {
  let directory = '';
  let db: DatabaseSync | undefined;
  const engine: Engine = {
    name: 'sqlite',
    async reset() {
      db?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
      directory = mkdtempSync(join(tmpdir(), 'tablewalk-audit-redaction-'));
      const file = join(directory, 'enrolments.db');
      db = new DatabaseSync(file);
      db.exec(`CREATE TABLE enrolment (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, reference TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'new', version INTEGER NOT NULL DEFAULT 0);
        INSERT INTO enrolment (id, name, email, reference) VALUES (1, 'First', 'first@example.invalid', 'ENR-FIRST');`);
      migrateSqliteCommandJournal(file);
      return file;
    },
    async rows(sql) {
      return db!
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    },
    table: (name) => `"${name}"`,
    async close() {
      db?.close();
      db = undefined;
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
  after(() => engine.close());
  scenarios(() => engine);
});

describe('the command audit on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  interface Control extends PgQuery {
    connect(): Promise<void>;
    end(): Promise<void>;
  }
  let control: Control;
  const engine: Engine = {
    name: 'postgres',
    async reset() {
      for (const statement of [
        `DROP TABLE IF EXISTS public.enrolment CASCADE`,
        `DROP SCHEMA IF EXISTS mistri CASCADE`,
        `CREATE TABLE public.enrolment (id serial PRIMARY KEY, name text NOT NULL, email text, reference text NOT NULL UNIQUE,
          status text NOT NULL DEFAULT 'new', version integer NOT NULL DEFAULT 0)`,
        `INSERT INTO public.enrolment (name, email, reference) VALUES ('First', 'first@example.invalid', 'ENR-FIRST')`,
      ])
        await control.query(statement);
      assert.equal((await migratePostgresCommandJournal(LIVE!)).version, 1);
      return LIVE!;
    },
    async rows(sql) {
      return (await control.query(sql)).rows as Row[];
    },
    table: (name) => (isRuntimeTable(name) ? runtimeTable('postgres', name) : `public."${name}"`),
    async close() {},
  };
  before(async () => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
    control = new (pg.Client ?? pg.default!.Client)({ connectionString: LIVE });
    await control.connect();
  });
  after(async () => {
    await control.query(`DROP TABLE IF EXISTS public.enrolment CASCADE`).catch(() => {});
    await control.end();
  });
  scenarios(() => engine);
});
