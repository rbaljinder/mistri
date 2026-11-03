/**
 * Triggers an App names, under a row policy, on SQLite's scoped writer
 * (docs/trigger-effects.md): a keyed effect runs when every row it reaches is
 * one the principal's rows admit, proven before the write, and refuses
 * otherwise with the answer a hidden row gets. The adversarial tests the note
 * lists are numbered as it numbers them; PostgreSQL's are in
 * postgres-trigger-effects.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import type { TriggerAcceptance, TriggerChange } from '../packages/engine/src/adapters/scoped/triggerProof.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import type { TableMeta } from '../packages/engine/src/shared/schema.js';
import { readChangeset, sqliteTriggerWitness } from '../packages/engine/src/adapters/scoped/sqliteTriggerSession.js';
import { readSqliteTrigger } from '../packages/engine/src/adapters/scoped/sqliteTriggers.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import type { ScopeTrigger } from '../packages/engine/src/adapters/scoped/scopeTriggers.js';
import { resolveTriggerEffects } from '../packages/engine/src/adapters/scoped/triggerEffects.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { bindScopedBusinessCommands } from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';
import { parseTestApp } from './support/commandCatalog.js';

export const LEDGER = `
  CREATE TABLE customer (id INTEGER PRIMARY KEY, owner TEXT NOT NULL);
  CREATE TABLE account (
    id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id),
    status TEXT NOT NULL DEFAULT 'open', posted_minor INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE ledger_entry (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), amount INTEGER NOT NULL);
  CREATE TABLE entry_history (
    id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES account(id), what TEXT NOT NULL);
  INSERT INTO customer VALUES (1, 'ada'), (2, 'ben');
  INSERT INTO account (id, customer_id, status, posted_minor) VALUES (1, 1, 'open', 500), (2, 2, 'closed', 900), (3, 2, 'open', 100);
  INSERT INTO ledger_entry VALUES (10, 2, 50);
`;
export const POST_BALANCE = `CREATE TRIGGER post_balance AFTER INSERT ON ledger_entry BEGIN
  UPDATE account SET posted_minor = posted_minor + NEW.amount WHERE id = NEW.account_id; END`;
export const ENTRY_AUDIT = `CREATE TRIGGER entry_audit AFTER INSERT ON ledger_entry BEGIN
  INSERT INTO entry_history (entry_id, account_id, what) VALUES (NEW.id, NEW.account_id, 'posted'); END`;
export const MOVE_ENTRY = `CREATE TRIGGER move_entry AFTER UPDATE OF account_id ON ledger_entry BEGIN
  UPDATE account SET posted_minor = posted_minor - OLD.amount WHERE id = OLD.account_id;
  UPDATE account SET posted_minor = posted_minor + NEW.amount WHERE id = NEW.account_id; END`;
export const CHECK_OPEN = `CREATE TRIGGER check_open BEFORE INSERT ON ledger_entry BEGIN
  SELECT RAISE(ABORT, 'closed account') WHERE (SELECT status FROM account WHERE id = NEW.account_id) = 'closed'; END`;

async function fixture(t: TestContext, triggers: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-trigger-effects-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`${LEDGER}\n${triggers}`);
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, db, file };
}

/** Ada's rows: her customer and account, and the entries and history on it. */
const ada = (overrides: Record<string, RowScope[string]> = {}): RowScope => ({
  customer: { groups: [[{ column: 'owner', op: '=', value: 'ada' }]] },
  account: { groups: [[{ column: 'customer_id', op: '=', value: 1 }]] },
  ledger_entry: { groups: [[{ column: 'account_id', op: '=', value: 1 }]] },
  entry_history: { groups: [[{ column: 'account_id', op: '=', value: 1 }]] },
  ...overrides,
});
const naming = (table: string, ...names: string[]): TriggerAcceptance => ({
  named: new Map([[table, new Map(names.map((name) => [name, undefined]))]]),
});

/** What the caller hears: the same sentence for every row a scope hides. */
const heard = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return `${error.constructor.name}: ${error.message}`;
  }
  return assert.fail('the write was not refused');
};
const causeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return String(refusalCause(error) ?? error.message);
  }
  return assert.fail('the write was not refused');
};
/** A command's refusal and the causes recorded under it, for the operator (refusalReport.ts). */
const refusedFor = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    const said: string[] = [];
    for (let at: unknown = error; at !== undefined && said.length < 8; at = refusalCause(at))
      said.push(at instanceof Error ? `${at.constructor.name}: ${at.message}` : String(at));
    return said.join(' <- ');
  }
  return assert.fail('the command was not refused');
};
const state = (db: DatabaseSync) => ({
  accounts: db
    .prepare('SELECT id, posted_minor FROM account ORDER BY id')
    .all()
    .map((r) => ({ ...r })),
  entries: db
    .prepare('SELECT id, account_id, amount FROM ledger_entry ORDER BY id')
    .all()
    .map((r) => ({ ...r })),
  history: db
    .prepare('SELECT entry_id, account_id, what FROM entry_history ORDER BY id')
    .all()
    .map((r) => ({ ...r })),
});

test('a named projection and audit trigger run under the policy, and each row they changed is told', async (t) => {
  const { adapter, db } = await fixture(t, `${POST_BALANCE};\n${ENTRY_AUDIT}`);
  const changes: TriggerChange[] = [];
  const accepted: TriggerAcceptance = {
    named: new Map([
      [
        'ledger_entry',
        new Map([
          ['post_balance', undefined],
          ['entry_audit', undefined],
        ]),
      ],
    ]),
    changed: (change) => void changes.push(change),
  };
  await adapter.scopeTransaction(
    ada(),
    (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 1, amount: 25 } }),
    accepted,
  );
  assert.deepEqual(state(db).accounts[0], { id: 1, posted_minor: 525 });
  assert.deepEqual(state(db).history, [{ entry_id: 11, account_id: 1, what: 'posted' }]);
  assert.deepEqual(
    changes.map((change) => [change.trigger, change.on, change.table, change.kind, change.key]),
    [
      ['post_balance', 'ledger_entry', 'account', 'update', { id: 1 }],
      ['entry_audit', 'ledger_entry', 'entry_history', 'insert', undefined],
    ],
  );
  assert.equal(changes[0].before?.posted_minor, 500);
  assert.equal(changes[0].after?.posted_minor, 525);
  // Not named: refused exactly as before, naming the trigger.
  assert.match(
    await causeOf(
      adapter.scopeTransaction(
        ada(),
        (tx) => tx.insert({ table: 'ledger_entry', values: { id: 12, account_id: 1, amount: 1 } }),
        naming('ledger_entry', 'post_balance'),
      ),
    ),
    /an insert fires the trigger "entry_audit" \(it writes rows\)/,
  );
  assert.match(
    await causeOf(
      adapter.scopeTransaction(ada(), (tx) => tx.insert({ table: 'ledger_entry', values: { id: 12, account_id: 1, amount: 1 } })),
    ),
    /an insert fires the triggers "post_balance" \(it writes rows\), "entry_audit" \(it writes rows\)/,
  );
  assert.equal(state(db).entries.length, 2);
});

