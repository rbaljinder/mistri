/**
 * A field report: under a row policy, a table with any trigger
 * could not be written at all — "it has the trigger …, whose writes the
 * policy cannot bound" — though the write was an update of `status` and the
 * trigger a validation-only `BEFORE UPDATE OF posted_minor`. A trigger now
 * blocks only the writes that fire it, and none if it is proven to check
 * NEW and OLD and raise without writing or reading anything else
 * (scopeTriggers.ts). Each engine's grammar is held here, and SQLite's
 * scoped writer end to end; PostgreSQL's writer is held in
 * postgres-scoped-transactions.test.ts, against a live server.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Filter, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  plpgsqlConditions,
  postgresTriggersByTable,
  readPostgresTree,
  type PostgresConditions,
  type PostgresTriggerAnalyzer,
  type PostgresTriggerRow,
} from '../packages/engine/src/adapters/scoped/postgresTriggers.js';
import {
  blockingTriggers,
  blocksEveryWrite,
  sayBlocked,
  sayRuns,
  sayTriggers,
  type ScopeTrigger,
} from '../packages/engine/src/adapters/scoped/scopeTriggers.js';
import { readSqliteTrigger } from '../packages/engine/src/adapters/scoped/sqliteTriggers.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { isAuthorFault, refusalCause } from '../packages/engine/src/shared/refusal.js';

/** The field report's trigger, as written. */
const REPRODUCER = `CREATE TRIGGER example_validation_only
BEFORE UPDATE OF posted_minor ON account
WHEN NEW.posted_minor < 0
BEGIN
 SELECT RAISE(ABORT, 'Negative customer balance');
END`;

const sqlite = (sql: string, generated: Iterable<string> = []) => readSqliteTrigger('t', sql, new Set(generated));
/** A trigger without its digest, which authority.lock pins (trigger-effects.test.ts holds it). */
const bare = ({ digest: _digest, ...trigger }: ScopeTrigger) => trigger;

test('SQLite: the events and UPDATE OF columns are read from the trigger, and an unreadable one fires on every write', () => {
  assert.deepEqual(bare(sqlite(REPRODUCER)), { name: 't', events: ['update'], columns: ['posted_minor'], validates: true });
  assert.deepEqual(sqlite('CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END').events, ['insert']);
  assert.deepEqual(sqlite('CREATE TRIGGER t BEFORE DELETE ON a FOR EACH ROW BEGIN SELECT 1; END').events, ['delete']);
  const quoted = sqlite(`CREATE TEMP TRIGGER IF NOT EXISTS "a t" BEFORE UPDATE OF "Status", [x] ON main.a BEGIN SELECT 1; END;`);
  assert.deepEqual(quoted.columns, ['Status', 'x']);
  // No column list: every update fires it.
  assert.equal(sqlite('CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT 1; END').columns, undefined);
  // A generated column in the list is not trusted to fire only when set.
  assert.equal(sqlite('CREATE TRIGGER t BEFORE UPDATE OF total ON a BEGIN SELECT 1; END', ['total']).columns, undefined);
  for (const unreadable of [
    null,
    'CREATE TRIGGER t BEFORE UPSERT ON a BEGIN SELECT 1; END',
    'CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT ?; END',
  ]) {
    const read = sqlite(unreadable as string);
    assert.equal(read.validates, false, String(unreadable));
    if (unreadable !== 'CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT ?; END')
      assert.deepEqual(read.events, ['insert', 'update', 'delete']);
  }
});

