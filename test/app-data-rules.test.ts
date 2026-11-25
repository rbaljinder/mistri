/**
 * Declared data rules (shared/appDataRules.ts, server/app/appDataRules.ts): a resource's `noOverlap`, and
 * `constraints`, a database constraint said as a field's refusal. An ordinary App here, at the write layer every
 * door passes (appAccess.ts authorizeTransaction), on SQLite always and on PostgreSQL when `TABLEWALK_TEST_PG` names
 * a disposable server (the schema `data_rules`, dropped before and after). The tenant path, through a served App's
 * commands and edits, is test/tenant-no-overlap.test.ts.
 *
 * What only PostgreSQL can show: two transactions that each read the slot free and then write. The exclusion
 * constraint lets one commit; the other is refused beside the field, in the App's words. And what `mistri check`
 * holds a PostgreSQL App to: the constraint behind the rule, with the statement that adds it, which runs as printed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { Adapter, TableConstraint, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { dataRuleFindings, unheldNoOverlap } from '../packages/mistri/src/server/app/appDataRuleChecks.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { compileAppDefinitionValidation } from '../packages/mistri/src/server/app/appValidation.js';
import { AppValidationDenied } from '../packages/mistri/src/server/app/appValidationDenied.js';
import { appDataRules, parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { noOverlapBacking, noOverlapDdl } from '../packages/mistri/src/shared/appDataRules.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'data_rules';
const TAKEN = 'That chair is taken then.';
const RULE = {
  by: ['chair'],
  from: 'starts_at',
  to: 'ends_at',
  when: 'status != cancelled',
  message: TAKEN,
};

const app = (booking: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      id: 'chairs',
      name: 'Chairs',
      resources: { booking: { access: 'write', ...booking }, ...more },
      views: { bookings: { kind: 'list', from: 'booking' } },
      home: 'bookings',
      nav: ['bookings'],
    },
    'chairs',
  );
const APP = app({
  noOverlap: RULE,
  constraints: {
    booking_fee_positive: { field: 'fee', message: 'A fee is more than zero.' },
  },
});

function statements(postgres: boolean): string[] {
  const at = postgres ? 'TIMESTAMP' : 'TEXT';
  return [
    `CREATE TABLE booking (id INTEGER PRIMARY KEY, chair INTEGER NOT NULL, starts_at ${at} NOT NULL, ends_at ${at} NOT NULL,
       status TEXT NOT NULL DEFAULT 'booked', fee INTEGER NOT NULL DEFAULT 10, code TEXT,
       CONSTRAINT booking_fee_positive CHECK (fee > 0), CONSTRAINT booking_code_short CHECK (code IS NULL OR length(code) < 4))`,
    `CREATE UNIQUE INDEX booking_code_once ON booking (code)`,
    `CREATE TABLE leave (id INTEGER PRIMARY KEY, first_day DATE NOT NULL, last_day DATE NOT NULL)`,
    `INSERT INTO booking (id, chair, starts_at, ends_at) VALUES (1, 1, '2026-11-02 09:00:00', '2026-11-02 10:00:00')`,
  ];
}

type Pg = {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
interface World {
  readonly adapter: SqliteAdapter | PostgresAdapter;
  readonly table: string;
  exec(sql: string): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;
}

async function sqliteWorld(): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-data-rules-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  for (const statement of statements(false)) db.exec(statement);
  const adapter = new SqliteAdapter(file, 'rules');
  return {
    adapter,
    table: 'booking',
    exec: async (sql) => db.exec(sql),
    count: async () => Number((db.prepare('SELECT count(*) AS n FROM booking').get() as { n: number }).n),
    async close() {
      await adapter.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function postgresWorld(): Promise<World> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as {
    default?: { Client: never };
    Client?: never;
  };
  const Client = (pg.Client ?? pg.default?.Client)! as new (c: unknown) => Pg;
  const control = new Client({
    connectionString: LIVE,
    statement_timeout: 60_000,
  });
  await control.connect();
  await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await control.query(`SET search_path TO ${SCHEMA}, public`);
  for (const statement of statements(true)) await control.query(statement);
  const adapter = new PostgresAdapter(LIVE!, 'rules', [SCHEMA]);
  return {
    adapter,
    table: `${SCHEMA}.booking`,
    exec: async (sql) => void (await control.query(sql)),
    count: async () => Number((await control.query(`SELECT count(*) AS n FROM ${SCHEMA}.booking`)).rows[0]!.n),
    async close() {
      await adapter.close();
      await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await control.end();
    },
  };
}

/* The App as `mistri check` and a start reach its database: one connection, each table by its own name. */
const resourcesOf = (schema: DatabaseSchema): RuntimeResources =>
  ({
    schema,
    connectionFor: () => 'db',
    toLogicalAt: (id: string) => schema.tables.find((table) => table.id === id)!.name,
  }) as unknown as RuntimeResources;

