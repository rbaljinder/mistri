// test-package: shared — holds the database browser and the App framework to one rule (scripts/test-owners.mjs).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Adapter, QueryRequest } from '../packages/engine/src/adapters/adapter.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { runTool } from '../packages/tablewalk/src/server/mcp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const appId = 'recorded-http';
const physical = 'physical_items';
const secret = 'PRIVATE_RECORDED_HTTP_SENTINEL';
type Source = 'ops' | 'stock';
type Reply = { status: number; body: any };
type Fixture = {
  registry: Registry;
  owners: Record<Source, string>;
  databases: Partial<Record<Source, DatabaseSync>>;
  adapters: Partial<Record<Source, Adapter>>;
  table: string;
  session: { id: string; who: string; role: string };
  call: (path: string, body?: Record<string, unknown>) => Promise<Reply>;
  row: (source?: Source, id?: number) => Record<string, unknown> | undefined;
};

async function fixture(
  options: {
    browser?: boolean;
    fields?: boolean;
    multi?: boolean;
    denied?: boolean;
    readOnly?: boolean;
    historyRestriction?: 'resource' | 'field';
  },
  run: (f: Fixture) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-recorded-http-'));
  const owners = { ops: `${basename(directory)}-ops`, stock: `${basename(directory)}-stock` };
  const databases: Fixture['databases'] = {};
  const adapters: Fixture['adapters'] = {};
  const registry = new Registry();
  let server: Server | undefined;
  try {
    for (const source of options.multi ? (['ops', 'stock'] as const) : (['ops'] as const)) {
      const file = join(directory, `${source}.db`);
      const db = (databases[source] = new DatabaseSync(file));
      db.exec(`CREATE TABLE ${physical} (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE,
        score INTEGER NOT NULL DEFAULT 7, private_note TEXT NOT NULL DEFAULT '${secret}');`);
      db.prepare(`INSERT INTO ${physical} (id, name) VALUES (1, ?), (2, ?)`).run(`${source} original`, `${source} second`);
      if (options.historyRestriction === 'resource') {
        db.exec(`CREATE TABLE physical_hidden (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
          INSERT INTO physical_hidden VALUES (1, 'hidden original');`);
      }
      registry.add({
        id: owners[source],
        name: owners[source],
        url: file,
        source: 'config',
        writable: !options.readOnly && (source === 'stock' || !options.multi),
      });
      adapters[source] = (await registry.open(owners[source])).adapter;
    }
    const tables = options.multi
      ? ['item', 'inventory.item']
      : options.historyRestriction === 'resource'
        ? ['item', 'hidden_item']
        : ['item'];
    const writes = options.denied ? [] : options.multi ? ['inventory.item'] : tables;
    const session = { id: 'verified-account', who: 'operator@example.test', role: 'operator' };
    const viewKey = (table: string) => table.replace(/[._]/g, '-');
    const definition = parseAppConfig(
      {
        id: appId,
        name: 'Recorded HTTP',
        ...(options.multi
          ? {
              sources: { operations: { connection: owners.ops, default: true }, inventory: { connection: owners.stock } },
            }
          : { connection: owners.ops }),
        resources: Object.fromEntries(
          tables.map((table) => [
            table,
            {
              physical: table === 'hidden_item' ? 'physical_hidden' : physical,
              ...(writes.includes(table) ? { access: 'write' } : {}),
              ...(writes.includes(table) ? { delete: true } : {}),
            },
          ]),
        ),
        auth: {
          roles: {
            operator: {
              read: true,
              write: true,
              ...(options.fields
                ? {
                    fields: Object.fromEntries(
                      tables.map((table) => [table, { read: ['id', 'name'], write: writes.includes(table) ? ['name'] : [] }]),
                    ),
                  }
                : {}),
            },
            ...(options.historyRestriction
              ? {
                  limited: {
                    read: ['item'],
                    write: ['item'],
                    ...(options.historyRestriction === 'field'
                      ? {
                          fields: { item: { read: ['id', 'name'], write: ['name'] } },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        },
        views: Object.fromEntries(tables.map((table) => [viewKey(table), { kind: 'list', from: table }])),
        home: 'item',
        nav: tables.map(viewKey),
      },
      'recorded HTTP fixture',
    );
    const host: AppHost = {
      app: { path: join(directory, 'app.ts'), app: definition, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: definition.auth!,
        store: 'unused',
        handler: async () => {},
        close: async () => {},
        session: async () => ({ ...session }),
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    server = createApp({ registry, bound, ...(options.browser ? {} : { apps: [host] }) });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({
      registry,
      owners,
      databases,
      adapters,
      session,
      table: options.browser ? physical : 'item',
      row: (source = 'ops', id = 1) => {
        const row = databases[source]!.prepare(`SELECT * FROM ${physical} WHERE id = ?`).get(id);
        return row ? { ...row } : undefined;
      },
      call: async (path, body = {}) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5_000),
          body: JSON.stringify({ ...(options.browser ? { conn: owners.ops } : { app: appId }), ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    if (server) {
      const closing = new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections();
      await closing;
    }
    await registry.closeAll();
    for (const source of ['ops', 'stock'] as const) {
      databases[source]?.close();
      clearJournal(owners[source]);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function successful(reply: Reply) {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.ok(!reply.body.errors?.length, JSON.stringify(reply.body));
  return reply.body;
}

async function rename(f: Fixture, name: string) {
  return successful(await f.call('/api/update', { table: f.table, key: { id: 1 }, values: { name } }));
}

async function undo(f: Fixture, expectedId: number) {
  assert.equal(successful(await f.call('/api/revert', { confirm: true, expectedId })).reverted, true);
}

function ordinaryWriteSpy(adapter: Adapter) {
  const calls: string[] = [];
  for (const method of ['update', 'insert', 'remove'] as const) {
    const original = adapter[method]!.bind(adapter);
    // The transaction's own operations must never dispatch via these entry points.
    Reflect.set(adapter, method, (...args: unknown[]) => {
      calls.push(method);
      return Reflect.apply(original, adapter, args);
    });
  }
  return calls;
}

test('recorded HTTP update captures the original after a competing writer reaches transaction entry', async () => {
  await fixture({ browser: true }, async (f) => {
    const adapter = f.adapters.ops!;
    const transaction = adapter.transaction!.bind(adapter);
    const ordinary = ordinaryWriteSpy(adapter);
    let entries = 0;
    adapter.transaction = (run) => {
      entries++;
      f.databases.ops!.exec(`UPDATE ${physical} SET name = 'racing stored value' WHERE id = 1`);
      return transaction(run);
    };
    const saved = await rename(f, 'saved value');
    assert.equal(entries, 1);
    assert.deepEqual(ordinary, []);
    assert.deepEqual(history(f.owners.ops)[0].steps[0].before, { name: 'racing stored value' });
    assert.equal(f.row()?.name, 'saved value');
    adapter.transaction = transaction;
    await undo(f, saved.undoId);
    assert.equal(f.row()?.name, 'racing stored value');
  });
});

test('recorded HTTP delete restores the complete writer-entry image, not its earlier preview', async () => {
  await fixture({ browser: true }, async (f) => {
    successful(await f.call('/api/delete', { table: f.table, key: { id: 1 } }));
    assert.deepEqual(history(f.owners.ops), []);
    const adapter = f.adapters.ops!;
    const transaction = adapter.transaction!.bind(adapter);
    let entered = false;
    adapter.transaction = (run) => {
      entered = true;
      f.databases.ops!.exec(`UPDATE ${physical} SET name = 'racing deletion', score = 42 WHERE id = 1`);
      return transaction(run);
    };
    const removed = successful(await f.call('/api/delete', { table: f.table, key: { id: 1 }, confirm: true }));
    assert.equal(entered, true);
    assert.equal(removed.deleted, true);
    assert.equal(f.row(), undefined);
    const entry = history(f.owners.ops)[0];
    assert.deepEqual(entry.steps[0].before, { id: 1, name: 'racing deletion', score: 42, private_note: secret });
    if (removed.undoId !== undefined) assert.equal(removed.undoId, entry.id);
    adapter.transaction = transaction;
    await undo(f, entry.id);
    assert.deepEqual(f.row(), entry.steps[0].before);
  });
});

test('recorded HTTP expected numeric coercion never becomes the stored Undo original', async () => {
  await fixture({ browser: true }, async (f) => {
    const saved = successful(
      await f.call('/api/update', {
        table: f.table,
        key: { id: 1 },
        values: { name: 'changed', score: 8 },
        expected: { name: 'ops original', score: '007' },
      }),
    );
    assert.equal(saved.affected, 1);
    assert.deepEqual(history(f.owners.ops)[0].steps[0].before, { name: 'ops original', score: 7 });
    await undo(f, saved.undoId);
    assert.equal(f.row()?.name, 'ops original');
    assert.equal(f.row()?.score, 7);
  });
});

test('recorded HTTP refuses a case-changed expected image even on a NOCASE column', async () => {
  await fixture({}, async (f) => {
    const before = f.row();
    const reply = await f.call('/api/update', {
      table: f.table,
      key: { id: 1 },
      values: { name: 'changed' },
      expected: { name: 'OPS ORIGINAL' },
    });
    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.equal(reply.body.code, 'record_conflict');
    assert.equal(reply.body.undoId, undefined);
    assert.deepEqual(f.row(), before);
    assert.deepEqual(history(f.owners.ops), []);
  });
});

test('recorded HTTP confirmed constraint rollback sanitizes driver details and keeps the previous save', async () => {
  await fixture({}, async (f) => {
    await rename(f, 'older saved');
    const adapter = f.adapters.ops!;
    const transaction = adapter.transaction!.bind(adapter);
    let mutated = false;
    adapter.transaction = (run) =>
      transaction(async (tx) => {
        await run(tx);
        mutated = true;
        throw Object.assign(new Error(`UNIQUE constraint failed: ${secret}`), { code: 'ERR_SQLITE_ERROR', errcode: 2067 });
      });
    const refused = await f.call('/api/update', { table: f.table, key: { id: 1 }, values: { name: 'rolled back' } });
    assert.equal(mutated, true);
    assert.equal(refused.status, 200);
    assert.equal(refused.body.outcome, 'rejected');
    assert.equal(refused.body.errors[0].code, 'duplicate_value');
    assert.equal(refused.body.undoId, undefined);
    assert.doesNotMatch(JSON.stringify(refused.body), /PRIVATE_RECORDED_HTTP_SENTINEL/);
    assert.equal(f.row()?.name, 'older saved');
    // An App journals nothing: it has no Undo.
    assert.deepEqual(history(f.owners.ops), []);
    adapter.transaction = transaction;
  });
});

test('recorded HTTP field-limited updates lock the row and read nothing hidden, inside the writer', async () => {
  await fixture({ fields: true }, async (f) => {
    const adapter = f.adapters.ops!;
    const transaction = adapter.transaction!.bind(adapter);
    const query = adapter.query.bind(adapter);
    const outside: QueryRequest[] = [];
    const inside: QueryRequest[] = [];
    const events: string[] = [];
    adapter.query = (request) => {
      outside.push(request);
      return query(request);
    };
    adapter.transaction = (run) =>
      transaction((tx) =>
        run({
          ...tx,
          lockRecord: (request) => {
            events.push('lock');
            assert.deepEqual(request, { table: physical, key: { id: 1 } });
            assert.ok(tx.lockRecord);
            return tx.lockRecord(request);
          },
          query: (request) => {
            events.push('read');
            inside.push(request);
            return tx.query(request);
          },
          update: (request) => {
            events.push('update');
            return tx.update(request);
          },
        }),
      );
    const saved = await rename(f, 'permitted');
    // The row is locked for the write it replaces; an App keeps no before-image to read (no Undo).
    assert.deepEqual(events, ['lock', 'update']);
    assert.deepEqual(inside, []);
    assert.deepEqual(outside, [], 'the save must not use the ordinary reader');
    assert.deepEqual(history(f.owners.ops), []);
    assert.doesNotMatch(JSON.stringify(saved), /private_note|PRIVATE_RECORDED_HTTP_SENTINEL/);
    adapter.transaction = transaction;
    assert.equal(f.row()?.private_note, secret);
    assert.equal(f.row()?.name, 'permitted');
  });
});

for (const kind of ['update', 'insert', 'delete'] as const) {
  test(`recorded HTTP ${kind} anchors the authorized secondary writer with a read-only default`, async () => {
    await fixture({ multi: true }, async (f) => {
      const adapter = f.adapters.stock!;
      const transaction = adapter.transaction!.bind(adapter);
      const ordinary = ordinaryWriteSpy(adapter);
      let entries = 0;
      adapter.transaction = (run) => {
        entries++;
        return transaction(run);
      };
      const primary = f.row();
      const secondary = f.row('stock');
      const body =
        kind === 'insert'
          ? { values: { id: 9, name: 'secondary created' } }
          : kind === 'update'
            ? { key: { id: 1 }, values: { name: 'secondary updated' } }
            : { key: { id: 1 }, confirm: true };
      const saved = successful(
        await f.call(`/api/${kind}`, { table: 'inventory.item', ...body, principal: 'forged-account', by: 'forged@example.test' }),
      );
      assert.equal(entries, 1);
      assert.deepEqual(ordinary, []);
      assert.deepEqual(f.row(), primary);
      // An App journals nothing: it has no Undo.
      assert.deepEqual([history(f.owners.ops), history(f.owners.stock)], [[], []]);
      assert.equal(saved.undoId, undefined);
      if (kind === 'insert') assert.equal(f.row('stock', 9)?.name, 'secondary created');
      else assert.equal(f.row('stock')?.name, kind === 'delete' ? undefined : 'secondary updated');
      if (kind !== 'insert') assert.notDeepEqual(f.row('stock'), secondary);
      assert.doesNotMatch(JSON.stringify(saved), /physical_items|forged-account|forged@example/);
    });
  });
}

for (const options of [{ denied: true }, { readOnly: true }, { fields: true }, { multi: true }]) {
  const boundary =
    'denied' in options
      ? 'resource ceiling'
      : 'readOnly' in options
        ? 'read-only connection'
        : 'fields' in options
          ? 'field ceiling'
          : 'read-only default of a named-source App';
  test(`recorded HTTP preserves the ${boundary} against forged mutation grants`, async () => {
    await fixture(options, async (f) => {
      const before = f.row();
      const ordinary = ordinaryWriteSpy(f.adapters.ops!);
      const adapter = f.adapters.ops!;
      const transaction = adapter.transaction!.bind(adapter);
      const mutations: string[] = [];
      adapter.transaction = (run) =>
        transaction((tx) =>
          run({
            ...tx,
            update: (request) => {
              mutations.push('update');
              return tx.update(request);
            },
            insert: (request) => {
              mutations.push('insert');
              return tx.insert(request);
            },
            remove: (request) => {
              mutations.push('remove');
              return tx.remove(request);
            },
          }),
        );
      for (const [kind, body] of [
        ['update', { key: { id: 1 }, values: { private_note: 'forbidden' } }],
        ['insert', { values: { id: 9, name: 'forbidden', private_note: 'forbidden' } }],
        ['delete', { key: { id: 1 }, confirm: true }],
      ] as const) {
        const reply = await f.call(`/api/${kind}`, {
          table: f.table,
          ...body,
          writable: true,
          role: 'admin',
          principal: 'forged-account',
          by: 'forged@example.test',
        });
        assert.equal(reply.status, 403, `${kind}: ${JSON.stringify(reply.body)}`);
        assert.equal(reply.body.undoId, undefined);
        assert.notEqual(reply.body.outcome, 'unknown');
        assert.doesNotMatch(JSON.stringify(reply.body), /PRIVATE_RECORDED_HTTP_SENTINEL/);
      }
      assert.deepEqual(ordinary, []);
      assert.deepEqual(mutations, []);
      assert.deepEqual(f.row(), before);
      assert.equal(f.row('ops', 9), undefined);
      assert.deepEqual(history(f.owners.ops), []);
      assert.deepEqual(history(f.owners.stock), []);
      if ('multi' in options) {
        assert.equal(f.row('stock')?.name, 'stock original');
        assert.equal(f.row('stock', 9), undefined);
      }
    });
  });
}

test('recorded HTTP refuses every ordinary mutation without transaction support and never falls back', async () => {
  await fixture({}, async (f) => {
    const adapter = f.adapters.ops!;
    const ordinary = ordinaryWriteSpy(adapter);
    adapter.transaction = undefined;
    const before = f.row();
    for (const [kind, body] of [
      ['update', { key: { id: 1 }, values: { name: 'forbidden' } }],
      ['insert', { values: { id: 9, name: 'forbidden' } }],
      ['delete', { key: { id: 1 }, confirm: true }],
    ] as const) {
      const result = await f.call(`/api/${kind}`, { table: f.table, ...body });
      assert.ok(result.status >= 400 || result.body.errors?.length, `${kind}: ${JSON.stringify(result)}`);
      assert.notEqual(result.body.outcome, 'unknown');
      assert.equal(result.body.undoId, undefined);
      assert.notEqual(result.body.deleted, true);
    }
    assert.deepEqual(ordinary, []);
    assert.deepEqual(f.row(), before);
    assert.equal(f.row('ops', 9), undefined);
    assert.deepEqual(history(f.owners.ops), []);
  });
});

for (const kind of ['update', 'delete'] as const) {
  test(`recorded HTTP ${kind} refuses a transaction without record locking before reading or mutating`, async () => {
    await fixture({ browser: true }, async (f) => {
      const older = await rename(f, 'older saved');
      const before = f.row();
      const journal = structuredClone(history(f.owners.ops));
      const adapter = f.adapters.ops!;
      const ordinary = ordinaryWriteSpy(adapter);
      const transaction = adapter.transaction!.bind(adapter);
      const operations: string[] = [];
      adapter.transaction = (run) =>
        transaction((tx) =>
          run({
            ...tx,
            lockRecord: undefined,
            query: (request) => {
              operations.push('query');
              return tx.query(request);
            },
            update: (request) => {
              operations.push('update');
              return tx.update(request);
            },
            remove: (request) => {
              operations.push('remove');
              return tx.remove(request);
            },
          }),
        );
      const reply = await f.call(`/api/${kind}`, {
        table: f.table,
        key: { id: 1 },
        ...(kind === 'update' ? { values: { name: 'forbidden' } } : { confirm: true }),
      });
      assert.ok(reply.status >= 400 || reply.body.errors?.length, JSON.stringify(reply));
      assert.notEqual(reply.body.outcome, 'unknown');
      assert.equal(reply.body.undoId, undefined);
      assert.notEqual(reply.body.deleted, true);
      assert.deepEqual(ordinary, []);
      assert.deepEqual(operations, [], 'plain SELECT is not a safe substitute for a locking original');
      assert.deepEqual(f.row(), before);
      assert.deepEqual(history(f.owners.ops), journal);
      adapter.transaction = transaction;
      await undo(f, older.undoId);
      assert.equal(f.row()?.name, 'ops original');
    });
  });
}

test('an App save refuses a transaction without record locking before reading or mutating', async () => {
  await fixture({}, async (f) => {
    const before = f.row();
    const adapter = f.adapters.ops!;
    const ordinary = ordinaryWriteSpy(adapter);
    const transaction = adapter.transaction!.bind(adapter);
    const operations: string[] = [];
    adapter.transaction = (run) =>
      transaction((tx) =>
        run({
          ...tx,
          lockRecord: undefined,
          query: (request) => {
            operations.push('query');
            return tx.query(request);
          },
          update: (request) => {
            operations.push('update');
            return tx.update(request);
          },
        }),
      );
    const reply = await f.call('/api/update', { table: f.table, key: { id: 1 }, values: { name: 'forbidden' } });
    assert.ok(reply.status >= 400 || reply.body.errors?.length, JSON.stringify(reply));
    assert.notEqual(reply.body.outcome, 'unknown');
    assert.deepEqual(ordinary, []);
    assert.deepEqual(operations, [], 'a plain read would not hold the row the App judges');
    assert.deepEqual(f.row(), before);
    adapter.transaction = transaction;
  });
});

for (const kind of ['update', 'insert', 'delete'] as const) {
  test(`recorded HTTP ${kind} with a lost commit acknowledgement leaves a value-free barrier without retry`, async () => {
    await fixture({ browser: true }, async (f) => {
      const older = await rename(f, 'older saved');
      const adapter = f.adapters.ops!;
      const transaction = adapter.transaction!.bind(adapter);
      const ordinary = ordinaryWriteSpy(adapter);
      let entries = 0;
      let mutations = 0;
      adapter.transaction = (run) => {
        entries++;
        return transaction(async (tx) => {
          const result = await run({
            ...tx,
            update: (request) => {
              mutations++;
              return tx.update(request);
            },
            insert: (request) => {
              mutations++;
              return tx.insert(request);
            },
            remove: (request) => {
              mutations++;
              return tx.remove(request);
            },
          });
          const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
          const exec = handle.exec.bind(handle);
          handle.exec = (sql) => {
            exec(sql);
            if (sql === 'COMMIT') throw new Error(secret);
          };
          return result;
        });
      };
      const body =
        kind === 'insert'
          ? { values: { id: 9, name: 'uncertain created' } }
          : kind === 'update'
            ? { key: { id: 1 }, values: { name: 'uncertain updated' } }
            : { key: { id: 1 }, confirm: true };
      const reply = await f.call(`/api/${kind}`, { table: f.table, ...body });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.outcome, 'unknown');
      assert.ok(reply.body.errors?.length);
      assert.equal(reply.body.undoId, undefined);
      assert.equal(reply.body.affected, undefined);
      assert.equal(entries, 1, 'an unknown commit must never be automatically retried');
      assert.equal(mutations, 1);
      assert.deepEqual(ordinary, []);
      if (kind === 'delete') assert.equal(reply.body.deleted, null);
      assert.doesNotMatch(JSON.stringify(reply.body), /PRIVATE_RECORDED_HTTP_SENTINEL|nothing was changed|rolled back/);
      if (kind === 'insert') assert.equal(f.row('ops', 9)?.name, 'uncertain created');
      else assert.equal(f.row()?.name, kind === 'delete' ? undefined : 'uncertain updated');
      assert.equal(Reflect.get(adapter, 'writeDb'), null, 'uncertain writer must be discarded');
      const [barrier, previous] = history(f.owners.ops);
      assert.equal(history(f.owners.ops).length, 2);
      assert.equal(previous.id, older.undoId);
      assert.equal(barrier.kind, kind);
      assert.equal(barrier.undoState, 'unknown');
      assert.equal(barrier.revertible, false);
      assert.deepEqual(barrier.steps, [{ table: physical }]);
      assert.doesNotMatch(JSON.stringify(barrier), /uncertain created|uncertain updated|older saved|PRIVATE_RECORDED_HTTP_SENTINEL/);
      adapter.transaction = async () => {
        assert.fail('history must block retrying the older inverse');
      };
      assert.equal(successful(await f.call('/api/revert')).next, undefined);
      assert.equal((await f.call('/api/revert', { confirm: true, expectedId: older.undoId })).status, 409);
    });
  });
}

test('recorded HTTP rollback uncertainty cannot unwrap a constraint into a safe rejection', async () => {
  await fixture({ browser: true }, async (f) => {
    const older = await rename(f, 'older saved');
    const adapter = f.adapters.ops!;
    const transaction = adapter.transaction!.bind(adapter);
    adapter.transaction = (run) =>
      transaction(async (tx) => {
        await run(tx);
        const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
        const exec = handle.exec.bind(handle);
        handle.exec = (sql) => {
          if (sql === 'ROLLBACK') throw new Error(secret);
          exec(sql);
        };
        throw Object.assign(new Error(`UNIQUE constraint failed: ${secret}`), { code: 'ERR_SQLITE_ERROR', errcode: 2067 });
      });
    const reply = await f.call('/api/insert', { table: f.table, values: { id: 9, name: 'uncertain rollback' } });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.outcome, 'unknown');
    assert.doesNotMatch(JSON.stringify(reply.body), /PRIVATE_RECORDED_HTTP_SENTINEL|nothing was changed|rolled back/);
    assert.equal(f.row('ops', 9), undefined, 'closing this SQLite writer happens to roll back, without confirming the outcome');
    assert.equal(Reflect.get(adapter, 'writeDb'), null);
    assert.equal(history(f.owners.ops)[0].undoState, 'unknown');
    assert.deepEqual(history(f.owners.ops)[0].steps, [{ table: physical }]);
    assert.equal(successful(await f.call('/api/revert')).next, undefined);
    assert.equal((await f.call('/api/revert', { confirm: true, expectedId: older.undoId })).status, 409);
  });
});

test('recorded HTTP and MCP writes share physical history and can undo each other in browser mode', async () => {
  await fixture({ browser: true }, async (f) => {
    const saved = await rename(f, 'HTTP saved');
    const preview = await runTool(f.registry, 'revert', { connection: f.owners.ops });
    assert.equal(preview.isError, false);
    assert.ok(preview.structuredContent);
    assert.equal((preview.structuredContent.next as { id: number }).id, saved.undoId);
    const reverted = await runTool(f.registry, 'revert', { connection: f.owners.ops, confirm: true, expectedId: saved.undoId });
    assert.equal(reverted.isError, false);
    assert.equal(reverted.structuredContent?.reverted, true);
    assert.equal(f.row()?.name, 'ops original');
    const changed = await runTool(f.registry, 'update', {
      connection: f.owners.ops,
      table: physical,
      key: { id: 1 },
      set: { name: 'MCP saved' },
    });
    assert.equal(changed.isError, false, changed.content[0]?.text);
    assert.equal(changed.structuredContent?.affected, 1);
    assert.equal(f.row()?.name, 'MCP saved');
    const entry = history(f.owners.ops)[0];
    assert.equal(successful(await f.call('/api/revert')).next.id, entry.id);
    await undo(f, entry.id);
    assert.equal(f.row()?.name, 'ops original');
    assert.deepEqual(history(f.owners.ops), []);
  });
});