test('SQLite: validation-only is SELECT of RAISE(ABORT) and CASE over NEW, OLD and literals; anything else is not', () => {
  for (const sql of [
    REPRODUCER,
    "CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'x') WHERE NEW.x IS NOT DISTINCT FROM OLD.x AND length(NEW.name) = 0; END",
    "CREATE TRIGGER t BEFORE INSERT ON a WHEN CAST(NEW.x AS INTEGER) BETWEEN 1 AND 3 BEGIN SELECT CASE NEW.s WHEN 'a' THEN RAISE(ABORT, 'no') ELSE NULL END; END",
    "CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'one') WHERE NEW.a < 0; SELECT RAISE(ABORT, 'two') WHERE NEW.b NOT IN (1, 2); END",
  ])
    assert.equal(sqlite(sql).validates, true, sql);
  for (const [sql, why] of [
    ['CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO log VALUES (1); END', 'it writes rows'],
    // A malicious trigger dressed as validation: the INSERT hidden after the check.
    ["CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'x') WHERE NEW.x < 0; INSERT INTO b VALUES (1); END", 'it writes rows'],
    ["CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'x') WHERE NEW.x < 0; UPDATE b SET y = 1; END", 'it writes rows'],
    // A CASE whose condition is a subquery: whether it raises says whether a hidden row exists.
    [
      "CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT CASE WHEN (SELECT count(*) FROM b) > 0 THEN RAISE(ABORT, 'x') END; END",
      'it reads another table',
    ],
    ["CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'x') FROM b WHERE b.id = NEW.b_id; END", 'it reads another table'],
    ["CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'x') WHERE NEW.x IN (SELECT id FROM b); END", 'it reads another table'],
    ["CREATE TRIGGER t BEFORE UPDATE ON a WHEN EXISTS (SELECT 1 FROM b) BEGIN SELECT RAISE(ABORT, 'x'); END", 'it reads another table'],
  ] as const)
    assert.deepEqual([sqlite(sql).validates, sqlite(sql).why], [false, why], sql);
  for (const sql of [
    // RAISE(ROLLBACK) would end the scoped transaction from inside it; FAIL keeps a half-made change; IGNORE skips silently.
    "CREATE TRIGGER t BEFORE DELETE ON a BEGIN SELECT RAISE(ROLLBACK, 'x'); END",
    "CREATE TRIGGER t AFTER UPDATE ON a BEGIN SELECT RAISE(FAIL, 'x'); END",
    'CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(IGNORE); END',
    // A function that is not one of SQLite's own pure ones, a table name, a quoted name that may be a string, JSON.
    'CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT evil(NEW.x); END',
    'CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT other.x; END',
    'CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT "x"; END',
    "CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT NEW.doc -> '$.a'; END",
    'CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, NEW.secret); END',
  ])
    assert.equal(sqlite(sql).validates, false, sql);
});

/* A review of the trigger proof: after IN a bare word is a table to SQLite, and TRUE, FALSE, LIKE and GLOB are words
   it reads as names there — `NEW.note IN TRUE` reads a view named "true", and whether it raises says what a hidden
   row holds. And U+00A0 is whitespace to JavaScript's \s but an identifier character to SQLite. */
test('SQLite: IN takes only a parenthesized list, and the tokens are SQLite’s to the byte', () => {
  const update = (body: string, when = '') => sqlite(`CREATE TRIGGER t BEFORE UPDATE OF note ON account ${when}BEGIN ${body} END`);
  for (const target of ['TRUE', 'FALSE', 'LIKE', 'GLOB', 'log', 'main.log', 'TRUE(1)', '\u00a0', '"x"'])
    for (const read of [
      update(`SELECT RAISE(ABORT, 'taken') WHERE NEW.note IN ${target};`),
      update(`SELECT RAISE(ABORT, 'taken') WHERE NEW.note NOT IN ${target};`),
      update("SELECT RAISE(ABORT, 'taken');", `WHEN NEW.note IN ${target} `),
    ])
      assert.deepEqual([read.validates, read.why], [false, 'it reads another table'], target);
  // A list still is one, and SQLite's own whitespace still separates.
  assert.equal(update("SELECT RAISE(ABORT, 'x') WHERE NEW.note IN ('a', 'b') AND NEW.note NOT IN (TRUE);").validates, true);
  assert.equal(update("SELECT RAISE(ABORT, 'x')\v\fWHERE\tNEW.note\r\nIN ('a');").validates, true);
  // A character past ASCII outside a string literal: not proven, wherever it stands. Inside a literal it is text.
  for (const body of [
    "SELECT RAISE(ABORT, 'x') WHERE NEW.note IN\u00a0('a');",
    "SELECT RAISE(ABORT, 'x') WHERE NEW.né < 0;",
    'SELECT RAISE(ABORT, \'x\') WHERE NEW."né" < 0;',
    "SELECT RAISE(ABORT, 'x') WHERE NEW.note = 'a'　;",
  ])
    assert.equal(update(body).validates, false, body);
  assert.equal(update("SELECT RAISE(ABORT, 'déjà vu') WHERE NEW.note = '\u00a0';").validates, true);
});