test("adversarial 1: a trigger keyed to NEW.account_id, with the request naming another customer's account, is refused before the write", async (t) => {
  const { adapter, db } = await fixture(t, `${POST_BALANCE};\n${ENTRY_AUDIT}`);
  const before = state(db);
  // The entry itself is admitted (every entry is in scope); the account the trigger would credit is not.
  const write = (account: number) =>
    adapter.scopeTransaction(
      ada({ ledger_entry: true, entry_history: true }),
      (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: account, amount: 25 } }),
      naming('ledger_entry', 'post_balance', 'entry_audit'),
    );
  assert.match(await causeOf(write(3)), /row of "account" outside|the "account" row id 3, which the principal's rows do not include/);
  assert.deepEqual(state(db), before, 'no row changed');
  // The projection alone: its own key is the one refused.
  const only = await fixture(t, POST_BALANCE);
  assert.match(
    await causeOf(
      only.adapter.scopeTransaction(
        ada({ ledger_entry: true }),
        (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 3, amount: 25 } }),
        naming('ledger_entry', 'post_balance'),
      ),
    ),
    /The trigger "post_balance" on "ledger_entry" reaches a row of "account" outside the principal's rows/,
  );
  assert.deepEqual(state(only.db), before);
  // A key that does not exist is answered as a hidden one is: the caller cannot tell them apart.
  assert.equal(await heard(write(99)), await heard(write(3)));
  assert.deepEqual(state(db), before, 'no row changed');
});

test('adversarial 2: a trigger keyed to OLD, through an update that moves the row, is refused before the write', async (t) => {
  const { adapter, db } = await fixture(t, MOVE_ENTRY);
  const before = state(db);
  // Entry 10 is on Ben's account 2; every entry is in Ada's scope here, so only the trigger's OLD key stands in the way.
  const cause = await causeOf(
    adapter.scopeTransaction(
      ada({ ledger_entry: true }),
      (tx) => tx.update({ table: 'ledger_entry', key: { id: 10 }, values: { account_id: 1 } }),
      naming('ledger_entry', 'move_entry'),
    ),
  );
  assert.match(cause, /The trigger "move_entry" on "ledger_entry" reaches a row of "account" outside the principal's rows/);
  assert.deepEqual(state(db), before);
  // Moving within Ada's rows runs, both sides proven.
  db.exec('INSERT INTO account (id, customer_id) VALUES (4, 1); INSERT INTO ledger_entry VALUES (20, 1, 7)');
  await adapter.scopeTransaction(
    ada({ ledger_entry: true }),
    (tx) => tx.update({ table: 'ledger_entry', key: { id: 20 }, values: { account_id: 4 } }),
    naming('ledger_entry', 'move_entry'),
  );
  assert.deepEqual(
    state(db).accounts.filter((account) => [1, 4].includes(account.id as number)),
    [
      { id: 1, posted_minor: 493 },
      { id: 4, posted_minor: 7 },
    ],
  );
  // An update that does not set account_id fires nothing, named or not.
  await adapter.scopeTransaction(ada({ ledger_entry: true }), (tx) =>
    tx.update({ table: 'ledger_entry', key: { id: 20 }, values: { amount: 8 } }),
  );
});

test('adversarial 7: a keyed read of a hidden row is refused with the hidden-row answer, whatever that row holds', async (t) => {
  const { adapter, db } = await fixture(t, CHECK_OPEN);
  const scope = ada({ ledger_entry: true });
  const closed = await causeOf(
    adapter.scopeTransaction(
      scope,
      (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 2, amount: 1 } }),
      naming('ledger_entry', 'check_open'),
    ),
  );
  const open = await causeOf(
    adapter.scopeTransaction(
      scope,
      (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 3, amount: 1 } }),
      naming('ledger_entry', 'check_open'),
    ),
  );
  // Account 2 is closed and 3 open, both Ben's: the trigger would raise for one only, and the answer is the same.
  assert.equal(closed, open);
  assert.doesNotMatch(closed, /closed account/);
  assert.equal(state(db).entries.length, 1);
  // On Ada's own account the trigger runs and speaks for itself.
  db.exec("UPDATE account SET status = 'closed' WHERE id = 1");
  await assert.rejects(
    adapter.scopeTransaction(
      scope,
      (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 1, amount: 1 } }),
      naming('ledger_entry', 'check_open'),
    ),
    /closed account/,
  );
});

test("adversarial 6, 10: a chain into a table outside the policy, or a trigger's effect outside it, is refused", async (t) => {
  const { adapter, db } = await fixture(
    t,
    `CREATE TABLE ledger_total (account_id INTEGER PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0);
     INSERT INTO ledger_total VALUES (1, 0), (2, 0);
     ${POST_BALANCE};
     CREATE TRIGGER total AFTER UPDATE OF posted_minor ON account BEGIN
       UPDATE ledger_total SET total = NEW.posted_minor WHERE account_id = NEW.id; END`,
  );
  const before = state(db);
  // ledger_total is not in the policy at all: the chain's last write reaches a row nothing admits.
  assert.match(
    await causeOf(
      adapter.scopeTransaction(ada(), (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 1, amount: 5 } }), {
        named: new Map([
          ['ledger_entry', new Map([['post_balance', undefined]])],
          ['account', new Map([['total', undefined]])],
        ]),
      }),
    ),
    /The trigger "total" on "account" reaches a row of "ledger_total" outside the principal's rows/,
  );
  // The chain's next trigger not named: refused, naming it.
  assert.match(
    await causeOf(
      adapter.scopeTransaction(
        { ...ada(), ledger_total: true },
        (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 1, amount: 5 } }),
        naming('ledger_entry', 'post_balance'),
      ),
    ),
    /fires "total", which the App does not name/,
  );
  assert.deepEqual(state(db), before);
  // Both named and the table in scope: the whole chain runs.
  await adapter.scopeTransaction(
    { ...ada(), ledger_total: true },
    (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 1, amount: 5 } }),
    {
      named: new Map([
        ['ledger_entry', new Map([['post_balance', undefined]])],
        ['account', new Map([['total', undefined]])],
      ]),
    },
  );
  assert.deepEqual({ ...db.prepare('SELECT total FROM ledger_total WHERE account_id = 1').get() }, { total: 505 });
});

test('adversarial 11: a refusal at each posting stage leaves nothing behind', async (t) => {
  const { adapter, db } = await fixture(
    t,
    `${POST_BALANCE};\n${ENTRY_AUDIT};
     CREATE TRIGGER positive BEFORE INSERT ON ledger_entry BEGIN SELECT RAISE(ABORT, 'not positive') WHERE NEW.amount <= 0; END`,
  );
  const both = {
    named: new Map([
      [
        'ledger_entry',
        new Map([
          ['post_balance', undefined],
          ['entry_audit', undefined],
        ]),
      ],
    ]),
  } satisfies TriggerAcceptance;
  const before = state(db);
  const post = (scope: RowScope, amount: number, then?: (tx: WriteTransaction) => Promise<unknown>) =>
    adapter.scopeTransaction(
      scope,
      async (tx) => {
        await tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 1, amount } });
        await then?.(tx);
      },
      both,
    );
  // The entry refused by its own validation trigger.
  await assert.rejects(post(ada(), 0), /not positive/);
  // The audit row would land outside the policy's rule for its table: refused before the write.
  await assert.rejects(post(ada({ entry_history: { groups: [[{ column: 'what', op: '=', value: 'manual' }]] } }), 5), Refusal);
  // A rule the proof cannot evaluate on the row the trigger inserts is refused, not guessed.
  await assert.rejects(post(ada({ entry_history: { groups: [[{ column: 'what', op: 'startsWith', value: 'p' }]] } }), 5), Refusal);
  // Entry, projection and history all written, then the command refuses: all of it goes.
  await assert.rejects(
    post(ada(), 5, async (tx) => {
      assert.equal(
        (await tx.count('entry_history')) + (await tx.count('ledger_entry')),
        2,
        'the entry and its history, written inside: Ada sees both',
      );
      throw new Refusal('the command changed its mind');
    }),
    /changed its mind/,
  );
  assert.deepEqual(state(db), before);
});

