/**
 * The host entry's contract (`@mistriwork/engine/host`, docs/boundary.md "The
 * host entry"): imported here by its package name and nothing else, it does
 * what the database browser does with the engine — connect and read the
 * catalog, answer the agent tools' reads, make the recorded writes and undo
 * them, keep the write journal across a restart where the store is
 * provisioned, explain a refused write, and stop a statement that was
 * cancelled. A name the browser uses that leaves the entry, or stops doing
 * this, fails here before the browser's own suite meets it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import * as host from '@mistriwork/engine/host';
import {
  attributeAction,
  attributeWrites,
  changingReferences,
  clampLimit,
  connect,
  deleteImpact,
  describeSchema,
  distance,
  explain,
  explainWriteFailure,
  findTable,
  history,
  inBatches,
  labelPath,
  lastRevertible,
  latestRevertible,
  looksLikeBreakdown,
  parseQuery,
  primaryKey,
  provisionPostgresWriteJournal,
  provisionSqliteWriteJournal,
  quoteValue,
  readBreakdown,
  readCount,
  readRecords,
  readView,
  recordedDelete,
  recordedInsert,
  recordedUpdate,
  recordWrite,
  redact,
  referencesFrom,
  referencesTo,
  Refusal,
  Registry,
  renderDDL,
  resolveConnection,
  revert,
  saveConfig,
  scrubSecrets,
  STATEMENT_TIMEOUT_MS,
  StatementStopped,
  stoppedReason,
  storeSecret,
  summarise,
  tableNamed,
  textToBreakdown,
  textToView,
  throwIfCancelled,
  toMarkdown,
  TransactionOutcomeUnknown,
  UNTRUSTED_NETWORK,
  withCancellation,
  writeFailureOutcome,
  type Adapter,
  type DatabaseSchema,
  type DeleteRule,
  type Filter,
  type ForeignKey,
  type InsertResult,
  type TableMeta,
  type UpdateRequest,
  type ViewDef,
  type WriteTransaction,
} from '@mistriwork/engine/host';

const SECRET = 'SECRET_SENTINEL_e2a0';
let dir: string;

function fixture(name: string): string {
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, secret TEXT);
    CREATE TABLE invoice (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), total REAL NOT NULL, status TEXT NOT NULL);
    INSERT INTO customer VALUES (1, 'Ada', '${SECRET}'), (2, 'Grace', '${SECRET}'), (3, 'Hedy', '${SECRET}');
    INSERT INTO invoice VALUES (1, 1, 120, 'open'), (2, 1, 80, 'paid'), (3, 2, 300, 'open'), (4, 2, 45, 'paid'), (5, 3, 990, 'open'), (6, 3, 10, 'void');
    PRAGMA foreign_keys = ON;`);
  db.close();
  return file;
}

/** A configured, writable connection the way the browser opens one: hidden columns cut from the catalog and every answer. */
async function opened(file: string, id: string) {
  // A writable connection says so, once, when its database holds no journal store; the browser provisions it first (idempotent).
  provisionSqliteWriteJournal(file);
  const registry = new Registry();
  registry.onWarning = (message) => assert.fail(`unexpected warning: ${message}`);
  registry.add({ id, name: 'Contract', url: file, source: 'config', writable: true, hidden: { customer: ['secret'] } });
  const { adapter, schema } = await registry.open(id);
  return { registry, adapter, schema };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mistri-host-contract-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('the entry exports exactly the names the browser uses from it', () => {
  // Exactly: a name the browser does not use is not added here speculatively, and one it uses is not missing.
  assert.deepEqual(Object.keys(host).sort(), [
    'Refusal',
    'Registry',
    'STATEMENT_TIMEOUT_MS',
    'StatementStopped',
    'TransactionOutcomeUnknown',
    'UNTRUSTED_NETWORK',
    'attributeAction',
    'attributeWrites',
    'changingReferences',
    'clampLimit',
    'connect',
    'deleteImpact',
    'describeSchema',
    'distance',
    'explain',
    'explainWriteFailure',
    'findTable',
    'history',
    'inBatches',
    'labelPath',
    'lastRevertible',
    'latestRevertible',
    'looksLikeBreakdown',
    'parseQuery',
    'primaryKey',
    'provisionPostgresWriteJournal',
    'provisionSqliteWriteJournal',
    'quoteValue',
    'readBreakdown',
    'readCount',
    'readRecords',
    'readView',
    'recordWrite',
    'recordedDelete',
    'recordedInsert',
    'recordedUpdate',
    'redact',
    'referencesFrom',
    'referencesTo',
    'renderDDL',
    'resolveConnection',
    'revert',
    'saveConfig',
    'scrubSecrets',
    'stoppedReason',
    'storeSecret',
    'summarise',
    'tableNamed',
    'textToBreakdown',
    'textToView',
    'throwIfCancelled',
    'toMarkdown',
    'withCancellation',
    'writeFailureOutcome',
  ]);
  // The ones the cases below do not call: the config file and the keychain, the network rule, PostgreSQL's provisioning.
  for (const value of [
    UNTRUSTED_NETWORK,
    saveConfig,
    storeSecret,
    resolveConnection,
    Refusal,
    TransactionOutcomeUnknown,
    recordWrite,
    provisionPostgresWriteJournal,
  ])
    assert.ok(value !== undefined);
});

test('connect, and the catalog with its hidden columns cut', async () => {
  const file = fixture('connect.db');
  const raw: Adapter = connect(file);
  try {
    const catalog = await raw.introspect();
    assert.ok(findTable(catalog, 'invoice'));
  } finally {
    await raw.close();
  }
  assert.doesNotMatch(redact('postgres://ana:hunter2@db.example/prod'), /hunter2/);
  assert.doesNotMatch(
    scrubSecrets('could not reach postgres://ana:hunter2@db.example/prod', 'postgres://ana:hunter2@db.example/prod'),
    /hunter2/,
  );

  const { registry, schema } = await opened(file, 'host-catalog');
  try {
    const customer = tableNamed(schema, 'customer')!;
    const invoice = findTable(schema, 'invoice')!;
    assert.deepEqual(primaryKey(invoice), ['id']);
    assert.equal(referencesFrom(schema, 'invoice').length, 1);
    assert.equal(referencesTo(schema, 'customer').length, 1);
    assert.equal(labelPath(schema, customer), 'name');
    assert.ok(!customer.columns.some((column) => column.name === 'secret'), 'a hidden column is not in the catalog');
    assert.match(renderDDL(schema, 'invoice'), /CREATE TABLE/i);
    assert.match(String(toMarkdown(schema)), /invoice/);
    assert.doesNotMatch(String(toMarkdown(schema)), /secret/);
    assert.ok(describeSchema(schema));
  } finally {
    await registry.closeAll();
  }
});

test('the reads the agent tools answer', async () => {
  const { registry, adapter, schema } = await opened(fixture('reads.db'), 'host-reads');
  try {
    const parsed = parseQuery('invoice status = open sort total desc', { schema });
    assert.deepEqual(parsed.errors, []);
    assert.match(explain(parsed.query!), /invoice/);
    const records = await readRecords(adapter, schema, { ...parsed.query!, limit: 2, offset: 0 }, 'exact', 1000);
    assert.deepEqual(
      records.result.rows.map((row) => row.id),
      [5, 3],
    );
    assert.equal(records.total?.count, 3);

    const counted = await readCount(adapter, schema, {
      table: 'invoice',
      filter: { groups: [[{ column: 'customer_id', op: '=', value: 2 }]] },
      exact: true,
      countLimit: 1000,
    });
    assert.equal(counted.count, 2);

    const asView = textToView(schema, 'invoice show id, customer_id.name sort id', { id: 'contract', name: '' });
    assert.deepEqual(asView.errors, []);
    const viewed = await readView(adapter, schema, asView.view!, { limit: 3, offset: 0 }, 'none');
    assert.deepEqual(
      viewed.result.rows.map((row) => Object.values(row)),
      [
        [1, 'Ada'],
        [2, 'Ada'],
        [3, 'Grace'],
      ],
    );

    const text = 'invoice count by status';
    assert.equal(looksLikeBreakdown(text), true);
    const breakdown = textToBreakdown(schema, text);
    assert.deepEqual(breakdown.errors, []);
    const grouped = await readBreakdown(adapter, schema, breakdown.breakdown!, { limit: 20 }, 1000);
    assert.deepEqual(Object.fromEntries(grouped.result.rows.map((row) => Object.values(row) as [string, number])), {
      open: 3,
      paid: 2,
      void: 1,
    });
    assert.equal(quoteValue("O'Neil"), `"O'Neil"`);
    assert.equal(clampLimit(10 ** 9), 100_000);
    assert.equal(distance('invoce', 'invoice'), 1);
  } finally {
    await registry.closeAll();
  }
});

test('the recorded writes, what a delete reaches, a refused write explained, and Undo', async () => {
  const id = 'host-writes';
  const { registry, adapter, schema } = await opened(fixture('writes.db'), id);
  try {
    const inserted = await attributeWrites({ via: 'agent' }, () =>
      recordedInsert({ adapter, connection: id }, { table: 'invoice', values: { id: 7, customer_id: 1, total: 15, status: 'open' } }),
    );
    const updated = await recordedUpdate({ adapter, connection: id }, { table: 'invoice', key: { id: 1 }, values: { status: 'paid' } });
    assert.ok(inserted.undoId && updated.undoId);
    assert.deepEqual(
      history(id).map((entry) => entry.kind),
      ['update', 'insert'],
    );
    assert.equal(summarise('update', [{ table: 'invoice', key: { id: 1 } }]), 'Updated invoice 1');

    const impact = await deleteImpact(adapter, schema, 'customer', { id: 1 });
    assert.match(JSON.stringify(impact), /invoice/);
    assert.deepEqual(await inBatches([1, 2, 3], 2, async (n) => n * 2), [2, 4, 6]);
    const removed = await recordedDelete(
      { adapter, connection: id },
      { table: 'invoice', key: { id: 6 } },
      { references: changingReferences(schema, 'invoice') },
    );
    assert.ok(removed.undoId);

    const orphan = { id: 8, customer_id: 999, total: 1, status: 'open' };
    const refused = await recordedInsert({ adapter, connection: id }, { table: 'invoice', values: orphan }).then(
      () => assert.fail('an invoice for no customer was written'),
      (error: Error) => error,
    );
    assert.equal(writeFailureOutcome(refused), 'rejected');
    assert.match(await explainWriteFailure(adapter, schema, 'invoice', orphan, refused.message), /customer/);

    // Undo walks back newest first: the delete, the update, the insert.
    for (const expected of [removed.undoId, updated.undoId, inserted.undoId]) {
      const next = latestRevertible(history(id, 50));
      assert.equal(next?.id, expected);
      const result = await attributeAction('Undo', () => revert(adapter, id, next!));
      assert.equal(result.outcome, 'applied', result.errors?.join('; '));
    }
    assert.equal(lastRevertible(id), undefined);
    const rows = await readRecords(adapter, schema, {
      table: 'invoice',
      limit: 10,
      offset: 0,
      orderBy: [{ column: 'id', direction: 'asc' }],
    });
    assert.deepEqual(
      rows.result.rows.map((row) => [row.id, row.status]),
      [
        [1, 'open'],
        [2, 'paid'],
        [3, 'open'],
        [4, 'paid'],
        [5, 'open'],
        [6, 'void'],
      ],
    );
  } finally {
    await registry.closeAll();
  }
});

test('the write journal is kept across a restart where the store is provisioned', async () => {
  const file = fixture('journal.db');
  const id = 'host-journal';
  assert.deepEqual(provisionSqliteWriteJournal(file), { version: 1, provisioned: true });
  const first = await opened(file, id);
  let written: number | undefined;
  try {
    written = (
      await recordedUpdate({ adapter: first.adapter, connection: id }, { table: 'customer', key: { id: 2 }, values: { name: 'Grace H' } })
    ).undoId;
  } finally {
    // Closing lands what the journal wrote behind.
    await first.registry.closeAll();
  }
  // A new process: nothing in memory carries over, so what it offers to undo is the store's.
  const restarted = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { Registry, history, lastRevertible, revert } from '@mistriwork/engine/host';
      const registry = new Registry();
      registry.add({ id: ${JSON.stringify(id)}, name: 'Contract', url: ${JSON.stringify(file)}, source: 'config', writable: true, hidden: { customer: ['secret'] } });
      const { adapter } = await registry.open(${JSON.stringify(id)});
      const offered = lastRevertible(${JSON.stringify(id)});
      const said = JSON.stringify(history(${JSON.stringify(id)}));
      const undone = await revert(adapter, ${JSON.stringify(id)}, offered);
      await registry.closeAll();
      console.log(JSON.stringify({ offered: offered?.id, said, outcome: undone.outcome }));`,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  const answer = JSON.parse(restarted.trim().split('\n').pop()!) as { offered: number; said: string; outcome: string };
  assert.equal(answer.offered, written);
  assert.doesNotMatch(answer.said, new RegExp(SECRET));
  assert.equal(answer.outcome, 'applied');
});

test('a cancelled statement stops, and says why', async () => {
  const { registry, adapter } = await opened(fixture('cancel.db'), 'host-cancel');
  try {
    assert.ok(STATEMENT_TIMEOUT_MS > 0);
    const stop = new AbortController();
    stop.abort();
    assert.throws(() => throwIfCancelled(stop.signal), StatementStopped);
    const stopped = await withCancellation(stop.signal, () => adapter.query({ table: 'invoice', limit: 1, offset: 0 })).then(
      () => assert.fail('a cancelled read answered'),
      (error: unknown) => error,
    );
    assert.equal(stoppedReason(stopped), 'cancelled');
  } finally {
    await registry.closeAll();
  }
});

/* The types a host writes against are the entry's too. */
export type HostTypes = [
  Adapter,
  DatabaseSchema,
  DeleteRule,
  Filter,
  ForeignKey,
  InsertResult,
  TableMeta,
  UpdateRequest,
  ViewDef,
  WriteTransaction,
];
