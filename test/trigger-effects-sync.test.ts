/**
 * Live sync and record history for the rows a trigger the App accepts changed (docs/trigger-effects.md, decision 4):
 * the database wrote them, not a statement of the transaction, so the proof tells the write's capture
 * (writeCapture.ts) of each row it reached. A history entry names the trigger and the command that fired it; the
 * live change row names the rows; a transaction that rolls back keeps neither.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { TriggerAcceptance } from '../packages/engine/src/adapters/scoped/triggerProof.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { attributeAction, attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { historyKey } from '../packages/mistri/src/adapters/history/recordHistory.js';
import { provisionPostgresRecordHistory } from '../packages/mistri/src/adapters/history/postgresRecordHistory.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import type { LiveEntry } from '../packages/mistri/src/adapters/live/liveChange.js';
import {
  POSTGRES_LIVE_START,
  provisionPostgresLiveChange,
  readPostgresLiveChanges,
} from '../packages/mistri/src/adapters/live/postgresLiveChange.js';
import { provisionSqliteLiveChange, readSqliteLiveChanges } from '../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import { appStoresOf } from '../packages/mistri/src/server/stores/appStores.js';
import { bindLiveChanges, bindRecordHistory } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { LIVE_PG } from './support/policyServer.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const SQLITE = `
  CREATE TABLE customer (id INTEGER PRIMARY KEY, owner TEXT NOT NULL);
  CREATE TABLE account (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id),
    status TEXT NOT NULL DEFAULT 'open', posted_minor INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE ledger_entry (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), amount INTEGER NOT NULL);
  CREATE TABLE entry_history (
    id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES account(id), what TEXT NOT NULL);
  INSERT INTO customer VALUES (1, 'ada'), (2, 'ben');
  INSERT INTO account (id, customer_id, status, posted_minor) VALUES (1, 1, 'open', 500), (2, 2, 'closed', 900), (3, 2, 'open', 100);
  CREATE TRIGGER post_balance AFTER INSERT ON ledger_entry BEGIN
    UPDATE account SET posted_minor = posted_minor + NEW.amount WHERE id = NEW.account_id; END;
  CREATE TRIGGER entry_audit AFTER INSERT ON ledger_entry BEGIN
    INSERT INTO entry_history (entry_id, account_id, what) VALUES (NEW.id, NEW.account_id, 'posted'); END;
`;
const POSTGRES = [
  'CREATE TABLE customer (id integer PRIMARY KEY, owner text NOT NULL)',
  `CREATE TABLE account (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES customer (id),
     status text NOT NULL DEFAULT 'open', posted_minor integer NOT NULL DEFAULT 0)`,
  'CREATE TABLE ledger_entry (id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES account (id), amount integer NOT NULL)',
  `CREATE TABLE entry_history (id bigserial PRIMARY KEY, entry_id integer NOT NULL,
     account_id integer NOT NULL REFERENCES account (id), what text NOT NULL)`,
  `INSERT INTO customer VALUES (1, 'ada'), (2, 'ben')`,
  `INSERT INTO account VALUES (1, 1, 'open', 500), (2, 2, 'closed', 900), (3, 2, 'open', 100)`,
  'INSERT INTO ledger_entry VALUES (10, 2, 50)',
  `CREATE FUNCTION public.post_balance() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN UPDATE public.account SET posted_minor = posted_minor + NEW.amount WHERE id = NEW.account_id; RETURN NULL; END $$`,
  `CREATE FUNCTION public.entry_audit() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN INSERT INTO public.entry_history (entry_id, account_id, what) VALUES (NEW.id, NEW.account_id, 'posted'); RETURN NULL; END $$`,
  'CREATE TRIGGER post_balance AFTER INSERT ON public.ledger_entry FOR EACH ROW EXECUTE FUNCTION public.post_balance()',
  'CREATE TRIGGER entry_audit AFTER INSERT ON public.ledger_entry FOR EACH ROW EXECUTE FUNCTION public.entry_audit()',
];

interface Ledger {
  adapter: SqliteAdapter | PostgresAdapter;
  /** A table's physical id, as the adapter is asked it. */
  table: (name: string) => string;
  live: () => Promise<LiveEntry[][]>;
}

async function sqliteLedger(t: TestContext): Promise<Ledger> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-trigger-sync-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(SQLITE);
  provisionSqliteRecordHistory(file);
  provisionSqliteLiveChange(file);
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    bindLiveChanges(adapter, undefined);
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, table: (name) => name, live: async () => readSqliteLiveChanges(db, '0', 100).map((row) => [...row.entries]) };
}