test('a definition changed after the App approved it is not accepted: the digest authority.lock pinned no longer matches', async (t) => {
  const { adapter, db } = await fixture(t, POST_BALANCE);
  const pinned = (digest: string): TriggerAcceptance => ({ named: new Map([['ledger_entry', new Map([['post_balance', digest]])]]) });
  assert.match(
    await causeOf(
      adapter.scopeTransaction(
        ada(),
        (tx) => tx.insert({ table: 'ledger_entry', values: { id: 11, account_id: 1, amount: 5 } }),
        pinned('sha256:00'),
      ),
    ),
    /named by the App, but its definition is not the one authority\.lock approved/,
  );
  assert.equal(state(db).entries.length, 1);
});

/* ---------- through an App: resources.<t>.triggers on a scoped command ---------- */

const POST_INPUT = { id: { type: 'number' }, account: { type: 'number' }, amount: { type: 'number' } } as const;
const books = (resources: Record<string, unknown>) =>
  parseTestApp(
    {
      id: 'books',
      name: 'Books',
      sources: { ledger: { connection: 'ledger-db', default: true } },
      resources,
      auth: { rows: 'policy', roles: { member: { read: true, commands: ['post'] } } },
      views: {
        entries: { kind: 'list', from: 'entries' },
        'new-entry': { kind: 'form', label: 'New entry', command: { id: 'post', version: 1, input: POST_INPUT } },
      },
      nav: ['entries', 'new-entry'],
      home: 'entries',
    },
    'trigger effects fixture',
  );

/** What `mistri check --write-authority` would approve: each named trigger's digest as the database defines it now. */
const lockFor = (db: DatabaseSync, resources: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(resources).flatMap(([resource, block]) =>
      ((block as { triggers?: string[] }).triggers ?? []).map((name) => {
        const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name) as { sql: string };
        return [`${resource}.${name}`, readSqliteTrigger(name, row.sql, new Set()).digest!];
      }),
    ),
  );

async function appFixture(t: TestContext, triggers: string, resources: Record<string, unknown>, locked = true) {
  const { adapter, db, file } = await fixture(t, triggers);
  const app = books(resources);
  if (locked) app.approvedTriggers = lockFor(db, resources);
  migrateSqliteCommandJournal(file);
  const physical: Record<string, string> = {
    customers: 'customer',
    accounts: 'account',
    entries: 'ledger_entry',
    history: 'entry_history',
  };
  const runtime = createAppSourceAdapter(
    {
      ledger: {
        adapter,
        schema: await adapter.introspect(),
        writable: true,
        resources: Object.fromEntries(Object.entries(physical).filter(([resource]) => resource in resources)),
      },
    },
    'ledger',
  );
  const anchor = runtime.forSource('ledger');
  const runtimeResources: RuntimeResources = {
    adapter: runtime.adapter,
    schema: runtime.schema,
    connections: ['ledger-db'],
    connectionFor: () => 'ledger-db',
    toPhysical: (resource) => runtime.resolve(resource).physicalTable,
    toLogical: (table) => runtime.catalogs.get('ledger')!.toLogical(table),
    toLogicalAt: (table) => runtime.catalogs.get('ledger')!.toLogical(table),
    forConnection: () => anchor,
  };
  const registry = {
    post: defineCommand({
      source: 'ledger',
      target: 'entries',
      targets: 'none',
      read: ['accounts'],
      write: ['entries'],
      input: POST_INPUT,
      output: { parse: (value: unknown) => value as { id: number } },
      async handle({ db }, input) {
        await db.entries.insert({ id: Number(input.id), account_id: Number(input.account), amount: Number(input.amount) });
        return { id: Number(input.id) };
      },
    }),
  };
  const rules = ada();
  const rows: RowScope = { customers: rules.customer, accounts: rules.account, entries: rules.ledger_entry, history: rules.entry_history };
  const binding = bindScopedBusinessCommands({
    app,
    resources: runtimeResources,
    registry,
    writableConnection: () => true,
    resultReferences: { post: (value: unknown) => [{ table: 'entries', key: { id: (value as { id: number }).id } }] },
  }).withScope(Object.fromEntries(Object.entries(rows).filter(([resource]) => resource in resources)), () => {});
  const post = (input: { id: number; account: number; amount: number }) =>
    executeBusinessCommand(
      binding,
      { id: 'ada', appId: 'books', roles: ['member'] },
      { command: 'post', commandVersion: 1, key: {}, expectedVersion: 0, idempotencyKey: `post-entry-${input.id}-request`, input },
      { signal: new AbortController().signal, door: 'ui' },
    );
  return { db, post };
}

const BOOKS: Record<string, unknown> = {
  customers: {},
  accounts: {},
  entries: { access: 'write', triggers: ['post_balance', 'entry_audit'] },
  history: {},
};

test('through an App, the triggers a resource names run under the policy, and one it does not name is refused as before', async (t) => {
  const named = await appFixture(t, `${POST_BALANCE};\n${ENTRY_AUDIT}`, BOOKS);
  assert.equal((await named.post({ id: 11, account: 1, amount: 25 })).status, 'applied');
  assert.deepEqual(state(named.db).accounts[0], { id: 1, posted_minor: 525 });
  assert.deepEqual(state(named.db).history, [{ entry_id: 11, account_id: 1, what: 'posted' }]);
  // Another customer's account: refused whole, before the write.
  assert.match(
    await refusedFor(named.post({ id: 12, account: 3, amount: 25 })),
    /ScopeRefusal.*The trigger "post_balance" on "ledger_entry" reaches a row of "account" outside/,
  );
  assert.deepEqual(
    state(named.db).entries.map((entry) => entry.id),
    [10, 11],
  );
  assert.deepEqual(state(named.db).accounts[2], { id: 3, posted_minor: 100 });

  const unnamed = await appFixture(t, `${POST_BALANCE};\n${ENTRY_AUDIT}`, {
    ...BOOKS,
    entries: { access: 'write', triggers: ['post_balance'] },
  });
  assert.match(
    await refusedFor(unnamed.post({ id: 11, account: 1, amount: 25 })),
    /an insert fires the trigger "entry_audit" \(it writes rows\)/,
  );
  assert.deepEqual(state(unnamed.db).accounts[0], { id: 1, posted_minor: 500 });
  assert.deepEqual(state(unnamed.db).history, []);
});