test('SQLite: a trigger that is not validation-only is said to do what it does, and no more', () => {
  const why = (body: string) => sqlite(`CREATE TRIGGER t BEFORE UPDATE ON a BEGIN ${body} END`).why;
  // A subquery is refused as one; it is not said to read a table it does not name.
  assert.equal(why("SELECT RAISE(ABORT, 'x') WHERE NEW.n = (SELECT 1);"), 'it has a subquery, which can read another table');
  assert.equal(why("SELECT RAISE(ABORT, 'x') WHERE NEW.n IN log;"), 'it reads another table');
  assert.equal(why("SELECT RAISE(ABORT, 'x') WHERE NEW.n IN (SELECT id FROM log);"), 'it reads another table');
  // A function SQLite does not count as pure is named.
  assert.equal(why('SELECT changes();'), "it calls changes(), which is not one of SQLite's own pure functions");
  assert.equal(why("SELECT load_extension('x');"), "it calls load_extension(), which is not one of SQLite's own pure functions");
  // replace() is a string function, not REPLACE INTO.
  assert.equal(why("SELECT replace(NEW.s, 'a', 'b'), random();"), "it calls random(), which is not one of SQLite's own pure functions");
  assert.equal(why("SELECT RAISE(ROLLBACK, 'x');"), "its RAISE is not RAISE(ABORT, '…') with a literal message");
  assert.equal(why('SELECT RAISE(ABORT, NEW.secret);'), "its RAISE is not RAISE(ABORT, '…') with a literal message");
  // Where nothing more particular is true, it says where reading stopped: the quoted name.
  assert.equal(
    why('SELECT NEW.n WHERE NEW.n IS DISTINCT FROM OLD.n AND "x";'),
    'it does more than check the row it fires on: mistri does not read `"x"` at line 1, column 95',
  );
});

/* An external assessment: a validation-only trigger written with `!=` was refused while the same one with `<>` was
   accepted, and the refusal said only "its definition is not one mistri can read". */
test('SQLite: `!=` is read as `<>` is, and a definition mistri cannot read is refused naming the token and where it is', () => {
  const update = (where: string) =>
    sqlite(`CREATE TRIGGER t BEFORE UPDATE OF status ON item\nBEGIN\n  SELECT RAISE(ABORT, 'closed') WHERE ${where};\nEND`);
  const bang = update("NEW.status != 'closed'");
  const angle = update("NEW.status <> 'closed'");
  assert.deepEqual([bang.validates, bang.events, bang.columns], [true, ['update'], ['status']]);
  assert.deepEqual(bare(bang), bare(angle));
  assert.equal(update('NEW.a != OLD.a AND NEW.b <> OLD.b').validates, true);
  // Only `!=` begins with `!` to SQLite: a lone one is still refused, and so is a parameter.
  for (const [where, said] of [
    ["NEW.status ! 'closed'", 'its definition has `!` at line 3, column 50, which mistri does not read'],
    ['NEW.status = ?', 'its definition has `?` at line 3, column 52, which mistri does not read'],
    ['NEW.status = $who', 'its definition has `$` at line 3, column 52, which mistri does not read'],
  ]) {
    const read = update(where);
    assert.deepEqual([read.validates, read.events, read.why], [false, ['insert', 'update', 'delete'], said], where);
  }
  // A header it cannot follow names the word, and still fires on every write.
  const upsert = sqlite('CREATE TRIGGER t BEFORE UPSERT ON a BEGIN SELECT 1; END');
  assert.deepEqual(
    [upsert.events, upsert.why],
    [['insert', 'update', 'delete'], 'its definition has `UPSERT` at line 1, column 25, which mistri does not read'],
  );
  // An unterminated string is named where it opens.
  assert.equal(update("NEW.status = 'closed").why, "its definition has `'` at line 3, column 52, which mistri does not read");
});

const row = (overrides: Partial<PostgresTriggerRow> = {}): PostgresTriggerRow => ({
  schema: 'public',
  table: 'account',
  relation: 'public.account',
  name: 'example_validation_only',
  // ROW | BEFORE | UPDATE
  type: 1 | 2 | 16,
  columns: ['posted_minor'],
  listed: 1,
  generated: false,
  constraint: false,
  transition: false,
  qual: '',
  language: 'plpgsql',
  kind: 'f',
  definer: false,
  configured: false,
  arguments: 0,
  source: `
BEGIN
  IF NEW.posted_minor < 0 THEN
    RAISE EXCEPTION 'Negative customer balance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
`,
  version: '1:1',
  around: '',
  ...overrides,
});

/* A view's stored tree as PostgreSQL 16 writes it, cut to what the reader needs: one query over the table twice,
   selecting `NEW.posted_minor < 0` (int4lt, operator 97, function 66). */
