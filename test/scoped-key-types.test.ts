/**
 * The types a scoped write takes as a row's identity (keyTypes.ts): an allow-list, refused from the catalog.
 *
 * Six reviews of the policy-scoped writes found one class of bypass, each in a new place: a check named a row by a
 * value that differed from what the database compares — a jsonb key read by the driver as another number, a SQLite
 * numeric(10,2) key said as "19.99" where 19.987 was stored, a float or timestamp whose text the session's settings
 * changed. Under a row policy a primary key, either side of a foreign key and either side of a trigger effect's key
 * must now be of a type whose value reads back exactly; any other is refused before a value is read, naming the
 * table, the column and its type. An allowed key still finds the visible row and refuses the hidden one.
 *
 * The PostgreSQL half is live and opt-in (TABLEWALK_TEST_PG); everything lives in the schema `scoped_key_types`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test, type TestContext } from 'node:test';
import type { Filter, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { TriggerAcceptance } from '../packages/engine/src/adapters/scoped/triggerProof.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';

const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const REFUSED = 'ScopeRefusal: This operation is not available in the current row scope.';
const NOT_A_KEY = /is of type .+, which is not supported as a key for writes under a row policy/;
const named = (table: string, trigger: string): TriggerAcceptance => ({ named: new Map([[table, new Map([[trigger, undefined]])]]) });

type Said = { said: string; cause: string };
const outcome = async (run: () => Promise<unknown>): Promise<Said> => {
  try {
    await run();
    return { said: 'committed', cause: '' };
  } catch (error) {
    return { said: `${(error as Error).constructor.name}: ${(error as Error).message}`, cause: String(refusalCause(error as Error)) };
  }
};
/** Refused for the key's type, before any value is read: the refusal names the column and its type. */
const refusedAsKey = (result: Said, column: RegExp, label: string) => {
  assert.notEqual(result.said, 'committed', label);
  assert.match(`${result.said} ${result.cause}`, NOT_A_KEY, label);
  assert.match(`${result.said} ${result.cause}`, column, label);
};

/** node:sqlite's rows have no prototype; deepEqual compares one. */
const plain = (rows: readonly object[]) => rows.map((row) => ({ ...row }));