test('an App that names a trigger and keeps no authority.lock has approved nothing: the write that fires it is refused', async (t) => {
  const unlocked = await appFixture(t, `${POST_BALANCE};\n${ENTRY_AUDIT}`, BOOKS, false);
  assert.match(
    await refusedFor(unlocked.post({ id: 11, account: 1, amount: 25 })),
    /fires the triggers "post_balance" \(named by the App, but its definition is not the one authority\.lock approved\), "entry_audit" \(named/,
  );
  assert.deepEqual(state(unlocked.db).accounts[0], { id: 1, posted_minor: 500 });
  assert.deepEqual(state(unlocked.db).history, []);
});

test('adversarial 10: an effect on a table the App does not list as a resource is refused', async (t) => {
  const { history: _, ...unlisted } = BOOKS;
  const f = await appFixture(t, `${POST_BALANCE};\n${ENTRY_AUDIT}`, unlisted);
  assert.match(
    await refusedFor(f.post({ id: 11, account: 1, amount: 25 })),
    /ScopeRefusal.*The trigger "entry_audit" on "ledger_entry" reaches a row of "entry_history" outside/,
  );
  assert.deepEqual(state(f.db).accounts[0], { id: 1, posted_minor: 500 });
  assert.deepEqual(state(f.db).history, []);
  assert.deepEqual(
    state(f.db).entries.map((entry) => entry.id),
    [10],
  );
});

test('resources.<t>.triggers is a list of trigger names, each once', () => {
  assert.deepEqual(books({ entries: { access: 'write', triggers: ['post_balance'] } }).resources?.entries.triggers, ['post_balance']);
  for (const bad of [[], 'post_balance', [''], [' post_balance'], [3]])
    assert.throws(() => books({ entries: { access: 'write', triggers: bad } }), /"triggers" that is not a list of trigger names/);
  assert.throws(() => books({ entries: { access: 'write', triggers: ['post_balance', 'post_balance'] } }), /names a trigger twice/);
});

/* ---------- SQLite's session: a second look before COMMIT ---------- */

const WITNESSED = `CREATE TABLE a (id INTEGER PRIMARY KEY, n INTEGER, t TEXT);
  CREATE TABLE h (x TEXT, y INTEGER, v TEXT, PRIMARY KEY (y, x));
  CREATE TABLE e (id INTEGER PRIMARY KEY, a INTEGER);
  CREATE TABLE loose (v TEXT);
  CREATE TRIGGER tr AFTER INSERT ON e BEGIN
    UPDATE a SET n = n + 1 WHERE id = NEW.a; INSERT INTO h VALUES ('k', NEW.id, 'v'); END;
  INSERT INTO a VALUES (1, 0, 'one'), (2, 0, 'two');`;
const witnessed = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(WITNESSED);
  const keyed = (id: string, ...key: string[]) => ({ id, columns: key.map((name) => ({ name, primaryKey: true })) });
  const tables = [keyed('a', 'id'), keyed('h', 'y', 'x'), keyed('e', 'id'), keyed('loose')] as unknown as TableMeta[];
  return { db, tables };
};
const told = (table: string, kind: TriggerChange['kind'], key?: Record<string, unknown>): TriggerChange => ({
  table,
  kind,
  ...(key ? { key } : {}),
  trigger: 'tr',
  on: 'e',
});

test("a changeset is read as SQLite writes it: each change's table, operation, whether a trigger made it, and its key", () => {
  const { db } = witnessed();
  db.exec('BEGIN');
  const session = db.createSession();
  db.exec('INSERT INTO e VALUES (7, 1)');
  db.exec("UPDATE a SET t = 'deux' WHERE id = 2");
  db.exec('DELETE FROM a WHERE id = 2');
  const changes = readChangeset(session.changeset());
  session.close();
  db.exec('ROLLBACK');
  assert.deepEqual(
    changes.map((change) => [change.table, change.op, change.indirect, [...change.key]]),
    [
      ['e', 'insert', false, [[0, 7]]],
      ['a', 'update', true, [[0, 1]]],
      ['a', 'delete', false, [[0, 2]]],
      // A composite key by column position, whatever its order in the key.
      [
        'h',
        'insert',
        true,
        [
          [0, 'k'],
          [1, 7],
        ],
      ],
    ],
  );
});

test('the session refuses a row a trigger wrote that the proof did not reach, and passes every one it did', () => {
  const run = (proven: (witness: ReturnType<typeof sqliteTriggerWitness>) => void) => {
    const { db, tables } = witnessed();
    db.exec('BEGIN');
    const witness = sqliteTriggerWitness(db, tables);
    witness.watch();
    db.exec('INSERT INTO e VALUES (7, 1)');
    try {
      proven(witness);
      witness.settle();
      return 'kept';
    } catch (error) {
      assert.ok(error instanceof Refusal);
      return String(refusalCause(error));
    } finally {
      witness.close();
      db.exec('ROLLBACK');
    }
  };
  assert.equal(
    run((witness) => {
      witness.proven(told('a', 'update', { id: 1 }));
      witness.proven(told('h', 'insert', { y: 7, x: 'k' }));
    }),
    'kept',
  );
  // An insert whose key the database assigned is counted, not named.
  assert.equal(
    run((witness) => {
      witness.proven(told('a', 'update', { id: 1 }));
      witness.proven(told('h', 'insert'));
    }),
    'kept',
  );
  assert.match(
    run((witness) => witness.proven(told('a', 'update', { id: 1 }))),
    /A trigger inserted a row of "h" that no accepted effect reached/,
  );
  assert.match(
    run((witness) => {
      witness.proven(told('a', 'update', { id: 2 }));
      witness.proven(told('h', 'insert'));
    }),
    /A trigger updated a row of "a" that no accepted effect reached/,
  );
  assert.match(
    run((witness) => witness.proven(told('loose', 'insert'))),
    /writes "loose", which has no primary key: SQLite cannot witness its rows/,
  );
});

test("the session refuses a trigger's write to a row the transaction wrote itself, which SQLite still calls direct", () => {
  /* The transaction updates a.2 itself, then inserts e.8, whose trigger updates a.2 again: SQLite folds both into one
     direct change (sqlite3session_indirect), which the indirect-only look passed whatever the proof had reached. */
  const run = (proven: (witness: ReturnType<typeof sqliteTriggerWitness>) => void, tell = true) => {
    const { db, tables } = witnessed();
    db.exec('BEGIN');
    const witness = sqliteTriggerWitness(db, tables);
    witness.watch();
    db.exec("UPDATE a SET t = 'mine' WHERE id = 2");
    witness.wrote('a', { id: 2 }, { t: 'mine' });
    db.exec('INSERT INTO e VALUES (8, 2)');
    try {
      proven(witness);
      if (tell) witness.wrote('e', { id: 8 });
      witness.settle();
      return 'kept';
    } catch (error) {
      assert.ok(error instanceof Refusal);
      return String(refusalCause(error));
    } finally {
      witness.close();
      db.exec('ROLLBACK');
    }
  };
  const OWN = /A trigger wrote a row of "a" that the transaction wrote itself and no accepted effect reached/;
  // Reached: the trigger's update of a.2 is the proof's.
  assert.equal(
    run((witness) => {
      witness.proven(told('a', 'update', { id: 2 }));
      witness.proven(told('h', 'insert', { y: 8, x: 'k' }));
    }),
    'kept',
  );
  // Not reached: refused after the statement that fired it…
  assert.match(
    run((witness) => witness.proven(told('h', 'insert', { y: 8, x: 'k' }))),
    OWN,
  );
  // …and before COMMIT where nothing was told after it, as a command that caught the first refusal would be.
  assert.match(
    run((witness) => witness.proven(told('h', 'insert', { y: 8, x: 'k' })), false),
    OWN,
  );
  // Reached for another row is no warrant for this one.
  assert.match(
    run((witness) => {
      witness.proven(told('a', 'update', { id: 1 }));
      witness.proven(told('h', 'insert', { y: 8, x: 'k' }));
    }),
    OWN,
  );
});

