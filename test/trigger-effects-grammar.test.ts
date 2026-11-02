/**
 * The keyed-effect grammar and its resolution against a catalog
 * (docs/trigger-effects.md): what a trigger an App may name does, read from
 * its definition, and why one is refused before any write runs. The writes
 * themselves are held in trigger-effects.test.ts.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  postgresTriggersByTable,
  type PostgresAssignment,
  type PostgresTriggerAnalyzer,
  type PostgresTriggerRow,
} from '../packages/engine/src/adapters/scoped/postgresTriggers.js';
import type { ScopeTrigger } from '../packages/engine/src/adapters/scoped/scopeTriggers.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { readSqliteTrigger } from '../packages/engine/src/adapters/scoped/sqliteTriggers.js';
import { resolveTriggerEffects } from '../packages/engine/src/adapters/scoped/triggerEffects.js';

const sqlite = (sql: string) => readSqliteTrigger('t', sql, new Set());

test('SQLite: a keyed update, insert, delete and read are read as effects, and the digest ignores spacing, case and comments', () => {
  const post = sqlite(
    `CREATE TRIGGER post AFTER INSERT ON ledger_entry BEGIN
       UPDATE account SET posted_minor = posted_minor + NEW.amount, note = NEW.memo WHERE id = NEW.account_id; END`,
  );
  assert.equal(post.validates, false);
  assert.equal(post.why, 'it writes rows');
  assert.deepEqual(post.effects, [
    {
      kind: 'update',
      table: 'account',
      key: { id: { row: 'new', column: 'account_id' } },
      values: { posted_minor: { expression: true }, note: { row: 'new', column: 'memo' } },
    },
  ]);
  assert.deepEqual(
    sqlite(`CREATE TRIGGER a AFTER UPDATE ON e BEGIN INSERT INTO history (entry_id, what, n) VALUES (NEW.id, 'changed', 3); END`).effects,
    [
      {
        kind: 'insert',
        table: 'history',
        values: { entry_id: { row: 'new', column: 'id' }, what: { literal: 'changed' }, n: { literal: 3 } },
      },
    ],
  );
  assert.deepEqual(sqlite(`CREATE TRIGGER a AFTER DELETE ON e BEGIN DELETE FROM shadow WHERE OLD.id = shadow.entry_id; END`).effects, [
    { kind: 'delete', table: 'shadow', key: { entry_id: { row: 'old', column: 'id' } } },
  ]);
  assert.deepEqual(
    sqlite(
      `CREATE TRIGGER a BEFORE INSERT ON e BEGIN
         SELECT RAISE(ABORT, 'closed') WHERE (SELECT status FROM account WHERE id = NEW.account_id) = 'closed'; END`,
    ).effects,
    [{ kind: 'read', table: 'account', key: { id: { row: 'new', column: 'account_id' } }, values: { status: { literal: null } } }],
  );
  const a = sqlite(`CREATE TRIGGER a AFTER DELETE ON e BEGIN DELETE FROM s WHERE k = OLD.id; END`);
  const b = sqlite(`create trigger a after delete on e begin -- a comment
    delete   from s where k = old.id; end`);
  assert.match(a.digest!, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, sqlite(`CREATE TRIGGER a AFTER DELETE ON e BEGIN DELETE FROM s WHERE k = NEW.id; END`).digest);
});

test('SQLite: a write by a constant, a non-key predicate, or anything past one keyed row has no effects (adversarial 3)', () => {
  for (const body of [
    `UPDATE account SET x = 1 WHERE id = 2;`,
    `UPDATE account SET x = 1 WHERE status = 'open';`,
    `UPDATE account SET x = 1 WHERE id = NEW.a OR id = NEW.b;`,
    `UPDATE account SET x = 1;`,
    `UPDATE OR REPLACE account SET x = 1 WHERE id = NEW.a;`,
    `UPDATE main.account SET x = 1 WHERE id = NEW.a;`,
    `UPDATE account SET x = (SELECT y FROM other WHERE id = NEW.a) WHERE id = NEW.a;`,
    `UPDATE account SET x = 1 FROM other WHERE account.id = NEW.a;`,
    `UPDATE account SET x = 1 WHERE id = NEW.a RETURNING *;`,
    `UPDATE account SET x = 1 WHERE id = NEW.a LIMIT 1;`,
    `INSERT INTO log (a) VALUES (NEW.a), (NEW.b);`,
    `INSERT INTO log (a) SELECT NEW.a;`,
    `INSERT OR REPLACE INTO log (a) VALUES (NEW.a);`,
    `INSERT INTO log (a) VALUES (NEW.a) ON CONFLICT DO NOTHING;`,
    `INSERT INTO log DEFAULT VALUES;`,
    `REPLACE INTO log (a) VALUES (NEW.a);`,
    `DELETE FROM log;`,
    `DELETE FROM log WHERE a > OLD.a;`,
    `SELECT RAISE(ABORT, 'x') WHERE (SELECT count(*) FROM log WHERE a = NEW.a) > 0;`,
    `SELECT RAISE(ABORT, 'x') WHERE EXISTS (SELECT 1 FROM log WHERE a = NEW.a);`,
    `SELECT RAISE(ABORT, 'x') WHERE (SELECT a FROM log WHERE a = 5) > 0;`,
    `SELECT RAISE(ABORT, 'x') WHERE (SELECT a FROM log, other WHERE a = NEW.a) > 0;`,
    `SELECT RAISE(ABORT, 'x') WHERE (SELECT a FROM log WHERE a = NEW.a ORDER BY 1) > 0;`,
  ]) {
    const read = sqlite(`CREATE TRIGGER t AFTER INSERT ON e BEGIN ${body} END`);
    assert.equal(read.validates, false, body);
    assert.equal(read.effects, undefined, body);
  }
});

test('SQLite: effects are refused where the definition leaves plain SQL, though it parses', () => {
  const nbsp = sqlite(`CREATE TRIGGER t AFTER INSERT ON e BEGIN UPDATE account SET x = 1 WHERE id = NEW.a; END`);
  // U+00A0 is space to JavaScript's \s and part of a name to SQLite: whatever the tokenizer made of it, no effect is accepted.
  assert.ok(!nbsp.effects || nbsp.unaccepted, JSON.stringify(nbsp));
  const unicode = sqlite(`CREATE TRIGGER t AFTER INSERT ON e BEGIN INSERT INTO log (a) VALUES ('héllo'); END`);
  assert.equal(unicode.unaccepted, undefined, 'non-ASCII inside a literal is plain');
});

/** A database with the field report's ledger shape, and what its writer's catalog makes of each trigger. */
function catalog(triggers: string, judged = true): Map<string, ScopeTrigger> {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE customer (id INTEGER PRIMARY KEY, owner TEXT NOT NULL);
    CREATE TABLE account (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), posted_minor INTEGER NOT NULL DEFAULT 0, status TEXT);
    CREATE TABLE ledger_entry (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), amount INTEGER NOT NULL);
    CREATE TABLE history (id INTEGER PRIMARY KEY, entry_id INTEGER, what TEXT);
    CREATE TABLE tally (account_id INTEGER, n INTEGER);
    CREATE VIEW recent AS SELECT * FROM history;
    ${triggers}`);
  try {
    const read = readSqliteScopeCatalog(db, judged ? resolveTriggerEffects : undefined);
    return new Map([...(read.triggered ?? new Map()).values()].flat().map((trigger) => [trigger.name, trigger]));
  } finally {
    db.close();
  }
}

test('SQLite: the catalog resolves each effect to a table and its key, or says why it cannot be accepted (adversarial 3, 6)', () => {
  const triggers = catalog(`
    CREATE TRIGGER post AFTER INSERT ON ledger_entry BEGIN UPDATE ACCOUNT SET Posted_Minor = posted_minor + NEW.amount WHERE ID = NEW.Account_Id; END;
    CREATE TRIGGER audit AFTER UPDATE ON ledger_entry BEGIN INSERT INTO history (entry_id, what) VALUES (NEW.id, 'changed'); END;
    CREATE TRIGGER by_owner AFTER DELETE ON ledger_entry BEGIN UPDATE account SET status = 'x' WHERE customer_id = OLD.account_id; END;
    CREATE TRIGGER rekey AFTER INSERT ON history BEGIN UPDATE account SET id = 9 WHERE id = NEW.entry_id; END;
    CREATE TRIGGER into_view AFTER UPDATE ON history BEGIN INSERT INTO recent (what) VALUES ('x'); END;
    CREATE TRIGGER nowhere AFTER DELETE ON history BEGIN INSERT INTO missing (a) VALUES (1); END;
    CREATE TRIGGER no_key AFTER INSERT ON customer BEGIN UPDATE tally SET n = 1 WHERE account_id = NEW.id; END;
    CREATE TRIGGER own AFTER UPDATE OF owner ON customer BEGIN UPDATE customer SET owner = 'x' WHERE id = NEW.id; END;
  `);
  const post = triggers.get('post')!;
  assert.equal(post.unaccepted, undefined);
  assert.equal(post.depth, 1);
  assert.deepEqual(post.effects, [
    {
      kind: 'update',
      table: 'account',
      key: { id: { row: 'new', column: 'account_id' } },
      values: { posted_minor: { expression: true } },
    },
  ]);
  // `audit` inserts into history, whose INSERT trigger `rekey` is refused: the chain is.
  assert.match(triggers.get('audit')!.unaccepted!, /fires "rekey", it changes the key of "account"/);
  assert.match(triggers.get('by_owner')!.unaccepted!, /is not by the primary key of it/);
  assert.match(triggers.get('rekey')!.unaccepted!, /changes the key/);
  assert.match(triggers.get('into_view')!.unaccepted!, /"recent", which a scoped write cannot reach/);
  assert.match(triggers.get('nowhere')!.unaccepted!, /"missing", which a scoped write cannot reach/);
  assert.match(triggers.get('no_key')!.unaccepted!, /not by the primary key/);
  assert.match(triggers.get('own')!.unaccepted!, /writes the table it fires on/);
  // A reader that did not load the judge accepts none of them.
  const unjudged = catalog(
    'CREATE TRIGGER post AFTER INSERT ON ledger_entry BEGIN UPDATE account SET status = NEW.id WHERE id = NEW.account_id; END;',
    false,
  );
  assert.equal(unjudged.get('post')!.unaccepted, 'its effects were not judged against the catalog');
});

test('SQLite: a chain is followed through what each write fires, and a cycle or a chain deeper than four is refused (adversarial 6)', () => {
  const chain = (n: number) =>
    Array.from({ length: n }, (_, i) => `CREATE TABLE c${i} (id INTEGER PRIMARY KEY, a INTEGER);`).join('\n') +
    Array.from(
      { length: n - 1 },
      (_, i) => `CREATE TRIGGER t${i} AFTER UPDATE ON c${i} BEGIN UPDATE c${i + 1} SET a = NEW.a WHERE id = NEW.id; END;`,
    ).join('\n');
  const four = catalog(chain(5));
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => [four.get(`t${i}`)!.depth, four.get(`t${i}`)!.unaccepted]),
    [
      [4, undefined],
      [3, undefined],
      [2, undefined],
      [1, undefined],
    ],
  );
  const five = catalog(chain(6));
  assert.match(five.get('t0')!.unaccepted!, /a chain of more than 4 triggers/);
  assert.equal(five.get('t1')!.depth, 4);
  const cycle = catalog(`
    CREATE TABLE p (id INTEGER PRIMARY KEY, a INTEGER);
    CREATE TABLE q (id INTEGER PRIMARY KEY, a INTEGER);
    CREATE TRIGGER pq AFTER UPDATE ON p BEGIN UPDATE q SET a = NEW.a WHERE id = NEW.id; END;
    CREATE TRIGGER qp AFTER UPDATE ON q BEGIN UPDATE p SET a = NEW.a WHERE id = NEW.id; END;`);
  assert.match(cycle.get('pq')!.unaccepted!, /fire it again/);
  assert.match(cycle.get('qp')!.unaccepted!, /fire it again/);
  // An effect table's trigger that writes by a non-key predicate refuses the trigger that reaches it.
  const third = catalog(`
    CREATE TABLE p (id INTEGER PRIMARY KEY, a INTEGER);
    CREATE TABLE q (id INTEGER PRIMARY KEY, a INTEGER);
    CREATE TABLE r (id INTEGER PRIMARY KEY, a INTEGER);
    CREATE TRIGGER pq AFTER UPDATE ON p BEGIN UPDATE q SET a = NEW.a WHERE id = NEW.id; END;
    CREATE TRIGGER qr AFTER UPDATE ON q BEGIN UPDATE r SET a = NEW.a; END;`);
  assert.match(third.get('pq')!.unaccepted!, /fires "qr", it writes rows/);
  // A validation-only trigger on the effect table does not count toward the chain.
  const validated = catalog(`
    CREATE TABLE p (id INTEGER PRIMARY KEY, a INTEGER);
    CREATE TABLE q (id INTEGER PRIMARY KEY, a INTEGER);
    CREATE TRIGGER pq AFTER UPDATE ON p BEGIN UPDATE q SET a = NEW.a WHERE id = NEW.id; END;
    CREATE TRIGGER qv BEFORE UPDATE ON q BEGIN SELECT RAISE(ABORT, 'neg') WHERE NEW.a < 0; END;`);
  assert.equal(validated.get('pq')!.depth, 1);
});

const row = (source: string, overrides: Partial<PostgresTriggerRow> = {}): PostgresTriggerRow => ({
  schema: 'public',
  table: 'ledger_entry',
  relation: 'public.ledger_entry',
  name: 'post',
  type: 1 | 4,
  columns: [],
  listed: 0,
  generated: false,
  constraint: false,
  transition: false,
  qual: '',
  language: 'plpgsql',
  kind: 'f',
  definer: false,
  configured: false,
  arguments: 0,
  source,
  version: '1:1',
  around: '',
  ...overrides,
});

/* A scalar subquery as PostgreSQL 16 stores it, cut to what the reader needs: one table, keyed by `=` (int4eq). */
const SUB =
  '{SUBLINK :subLinkType 4 :subselect {QUERY :commandType 1 :rtable ({RANGETBLENTRY :relkind r}) :jointree {FROMEXPR :fromlist ({RANGETBLREF :rtindex 1}) :quals {OPEXPR :opno 96 :opfuncid 65 :args ({VAR :varno 1} {VAR :varno 1 :varlevelsup 1})}} :targetList ({TARGETENTRY :expr {VAR :varno 1}})}}';
/** The view over the trigger's table twice, selecting one scalar subquery per `(SELECT` it was handed, and `extra`. */
const view = (sublinks: number, extra = '') =>
  `({QUERY :commandType 1 :rtable ({RANGETBLENTRY :relkind r} {RANGETBLENTRY :relkind r}) :jointree {FROMEXPR :fromlist ({RANGETBLREF :rtindex 1} {RANGETBLREF :rtindex 2}) :quals <>} :targetList (${Array.from({ length: sublinks }, () => `{TARGETENTRY :expr ${SUB}}`).join(' ')}${extra})})`;

/** PostgreSQL as a test says it answers: what it was handed, and `impure` of every function, operator and assignment. */
const analyzer = (options: { impure?: string[]; types?: number[]; extra?: string } = {}) => {
  const asked: Array<{ conditions: string[]; values?: string[] }> = [];
  const assigned: PostgresAssignment[][] = [];
  const said: PostgresTriggerAnalyzer & { asked: typeof asked; assigned: typeof assigned } = {
    asked,
    assigned,
    conditions: async (_relation, conditions, values) => {
      asked.push({ conditions: [...conditions], ...(values ? { values: [...values] } : {}) });
      const sublinks = [...conditions, ...(values ?? [])].join(' ').split('(SELECT ').length - 1;
      return { tree: view(sublinks, options.extra), boolean: true, ...(values ? { types: options.types ?? values.map(() => 20) } : {}) };
    },
    impure: async (_functions, _operators, _types, assignments = []) => {
      assigned.push([...assignments]);
      return new Set(options.impure ?? []);
    },
  };
  return said;
};
/** The trigger as read through `said`; null reads it with no analyzer at all. */
const pg = async (source: string, overrides: Partial<PostgresTriggerRow> = {}, said: PostgresTriggerAnalyzer | null = analyzer()) =>
  (await postgresTriggersByTable([row(source, overrides)], said ?? undefined)).get('public.ledger_entry')!.triggers[0];

test('PostgreSQL: keyed effects need a schema-qualified table; an unqualified one resolves through search_path (adversarial 9)', async () => {
  const said = analyzer();
  const post = await pg(
    `BEGIN
    UPDATE public.account SET posted_minor = posted_minor + NEW.amount, touched = CURRENT_TIMESTAMP WHERE id = NEW.account_id;
    INSERT INTO public.history (entry_id, what) VALUES (NEW.id, 'posted');
    IF (SELECT status FROM public.account WHERE id = NEW.account_id) = 'closed' THEN RAISE EXCEPTION 'closed'; END IF;
    RETURN NULL;
  END`,
    {},
    said,
  );
  assert.equal(post.validates, false);
  assert.equal(post.unaccepted, undefined);
  assert.deepEqual(post.effects, [
    {
      kind: 'update',
      table: 'public.account',
      key: { id: { row: 'new', column: 'account_id' } },
      values: { posted_minor: { expression: true }, touched: { expression: true } },
    },
    { kind: 'insert', table: 'public.history', values: { entry_id: { row: 'new', column: 'id' }, what: { literal: 'posted' } } },
    { kind: 'read', table: 'public.account', key: { id: { row: 'new', column: 'account_id' } }, values: { status: { literal: null } } },
  ]);
  // Every expression is PostgreSQL's to judge: a keyed read in its place, an update's key and values over its table.
  assert.deepEqual(said.asked, [
    {
      conditions: [
        '(SELECT true FROM ONLY public.account WHERE id = "new".account_id)',
        '(SELECT status FROM ONLY public.account WHERE id = "new".account_id) = NULL',
      ],
      values: [
        '(SELECT (posted_minor + "new".amount) FROM ONLY public.account)',
        '(SELECT ((NULL::pg_catalog.timestamptz)) FROM ONLY public.account)',
        '"new".id',
      ],
    },
    // Then each key equality alone, so that its tree says what the equality alone resolved to.
    {
      conditions: [
        '(SELECT true FROM ONLY public.account WHERE id = "new".account_id)',
        '(SELECT true FROM ONLY public.account WHERE id = "new".account_id)',
      ],
    },
  ]);
  // Each value but a bare literal is assigned by its type, as PostgreSQL said it.
  assert.deepEqual(said.assigned, [
    [
      { from: 20, relation: 'public.account', column: 'posted_minor' },
      { from: 20, relation: 'public.account', column: 'touched' },
      { from: 20, relation: 'public.history', column: 'entry_id' },
    ],
  ]);
  for (const source of [
    'BEGIN UPDATE account SET a = 1 WHERE id = NEW.account_id; RETURN NULL; END',
    'BEGIN INSERT INTO history (entry_id) VALUES (NEW.id); RETURN NULL; END',
    'BEGIN DELETE FROM shadow WHERE id = OLD.id; RETURN NULL; END',
    "BEGIN IF (SELECT status FROM account WHERE id = NEW.account_id) = 'x' THEN RAISE 'x'; END IF; RETURN NULL; END",
  ])
    assert.equal((await pg(source)).effects, undefined, source);
  // Pinning search_path with SET is refused too: pg_temp is searched first for tables unless named last.
  assert.equal(
    (await pg('BEGIN UPDATE public.account SET a = 1 WHERE id = NEW.account_id; RETURN NULL; END', { configured: true })).effects,
    undefined,
  );
});

test('PostgreSQL: a write by a constant, a non-key predicate, a function variable or past one keyed row has no effects (adversarial 3)', async () => {
  for (const body of [
    'UPDATE public.account SET a = 1 WHERE id = 2;',
    "UPDATE public.account SET a = 1 WHERE status = 'open';",
    'UPDATE public.account SET a = 1 WHERE id = NEW.a OR id = NEW.b;',
    'UPDATE public.account SET a = found WHERE id = NEW.a;',
    'UPDATE public.account SET a = tg_name WHERE id = NEW.a;',
    'UPDATE public.account SET a = (SELECT max(b) FROM public.other) WHERE id = NEW.a;',
    'UPDATE public.account SET a = 1 WHERE id = NEW.a RETURNING id;',
    'UPDATE public.account SET a = 1 FROM public.other WHERE id = NEW.a;',
    'UPDATE ONLY public.account SET a = 1 WHERE id = NEW.a;',
    'INSERT INTO public.log (a) VALUES (NEW.a), (NEW.b);',
    'INSERT INTO public.log (a) VALUES (NEW.a) ON CONFLICT DO NOTHING;',
    'INSERT INTO public.log (a) SELECT NEW.a;',
    'DELETE FROM public.log WHERE a > OLD.a;',
    'DELETE FROM public.log USING public.other WHERE log.a = OLD.a;',
  ]) {
    const read = await pg(`BEGIN ${body} RETURN NULL; END`);
    assert.equal(read.validates, false, body);
    assert.equal(read.effects, undefined, body);
  }
  // A function a value calls (`evil(NEW.a)`, `now()`) is PostgreSQL's to judge, with every operator and the casts
  // that assign each value: any one it does not prove pure, or a subquery more than the grammar wrote, refuses them.
  const keyed = 'BEGIN UPDATE public.account SET a = NEW.a + 1 WHERE id = NEW.id; RETURN NULL; END';
  assert.ok((await pg(keyed)).effects);
  const cases: Array<[PostgresTriggerAnalyzer | null, string]> = [
    [analyzer({ impure: ['o96'] }), 'an expression of it runs a function mistri cannot prove writes nothing'],
    [
      analyzer({ impure: ['c0'] }),
      "a value it writes is not of its column's type, and no cast mistri can prove writes nothing makes it one",
    ],
    [analyzer({ extra: ` {TARGETENTRY :expr ${SUB}}` }), 'it reads another table'],
    [analyzer({ types: [] }), 'PostgreSQL does not read an expression of it as a check of NEW and OLD alone'],
    [null, 'mistri could not have PostgreSQL read its conditions'],
  ];
  for (const [said, why] of cases) {
    const trigger = await pg(keyed, {}, said);
    assert.deepEqual([trigger.effects, trigger.why], [undefined, why]);
  }
  assert.equal((await pg(keyed, { definer: true })).effects, undefined);
  // The digest moves with the body, not with its spacing.
  assert.equal((await pg(keyed)).digest, (await pg(keyed.replace(/ /g, '\n  '))).digest);
  assert.notEqual((await pg(keyed)).digest, (await pg(keyed.replace('+ 1', '+ 2'))).digest);
  assert.notEqual((await pg(keyed)).digest, (await pg(keyed, { type: 1 | 16 })).digest, 'the events are part of the definition');
});