const viewOf = (expression: string) =>
  `({QUERY :commandType 1 :rtable ({RANGETBLENTRY :alias {ALIAS :aliasname new :colnames <>} :eref {ALIAS :aliasname new :colnames ("id" "we\\ ird\\{SUBLINK")}} {RANGETBLENTRY :alias <>}) :rteperminfos ({RTEPERMISSIONINFO :relid 17121 :selectedCols (b 9 10)}) :jointree {FROMEXPR :fromlist ({RANGETBLREF :rtindex 1} {RANGETBLREF :rtindex 2}) :quals <>} :targetList ({TARGETENTRY :expr ${expression} :resno 1 :resname c0})})`;
const LESS =
  '{OPEXPR :opno 97 :opfuncid 66 :args ({VAR :varno 1 :varattno 2} {CONST :consttype 23 :constisnull false :constvalue 4 [ 0 0 0 0 0 0 0 0 ]})}';

/** PostgreSQL, as a test says it answers: `said` for every parse, `impure` for every function and operator asked of it. */
const analyzer = (
  said: PostgresConditions | null = { tree: viewOf(LESS), boolean: true },
  impure: string[] = [],
): PostgresTriggerAnalyzer & { asked: string[][] } => {
  const asked: string[][] = [];
  return {
    asked,
    conditions: async (_relation, conditions) => {
      asked.push([...conditions]);
      return said ?? undefined;
    },
    impure: async () => new Set(impure),
  };
};
const proven = async (overrides: Partial<PostgresTriggerRow> = {}, said = analyzer()) =>
  (await postgresTriggersByTable([row(overrides)], said)).get('public.account')!.triggers[0];
const UPDATE_ONLY = new Set(['NEW']);

test('PostgreSQL: events and columns from tgtype and tgattr, and validation-only proven of the body and of what PostgreSQL makes of its conditions', async () => {
  const said = analyzer();
  assert.deepEqual(bare(await proven({}, said)), {
    name: 'example_validation_only',
    events: ['update'],
    columns: ['posted_minor'],
    validates: true,
  });
  // The condition as PostgreSQL is handed it: NEW as the view's "new".
  assert.deepEqual(said.asked, [['"new".posted_minor < 0']]);
  // INSERT | UPDATE | DELETE, no column list: every write fires it; a body without conditions asks nothing.
  const none = analyzer();
  assert.deepEqual(bare(await proven({ type: 1 | 4 | 8 | 16, columns: [], listed: 0, source: 'BEGIN RETURN NULL; END' }, none)), {
    name: 'example_validation_only',
    events: ['insert', 'update', 'delete'],
    validates: true,
  });
  assert.deepEqual(none.asked, []);
  assert.equal((await proven({ generated: true })).columns, undefined);
  assert.equal((await proven({ columns: [], listed: 1 })).columns, undefined, 'a column the catalog could not name');
});