test('the session knows a row the transaction wrote by its stored key, not by the key as the write named it', () => {
  /* The key is NOCASE: the transaction updates "ABC", which is the stored row "abc", and the changeset names it as
     stored. Kept under the key as sent, the row was never found in the changeset, so a trigger's later write to it
     (direct, the row being the transaction's own) passed unseen. */
  const run = (proven: (witness: ReturnType<typeof sqliteTriggerWitness>) => void, remove = false) => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE a (code TEXT PRIMARY KEY COLLATE NOCASE, n INTEGER, t TEXT);
      CREATE TABLE e (id INTEGER PRIMARY KEY, a TEXT);
      CREATE TRIGGER tr AFTER INSERT ON e BEGIN
        UPDATE a SET n = n + 1 WHERE code = NEW.a; INSERT OR IGNORE INTO a VALUES (NEW.a, 0, 'again'); END;
      INSERT INTO a VALUES ('abc', 0, 'one');`);
    const keyed = (id: string, ...key: string[]) => ({ id, columns: key.map((name) => ({ name, primaryKey: true })) });
    const witness = sqliteTriggerWitness(db, [keyed('a', 'code'), keyed('e', 'id')] as unknown as TableMeta[]);
    db.exec('BEGIN');
    witness.watch();
    if (remove) {
      // A deleted row cannot be read back after its statement: its stored key is read before it.
      const key = witness.stored('a', { code: 'ABC' });
      db.exec("DELETE FROM a WHERE code = 'ABC'");
      witness.wrote('a', key);
    } else {
      db.exec("UPDATE a SET t = 'mine' WHERE code = 'ABC'");
      witness.wrote('a', { code: 'ABC' }, { t: 'mine' });
    }
    db.exec("INSERT INTO e VALUES (8, 'abc')");
    try {
      proven(witness);
      witness.wrote('e', { id: 8 });
      witness.settle();
      return 'kept';
    } catch (error) {
      assert.ok(error instanceof Refusal);
      return String(refusalCause(error));
    } finally {
      witness.close();
      db.exec('ROLLBACK');
      db.close();
    }
  };
  const OWN = /A trigger wrote a row of "a" that the transaction wrote itself and no accepted effect reached/;
  assert.match(
    run(() => {}),
    OWN,
  );
  assert.equal(
    run((witness) => witness.proven(told('a', 'update', { code: 'abc' }))),
    'kept',
  );
  // Deleted as "ABC", inserted again as "abc" by the trigger: the transaction's own row, written again unseen.
  assert.match(
    run(() => {}, true),
    OWN,
  );
  assert.equal(
    run((witness) => witness.proven(told('a', 'insert', { code: 'abc' })), true),
    'kept',
  );
});

test("the session knows a row the transaction wrote by a BLOB key as the changeset says it, as x'…' hex", () => {
  /* The key was said by String(), "1,2" for the bytes 01 02, while the changeset says x'0102': the transaction's own
     row was never found in it, so a trigger's later write to it passed unseen. */
  const run = (proven: (witness: ReturnType<typeof sqliteTriggerWitness>) => void) => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE a (k BLOB PRIMARY KEY, t TEXT) WITHOUT ROWID;
      CREATE TABLE e (id INTEGER PRIMARY KEY, a TEXT);
      CREATE TRIGGER tr AFTER INSERT ON e BEGIN UPDATE a SET t = 'trigger' WHERE k = x'0102'; END;
      INSERT INTO a VALUES (x'0102', 'one');`);
    const keyed = (id: string, ...key: string[]) => ({ id, columns: key.map((name) => ({ name, primaryKey: true })) });
    const witness = sqliteTriggerWitness(db, [keyed('a', 'k'), keyed('e', 'id')] as unknown as TableMeta[]);
    db.exec('BEGIN');
    witness.watch();
    db.prepare("UPDATE a SET t = 'mine' WHERE k = ?").run(new Uint8Array([1, 2]));
    witness.wrote('a', { k: new Uint8Array([1, 2]) }, { t: 'mine' });
    db.exec("INSERT INTO e VALUES (8, 'x')");
    try {
      proven(witness);
      witness.wrote('e', { id: 8 });
      witness.settle();
      return 'kept';
    } catch (error) {
      assert.ok(error instanceof Refusal);
      return String(refusalCause(error));
    } finally {
      witness.close();
      db.exec('ROLLBACK');
      db.close();
    }
  };
  assert.match(
    run(() => {}),
    /A trigger wrote a row of "a" that the transaction wrote itself and no accepted effect reached/,
  );
  assert.equal(
    run((witness) => witness.proven(told('a', 'update', { k: new Uint8Array([1, 2]) }))),
    'kept',
  );
});

/* ---------- a review's bypasses: every key known before the statement, and compared as the proof compares ---------- */

const CLAIMS = `
  CREATE TABLE customer (id INTEGER PRIMARY KEY, owner TEXT NOT NULL);
  CREATE TABLE account (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), note TEXT, ref INTEGER);
  INSERT INTO customer VALUES (1, 'ada'), (2, 'ben');
  INSERT INTO account VALUES (1, 1, NULL, 1), (2, 2, NULL, NULL), (3, 2, 'bens', NULL);
`;
const adaClaims = (more: RowScope = {}): RowScope => ({
  customer: { groups: [[{ column: 'owner', op: '=', value: 'ada' }]] },
  account: { groups: [[{ column: 'customer_id', op: '=', value: 1 }]] },
  ...more,
});
const ofAda = (column: string): RowScope[string] => ({ groups: [[{ column, op: '=', value: 1 }]] });
async function claims(t: TestContext, sql: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-trigger-claims-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`${CLAIMS}\n${sql}`);
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, db };
}
const named = (entries: Record<string, string[]>): TriggerAcceptance => ({
  named: new Map(Object.entries(entries).map(([table, names]) => [table, new Map(names.map((name) => [name, undefined]))])),
});
/** The refusal's cause, or 'committed': a test that must not commit says which one it got. */
const settled = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'committed';
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return String(refusalCause(error) ?? error.message);
  }
};
const SESSION = /SQLite's session saw it/;