test('a rule that does not read against the catalog keeps the App from loading, naming the fix', () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const statement of statements(false)) sqlite.exec(statement);
  const columns = (name: string) =>
    (
      sqlite.prepare(`PRAGMA table_info(${name})`).all() as Array<{
        name: string;
        type: string;
        pk: number;
        notnull: number;
      }>
    ).map((column) => ({
      name: column.name,
      type: column.type,
      nullable: !column.notnull,
      primaryKey: column.pk > 0,
    }));
  const read: Record<string, ReturnType<typeof columns>> = {
    booking: columns('booking'),
    leave: columns('leave'),
  };
  sqlite.close();
  const schema = (dialect: string, types: Record<string, string> = {}) =>
    ({
      dialect,
      foreignKeys: [],
      tables: ['booking', 'leave'].map((name) => ({
        id: name,
        name,
        schema: '',
        columns: read[name]!.map((column) => ({
          ...column,
          type: types[column.name] ?? column.type,
        })),
      })),
    }) as unknown as DatabaseSchema;
  const problems = (noOverlap: unknown, on = schema('sqlite')) => appDataRules(app({ noOverlap }), on).problems;
  assert.deepEqual(problems(RULE), []);
  assert.match(
    problems({ ...RULE, by: ['room'] })[0],
    /resources "booking", noOverlap: "room" is not a column of "booking" \[no-overlap-column\]/,
  );
  assert.match(problems({ ...RULE, to: 'fee' })[0], /"starts_at" \(TEXT\) and "fee" \(INTEGER\) do not make a range \[no-overlap-range\]/);
  // Text ends compare on SQLite; PostgreSQL has no range of text, so the App does not load there.
  assert.match(
    problems(RULE, schema('postgres'))[0],
    /do not make a range \[no-overlap-range\].*date, timestamp, timestamptz, integer, bigint or numeric/,
  );
  assert.deepEqual(
    problems(
      RULE,
      schema('postgres', {
        starts_at: 'timestamp with time zone',
        ends_at: 'timestamp with time zone',
      }),
    ),
    [],
  );
  assert.match(
    problems({ ...RULE, when: 'status contains cancel' })[0],
    /"when" compares "status" in a way a constraint's condition cannot \(contains\) \[no-overlap-when\]/,
  );
  assert.match(problems({ ...RULE, when: 'nothing = here' })[0], /"when" does not read: .*\[no-overlap-when\]/);
  assert.match(
    problems([RULE, { by: [], from: 'starts_at', to: 'ends_at' }])[0],
    /noOverlap rule 2: the constraint name "booking_no_overlap" is used twice on this resource \[no-overlap-name\]/,
  );
  assert.deepEqual(
    problems([
      RULE,
      {
        by: [],
        from: 'starts_at',
        to: 'ends_at',
        constraint: 'booking_one_at_a_time',
      },
    ]),
    [],
  );
  assert.match(
    appDataRules(
      app({
        constraints: { some_check: { field: 'nowhere', message: 'No.' } },
      }),
      schema('sqlite'),
    ).problems[0],
    /constraints "some_check": "field" names "nowhere", which is not a column of "booking" \[constraint-field\]/,
  );
  // Shape, where the block is read.
  assert.throws(() => app({ noOverlap: { by: ['chair'], from: 'starts_at' } }), /needs a "to": the column where a row's range ends/);
  assert.throws(() => app({ noOverlap: { ...RULE, by: ['starts_at'] } }), /names a column in "by" and as an end of the range/);
  assert.throws(() => app({ noOverlap: { ...RULE, minutes: 30 } }), /minutes/);
  assert.throws(() => app({ constraints: { some_check: { field: 'fee' } } }), /needs a "message"/);
  assert.throws(() => app({ constraints: { 'not a name': { field: 'fee', message: 'No.' } } }), /is not a constraint's name/);
});