describe('SQLite', () => {
  async function fixture(t: TestContext, sql: string) {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-key-types-'));
    const file = join(directory, 'data.db');
    const db = new DatabaseSync(file);
    db.exec(sql);
    const adapter = new SqliteAdapter(file);
    t.after(async () => {
      await adapter.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const said = (scope: RowScope, operation: (tx: WriteTransaction) => Promise<unknown>, accepted?: TriggerAcceptance) =>
      outcome(() => adapter.scopeTransaction(scope, operation, accepted));
    return { db, said, adapter };
  }
  const ofA = (...tables: string[]): RowScope => Object.fromEntries(tables.map((table) => [table, eq('tenant', 'a')]));

  /* Each a key of the type and a reference to it, tenant a's row and tenant b's: the visible one is found and the
     hidden one is not, as a reference and as a write's own row. */
  for (const [type, child, visible, hidden] of [
    ['INTEGER', 'INTEGER', 1, 2],
    ['BIGINT', 'INTEGER', 3, 4],
    ['TEXT', 'TEXT', 'a1', 'b1'],
    ['VARCHAR(10)', 'TEXT', 'a1', 'b1'],
    ['TEXT COLLATE NOCASE', 'TEXT COLLATE NOCASE', 'A1', 'B1'],
    // A typeless reference stores what was written, which the key's affinity reads as the check does.
    ['INTEGER', '', 1, 2],
  ] as const)
    test(`an allowed key, ${type} (referenced as ${child || 'typeless'}): the visible row is found, the hidden one refused`, async (t) => {
      const { db, said } = await fixture(
        t,
        `CREATE TABLE p (k ${type} PRIMARY KEY, tenant TEXT NOT NULL, note TEXT);
         CREATE TABLE c (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, ref ${child} REFERENCES p(k));`,
      );
      db.prepare("INSERT INTO p VALUES (?, 'a', NULL), (?, 'b', NULL)").run(visible, hidden);
      const insert = (id: number, ref: string | number) => (tx: WriteTransaction) =>
        tx.insert({ table: 'c', values: { id, tenant: 'a', ref } });
      const note = (k: string | number) => (tx: WriteTransaction) => tx.update({ table: 'p', key: { k }, values: { note: 'seen' } });
      const found = await said(ofA('p', 'c'), insert(1, visible));
      assert.equal(found.said, 'committed', found.cause);
      assert.equal((await said(ofA('p', 'c'), insert(2, hidden))).said, REFUSED);
      const edited = await said(ofA('p', 'c'), note(visible));
      assert.equal(edited.said, 'committed', edited.cause);
      const hiddenEdit = await said(ofA('p', 'c'), note(hidden));
      assert.equal(hiddenEdit.said, REFUSED);
      assert.doesNotMatch(hiddenEdit.cause, NOT_A_KEY);
      assert.deepEqual(
        db
          .prepare('SELECT tenant, note FROM p ORDER BY tenant')
          .all()
          .map((row) => [row.tenant, row.note]),
        [
          ['a', 'seen'],
          ['b', null],
        ],
      );
    });

  for (const [type, value, strict] of [
    ['REAL', 1.5],
    ['DOUBLE', 1.5],
    ['NUMERIC', 1.5],
    ['DECIMAL(10,2)', 19.99],
    ['numeric(10,2)', 19.99],
    ['BLOB', 'x'],
    ['', 'x'],
    ['UUID', 'x'],
    ['DATE', '2026-01-02'],
    ['BOOLEAN', 1],
    ['ANY', 'x', true],
  ] as const)
    test(`a key of type ${type || '(none)'} is refused as a key, as a reference to it and as a write's own row`, async (t) => {
      const { db, said } = await fixture(
        t,
        `CREATE TABLE p (k ${type} PRIMARY KEY, tenant TEXT NOT NULL, note TEXT)${strict ? ' STRICT' : ''};
         CREATE TABLE c (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, ref ${strict ? 'ANY' : type} REFERENCES p(k))${strict ? ' STRICT' : ''};`,
      );
      db.prepare("INSERT INTO p VALUES (?, 'a', NULL)").run(value);
      refusedAsKey(
        await said(ofA('p', 'c'), (tx) => tx.insert({ table: 'c', values: { id: 1, tenant: 'a', ref: value } })),
        /"p"\.k/,
        `${type} reference`,
      );
      refusedAsKey(await said(ofA('p', 'c'), (tx) => tx.update({ table: 'p', key: { k: value }, values: { note: 'x' } })), /"p"\.k/, type);
      refusedAsKey(await said(ofA('p', 'c'), (tx) => tx.insert({ table: 'p', values: { k: 'y', tenant: 'a' } })), /"p"\.k/, type);
      assert.deepEqual({ ...db.prepare('SELECT count(*) AS n FROM c').get() }, { n: 0 });
      assert.deepEqual(plain(db.prepare('SELECT note FROM p').all()), [{ note: null }]);
    });

  /* SQLite gives a type it does not know NUMERIC affinity, so a key declared UUID, STRING, DATETIME, BOOLEAN or GUID
     (another engine's names) is refused: the refusal says what to declare instead. A NUMERIC or DECIMAL key, which
     its author meant as a number, is not told to be text. */
  for (const [type, hinted] of [
    ['UUID', true],
    ['STRING', true],
    ['DATETIME', true],
    ['BOOLEAN', true],
    ['GUID', true],
    ['NUMERIC', false],
    ['DECIMAL(10,2)', false],
    ['REAL', false],
  ] as const)
    test(`a ${type} key's refusal ${hinted ? 'says to declare it TEXT or INTEGER' : 'gives no hint'}`, async (t) => {
      const { said } = await fixture(t, `CREATE TABLE p (k ${type} PRIMARY KEY, tenant TEXT NOT NULL);`);
      const result = await said(ofA('p'), (tx) => tx.insert({ table: 'p', values: { k: '1', tenant: 'a' } }));
      refusedAsKey(result, /"p"\.k/, type);
      const hint = /; declare it TEXT \(or INTEGER\) to use it as a key under a row policy\.$/;
      if (hinted) assert.match(result.cause, hint, type);
      else assert.doesNotMatch(result.cause, /declare it TEXT/, type);
    });

  test('a REAL reference to a TEXT key is refused for the reference', async (t) => {
    const { said } = await fixture(
      t,
      `CREATE TABLE p (k TEXT PRIMARY KEY, tenant TEXT NOT NULL);
       CREATE TABLE c (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, ref REAL REFERENCES p(k));
       INSERT INTO p VALUES ('7', 'a');`,
    );
    refusedAsKey(
      await said(ofA('p', 'c'), (tx) => tx.insert({ table: 'c', values: { id: 1, tenant: 'a', ref: '7' } })),
      /"c"\.ref/,
      'REAL',
    );
  });

  /* The review's reproducers: a numeric(10,2) column is said with its scale by every read a person sees, so a stored
     19.987 read as "19.99" named Ada's visible row where the database compared Ben's hidden one. */
  test('a composite reference of numeric(10,2), one part set by an update, is refused for its type', async (t) => {
    const { db, said } = await fixture(
      t,
      `CREATE TABLE p (a numeric(10,2) NOT NULL, b integer NOT NULL, owner text NOT NULL, PRIMARY KEY (a, b));
       CREATE TABLE c (id integer PRIMARY KEY, a numeric(10,2) NOT NULL, b integer NOT NULL, FOREIGN KEY (a, b) REFERENCES p (a, b));
       INSERT INTO p VALUES (19.987, 1, 'ada'), (19.99, 2, 'ada'), (19.987, 2, 'ben');
       INSERT INTO c VALUES (1, 19.987, 1);`,
    );
    const result = await said({ p: eq('owner', 'ada'), c: true }, (tx) => tx.update({ table: 'c', key: { id: 1 }, values: { b: 2 } }));
    refusedAsKey(result, /"p"\.a/, 'composite');
    assert.deepEqual(plain(db.prepare('SELECT b FROM c').all()), [{ b: 1 }]);
  });

  test('a scoped insert with a numeric(10,2) key is refused before its row is read back by a scaled key', async (t) => {
    const { db, said } = await fixture(
      t,
      `CREATE TABLE p (k numeric(10,2) PRIMARY KEY, owner text NOT NULL); INSERT INTO p VALUES (19.99, 'ada');`,
    );
    refusedAsKey(
      await said({ p: eq('owner', 'ada') }, (tx) => tx.insert({ table: 'p', values: { k: 19.987, owner: 'ben' } })),
      /"p"\.k/,
      'insert',
    );
    assert.deepEqual({ ...db.prepare('SELECT count(*) AS n FROM p').get() }, { n: 1 });
  });

  test('a trigger keyed by a numeric(10,2) column is refused, written or read: no oracle on the hidden row', async (t) => {
    const { db, said } = await fixture(
      t,
      `CREATE TABLE h (k numeric(10,2) PRIMARY KEY, owner text NOT NULL, v integer NOT NULL DEFAULT 0, note text);
       CREATE TABLE s (id integer PRIMARY KEY, ref numeric(10,2) NOT NULL, memo text);
       INSERT INTO h VALUES (19.99, 'ada', 0, 'mine'), (19.987, 'ben', 0, 'secret');
       INSERT INTO s VALUES (1, 19.987, 'x');
       CREATE TRIGGER bump AFTER UPDATE OF memo ON s BEGIN UPDATE h SET v = v + 1 WHERE k = NEW.ref; END;`,
    );
    const update = (tx: WriteTransaction) => tx.update({ table: 's', key: { id: 1 }, values: { memo: 'y' } });
    refusedAsKey(await said({ h: eq('owner', 'ada'), s: true }, update, named('s', 'bump')), /"h"\.k/, 'write');
    assert.deepEqual(
      db
        .prepare('SELECT owner, v FROM h ORDER BY owner')
        .all()
        .map((row) => [row.owner, row.v]),
      [
        ['ada', 0],
        ['ben', 0],
      ],
    );
    db.exec(`DROP TRIGGER bump;
      CREATE TRIGGER peek BEFORE UPDATE OF memo ON s BEGIN
        SELECT RAISE(ABORT, 'it is secret') WHERE (SELECT note FROM h WHERE k = NEW.ref) = 'secret'; END;`);
    // Whatever Ben's note says, the answer is the same refusal, for the key's type.
    const secret = await said({ h: eq('owner', 'ada'), s: true }, update, named('s', 'peek'));
    db.exec(`UPDATE h SET note = 'public' WHERE owner = 'ben'`);
    const open = await said({ h: eq('owner', 'ada'), s: true }, update, named('s', 'peek'));
    refusedAsKey(secret, /"h"\.k/, 'read');
    assert.equal(secret.said, open.said);
    assert.equal(secret.cause, open.cause);
  });

  test('what a person reads of a scoped insert still says a decimal with its scale', async (t) => {
    const { adapter } = await fixture(t, `CREATE TABLE p (id INTEGER PRIMARY KEY, price numeric(10,2), tenant TEXT NOT NULL);`);
    const result = await adapter.scopeTransaction(ofA('p'), (tx) => tx.insert({ table: 'p', values: { id: 1, price: 19.9, tenant: 'a' } }));
    assert.deepEqual(result.key, { id: 1 });
    assert.equal(result.row?.price, '19.90');
  });
});

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'scoped_key_types';

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: LIVE, statement_timeout: 10_000 });
  await created.connect();
  return created;
}