test('PostgreSQL: each condition is cut where PL/pgSQL cuts it, a literal as NULL and TG_OP as a NULL text', () => {
  const conditions = (source: string) => plpgsqlConditions(source, UPDATE_ONLY);
  assert.deepEqual(
    conditions(
      "BEGIN IF NEW.a IS DISTINCT FROM OLD.a AND TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'immutable'; ELSIF NEW.b NOT IN (1, 2.5) THEN RAISE 'b'; ELSE NULL; END IF; RETURN NEW; END;",
    ),
    ['"new".a IS DISTINCT FROM "old".a AND (NULL::pg_catalog.text) = NULL', '"new".b NOT IN ( 1 , 2.5 )'],
  );
  // A call is PostgreSQL's to resolve and judge, not refused by name.
  assert.deepEqual(conditions("BEGIN IF lower(NEW.\"A b\") = 'x' THEN RAISE 'x'; END IF; RETURN NEW; END"), [
    'lower ( "new"."A b" ) = NULL',
  ]);
  // PL/pgSQL takes a CASE's THEN for the IF's: in parentheses it is a condition, bare it is not one PL/pgSQL can run.
  assert.deepEqual(conditions("BEGIN IF (CASE WHEN NEW.a > 0 THEN NEW.b ELSE NEW.c END) < 0 THEN RAISE 'x'; END IF; RETURN NEW; END"), [
    '( CASE WHEN "new".a > 0 THEN "new".b ELSE "new".c END ) < 0',
  ]);
  assert.equal(conditions("BEGIN IF CASE WHEN NEW.a > 0 THEN NEW.b ELSE NEW.c END < 0 THEN RAISE 'x'; END IF; RETURN NEW; END"), undefined);
  // A line comment ends at either newline character, as PostgreSQL's does: the THEN after a CR is read.
  assert.deepEqual(conditions("BEGIN IF NEW.a < 0 -- note\rTHEN RAISE 'x'; END IF; RETURN NEW; END"), ['"new".a < 0']);
  // A character past ASCII inside a literal is the literal's.
  assert.deepEqual(conditions("BEGIN IF NEW.a = '\u00a0é' THEN RAISE 'x'; END IF; RETURN NEW; END"), ['"new".a = NULL']);
  for (const source of [
    // U+00A0 is a letter to PostgreSQL: a function named by it, called.
    "BEGIN IF \u00a0(NEW.a) THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF NEW.a <\u00a0lower(NEW.b) THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF NEW.a\u00a0< 0 THEN RAISE 'x'; END IF; RETURN NEW; END",
    // A `$` continues a name, or starts a parameter or a dollar quote.
    "BEGIN IF f$x(NEW.a) THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF $1 THEN RAISE 'x'; END IF; RETURN NEW; END",
    // A cast names a type whose input runs on the literal when PostgreSQL parses it.
    "BEGIN IF NEW.a::int < 0 THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF NEW.a = CAST('{zz}' AS text[]) THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF NEW.a[1] < 0 THEN RAISE 'x'; END IF; RETURN NEW; END",
    // Numbers whose reading varies by version, strings with rules of their own.
    "BEGIN IF NEW.a < 0x1F THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF NEW.a < 1_000 THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF NEW.a = E'x' THEN RAISE 'x'; END IF; RETURN NEW; END",
    // The row whole, a field of a column, a column PL/pgSQL's lexer would read as THEN, a qualified name.
    "BEGIN IF NEW IS NULL THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF NEW.a.b < 0 THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF NEW.then THEN RAISE 'x'; END IF; RETURN NEW; END",
    "BEGIN IF public.f(NEW.a) THEN RAISE 'x'; END IF; RETURN NEW; END",
    'DECLARE n int; BEGIN RETURN NEW; END',
    "BEGIN RAISE EXCEPTION 'x %', NEW.secret; RETURN NEW; END",
    "BEGIN RAISE NOTICE 'x'; RETURN NEW; END",
    "BEGIN IF NEW.a < 0 THEN RAISE 'x'; END IF; RETURN OLD; END",
    'BEGIN RETURN NEW; EXCEPTION WHEN others THEN RETURN NEW; END',
    'BEGIN RETURN $x$NEW$x$; END',
  ])
    assert.equal(conditions(source), undefined, JSON.stringify(source));
});

test('PostgreSQL: a stored tree is read as PostgreSQL reads it, a name in it never a node', () => {
  const tree = readPostgresTree(viewOf(LESS))!;
  assert.deepEqual([...tree.functions], [66]);
  assert.deepEqual([...tree.operators], [97]);
  assert.equal(tree.nodes.get('RANGETBLENTRY'), 2);
  // `"we\ ird\{SUBLINK"` is a column's name, escaped as outToken escapes it.
  assert.equal(tree.nodes.has('SUBLINK'), false);
  assert.equal(readPostgresTree('{OPEXPR :opno 97 :opfuncid'), undefined, 'cut short');
  assert.equal(readPostgresTree('{OPEXPR :opno x}'), undefined, 'an oid that is not one');
});

test('PostgreSQL: a stored tree names the domains it coerces to, its constants’ types and a row comparison’s operators', () => {
  const tree = readPostgresTree(
    '{COERCETODOMAIN :arg {CONST :consttype 25 :consttypmod -1 :constvalue <>} :resulttype 16500 :resulttypmod -1}',
  )!;
  assert.deepEqual([...tree.domains], [16500]);
  assert.deepEqual([...tree.constants], [25]);
  assert.deepEqual([...readPostgresTree('{ROWCOMPAREEXPR :rctype 1 :opnos (o 97 521) :largs <> :rargs <>}')!.operators], [97, 521]);
});

test('code that is not a trigger is named by what it is, and run rather than fired', () => {
  const check = {
    name: 'seen',
    kind: 'CHECK constraint',
    events: ['insert', 'update'],
    validates: false,
    why: 'it calls public.peek(text)',
  } as const;
  const trigger = { name: 'post', events: ['insert'], validates: false, why: 'it writes rows' } as const;
  assert.equal(sayTriggers([trigger]), 'the trigger "post" (it writes rows)');
  assert.equal(sayRuns([trigger]), 'fires');
  assert.equal(
    sayTriggers([trigger, check]),
    'the trigger "post" (it writes rows), the CHECK constraint "seen" (it calls public.peek(text))',
  );
  assert.equal(sayRuns([trigger, check]), 'runs');
});