test('the statement a PostgreSQL table needs, and what does and does not hold a rule', () => {
  const table = {
    id: 'public.booking',
    name: 'booking',
    schema: 'public',
    columns: ['id', 'clinic_id', 'chair', 'status']
      .map((name) => ({ name, type: 'text' }))
      .concat([
        { name: 'starts_at', type: 'timestamp with time zone' },
        { name: 'ends_at', type: 'timestamp with time zone' },
      ]),
  } as never;
  const schema = {
    dialect: 'postgres',
    foreignKeys: [],
    tables: [table],
  } as unknown as DatabaseSchema;
  const rule = (noOverlap: Record<string, unknown>) => appDataRules(app({ noOverlap }), schema).overlaps.get('public.booking')![0]!;
  const declared = rule({ ...RULE, when: 'status in (booked, held)' });
  assert.equal(
    noOverlapDdl(declared, table, 'clinic_id'),
    'CREATE EXTENSION IF NOT EXISTS btree_gist; ALTER TABLE booking ADD CONSTRAINT booking_no_overlap EXCLUDE USING gist ' +
      "(clinic_id WITH =, chair WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = ANY (ARRAY['booked', 'held']));",
  );
  // No column to compare for equality: the range's own index method is enough, and no extension is asked for.
  assert.equal(
    noOverlapDdl(rule({ by: [], from: 'starts_at', to: 'ends_at' }), table),
    'ALTER TABLE booking ADD CONSTRAINT booking_no_overlap EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&);',
  );
  // As PostgreSQL writes the constraint back from its catalog: casts, quotes and parentheses its own.
  const held = (over: Partial<NonNullable<TableConstraint['exclusion']>> = {}, name = 'booking_no_overlap'): TableConstraint[] => [
    {
      name,
      kind: 'exclusion',
      named: true,
      exclusion: {
        method: 'gist',
        keys: [
          { expression: 'clinic_id', operator: '=' },
          { expression: 'chair', operator: '=' },
          { expression: 'tstzrange(starts_at, ends_at)', operator: '&&' },
        ],
        predicate: "(status = ANY (ARRAY['booked'::text, 'held'::text]))",
        deferrable: false,
        ...over,
      },
    },
  ];
  assert.equal(noOverlapBacking(declared, table, 'clinic_id', held()), undefined);
  assert.equal(
    noOverlapBacking(
      declared,
      table,
      'clinic_id',
      held({
        predicate: "((status)::text = ANY ((ARRAY['booked'::character varying, 'held'::character varying])::text[]))",
      }),
    ),
    undefined,
  );
  assert.match(
    noOverlapBacking(declared, table, 'clinic_id', [])!,
    /"booking" has no constraint named "booking_no_overlap"\. Add it in a migration: CREATE EXTENSION/,
  );
  assert.match(noOverlapBacking(declared, table, 'clinic_id', held({}, 'other'))!, /has no constraint named/);
  // One tenant's rule must not be another's: the constraint without the tenant's column is refused.
  assert.match(
    noOverlapBacking(declared, table, 'clinic_id', held({ keys: held()[0]!.exclusion!.keys.slice(1) }))!,
    /compares "chair" with =, where the rule needs "clinic_id", "chair" \(the tenant column "clinic_id" included\)/,
  );
  assert.match(
    noOverlapBacking(declared, table, 'clinic_id', held({ predicate: "(status <> 'cancelled'::text)" }))!,
    /holds WHERE .*where the rule's "when" is/,
  );
  assert.match(noOverlapBacking(declared, table, 'clinic_id', held({ deferrable: true }))!, /is DEFERRABLE/);
  assert.match(
    noOverlapBacking(
      declared,
      table,
      'clinic_id',
      held({
        keys: [
          ...held()[0]!.exclusion!.keys.slice(0, 2),
          {
            expression: "tstzrange(starts_at, ends_at, '[]'::text)",
            operator: '&&',
          },
        ],
      }),
    )!,
    /does not exclude the range tstzrange\(starts_at, ends_at\) with &&/,
  );
  assert.match(
    noOverlapBacking(declared, table, 'clinic_id', [{ name: 'booking_no_overlap', kind: 'check', named: true }])!,
    /is not an exclusion constraint/,
  );
});