describe('PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  const reset = async (sql: string) => {
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await control.query(`CREATE SCHEMA ${SCHEMA}; ${sql}`);
  };
  const rows = async (sql: string) => (await control.query(sql)).rows as Array<Record<string, unknown>>;
  before(async () => {
    control = await client();
  });
  after(async () => {
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await control.end();
  });
  const at = (table: string) => `${SCHEMA}.${table}`;
  const ofA = (...tables: string[]): RowScope => Object.fromEntries(tables.map((table) => [at(table), eq('tenant', 'a')]));
  /** 'committed', or the refusal and its cause; `url` connects as another session would (a role's settings). */
  const said = async (
    scope: RowScope,
    operation: (tx: WriteTransaction) => Promise<unknown>,
    accepted?: TriggerAcceptance,
    url: string = LIVE!,
  ): Promise<Said> => {
    const adapter = new PostgresAdapter(url, 'key-types', [SCHEMA]);
    try {
      return await outcome(() => adapter.scopeTransaction(scope, operation, accepted));
    } finally {
      await adapter.close();
    }
  };

  /* Each allowed type as a key and a reference to it: the visible row is found and the hidden one refused, as a
     reference and as a write's own row. A boolean is a reference here alone: a key is named by a text or a number. */
  const ALLOWED: Array<{ type: string; visible: string; hidden: string; pre?: string; referenceOnly?: true }> = [
    { type: 'text', visible: 'a1', hidden: 'b1' },
    { type: 'varchar(10)', visible: 'a1', hidden: 'b1' },
    { type: 'char(3)', visible: 'a1', hidden: 'b1' },
    { type: 'name', visible: 'a1', hidden: 'b1' },
    { type: 'smallint', visible: '1', hidden: '2' },
    { type: 'integer', visible: '1', hidden: '2' },
    { type: 'bigint', visible: '9007199254740993', hidden: '9007199254740992' },
    { type: 'numeric', visible: '12345678901234567.89', hidden: '12345678901234567.8900001' },
    { type: 'numeric(10,2)', visible: '19.99', hidden: '19.98' },
    { type: 'uuid', visible: '00000000-0000-0000-0000-00000000000a', hidden: '00000000-0000-0000-0000-00000000000b' },
    { type: 'date', visible: '2026-01-02', hidden: '2026-02-01' },
    { type: 'boolean', visible: 'true', hidden: 'false', referenceOnly: true },
    { type: `${SCHEMA}.mood`, visible: 'calm', hidden: 'cross', pre: `CREATE TYPE ${SCHEMA}.mood AS ENUM ('calm', 'cross')` },
    { type: `${SCHEMA}.ident`, visible: '7', hidden: '8', pre: `CREATE DOMAIN ${SCHEMA}.ident AS bigint` },
  ];
  for (const { type, visible, hidden, pre, referenceOnly } of ALLOWED)
    test(`an allowed key, ${type}: the visible row is found, the hidden one refused`, async () => {
      await reset(`${pre ? `${pre};` : ''}
        CREATE TABLE ${at('p')} (k ${type} PRIMARY KEY, tenant text NOT NULL, note text);
        CREATE TABLE ${at('c')} (id int PRIMARY KEY, tenant text NOT NULL, ref ${type} REFERENCES ${at('p')} (k));`);
      await control.query(`INSERT INTO ${at('p')} VALUES ($1, 'a'), ($2, 'b')`, [visible, hidden]);
      const insert = (id: number, ref: string) => (tx: WriteTransaction) => tx.insert({ table: at('c'), values: { id, tenant: 'a', ref } });
      const found = await said(ofA('p', 'c'), insert(1, visible));
      assert.equal(found.said, 'committed', found.cause);
      const refused = await said(ofA('p', 'c'), insert(2, hidden));
      assert.equal(refused.said, REFUSED);
      assert.doesNotMatch(refused.cause, NOT_A_KEY);
      if (referenceOnly) return;
      const note = (k: string) => (tx: WriteTransaction) => tx.update({ table: at('p'), key: { k }, values: { note: 'seen' } });
      const edited = await said(ofA('p', 'c'), note(visible));
      assert.equal(edited.said, 'committed', edited.cause);
      assert.equal((await said(ofA('p', 'c'), note(hidden))).said, REFUSED);
      assert.deepEqual(await rows(`SELECT tenant, note FROM ${at('p')} ORDER BY tenant`), [
        { tenant: 'a', note: 'seen' },
        { tenant: 'b', note: null },
      ]);
    });

  const REFUSED_TYPES: Array<{ type: string; value: string; pre?: string }> = [
    { type: 'jsonb', value: '1' },
    { type: 'real', value: '1.5' },
    { type: 'double precision', value: '1.5' },
    { type: 'timestamp', value: '2026-01-01 10:00' },
    { type: 'timestamptz', value: '2026-01-01 10:00+00' },
    { type: 'time', value: '10:00' },
    { type: 'timetz', value: '10:00+00' },
    { type: 'interval', value: '1 day' },
    { type: 'money', value: '1.00' },
    { type: 'bytea', value: '\\x01' },
    { type: 'inet', value: '10.0.0.1' },
    { type: 'cidr', value: '10.0.0.0/8' },
    { type: 'macaddr', value: '08:00:2b:01:02:03' },
    { type: 'int[]', value: '{1,2}' },
    { type: 'text[]', value: '{a}' },
    { type: 'varchar(3)[]', value: '{ab}' },
    { type: 'int4range', value: '[1,2)' },
    { type: '"char"', value: 'a' },
    { type: 'bit varying(8)', value: '101' },
    { type: `${SCHEMA}.pair`, value: '(1,a)', pre: `CREATE TYPE ${SCHEMA}.pair AS (n int, s text)` },
    { type: `${SCHEMA}.doc`, value: '{"a": 1}', pre: `CREATE DOMAIN ${SCHEMA}.doc AS jsonb` },
  ];
  for (const { type, value, pre } of REFUSED_TYPES)
    test(`a key of type ${type} is refused as a key, as a reference to it and as a write's own row`, async () => {
      await reset(`${pre ? `${pre};` : ''}
        CREATE TABLE ${at('p')} (k ${type} PRIMARY KEY, tenant text NOT NULL, note text);
        CREATE TABLE ${at('c')} (id int PRIMARY KEY, tenant text NOT NULL, ref ${type} REFERENCES ${at('p')} (k));`);
      await control.query(`INSERT INTO ${at('p')} VALUES ($1, 'a')`, [value]);
      const column = new RegExp(`"${SCHEMA}\\.p"\\.k is of type`);
      refusedAsKey(
        await said(ofA('p', 'c'), (tx) => tx.insert({ table: at('c'), values: { id: 1, tenant: 'a', ref: value } })),
        column,
        type,
      );
      refusedAsKey(
        await said(ofA('p', 'c'), (tx) => tx.update({ table: at('p'), key: { k: value }, values: { note: 'x' } })),
        column,
        type,
      );
      refusedAsKey(await said(ofA('p', 'c'), (tx) => tx.insert({ table: at('p'), values: { k: value, tenant: 'a' } })), column, type);
      assert.deepEqual(await rows(`SELECT count(*)::int AS n FROM ${at('c')}`), [{ n: 0 }]);
      assert.deepEqual(await rows(`SELECT note FROM ${at('p')}`), [{ note: null }]);
    });

  test('a domain over jsonb is named with the type it is over', async () => {
    await reset(`CREATE DOMAIN ${SCHEMA}.doc AS jsonb; CREATE TABLE ${at('p')} (k ${SCHEMA}.doc PRIMARY KEY, tenant text NOT NULL)`);
    const result = await said(ofA('p'), (tx) => tx.insert({ table: at('p'), values: { k: '1', tenant: 'a' } }));
    assert.match(result.cause, /is of type scoped_key_types\.doc \(a domain over jsonb\)/);
  });

  /* The review's reproducers. A trigger keyed by jsonb: the proof read the stored "123" (a string) through the driver as
     the number 123, proved Ada's visible 123, and the trigger wrote Ben's hidden "123". */
  for (const kind of ['update', 'delete'] as const)
    test(`a trigger whose ${kind} is keyed by a jsonb column is refused for the key's type`, async () => {
      await reset(`CREATE TABLE ${at('h')} (k jsonb PRIMARY KEY, owner text NOT NULL, v integer NOT NULL DEFAULT 0);
        CREATE TABLE ${at('s')} (id integer PRIMARY KEY, ref jsonb NOT NULL, note text);
        INSERT INTO ${at('h')} VALUES ('123', 'ada', 0), ('"123"', 'ben', 0), ('9007199254740992', 'ada', 0), ('9007199254740993', 'ben', 0);
        INSERT INTO ${at('s')} VALUES (1, '"123"', 'x'), (2, '9007199254740993', 'x');
        CREATE FUNCTION ${at('f')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          ${kind === 'update' ? `UPDATE ${at('h')} SET v = v + 1 WHERE k = NEW.ref; RETURN NULL;` : `DELETE FROM ${at('h')} WHERE k = OLD.ref; RETURN NULL;`} END $$;
        CREATE TRIGGER t AFTER ${kind === 'update' ? 'UPDATE OF note' : 'DELETE'} ON ${at('s')} FOR EACH ROW EXECUTE FUNCTION ${at('f')}();`);
      for (const id of [1, 2]) {
        const result = await said(
          { [at('s')]: true, [at('h')]: eq('owner', 'ada') },
          (tx) =>
            kind === 'update'
              ? tx.update({ table: at('s'), key: { id }, values: { note: 'y' } })
              : tx.remove({ table: at('s'), key: { id } }),
          named(at('s'), 't'),
        );
        refusedAsKey(result, /"h"\.k is of type jsonb/, `${kind} ${id}`);
      }
      assert.deepEqual(await rows(`SELECT k::text, v FROM ${at('h')} WHERE owner = 'ben' ORDER BY k::text`), [
        { k: '"123"', v: 0 },
        { k: '9007199254740993', v: 0 },
      ]);
    });

  /* A trigger keyed by a unique text column reaches a table whose primary key is jsonb or a float: the proof proved
     Ada's row by `u`, and the change it told live sync and history named it by a lossy reading of its key, which
     named Ben's hidden row (9007199254740993 read as ...992, 0.30000000000000004 as 0.3 elsewhere). A table an
     effect reaches takes the primary-key gate a write's own target does, from the catalog. */
  for (const [type, ada, ben] of [
    ['jsonb', `'9007199254740993'`, `'9007199254740992'`],
    ['float8', '0.30000000000000004', '0.3'],
  ] as const)
    test(`a trigger effect reaching a table whose primary key is ${type} is refused, whatever key it uses`, async () => {
      await reset(`CREATE TABLE ${at('h')} (k ${type} PRIMARY KEY, u text UNIQUE NOT NULL, owner text NOT NULL, v int NOT NULL DEFAULT 0);
        CREATE TABLE ${at('s')} (id int PRIMARY KEY, ref text NOT NULL, note text);
        INSERT INTO ${at('h')} VALUES (${ada}, 'x', 'ada', 0), (${ben}, 'y', 'ben', 0);
        INSERT INTO ${at('s')} VALUES (1, 'x', 'n');
        CREATE FUNCTION ${at('f')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE ${at('h')} SET v = v + 1 WHERE u = NEW.ref; RETURN NULL; END $$;
        CREATE TRIGGER t AFTER UPDATE OF note ON ${at('s')} FOR EACH ROW EXECUTE FUNCTION ${at('f')}();`);
      const changes: unknown[] = [];
      const result = await said(
        { [at('s')]: true, [at('h')]: eq('owner', 'ada') },
        (tx) => tx.update({ table: at('s'), key: { id: 1 }, values: { note: 'm' } }),
        { ...named(at('s'), 't'), changed: (change) => void changes.push(change) },
      );
      refusedAsKey(
        result,
        new RegExp(`whose primary key cannot name its rows: "h"\\.k is of type ${type === 'float8' ? 'double precision' : type}`),
        type,
      );
      assert.deepEqual(changes, []);
      assert.deepEqual(await rows(`SELECT owner, v FROM ${at('h')} ORDER BY owner`), [
        { owner: 'ada', v: 0 },
        { owner: 'ben', v: 0 },
      ]);
    });

  test('a jsonb primary key is refused before the insert is read back by the driver reading of it', async () => {
    await reset(`CREATE TABLE ${at('j')} (k jsonb PRIMARY KEY, owner text NOT NULL);
      INSERT INTO ${at('j')} VALUES ('123', 'ada'), ('9007199254740992', 'ada');`);
    for (const k of ['"123"', '9007199254740993'])
      refusedAsKey(
        await said({ [at('j')]: eq('owner', 'ada') }, (tx) => tx.insert({ table: at('j'), values: { k, owner: 'ben' } })),
        /"scoped_key_types\.j"\.k is of type jsonb/,
        k,
      );
    assert.deepEqual(await rows(`SELECT count(*)::int AS n FROM ${at('j')}`), [{ n: 2 }]);
  });

  /* A composite reference, one part set by an update, the other bound as its stored text: under a role's or a
     database's settings that text named another row (a float under extra_float_digits = 0, a timestamptz under
     DateStyle SQL, DMY and another TimeZone). Both are refused as keys; a date, which is allowed, reads back whatever
     the session's DateStyle, its text pinned to ISO for the transaction. */
  const withOptions = (options: string) => `${LIVE}${LIVE!.includes('?') ? '&' : '?'}options=${encodeURIComponent(options)}`;
  for (const { type, hidden, visible, options } of [
    { type: 'float8', hidden: '(0.1::float8 + 0.2::float8)', visible: '0.3', options: '-c extra_float_digits=0' },
    {
      type: 'timestamptz',
      hidden: `'2026-01-01 10:00+05:30'`,
      visible: `'2026-01-01 13:30+05:30'`,
      options: '-c DateStyle=SQL,DMY -c TimeZone=Asia/Kolkata',
    },
  ])
    test(`a composite reference of ${type}, bound as its stored text under the session's settings, is refused for its type`, async () => {
      await reset(`CREATE TABLE ${at('p')} (a ${type} NOT NULL, b integer NOT NULL, owner text NOT NULL, PRIMARY KEY (a, b));
        CREATE TABLE ${at('c')} (id integer PRIMARY KEY, a ${type} NOT NULL, b integer NOT NULL, FOREIGN KEY (a, b) REFERENCES ${at('p')} (a, b));
        INSERT INTO ${at('p')} VALUES (${hidden}, 1, 'ada'), (${visible}, 2, 'ada'), (${hidden}, 2, 'ben');
        INSERT INTO ${at('c')} VALUES (1, ${hidden}, 1);`);
      const result = await said(
        { [at('p')]: eq('owner', 'ada'), [at('c')]: true },
        (tx) => tx.update({ table: at('c'), key: { id: 1 }, values: { b: 2 } }),
        undefined,
        withOptions(options),
      );
      refusedAsKey(result, new RegExp(`"${SCHEMA}\\.p"\\.a is of type`), type);
      assert.deepEqual(await rows(`SELECT b FROM ${at('c')}`), [{ b: 1 }]);
    });

  test('a date reference bound as its stored text reads back under any DateStyle the session was given', async () => {
    await reset(`CREATE TABLE ${at('p')} (a date NOT NULL, b integer NOT NULL, owner text NOT NULL, PRIMARY KEY (a, b));
      CREATE TABLE ${at('c')} (id integer PRIMARY KEY, a date NOT NULL, b integer NOT NULL, FOREIGN KEY (a, b) REFERENCES ${at('p')} (a, b));
      INSERT INTO ${at('p')} VALUES ('2026-01-02', 1, 'ada'), ('2026-01-02', 2, 'ada'), ('2026-01-02', 3, 'ben');
      INSERT INTO ${at('c')} VALUES (1, '2026-01-02', 1);`);
    for (const style of ['SQL,YMD', 'SQL,DMY', 'Postgres,YMD', 'German']) {
      const url = withOptions(`-c DateStyle=${style}`);
      const retag = (b: number) => (tx: WriteTransaction) => tx.update({ table: at('c'), key: { id: 1 }, values: { b } });
      const hidden = await said({ [at('p')]: eq('owner', 'ada'), [at('c')]: true }, retag(3), undefined, url);
      assert.equal(hidden.said, REFUSED, style);
      assert.doesNotMatch(hidden.cause, NOT_A_KEY, style);
      const visible = await said({ [at('p')]: eq('owner', 'ada'), [at('c')]: true }, retag(2), undefined, url);
      assert.equal(visible.said, 'committed', `${style}: ${visible.cause}`);
      await control.query(`UPDATE ${at('c')} SET b = 1`);
    }
  });
});
