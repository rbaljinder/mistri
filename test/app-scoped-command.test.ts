import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Filter, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandTransactionFailure,
  migrateSqliteCommandJournal,
  type CommandJournal,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { assertScopeCatalog, captureScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const receipt: StoredCommandReceipt = {
  id: 'receipt-1',
  appId: 'desk',
  actorId: 'reviewer',
  commandId: 'assign',
  commandVersion: 1,
  idempotencyKey: 'attempt-1',
  fingerprint: 'digest',
  resultJson: '{"assigned":true}',
  requestId: 'request-1',
  completedAt: '2026-09-07T12:00:00.000Z',
};
const audit = { target: 'tickets', keyJson: '{"id":1}', changesJson: '[{"field":"name"}]' };
const rule = (value: number): Filter => ({ groups: [[{ column: 'desk', op: '=', value }]] });
const query = (table: string) => ({ table, limit: 20, offset: 0 });
const update = (table: string) => ({ table, key: { id: 1 }, values: { name: 'Updated' } });
// A table by name, or a subquery (a receipt's targets, support/commandTargets.ts).
const count = (db: DatabaseSync, table: string) =>
  db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`).get()!.n;
const name = (db: DatabaseSync) => db.prepare('SELECT name FROM raw_ticket WHERE id = 1').get()!.name;
const modes = ['logical', 'default', 'secondary'] as const;
type Mode = (typeof modes)[number];
function failed(cause: Error | ((error: unknown) => boolean)) {
  return (error: unknown) => {
    assert.ok(error instanceof CommandTransactionFailure);
    assert.equal(error.outcome, 'not_applied');
    if (typeof cause === 'function') assert.equal(cause(error.cause), true);
    else assert.equal(error.cause, cause);
    return true;
  };
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) frozen(child);
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-scoped-command-'));
  const sources: Record<string, AppAdapterSource> = {};
  const databases = new Map<string, DatabaseSync>();
  t.after(async () => {
    try {
      await Promise.all(Object.values(sources).map((source) => source.adapter.close()));
    } finally {
      for (const db of databases.values()) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const source of ['operations', 'archive']) {
    const path = join(directory, `${source}.db`);
    const db = new DatabaseSync(path);
    databases.set(source, db);
    db.exec(`CREATE TABLE raw_person (id INTEGER PRIMARY KEY, desk INTEGER, name TEXT);
      CREATE TABLE raw_ticket (id INTEGER PRIMARY KEY, desk INTEGER DEFAULT 1, name TEXT,
        owner_id INTEGER DEFAULT 1 REFERENCES raw_person(id));
      INSERT INTO raw_person VALUES (1, 1, 'Visible'), (2, 2, 'Hidden');
      INSERT INTO raw_ticket VALUES (1, 1, 'Original', 1), (2, 2, 'Hidden', 2);`);
    migrateSqliteCommandJournal(path);
    const adapter = new SqliteAdapter(path, source);
    sources[source] = {
      adapter,
      schema: await adapter.introspect(),
      writable: true,
      resources: { people: 'raw_person', tickets: 'raw_ticket' },
    };
  }
  const runtime = () => createAppSourceAdapter(sources, 'operations');
  const select = (mode: Mode) => {
    const app = runtime();
    const logical = createAppResources(sources.operations.adapter, sources.operations.schema, sources.operations.resources);
    const owner = mode === 'secondary' ? 'archive' : 'operations';
    const prefix = mode === 'secondary' ? 'archive.' : '';
    const people = `${prefix}people`,
      tickets = `${prefix}tickets`;
    return {
      app,
      owner,
      people,
      tickets,
      db: databases.get(owner)!,
      adapter: mode === 'logical' ? logical.adapter : app.forSource(owner),
      catalog: mode === 'logical' ? logical.schema : app.schema,
      scope: { [people]: rule(1), [tickets]: rule(1) },
    };
  };
  return { sources, databases, runtime, select };
}

for (const mode of modes) {
  test(`${mode}: scoped commands map five record methods and commit records, receipt and audit atomically`, async (t) => {
    const { select, databases } = await fixture(t);
    const { adapter, scope, people, tickets, db, owner, catalog } = select(mode);
    const result = await commandsOf(adapter).scopeCommandTransaction!(scope, async function (records, journal, evidence) {
      assert.equal(arguments.length, 3);
      assert.deepEqual(Reflect.ownKeys(records).sort(), ['count', 'insert', 'query', 'remove', 'update']);
      assert.equal(Object.isFrozen(records), true);
      assert.deepEqual(Reflect.ownKeys(journal).sort(), ['commit', 'find', 'insert', 'kept', 'nextNumber', 'taken']);
      assert.notEqual(evidence, catalog);
      frozen(evidence);
      assert.deepEqual(evidence.tables.map((table) => table.id).sort(), [people, tickets].sort());
      assert.ok(evidence.tables.every((table) => table.name === table.id && table.schema === ''));
      assert.deepEqual(
        evidence.foreignKeys.map((fk) => [fk.from.table, fk.to.table]),
        [[tickets, people]],
      );
      assert.equal(
        evidence.tables.find((table) => table.id === tickets)!.columns.find((column) => column.name === 'owner_id')!.references!.table,
        people,
      );
      assert.equal(JSON.stringify(evidence).includes('__mistri_command_'), false);
      assert.equal(await journal.find(receipt), undefined);
      assert.deepEqual(
        (await records.query(query(tickets))).rows.map((row) => row.id),
        [1],
      );
      assert.equal(await records.count(people), 1);
      await records.update(update(tickets));
      await records.insert({ table: tickets, values: { id: 3, name: 'Inserted' } });
      assert.equal(await records.count(tickets), 2);
      await records.remove({ table: tickets, key: { id: 3 } });
      await journal.commit(receipt, { ...audit, target: tickets });
      assert.deepEqual(await journal.find(receipt), receipt);
      assert.equal(name(db), 'Original');
      assert.equal(count(db, tables.receipt), 0);
      assert.equal(count(db, sqliteAuditRows), 0);
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(name(db), 'Updated');
    assert.equal(count(db, 'raw_ticket'), 2);
    assert.equal(count(db, tables.receipt), 1);
    assert.equal(count(db, sqliteAuditRows), 1);
    assert.deepEqual(
      { ...db.prepare(`SELECT target, key_json, changes_json FROM ${sqliteAuditRows} a`).get()! },
      { target: tickets, key_json: audit.keyJson, changes_json: audit.changesJson },
    );
    const other = databases.get(owner === 'archive' ? 'operations' : 'archive')!;
    assert.equal(name(other), 'Original');
    assert.equal(count(other, tables.receipt), 0);
    assert.equal(count(other, sqliteAuditRows), 0);
  });

  test(`${mode}: callback failure rolls back records and the paired journal`, async (t) => {
    const { select } = await fixture(t);
    const { adapter, scope, tickets, db } = select(mode);
    const cause = new Error('runtime callback failed');
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction!(scope, async (records, journal) => {
        await records.update(update(tickets));
        await journal.commit(receipt, audit);
        throw cause;
      }),
      failed(cause),
    );
    assert.equal(name(db), 'Original');
    assert.equal(count(db, tables.receipt), 0);
    assert.equal(count(db, sqliteAuditRows), 0);
  });

  test(`${mode}: caught exact-ID mapping refusals in every method roll back earlier records and journal`, async (t) => {
    const { select } = await fixture(t);
    const { adapter, scope, tickets, db } = select(mode);
    const invalid = [
      'missing',
      'raw_ticket',
      'operations.tickets',
      'archive.raw_ticket',
      ...Object.values(tables),
      mode === 'secondary' ? 'tickets' : 'archive.tickets',
    ];
    for (const table of invalid)
      for (const operation of [
        (tx: WriteTransaction) => tx.query(query(table)),
        (tx: WriteTransaction) => tx.count(table),
        (tx: WriteTransaction) => tx.insert({ table, values: { id: 3 } }),
        (tx: WriteTransaction) => tx.update(update(table)),
        (tx: WriteTransaction) => tx.remove({ table, key: { id: 1 } }),
      ]) {
        let caught: unknown;
        await assert.rejects(
          commandsOf(adapter).scopeCommandTransaction!(scope, async (records, journal) => {
            await records.update(update(tickets));
            await journal.commit(receipt, audit);
            try {
              await operation(records);
            } catch (error) {
              caught = error;
            }
          }),
          failed((error) => error instanceof Refusal && /Unknown app resource|belongs to source/.test(error.message)),
        );
        assert.ok(caught instanceof Refusal);
        assert.equal(name(db), 'Original');
        assert.equal(count(db, tables.receipt), 0);
        assert.equal(count(db, sqliteAuditRows), 0);
      }
  });

  test(`${mode}: entire scope validates before physical invocation, including unused and foreign rules`, async (t) => {
    const { sources, select } = await fixture(t);
    let calls = 0;
    for (const source of Object.values(sources)) {
      const bind = commandsOf(source.adapter).scopeCommandTransaction!.bind(source.adapter);
      source.adapter.scopeCommandTransaction = (scope, run) => {
        calls++;
        return bind(scope, run);
      };
    }
    const { adapter, scope, people, tickets } = select(mode);
    let callbacks = 0,
      getters = 0;
    for (const input of [
      { ...scope, [people]: { groups: [[{ column: 'missing', op: '=', value: 1 }]] } },
      { [tickets]: true, [people]: { groups: [] } },
      { ...scope, missing: true },
      { ...scope, raw_ticket: true },
      { ...scope, 'operations.tickets': true },
      { ...scope, 'archive.raw_ticket': true },
      { ...scope, [mode === 'secondary' ? 'tickets' : 'archive.tickets']: true },
      ...Object.values(tables).map((table) => ({ ...scope, [table]: true })),
      Object.create(scope),
      Object.defineProperty({}, tickets, {
        enumerable: true,
        get() {
          getters++;
          return true;
        },
      }),
    ])
      await assert.rejects(
        commandsOf(adapter).scopeCommandTransaction!(input as RowScope, async () => {
          callbacks++;
        }),
        Refusal,
      );
    assert.equal(calls, 0);
    assert.equal(callbacks, 0);
    assert.equal(getters, 0);
  });

  test(`${mode}: all policy rules are detached and physically mapped before an asynchronous bind`, async (t) => {
    const { sources, select } = await fixture(t);
    const release = gate();
    let captured!: RowScope;
    const owner = mode === 'secondary' ? 'archive' : 'operations';
    const physical = sources[owner].adapter;
    const bind = commandsOf(physical).scopeCommandTransaction!.bind(physical);
    physical.scopeCommandTransaction = async (scope, run) => {
      captured = scope;
      await release.promise;
      return bind(scope, run);
    };
    const { adapter, people, tickets } = select(mode);
    const peopleRule = rule(1),
      ticketRule = rule(1);
    const input: Record<string, boolean | Filter> = { [people]: peopleRule, [tickets]: ticketRule };
    const pending = commandsOf(adapter).scopeCommandTransaction!(input, async (records) => {
      assert.deepEqual(
        (await records.query(query(people))).rows.map((row) => row.id),
        [1],
      );
      assert.deepEqual(
        (await records.query(query(tickets))).rows.map((row) => row.id),
        [1],
      );
    });
    try {
      assert.deepEqual(Object.keys(captured).sort(), ['raw_person', 'raw_ticket']);
      frozen(captured);
      peopleRule.groups[0][0].value = 2;
      ticketRule.groups[0][0].value = 2;
      delete input[people];
      input[tickets] = true;
      assert.equal((captured.raw_person as Filter).groups[0][0].value, 1);
      assert.equal((captured.raw_ticket as Filter).groups[0][0].value, 1);
    } finally {
      release.release();
    }
    await pending;
  });

  test(`${mode}: evidence identities and validation ignore mutated presentation catalogs and new unrelated tables`, async (t) => {
    const { select } = await fixture(t);
    const { adapter, app, scope, people, tickets, db, catalog } = select(mode);
    const added = structuredClone(catalog.tables.find((table) => table.id === tickets)!);
    added.id = 'late';
    added.name = 'late';
    db.exec('CREATE TABLE late (id INTEGER PRIMARY KEY)');
    catalog.tables.push(added);
    catalog.tables.find((table) => table.id === people)!.columns.length = 0;
    catalog.foreignKeys.length = 0;
    for (const local of app.catalogs.values()) {
      local.schema.tables.length = 0;
      local.schema.foreignKeys.length = 0;
    }
    let retained!: DatabaseSchema;
    await commandsOf(adapter).scopeCommandTransaction!(scope, async (records, _journal, evidence) => {
      retained = evidence;
      assert.deepEqual(evidence.tables.map((table) => table.id).sort(), [people, tickets].sort());
      assert.equal(evidence.foreignKeys.length, 1);
      await records.update(update(tickets));
    });
    frozen(retained);
    assert.equal(JSON.stringify(retained).includes('__mistri_command_'), false);
    assert.equal(retained.tables.find((table) => table.id === people)!.columns.length, 3);
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction!({ ...scope, late: true }, async () => {}),
      Refusal,
    );
    assert.equal(name(db), 'Updated');
  });

  test(`${mode}: missing, malformed or incomplete callback evidence refuses before the trusted callback`, async (t) => {
    const { sources, select } = await fixture(t);
    const physical = sources[mode === 'secondary' ? 'archive' : 'operations'].adapter;
    const bind = commandsOf(physical).scopeCommandTransaction!.bind(physical);
    let callbacks = 0,
      fallbacks = 0;
    const fallback = async (): Promise<never> => {
      fallbacks++;
      throw new Error('ordinary fallback');
    };
    physical.transaction = fallback;
    physical.commandTransaction = fallback;
    physical.scopeTransaction = fallback;
    for (const shape of ['absent', 'null', 'malformed', 'missing table'] as const) {
      physical.scopeCommandTransaction = (scope, run) =>
        bind(scope, (records, journal, evidence) => {
          const supplied =
            shape === 'absent'
              ? undefined
              : shape === 'null'
                ? null
                : shape === 'malformed'
                  ? {}
                  : {
                      ...evidence,
                      tables: evidence.tables.filter((table) => table.id !== 'raw_ticket'),
                      foreignKeys: [],
                    };
          return run(records, journal, supplied as DatabaseSchema);
        });
      const { adapter, scope, db } = select(mode);
      await assert.rejects(
        commandsOf(adapter).scopeCommandTransaction!(scope, async () => {
          callbacks++;
        }),
        failed((error) => error instanceof Refusal && /catalog/.test(error.message)),
      );
      assert.equal(name(db), 'Original');
      assert.equal(count(db, tables.receipt), 0);
      assert.equal(count(db, sqliteAuditRows), 0);
    }
    assert.equal(callbacks, 0);
    assert.equal(fallbacks, 0);
  });

  test(`${mode}: changed writer evidence survives mapping so trusted attestation can refuse stale metadata`, async (t) => {
    const { select } = await fixture(t);
    const { adapter, scope, people, tickets, db } = select(mode);
    let baseline!: DatabaseSchema;
    await commandsOf(adapter).scopeCommandTransaction!(scope, async (_records, _journal, evidence) => {
      baseline = captureScopeCatalog(evidence);
    });
    db.exec('ALTER TABLE raw_ticket ADD COLUMN fresh_note TEXT');
    let delivered!: DatabaseSchema;
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction!(scope, async (_records, _journal, evidence) => {
        delivered = evidence;
        assertScopeCatalog(baseline, evidence);
        assert.fail('changed evidence must refuse before business execution');
      }),
      failed((error) => error instanceof Refusal && /catalog/.test(error.message)),
    );
    assert.deepEqual(delivered.tables.map((table) => table.id).sort(), [people, tickets].sort());
    assert.equal(
      delivered.tables.find((table) => table.id === tickets)!.columns.find((column) => column.name === 'fresh_note')!.type,
      'TEXT',
    );
    assert.equal(
      baseline.tables.find((table) => table.id === tickets)!.columns.some((column) => column.name === 'fresh_note'),
      false,
    );
    frozen(delivered);
    assert.equal(JSON.stringify(delivered).includes('__mistri_command_'), false);
    assert.equal(name(db), 'Original');
    assert.equal(count(db, tables.receipt), 0);
    assert.equal(count(db, sqliteAuditRows), 0);
  });

  test(`${mode}: evidence detaches from provider mutation while the runtime journal retains its identity`, async (t) => {
    const { sources, select } = await fixture(t);
    const physical = sources[mode === 'secondary' ? 'archive' : 'operations'].adapter;
    const bind = commandsOf(physical).scopeCommandTransaction!.bind(physical);
    let originalJournal!: CommandJournal;
    physical.scopeCommandTransaction = (scope, run) =>
      bind(scope, (records, journal, evidence) => {
        originalJournal = journal;
        const supplied = structuredClone(evidence);
        const pending = run(records, journal, supplied);
        supplied.tables.find((table) => table.id === 'raw_ticket')!.columns.length = 0;
        supplied.foreignKeys[0].to.table = 'mutated';
        return pending;
      });
    const { adapter, scope, people, tickets } = select(mode);
    await commandsOf(adapter).scopeCommandTransaction!(scope, async (records, journal, evidence) => {
      await Promise.resolve();
      assert.equal(journal, originalJournal);
      assert.equal(evidence.tables.find((table) => table.id === tickets)!.columns.length, 4);
      assert.equal(evidence.foreignKeys[0].to.table, people);
      assert.equal(
        evidence.tables.find((table) => table.id === tickets)!.columns.find((column) => column.name === 'owner_id')!.references!.table,
        people,
      );
      frozen(evidence);
      assert.equal(await records.count(tickets), 1);
      await journal.commit(receipt, audit);
    });
  });

  for (const rollback of [false, true]) {
    test(`${mode}: retained record and journal handles expire after ${rollback ? 'rollback' : 'commit'}`, async (t) => {
      const { select } = await fixture(t);
      const { adapter, scope, tickets, db } = select(mode);
      let records!: WriteTransaction, journal!: CommandJournal;
      const cause = new Error('rollback');
      const pending = commandsOf(adapter).scopeCommandTransaction!(scope, async (tx, runtimeJournal) => {
        records = tx;
        journal = runtimeJournal;
        await tx.update(update(tickets));
        await journal.commit(receipt, audit);
        if (rollback) throw cause;
      });
      if (rollback) await assert.rejects(pending, failed(cause));
      else await pending;
      for (const late of [
        () => records.query(query(tickets)),
        () => records.count(tickets),
        () => records.insert({ table: tickets, values: { id: 3 } }),
        () => records.update(update(tickets)),
        () => records.remove({ table: tickets, key: { id: 1 } }),
        () => journal.find(receipt),
        () => journal.commit({ ...receipt, id: 'late', idempotencyKey: 'late' }, audit),
      ])
        await assert.rejects(late, /no longer active/);
      assert.equal(name(db), rollback ? 'Original' : 'Updated');
      assert.equal(count(db, tables.receipt), rollback ? 0 : 1);
      assert.equal(count(db, sqliteAuditRows), rollback ? 0 : 1);
    });
  }
}

test('scoped command capability requires a writable supported anchor and has no ordinary fallback', async (t) => {
  const { sources, runtime } = await fixture(t);
  let fallbacks = 0;
  for (const source of Object.values(sources)) {
    const fallback = async (): Promise<never> => {
      fallbacks++;
      throw new Error('ordinary fallback');
    };
    source.adapter.transaction = fallback;
    source.adapter.commandTransaction = fallback;
    source.adapter.scopeTransaction = fallback;
  }
  sources.archive.adapter.scopeCommandTransaction = undefined;
  const app = runtime();
  assert.equal('scopeCommandTransaction' in app.adapter, false);
  assert.equal('scopeCommandTransaction' in app.forSource('archive'), false);
  assert.equal(typeof commandsOf(app.forSource('operations')).scopeCommandTransaction, 'function');
  await commandsOf(app.forSource('operations')).scopeCommandTransaction!({ tickets: true, people: true }, async (records) => {
    assert.equal(await records.count('tickets'), 2);
  });
  const logical = createAppResources(sources.archive.adapter, sources.archive.schema, sources.archive.resources);
  assert.equal('scopeCommandTransaction' in logical.adapter, false);
  sources.operations.writable = false;
  assert.equal('scopeCommandTransaction' in runtime().forSource('operations'), false);
  assert.equal(fallbacks, 0);
});

test('both source policies capture independently despite identical physical IDs and interleaved binds', async (t) => {
  const { sources, runtime, databases } = await fixture(t);
  const release = gate();
  const captured = new Map<string, RowScope>();
  for (const [owner, source] of Object.entries(sources)) {
    const bind = commandsOf(source.adapter).scopeCommandTransaction!.bind(source.adapter);
    source.adapter.scopeCommandTransaction = async (scope, run) => {
      captured.set(owner, scope);
      await release.promise;
      return bind(scope, run);
    };
  }
  const app = runtime();
  const primary = rule(1),
    secondary = rule(2);
  const first = commandsOf(app.forSource('operations')).scopeCommandTransaction!({ people: primary, tickets: false }, async (records) => {
    assert.deepEqual(
      (await records.query(query('people'))).rows.map((row) => row.id),
      [1],
    );
    assert.equal(await records.count('tickets'), 0);
  });
  const second = commandsOf(app.forSource('archive')).scopeCommandTransaction!(
    { 'archive.people': secondary, 'archive.tickets': true },
    async (records, journal) => {
      assert.deepEqual(
        (await records.query(query('archive.people'))).rows.map((row) => row.id),
        [2],
      );
      assert.equal(await records.count('archive.tickets'), 2);
      await journal.commit(receipt, audit);
    },
  );
  try {
    primary.groups[0][0].value = 2;
    secondary.groups[0][0].value = 1;
    assert.equal(captured.size, 2);
    assert.notEqual(captured.get('operations'), captured.get('archive'));
    assert.equal(captured.get('operations')!.raw_ticket, false);
    assert.equal(captured.get('archive')!.raw_ticket, true);
  } finally {
    release.release();
  }
  await Promise.all([first, second]);
  assert.equal(count(databases.get('operations')!, tables.receipt), 0);
  assert.equal(count(databases.get('archive')!, tables.receipt), 1);
});

test('reserved physical journal tables cannot be enrolled through logical or source aliases', async (t) => {
  const { sources, runtime } = await fixture(t);
  for (const table of Object.values(tables)) {
    assert.throws(() => createAppResources(sources.operations.adapter, sources.operations.schema, { receipts: table }), /unknown table/);
    sources.archive.resources = { receipts: table };
    assert.throws(runtime, /unknown table/);
  }
});