function proofs(open: () => Promise<World>, label: string, skip: false | string = false) {
  describe(`declared data rules on ${label}`, { skip }, () => {
    let w: World;
    let schema: DatabaseSchema;
    let next = 100;
    const postgres = label === 'PostgreSQL';
    /** One write through the App's write layer, in a transaction of its own. */
    const write = <T>(run: (tx: WriteTransaction) => Promise<T>, of = APP, adapter: Adapter = w.adapter): Promise<T> =>
      adapter.transaction!((raw) => {
        const access = {
          readable: new Set([w.table]),
          writable: new Set([w.table]),
          validation: compileAppDefinitionValidation(schema, of),
        };
        return run(authorizeTransaction(schema, access, raw));
      });
    const book = (chair: number, from: string, to: string, more: Record<string, unknown> = {}) =>
      write((tx) =>
        tx.insert({
          table: w.table,
          values: {
            id: ++next,
            chair,
            starts_at: `2026-11-02 ${from}:00`,
            ends_at: `2026-11-02 ${to}:00`,
            ...more,
          },
        }),
      );
    const refused = async (work: Promise<unknown>, field = 'starts_at', message = TAKEN) => {
      await assert.rejects(work, (error: unknown) => {
        assert.ok(error instanceof AppValidationDenied, String((error as Error)?.stack ?? error));
        assert.deepEqual(error.fields, [field]);
        assert.equal(error.reasons[field], message);
        // The refusal is the field and the App's words: nothing of the engine's, which quotes the row it met.
        assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /09:00|conflicting|Key \(/);
        return true;
      });
    };
    before(async () => {
      w = await open();
      if (postgres)
        await w.exec(
          noOverlapDdl(
            appDataRules(APP, await w.adapter.introspect()).overlaps.get(w.table)![0]!,
            (await w.adapter.introspect()).tables.find((table) => table.id === w.table)!,
          ),
        );
      schema = await w.adapter.introspect();
    });
    after(() => w?.close());

    test('a booking that meets another is refused beside its start, and the write is not kept', async () => {
      const rows = await w.count();
      await refused(book(1, '09:30', '10:30'));
      await refused(book(1, '08:00', '11:00'));
      await refused(book(1, '09:15', '09:45'));
      assert.equal(await w.count(), rows);
    });

    test('touching is not meeting; another chair, a cancelled booking and an empty range are outside the rule', async () => {
      await book(1, '10:00', '11:00');
      await book(1, '08:00', '09:00');
      await book(2, '09:00', '10:00');
      await book(1, '09:00', '10:00', { status: 'cancelled' });
      await book(1, '09:30', '09:30');
    });

    test('an edit is held to it, where it writes a column the rule reads', async () => {
      const made = await book(3, '09:00', '10:00');
      const key = made.key as { id: number };
      await refused(write((tx) => tx.update({ table: w.table, key, values: { chair: 1 } })));
      await refused(
        write((tx) =>
          tx.update({
            table: w.table,
            key: { id: 1 },
            values: { ends_at: '2026-11-02 10:30:00' },
          }),
        ),
      );
      // Moved clear of everything, then cancelled where it would meet: neither is refused.
      await write((tx) =>
        tx.update({
          table: w.table,
          key,
          values: {
            starts_at: '2026-11-02 15:00:00',
            ends_at: '2026-11-02 16:00:00',
          },
        }),
      );
      await write((tx) =>
        tx.update({
          table: w.table,
          key,
          values: {
            chair: 1,
            status: 'cancelled',
            starts_at: '2026-11-02 09:00:00',
            ends_at: '2026-11-02 10:00:00',
          },
        }),
      );
      await refused(write((tx) => tx.update({ table: w.table, key, values: { status: 'booked' } })));
      await write((tx) => tx.update({ table: w.table, key, values: { code: 'abc' } }));
    });

    test("a constraint the App named is its field's refusal; one it did not name is the engine's own", async () => {
      await refused(book(4, '09:00', '10:00', { fee: 0 }), 'fee', 'A fee is more than zero.');
      await refused(
        write((tx) => tx.update({ table: w.table, key: { id: 1 }, values: { fee: -1 } })),
        'fee',
        'A fee is more than zero.',
      );
      await assert.rejects(book(4, '09:00', '10:00', { code: 'too long' }), (error: unknown) => {
        assert.ok(!(error instanceof AppValidationDenied));
        assert.match(String((error as Error).message), /booking_code_short/);
        return true;
      });
    });

    test('the names a refused write can carry are read off the database', async () => {
      const found = (await w.adapter.constraints()).get(w.table) ?? [];
      const named = (name: string) => found.find((constraint) => constraint.name === name);
      assert.deepEqual(
        {
          kind: named('booking_fee_positive')?.kind,
          named: named('booking_fee_positive')?.named,
        },
        { kind: 'check', named: true },
      );
      // SQLite says a unique rule by its columns, never by the index's name.
      assert.deepEqual(
        {
          kind: named('booking_code_once')?.kind,
          named: named('booking_code_once')?.named,
        },
        { kind: 'unique', named: postgres },
      );
      const checked = await dataRuleFindings(
        app({
          noOverlap: RULE,
          constraints: {
            booking_fee_positive: { field: 'fee', message: 'No.' },
            booking_code_once: { field: 'code', message: 'Taken.' },
            booking_fee_postive: { field: 'fee', message: 'No.' },
          },
        }),
        resourcesOf(schema),
        async () => w.adapter,
      );
      assert.equal(checked.problems.length, 1, checked.problems.join('\n'));
      assert.match(
        checked.problems[0]!,
        /constraints "booking_fee_postive": "booking" has no constraint of that name \[constraint-unknown\].*"booking_fee_positive"/,
      );
      if (postgres) return assert.deepEqual(checked.warnings, []);
      assert.equal(checked.warnings.length, 2, checked.warnings.join('\n'));
      assert.match(
        checked.warnings[0]!,
        /constraints "booking_code_once": SQLite reports a unique rule by its columns.*\[constraint-unnamed\]/,
      );
      // What the App will need where it is hosted, said while it is still on SQLite.
      assert.match(
        checked.warnings[1]!,
        /\[no-overlap-postgres\]: CREATE EXTENSION IF NOT EXISTS btree_gist; ALTER TABLE booking ADD CONSTRAINT booking_no_overlap EXCLUDE USING gist \(chair WITH =, tsrange\(starts_at, ends_at\) WITH &&\) WHERE \(status <> 'cancelled'\);/,
      );
    });

    if (!postgres) return;

    test('of two writers that each read the slot free, one commits and the other is refused beside the field', async (t) => {
      const rows = await w.count();
      /* Each reads for a meeting booking, finds none, and only then writes: the check-then-insert an App's own
         handler would make, which is not enough on its own under READ COMMITTED. Both have read before either writes. */
      let read = 0;
      let bothRead!: () => void;
      const ready = new Promise<void>((resolve) => (bothRead = resolve));
      /* Two servers' worth: an adapter writes one transaction at a time, so the second writer is another adapter. */
      const other = new PostgresAdapter(LIVE!, 'rules-2', [SCHEMA]);
      t.after(() => other.close());
      await other.introspect();
      const attempt = (id: number, adapter: Adapter) =>
        write(
          async (tx) => {
            const free = await tx.count(w.table, {
              groups: [[{ column: 'chair', op: '=', value: 9 }]],
            });
            assert.equal(free, 0);
            if (++read === 2) bothRead();
            await ready;
            return tx.insert({
              table: w.table,
              values: {
                id,
                chair: 9,
                starts_at: '2026-11-03 09:00:00',
                ends_at: '2026-11-03 10:00:00',
              },
            });
          },
          APP,
          adapter,
        );
      const outcomes = await Promise.allSettled([attempt(901, w.adapter), attempt(902, other)]);
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
      const lost = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      await refused(Promise.reject(lost.reason));
      assert.equal(await w.count(), rows + 1);
    });

    test('an App whose rule has no constraint behind it is a problem, with the statement that adds it', async () => {
      const resources = resourcesOf(schema);
      const open = async () => w.adapter as Adapter;
      assert.deepEqual(await unheldNoOverlap(APP, resources, open), []);
      // Another rule than the one declared: the same name, without the `when`.
      const plain = app({
        noOverlap: { by: ['chair'], from: 'starts_at', to: 'ends_at' },
      });
      const differs = await unheldNoOverlap(plain, resources, open);
      assert.equal(differs.length, 1);
      assert.match(
        differs[0]!,
        /PostgreSQL holds this rule with an exclusion constraint, and the constraint "booking_no_overlap" on "booking" holds only WHERE .*cancelled.*\[no-overlap-constraint\]/,
      );
      // A rule over the whole table, of dates: nothing holds it yet, and the statement check prints runs as it is.
      const leave = app(
        {},
        {
          leave: {
            access: 'write',
            noOverlap: { from: 'first_day', to: 'last_day' },
          },
        },
      );
      const missing = (await dataRuleFindings(leave, resources, open)).problems;
      assert.equal(missing.length, 1, missing.join('\n'));
      const statement =
        /"leave" has no constraint named "leave_no_overlap"\. Add it in a migration: (ALTER TABLE .*;) \[no-overlap-constraint\]$/.exec(
          missing[0]!,
        )?.[1];
      assert.equal(
        statement,
        'ALTER TABLE data_rules.leave ADD CONSTRAINT leave_no_overlap EXCLUDE USING gist (daterange(first_day, last_day) WITH &&);',
      );
      await w.exec(statement!);
      assert.deepEqual((await dataRuleFindings(leave, resourcesOf(await w.adapter.introspect()), open)).problems, []);
    });
  });
}

proofs(sqliteWorld, 'SQLite');
proofs(postgresWorld, 'PostgreSQL', liveSkip('postgres', LIVE));