test('an update effect keyed by an id the database assigns is refused before the write, not proven against the row it already moved', async (t) => {
  const { adapter, db } = await claims(
    t,
    `CREATE TABLE claim (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id));
     INSERT INTO claim VALUES (1, 1), (2, 1);
     CREATE TRIGGER claim_it AFTER INSERT ON claim BEGIN
       UPDATE account SET customer_id = NEW.customer_id WHERE id = NEW.id; END;`,
  );
  // Ada gives no id; SQLite assigns 3, which is Ben's account's.
  const outcome = await settled(
    adapter.scopeTransaction(
      adaClaims({ claim: ofAda('customer_id') }),
      (tx) => tx.insert({ table: 'claim', values: { customer_id: 1 } }),
      named({ claim: ['claim_it'] }),
    ),
  );
  assert.match(outcome, /The trigger "claim_it" reaches a row of "account" by a value only the write assigns/);
  assert.equal((db.prepare('SELECT customer_id FROM account WHERE id = 3').get() as { customer_id: number }).customer_id, 2);
});

test('a chained update keyed by a value an effect computes is refused before the write', async (t) => {
  const { adapter, db } = await claims(
    t,
    `CREATE TABLE vault (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id));
     INSERT INTO vault VALUES (1, 1), (3, 2);
     CREATE TABLE entry (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), amount INTEGER NOT NULL);
     CREATE TRIGGER a_ref AFTER INSERT ON entry BEGIN UPDATE account SET ref = NEW.amount + 0 WHERE id = NEW.account_id; END;
     CREATE TRIGGER b_claim AFTER UPDATE OF ref ON account BEGIN
       UPDATE vault SET customer_id = NEW.customer_id WHERE id = NEW.ref; END;`,
  );
  const outcome = await settled(
    adapter.scopeTransaction(
      adaClaims({ vault: ofAda('customer_id'), entry: ofAda('account_id') }),
      (tx) => tx.insert({ table: 'entry', values: { id: 1, account_id: 1, amount: 3 } }),
      named({ entry: ['a_ref'], account: ['b_claim'] }),
    ),
  );
  assert.match(outcome, /The trigger "b_claim" reaches a row of "vault" by a value only the write assigns/);
  assert.equal((db.prepare('SELECT customer_id FROM vault WHERE id = 3').get() as { customer_id: number }).customer_id, 2);
});

test('a row two effects of one write reach, where a write to it fires a keyed trigger, is refused before the write', async (t) => {
  const { adapter, db } = await claims(
    t,
    // Whichever runs first, the second sees the row as the first left it: b_claim would key on the ref a_ref set.
    `CREATE TABLE vault (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id));
     INSERT INTO vault VALUES (1, 1), (3, 2);
     CREATE TABLE entry (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), amount INTEGER NOT NULL);
     CREATE TRIGGER b_touch AFTER INSERT ON entry BEGIN UPDATE account SET note = 'x' WHERE id = NEW.account_id; END;
     CREATE TRIGGER a_ref AFTER INSERT ON entry BEGIN UPDATE account SET ref = NEW.amount WHERE id = NEW.account_id; END;
     CREATE TRIGGER c_claim AFTER UPDATE OF note ON account BEGIN
       UPDATE vault SET customer_id = NEW.customer_id WHERE id = NEW.ref; END;`,
  );
  const outcome = await settled(
    adapter.scopeTransaction(
      adaClaims({ vault: ofAda('customer_id'), entry: ofAda('account_id') }),
      (tx) => tx.insert({ table: 'entry', values: { id: 1, account_id: 1, amount: 3 } }),
      named({ entry: ['a_ref', 'b_touch'], account: ['c_claim'] }),
    ),
  );
  assert.doesNotMatch(outcome, SESSION, 'the proof refuses it, not only the session after the trigger ran');
  assert.match(outcome, /reaches a row of "account" that this write already reaches, and a write to it fires a trigger/);
  assert.equal((db.prepare('SELECT customer_id FROM vault WHERE id = 3').get() as { customer_id: number }).customer_id, 2);
});

const REQUESTS = `
  CREATE TABLE req (id INTEGER PRIMARY KEY, target INTEGER NOT NULL, claimer INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE req_log (id INTEGER PRIMARY KEY, req_id INTEGER NOT NULL REFERENCES req(id), target INTEGER NOT NULL, claimer INTEGER NOT NULL);
  CREATE TRIGGER log_req AFTER INSERT ON req BEGIN
    INSERT INTO req_log (req_id, target, claimer) VALUES (NEW.id, NEW.target, NEW.claimer); END;`;