async function postgresLedger(t: TestContext): Promise<Ledger> {
  const owned = await uuidPostgresDatabase('tw_trigger_sync');
  const control = await pgClient(owned.url);
  for (const statement of POSTGRES) await control.query(statement);
  await provisionPostgresRecordHistory(owned.url);
  await provisionPostgresLiveChange(owned.url);
  const adapter = new PostgresAdapter(owned.url, 'trigger sync', ['public']);
  t.after(async () => {
    bindLiveChanges(adapter, undefined);
    await adapter.close();
    await control.end();
    await owned.drop();
  });
  return {
    adapter,
    table: (name) => `public.${name}`,
    live: async () => (await readPostgresLiveChanges(control, POSTGRES_LIVE_START, 100)).map(({ change }) => [...change.entries]),
  };
}

async function heardAndKept(t: TestContext, open: (t: TestContext) => Promise<Ledger>) {
  const { adapter, table, live } = await open(t);
  bindRecordHistory(
    adapter,
    new Map([
      [table('account'), { redact: new Set<string>() }],
      [table('ledger_entry'), { redact: new Set<string>() }],
    ]),
  );
  bindLiveChanges(adapter, { scoped: true });
  const eq = (column: string, value: string | number) => ({ groups: [[{ column, op: '=' as const, value }]] });
  const scope: RowScope = {
    [table('customer')]: eq('owner', 'ada'),
    [table('account')]: eq('customer_id', 1),
    [table('ledger_entry')]: eq('account_id', 1),
    [table('entry_history')]: eq('account_id', 1),
  };
  const accepted: TriggerAcceptance = {
    named: new Map([
      [
        table('ledger_entry'),
        new Map([
          ['post_balance', undefined],
          ['entry_audit', undefined],
        ]),
      ],
    ]),
  };
  const post = (id: number, fail = false) =>
    attributeWrites({ actor: 'ada@example.com', name: 'Ada Park', via: 'app' }, () =>
      attributeAction('Post entry', () =>
        adapter.scopeTransaction(
          scope,
          async (tx: WriteTransaction) => {
            await tx.insert({ table: table('ledger_entry'), values: { id, account_id: 1, amount: 25 } });
            if (fail) throw new Error('the handler failed after the write');
          },
          accepted,
        ),
      ),
    );
  await post(11);

  const account = await appStoresOf(adapter).readRecordHistory({ resource: table('account'), key: historyKey({ id: 1 }), limit: 10 });
  assert.equal(account.length, 1, "the account's change is in its history");
  assert.equal(account[0].kind, 'update');
  assert.equal(account[0].action, 'Post entry (trigger post_balance)', 'attributed to the trigger and the command that fired it');
  assert.equal(account[0].actor, 'ada@example.com');
  assert.equal(account[0].actorName, 'Ada Park');
  assert.deepEqual(account[0].changes, [{ c: 'posted_minor', b: 500, a: 525 }]);
  const entry = await appStoresOf(adapter).readRecordHistory({ resource: table('ledger_entry'), key: historyKey({ id: 11 }), limit: 10 });
  assert.equal(entry[0].action, 'Post entry', "the command's own write keeps its own name");
  assert.equal(entry[0].writeId, account[0].writeId, 'one write: the entry and what its triggers did');

  const [row, ...more] = await live();
  assert.equal(more.length, 0, 'one change row for the transaction');
  const said = (name: string) => row!.find((each) => each.table === table(name));
  assert.deepEqual(said('ledger_entry')?.keys, [{ id: 11 }]);
  assert.deepEqual(
    [said('account')?.kind, said('account')?.keys, said('account')?.columns],
    ['update', [{ id: 1 }], ['posted_minor']],
    'an open account page is told its balance moved',
  );
  // The scope may name any column of the account, so its image before the trigger wrote is kept, as a write's is.
  assert.equal(said('account')?.before?.[0]?.customer_id, 1);
  // Its key assigned by the database and never read back, the audit row is announced for its whole table.
  assert.equal(said('entry_history')?.keys, 'many');

  // A transaction that rolls back keeps none of it.
  await assert.rejects(post(12, true));
  assert.equal(
    (await appStoresOf(adapter).readRecordHistory({ resource: table('account'), key: historyKey({ id: 1 }), limit: 10 })).length,
    1,
  );
  assert.equal((await live()).length, 1);
}

test('SQLite: what an accepted trigger changed is in record history and live sync, and a rollback keeps neither', (t) =>
  heardAndKept(t, sqliteLedger));

test(
  'PostgreSQL: what an accepted trigger changed is in record history and live sync, and a rollback keeps neither',
  { skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => heardAndKept(t, postgresLedger),
);