test('PostgreSQL: a writing, reading or disguised trigger function is not validation-only', async () => {
  for (const [source, why] of [
    ['BEGIN IF NEW.a < 0 THEN INSERT INTO evil VALUES (1); END IF; RETURN NEW; END', 'it writes rows'],
    ["BEGIN IF NEW.a < 0 THEN RAISE 'x'; END IF; UPDATE other SET b = 1; RETURN NEW; END", 'it writes rows'],
    [
      "BEGIN IF EXISTS (SELECT 1 FROM public.other WHERE id = NEW.other_id) THEN RAISE 'x'; END IF; RETURN NEW; END",
      'it reads another table',
    ],
    ['BEGIN NEW.a := 1; RETURN NEW; END', 'it writes rows'],
    ['BEGIN PERFORM evil(); RETURN NEW; END', 'it writes rows'],
    ["BEGIN EXECUTE 'DELETE FROM other'; RETURN NEW; END", 'it writes rows'],
    // A backslash string ends where standard_conforming_strings says: refused rather than guessed.
    ["BEGIN RAISE EXCEPTION 'a\\' USING ERRCODE = '; INSERT INTO evil VALUES (1); --'; RETURN NEW; END", 'it writes rows'],
  ] as const) {
    const trigger = await proven({ source });
    assert.deepEqual([trigger.validates, trigger.why], [false, why], source);
  }
  // The function and the trigger, not only the body.
  for (const overrides of [
    { language: 'sql' },
    { definer: true },
    { configured: true },
    { type: 2 | 16 },
    { constraint: true },
    { transition: true },
  ])
    assert.equal((await proven(overrides)).validates, false, JSON.stringify(overrides));
  // What PostgreSQL makes of the conditions, each way it can fall short.
  const cases: Array<[ReturnType<typeof analyzer> | undefined, string]> = [
    [analyzer(null), 'PostgreSQL does not read a condition of it as a check of NEW and OLD alone'],
    [analyzer({ tree: viewOf(LESS), boolean: false }), 'a condition of it is not a boolean'],
    [analyzer({ tree: viewOf('{SUBLINK :subLinkType 0}'), boolean: true }), 'it reads another table'],
    [analyzer({ tree: viewOf('{COERCETODOMAIN :arg {VAR :varno 2}}'), boolean: true }), 'a condition of it does more than compare the row'],
    // A function of the database's that an implicit cast or an operator resolves to (`TRUE + 1.5`).
    [analyzer({ tree: viewOf(LESS), boolean: true }, ['f66']), 'a condition of it runs a function mistri cannot prove writes nothing'],
    [analyzer({ tree: viewOf(LESS), boolean: true }, ['o97']), 'a condition of it runs a function mistri cannot prove writes nothing'],
    [undefined, 'mistri could not have PostgreSQL read its conditions'],
  ];
  for (const [said, why] of cases) {
    const trigger = (await postgresTriggersByTable([row()], said)).get('public.account')!.triggers[0];
    assert.deepEqual([trigger.validates, trigger.why], [false, why]);
  }
  // A WHEN is judged from its stored tree, by the same rules.
  assert.equal((await proven({ qual: LESS })).validates, true);
  assert.equal((await proven({ qual: LESS }, analyzer(undefined, ['f66']))).validates, false);
  assert.equal((await proven({ qual: '{SUBLINK :subLinkType 0}' })).validates, false);
  assert.equal((await proven({ qual: '{COERCETODOMAIN :arg {VAR :varno 2}}' })).validates, false);
});