test("an insert proven only after the statement may fire no keyed trigger on its table: its chain's proof would come after the chain ran", async (t) => {
  const { adapter, db } = await claims(
    t,
    `${REQUESTS}
     CREATE TRIGGER apply_req AFTER INSERT ON req_log BEGIN
       UPDATE account SET customer_id = NEW.claimer WHERE id = NEW.target; END;`,
  );
  // The target (3) and the claimer (1) are known before the write; only req_log.req_id waits for the id.
  const outcome = await settled(
    adapter.scopeTransaction(
      adaClaims({ req: true, req_log: true }),
      (tx) => tx.insert({ table: 'req', values: { target: 3, claimer: 1 } }),
      named({ req: ['log_req'], req_log: ['apply_req'] }),
    ),
  );
  assert.match(outcome, /The trigger "log_req" inserts a "req_log" row whose place in the principal's rows only the write can tell/);
  assert.equal((db.prepare('SELECT customer_id FROM account WHERE id = 3').get() as { customer_id: number }).customer_id, 2);
});

test('an insert proven late cannot let a keyed read on its table raise before it is proven: two hidden rows answer alike', async (t) => {
  const { adapter } = await claims(
    t,
    `${REQUESTS}
     CREATE TRIGGER check_req BEFORE INSERT ON req_log BEGIN
       SELECT RAISE(ABORT, 'it is bens') WHERE (SELECT note FROM account WHERE id = NEW.target) = 'bens'; END;`,
  );
  const ask = (target: number) =>
    settled(
      adapter.scopeTransaction(
        adaClaims({ req: true, req_log: true }),
        (tx) => tx.insert({ table: 'req', values: { target } }),
        named({ req: ['log_req'], req_log: ['check_req'] }),
      ),
    );
  const three = await ask(3); // Ben's, note 'bens'
  const two = await ask(2); // Ben's, note NULL
  assert.equal(three, two, 'two hidden rows answer differently');
  assert.doesNotMatch(three, /it is bens/);
});

const NULL_ID = `
  CREATE TABLE claim (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id));
  INSERT INTO claim VALUES (1, 1);`;

test('an explicit NULL for a rowid alias is the id SQLite assigns, not a key that reaches nothing: a keyed write by it is refused by the proof', async (t) => {
  const { adapter, db } = await claims(
    t,
    `${NULL_ID}
     CREATE TRIGGER claim_it AFTER INSERT ON claim BEGIN UPDATE account SET note = 'touched' WHERE id = NEW.id; END;`,
  );
  const outcome = await settled(
    adapter.scopeTransaction(
      adaClaims({ claim: ofAda('customer_id') }),
      (tx) => tx.insert({ table: 'claim', values: { id: null, customer_id: 1 } }),
      named({ claim: ['claim_it'] }),
    ),
  );
  assert.doesNotMatch(outcome, SESSION, 'the proof refuses it, not only the session after the trigger ran');
  assert.match(outcome, /The trigger "claim_it" reaches a row of "account" by a value only the write assigns/);
  assert.equal((db.prepare('SELECT note FROM account WHERE id = 2').get() as { note: string | null }).note, null);
});

test('an explicit NULL for a rowid alias does not skip a keyed read by it: two hidden rows answer alike', async (t) => {
  const { adapter } = await claims(
    t,
    `${NULL_ID}
     CREATE TRIGGER peek AFTER INSERT ON claim BEGIN
       SELECT RAISE(ABORT, 'it is bens') WHERE (SELECT note FROM account WHERE id = NEW.id) = 'bens'; END;`,
  );
  const ask = () =>
    settled(
      adapter.scopeTransaction(
        adaClaims({ claim: ofAda('customer_id') }),
        (tx) => tx.insert({ table: 'claim', values: { id: null, customer_id: 1 } }),
        named({ claim: ['peek'] }),
      ),
    );
  const second = await ask(); // rowid 2: Ben's account 2, note NULL
  const third = await ask(); // rowid 3, had the second been kept: Ben's account 3, note 'bens'
  assert.equal(third, second, 'two hidden rows answer differently');
  assert.match(second, /The trigger "peek" reads a "account" row by a value only the write assigns/);
});

/** A text key whose NEW side folds case: `NEW.code = code` compares under NEW's NOCASE, the key and the proof under BINARY. */
const folding = (bens: string, trigger: string) => `
  CREATE TABLE customer (id INTEGER PRIMARY KEY, owner TEXT NOT NULL);
  CREATE TABLE acct (code TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), note TEXT);
  INSERT INTO customer VALUES (1, 'ada'), (2, 'ben');
  INSERT INTO acct VALUES ('ABC', 2, ${bens}), ('abc', 1, NULL);
  CREATE TABLE entry (id INTEGER PRIMARY KEY, code TEXT COLLATE NOCASE NOT NULL);
  ${trigger}`;
async function folded(t: TestContext, sql: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-trigger-collation-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(sql);
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const write = () =>
    settled(
      adapter.scopeTransaction(
        { customer: adaClaims().customer, acct: ofAda('customer_id'), entry: true },
        (tx) => tx.insert({ table: 'entry', values: { id: 1, code: 'abc' } }),
        named({ entry: ['touch', 'peek'] }),
      ),
    );
  return { db, write };
}

test("a key whose NEW side compares under another collation than the key column's is refused when the catalog is read", async (t) => {
  const f = await folded(
    t,
    folding("'bens'", `CREATE TRIGGER touch AFTER INSERT ON entry BEGIN UPDATE acct SET note = 'touched' WHERE NEW.code = code; END;`),
  );
  const outcome = await f.write();
  assert.doesNotMatch(outcome, SESSION, 'the proof refuses it, not only the session after the trigger ran');
  assert.match(outcome, /its key "acct"\.code = NEW\.code compares TEXT affinity, COLLATE BINARY with TEXT affinity, COLLATE NOCASE/);
  assert.equal((f.db.prepare("SELECT note FROM acct WHERE code = 'ABC'").get() as { note: string }).note, 'bens');
});

test('a keyed read whose NEW side folds case cannot read a hidden row: two hidden rows answer alike', async (t) => {
  const peek = `CREATE TRIGGER peek BEFORE INSERT ON entry BEGIN
    SELECT RAISE(ABORT, 'it is secret') WHERE (SELECT note FROM acct WHERE NEW.code = code) = 'secret'; END;`;
  const secret = await (await folded(t, folding("'secret'", peek))).write();
  const none = await (await folded(t, folding('NULL', peek))).write();
  assert.equal(secret, none, "Ben's hidden note changes the answer");
  assert.match(secret, /compares TEXT affinity, COLLATE BINARY with TEXT affinity, COLLATE NOCASE/);
});

test('on SQLite a key is the primary key, its index comparing as its columns do, and both sides of it share an affinity', () => {
  const judged = (sql: string) => {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA foreign_keys = ON; ${sql}`);
    try {
      return [...(readSqliteScopeCatalog(db, resolveTriggerEffects).triggered ?? new Map()).values()].flat()[0] as ScopeTrigger;
    } finally {
      db.close();
    }
  };
  // Unique under NOCASE by its index, compared under BINARY by its column and by the proof.
  assert.match(
    judged(`CREATE TABLE acct (code TEXT, note TEXT, PRIMARY KEY (code COLLATE NOCASE));
      CREATE TABLE entry (id INTEGER PRIMARY KEY, code TEXT NOT NULL);
      CREATE TRIGGER touch AFTER INSERT ON entry BEGIN UPDATE acct SET note = 'x' WHERE code = NEW.code; END;`).unaccepted!,
    /its write to "acct" is not by the primary key of it/,
  );
  // An untyped key holds 3 and '3' apart; a TEXT NEW side compares them as one. It is not a type a key may be at all.
  assert.match(
    judged(`CREATE TABLE acct (code PRIMARY KEY, note TEXT);
      CREATE TABLE entry (id INTEGER PRIMARY KEY, code TEXT NOT NULL);
      CREATE TRIGGER touch AFTER INSERT ON entry BEGIN UPDATE acct SET note = 'x' WHERE code = NEW.code; END;`).unaccepted!,
    /its key "acct"\.code = NEW\.code is not one a scoped write can prove: "acct"\.code is of type BLOB \(BLOB affinity\), which is not supported as a key/,
  );
  // An INTEGER key reads '3.0' as 3; a TEXT NEW side keeps it '3.0'.
  assert.match(
    judged(`CREATE TABLE acct (code INT PRIMARY KEY, note TEXT);
      CREATE TABLE entry (id INTEGER PRIMARY KEY, code TEXT NOT NULL);
      CREATE TRIGGER touch AFTER INSERT ON entry BEGIN UPDATE acct SET note = 'x' WHERE code = NEW.code; END;`).unaccepted!,
    /compares INTEGER affinity, COLLATE BINARY with TEXT affinity, COLLATE BINARY/,
  );
  // A unique column that is not the primary key is not a key SQLite's session can name a change by.
  assert.match(
    judged(`CREATE TABLE acct (id INTEGER PRIMARY KEY, code TEXT UNIQUE, note TEXT);
      CREATE TABLE entry (id INTEGER PRIMARY KEY, code TEXT NOT NULL);
      CREATE TRIGGER touch AFTER INSERT ON entry BEGIN UPDATE acct SET note = 'x' WHERE code = NEW.code; END;`).unaccepted!,
    /is not by the primary key of it/,
  );
  // The same column on both sides, a collation the key's own: accepted.
  const same = judged(`CREATE TABLE acct (code TEXT COLLATE NOCASE PRIMARY KEY, note TEXT);
      CREATE TABLE entry (id INTEGER PRIMARY KEY, code TEXT COLLATE nocase NOT NULL);
      CREATE TRIGGER touch AFTER INSERT ON entry BEGIN UPDATE acct SET note = 'x' WHERE code = NEW.code; END;`);
  assert.equal(same.unaccepted, undefined);
  assert.ok(same.effects?.length);
});

/* ---------- a second review: what a delete cannot say, and what a reference answers ---------- */

/** A database of its own, where Ada's rows are those she owns: the review's reproducers, kept. */
async function owned(t: TestContext, sql: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-trigger-owned-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(sql);
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, db };
}
const adaOwns = (...tables: string[]): RowScope =>
  Object.fromEntries(tables.map((table) => [table, { groups: [[{ column: 'owner', op: '=', value: 'ada' }]] }]));

test("a delete's insert effect into a table whose schema says ON CONFLICT REPLACE is refused, and the hidden row it would replace is kept", async (t) => {
  // A scoped delete cannot say OR ABORT, so the table's own REPLACE, not the proof, would decide which row the insert replaces.
  const { adapter, db } = await owned(
    t,
    `CREATE TABLE note (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, hist_id INTEGER);
     CREATE TABLE hist (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, owner TEXT NOT NULL, what TEXT);
     INSERT INTO note VALUES (1, 'ada', 100);
     INSERT INTO hist VALUES (100, 'ben', 'ben secret');
     CREATE TRIGGER audit_delete AFTER DELETE ON note BEGIN
       INSERT INTO hist (id, owner, what) VALUES (OLD.hist_id, OLD.owner, 'deleted'); END;`,
  );
  const cause = await settled(
    adapter.scopeTransaction(
      adaOwns('note', 'hist'),
      (tx) => tx.remove({ table: 'note', key: { id: 1 } }),
      named({ note: ['audit_delete'] }),
    ),
  );
  assert.match(cause, /inserts into "hist", whose schema declares ON CONFLICT REPLACE/);
  assert.deepEqual({ ...db.prepare('SELECT id, owner, what FROM hist').get() }, { id: 100, owner: 'ben', what: 'ben secret' });
  assert.equal((db.prepare('SELECT count(*) AS n FROM note').get() as { n: number }).n, 1);
});

test('a conflict clause a table declares on any constraint refuses an insert or update effect on it; ABORT, the default, does not', () => {
  const judged = (target: string) => {
    const db = new DatabaseSync(':memory:');
    db.exec(`${target};
      CREATE TABLE note (id INTEGER PRIMARY KEY, t_id INTEGER, code TEXT);
      CREATE TRIGGER touch AFTER DELETE ON note BEGIN UPDATE t SET code = 'x' WHERE id = OLD.t_id; END;`);
    try {
      return ([...(readSqliteScopeCatalog(db, resolveTriggerEffects).triggered ?? new Map()).values()].flat()[0] as ScopeTrigger)
        .unaccepted;
    } finally {
      db.close();
    }
  };
  assert.match(judged('CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT UNIQUE ON CONFLICT REPLACE)')!, /declares ON CONFLICT REPLACE/);
  assert.match(
    judged('CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT, UNIQUE (code) ON CONFLICT IGNORE)')!,
    /declares ON CONFLICT IGNORE/,
  );
  assert.match(judged('CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT NOT NULL ON CONFLICT FAIL)')!, /declares ON CONFLICT FAIL/);
  assert.equal(judged('CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT ABORT, code TEXT)'), undefined);
  // A word in a default or a check is not a clause.
  assert.equal(judged(`CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT DEFAULT 'on conflict replace')`), undefined);
});

test('the session counts a change as the proof told it: an insert proven is not an update made', () => {
  const run = (kind: TriggerChange['kind']) => {
    const { db, tables } = witnessed();
    db.exec('BEGIN');
    const witness = sqliteTriggerWitness(db, tables);
    witness.watch();
    db.exec('INSERT INTO e VALUES (7, 1)');
    try {
      witness.proven(told('a', kind, { id: 1 }));
      witness.proven(told('h', 'insert', { y: 7, x: 'k' }));
      witness.settle();
      return 'kept';
    } catch (error) {
      assert.ok(error instanceof Refusal);
      return String(refusalCause(error));
    } finally {
      witness.close();
      db.exec('ROLLBACK');
    }
  };
  assert.equal(run('update'), 'kept');
  // A REPLACE's delete and insert of one key consolidate into an update: an insert proven by that key does not cover it.
  assert.match(run('insert'), /A trigger updated a row of "a" that no accepted effect reached/);
  assert.match(run('delete'), /A trigger updated a row of "a" that no accepted effect reached/);
});

test("a delete effect on a table a foreign key references is refused before the write: a hidden row's reference does not change the answer", async (t) => {
  const outcome = async (benUses: boolean) => {
    const { adapter, db } = await owned(
      t,
      `PRAGMA foreign_keys = ON;
       CREATE TABLE tag (id INTEGER PRIMARY KEY, owner TEXT NOT NULL);
       CREATE TABLE tag_use (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, tag_id INTEGER REFERENCES tag(id));
       CREATE TABLE item (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, tag_id INTEGER);
       INSERT INTO tag VALUES (5, 'ada');
       INSERT INTO item VALUES (1, 'ada', 5);
       ${benUses ? "INSERT INTO tag_use VALUES (9, 'ben', 5);" : ''}
       CREATE TRIGGER drop_tag AFTER DELETE ON item BEGIN DELETE FROM tag WHERE id = OLD.tag_id; END;`,
    );
    const write = () =>
      adapter.scopeTransaction(
        adaOwns('item', 'tag', 'tag_use'),
        (tx) => tx.remove({ table: 'item', key: { id: 1 } }),
        named({ item: ['drop_tag'] }),
      );
    const said = await heard(write()).catch((error: unknown) => `not a refusal: ${String(error)}`);
    return { said, cause: await settled(write()), items: (db.prepare('SELECT count(*) AS n FROM item').get() as { n: number }).n };
  };
  const without = await outcome(false);
  assert.deepEqual(await outcome(true), without);
  assert.equal(without.items, 1);
  assert.match(without.cause, /it deletes from "tag", which a foreign key references/);
});

test('an update effect that points a row at a parent answers alike whether that parent is hidden or missing, before the write', async (t) => {
  const { adapter, db } = await owned(
    t,
    `PRAGMA foreign_keys = ON;
     CREATE TABLE account (id INTEGER PRIMARY KEY, owner TEXT NOT NULL);
     CREATE TABLE card (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, account_id INTEGER REFERENCES account(id));
     CREATE TABLE entry (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, card_id INTEGER, target INTEGER);
     INSERT INTO account VALUES (1, 'ada'), (2, 'ben');
     INSERT INTO card VALUES (7, 'ada', 1);
     CREATE TRIGGER relink AFTER INSERT ON entry BEGIN UPDATE card SET account_id = NEW.target WHERE id = NEW.card_id; END;`,
  );
  const write = (target: number) =>
    heard(
      adapter.scopeTransaction(
        adaOwns('account', 'card', 'entry'),
        (tx) => tx.insert({ table: 'entry', values: { id: target, owner: 'ada', card_id: 7, target } }),
        named({ entry: ['relink'] }),
      ),
    ).catch((error: unknown) => `not a refusal: ${String(error)}`);
  const hidden = await write(2);
  assert.equal(await write(99), hidden);
  assert.match(hidden, /^ScopeRefusal: /);
  assert.deepEqual(
    db
      .prepare('SELECT id, account_id FROM card')
      .all()
      .map((row) => ({ ...row })),
    [{ id: 7, account_id: 1 }],
  );
  assert.equal((db.prepare('SELECT count(*) AS n FROM entry').get() as { n: number }).n, 0);
});