test('a trigger blocks only the writes that fire it, and a validation-only one blocks none', () => {
  const validation = sqlite(REPRODUCER);
  const projection = readSqliteTrigger(
    'post',
    'CREATE TRIGGER post AFTER INSERT ON entry BEGIN UPDATE account SET posted_minor = 0; END',
    new Set(),
  );
  const guard = readSqliteTrigger(
    'guard',
    'CREATE TRIGGER guard AFTER UPDATE OF status ON account BEGIN INSERT INTO log VALUES (1); END',
    new Set(),
  );
  const triggers = [validation, projection, guard];
  const names = (kind: 'insert' | 'update' | 'delete', set?: string[]) =>
    blockingTriggers(triggers, { kind, ...(set ? { set } : {}) }, true).map((trigger) => trigger.name);
  assert.deepEqual(names('update', ['posted_minor']), [], 'the validation trigger fires and does not block');
  assert.deepEqual(names('update', ['note']), []);
  assert.deepEqual(names('update', ['STATUS']), ['guard'], 'SQLite matches the column folding case');
  assert.deepEqual(names('update'), ['guard'], 'an update whose columns are not known fires every update trigger');
  assert.deepEqual(names('insert'), ['post']);
  assert.deepEqual(names('delete'), []);
  assert.deepEqual(sayBlocked(triggers), ['inserts', 'updates of status']);
  assert.equal(blocksEveryWrite(triggers), false);
  assert.equal(
    blocksEveryWrite([
      sqlite('CREATE TRIGGER t AFTER DELETE ON a BEGIN DELETE FROM b; END'),
      projection,
      sqlite('CREATE TRIGGER u AFTER UPDATE ON a BEGIN DELETE FROM b; END'),
    ]),
    true,
  );
  // PostgreSQL names a column exactly.
  assert.deepEqual(blockingTriggers([guard], { kind: 'update', set: ['STATUS'] }, false), []);
});

/* SQLite's scoped writer, end to end: a real adapter, its writer's catalog inside BEGIN IMMEDIATE. */
async function fixture(t: TestContext, triggers: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-scope-triggers-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customer (id INTEGER PRIMARY KEY, owner TEXT NOT NULL);
    CREATE TABLE account (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), status TEXT NOT NULL DEFAULT 'open',
      posted_minor INTEGER NOT NULL DEFAULT 0, note TEXT);
    CREATE TABLE activity (id INTEGER PRIMARY KEY, account_id INTEGER, what TEXT);
    INSERT INTO customer VALUES (1, 'ada'), (2, 'ben');
    INSERT INTO account (id, customer_id, posted_minor) VALUES (1, 1, 500), (2, 2, 900);
    ${triggers}
  `);
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, db };
}
const ada = (): Record<string, Filter> => ({
  customer: { groups: [[{ column: 'owner', op: '=', value: 'ada' }]] },
  account: { groups: [[{ column: 'customer_id', op: '=', value: 1 }]] },
  activity: { groups: [[{ column: 'account_id', op: '=', value: 1 }]] },
});
const causeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return String(refusalCause(error));
  }
  return assert.fail('the write was not refused');
};
const accounts = (db: DatabaseSync) =>
  db
    .prepare('SELECT id, status, posted_minor FROM account ORDER BY id')
    .all()
    .map((r) => ({ ...r }));

test("SQLite: the field report's reproducer — an update of status runs under the validation-only posted_minor trigger", async (t) => {
  const { adapter, db } = await fixture(t, REPRODUCER);
  await adapter.scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 1 }, values: { status: 'restricted' } }));
  assert.deepEqual(accounts(db)[0], { id: 1, status: 'restricted', posted_minor: 500 });
  // The trigger's own column: a valid value is written, an invalid one is refused by the trigger, and nothing changes.
  await adapter.scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 1 }, values: { posted_minor: 250 } }));
  await assert.rejects(
    adapter.scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 1 }, values: { posted_minor: -1 } })),
    /Negative customer balance/,
  );
  assert.deepEqual(accounts(db), [
    { id: 1, status: 'restricted', posted_minor: 250 },
    { id: 2, status: 'open', posted_minor: 900 },
  ]);
  // The row policy still holds: another customer's account is outside the scope.
  await assert.rejects(
    adapter.scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 2 }, values: { status: 'x' } })),
    Refusal,
  );
  // Inserts and deletes fire no UPDATE trigger.
  await adapter.scopeTransaction(ada(), async (tx: WriteTransaction) => {
    await tx.insert({ table: 'account', values: { id: 3, customer_id: 1 } });
    await tx.remove({ table: 'account', key: { id: 3 } });
  });
});

test('SQLite: a writing trigger still blocks the writes that fire it, and only those, naming the write and the trigger', async (t) => {
  const { adapter, db } = await fixture(
    t,
    `CREATE TRIGGER project_balance AFTER UPDATE OF posted_minor ON account BEGIN UPDATE account SET posted_minor = 0 WHERE id = 2; END;
     CREATE TRIGGER audit_insert AFTER INSERT ON account BEGIN INSERT INTO activity (account_id, what) VALUES (NEW.id, 'opened'); END;
     CREATE TRIGGER audit_delete BEFORE DELETE ON account BEGIN INSERT INTO activity (account_id, what) VALUES (OLD.id, 'closed'); END`,
  );
  const before = accounts(db);
  assert.match(
    await causeOf(adapter.scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 1 }, values: { posted_minor: 1 } }))),
    /"account" cannot be written under a row policy: an update of posted_minor fires the trigger "project_balance" \(it writes rows\), whose effects the policy cannot bound/,
  );
  assert.match(
    await causeOf(adapter.scopeTransaction(ada(), (tx) => tx.insert({ table: 'account', values: { id: 3, customer_id: 1 } }))),
    /an insert fires the trigger "audit_insert" \(it writes rows\)/,
  );
  assert.match(
    await causeOf(adapter.scopeTransaction(ada(), (tx) => tx.remove({ table: 'account', key: { id: 1 } }))),
    /a delete fires the trigger "audit_delete" \(it writes rows\)/,
  );
  assert.deepEqual(accounts(db), before, "the other customer's balance was never touched");
  assert.equal((db.prepare('SELECT count(*) AS n FROM activity').get() as { n: number }).n, 0);
  // An update of a column no UPDATE OF names fires nothing.
  await adapter.scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 1 }, values: { status: 'frozen' } }));
  assert.equal(accounts(db)[0].status, 'frozen');
});

test("a blocking trigger's refusal is the author's to fix: the operator's terminal leads with it, the caller's words name nothing", async (t) => {
  const { adapter } = await fixture(
    t,
    `CREATE TRIGGER stock_check BEFORE UPDATE ON account BEGIN
       SELECT RAISE(ABORT, 'no stock') WHERE (SELECT count(*) FROM activity) > 99; END`,
  );
  const error = await adapter
    .scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 1 }, values: { status: 'open' } }))
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
  assert.ok(error instanceof Refusal);
  assert.equal(error.message, 'This operation is not available in the current row scope.');
  assert.ok(isAuthorFault(error), 'a schema trigger is no fault of the person pressing the button');
  assert.match(String(refusalCause(error)), /the trigger "stock_check" \(it reads another table\)/);
});

test('SQLite: a trigger reading another table, or disguised as validation, still blocks', async (t) => {
  for (const trigger of [
    // Whether it raises says whether a customer the policy hides has an account.
    `CREATE TRIGGER exists_check BEFORE UPDATE ON account BEGIN
       SELECT RAISE(ABORT, 'taken') WHERE EXISTS (SELECT 1 FROM account WHERE customer_id = 2 AND status = NEW.status); END`,
    `CREATE TRIGGER case_check BEFORE UPDATE ON account BEGIN
       SELECT CASE WHEN (SELECT posted_minor FROM account WHERE id = 2) > 0 THEN RAISE(ABORT, 'rich') END; END`,
    `CREATE TRIGGER hidden_write BEFORE UPDATE ON account BEGIN
       SELECT RAISE(ABORT, 'negative') WHERE NEW.posted_minor < 0;
       UPDATE account SET status = 'drained' WHERE id = 2; END`,
  ]) {
    const { adapter, db } = await fixture(t, trigger);
    const before = accounts(db);
    assert.match(
      await causeOf(adapter.scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 1 }, values: { status: 'open' } }))),
      /cannot be written under a row policy: an update of status fires the trigger "\w+" \(it (reads another table|writes rows)\)/,
      trigger,
    );
    assert.deepEqual(accounts(db), before, trigger);
  }
});

test('SQLite: a trigger that reads a view through IN <word> blocks, and says nothing of the hidden row', async (t) => {
  for (const [view, target] of [
    ['true', 'TRUE'],
    ['like', 'LIKE'],
    ['\u00a0', '\u00a0'],
  ]) {
    // The view holds the other customer's owner: whether the trigger raises would say what it is.
    const { adapter, db } = await fixture(
      t,
      `CREATE VIEW "${view}" AS SELECT owner FROM customer;
       CREATE TRIGGER guard BEFORE UPDATE OF note ON account BEGIN SELECT RAISE(ABORT, 'taken') WHERE NEW.note IN ${target}; END;`,
    );
    for (const note of ['ben', 'zed']) {
      const cause = await causeOf(
        adapter.scopeTransaction(ada(), (tx) => tx.update({ table: 'account', key: { id: 1 }, values: { note } })),
      );
      assert.match(cause, /an update of note fires the trigger "guard" \(it reads another table\)/, `${JSON.stringify(view)} ${note}`);
    }
    assert.equal((db.prepare('SELECT note FROM account WHERE id = 1').get() as { note: unknown }).note, null);
  }
});
