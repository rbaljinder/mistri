import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { runTool, setToolProfile } from '../packages/tablewalk/src/server/mcp.js';

const table = 'physical_mcp_items';
const secret = 'PRIVATE_RECORDED_MCP_SENTINEL';
type Kind = 'update' | 'insert' | 'delete';
type Reply = Awaited<ReturnType<typeof runTool>>;
type Fixture = {
  adapter: Adapter;
  database: DatabaseSync;
  owner: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<Reply>;
  row: (id?: number) => Record<string, unknown> | undefined;
};

async function fixture(run: (f: Fixture) => Promise<void>, writable = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-recorded-mcp-'));
  const owner = basename(directory);
  const registry = new Registry();
  const database = new DatabaseSync(join(directory, 'records.db'));
  try {
    database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE,
      score INTEGER NOT NULL DEFAULT 7, private_note TEXT NOT NULL DEFAULT '${secret}');
      INSERT INTO ${table} (id, name) VALUES (1, 'original'), (2, 'second');`);
    registry.add({ id: owner, name: owner, url: join(directory, 'records.db'), source: 'config', writable });
    const { adapter } = await registry.open(owner);
    await run({
      adapter,
      database,
      owner,
      call: (name, args = {}) => runTool(registry, name, { connection: owner, ...args }),
      row: (id = 1) => {
        const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
        return row ? { ...row } : undefined;
      },
    });
  } finally {
    setToolProfile('full');
    await registry.closeAll();
    database.close();
    clearJournal(owner);
    rmSync(directory, { recursive: true, force: true });
  }
}

function successful(reply: Reply) {
  assert.equal(reply.isError, false, JSON.stringify(reply));
  assert.ok(reply.structuredContent, JSON.stringify(reply));
  assert.ok(!reply.structuredContent.errors, JSON.stringify(reply));
  return reply.structuredContent;
}

function request(kind: Kind) {
  return {
    table,
    ...(kind === 'insert'
      ? { values: { id: 9, name: 'created' } }
      : kind === 'update'
        ? { key: { id: 1 }, set: { name: 'updated' } }
        : { key: { id: 1 }, confirm: true }),
  };
}

function forbidOrdinaryWrites(adapter: Adapter) {
  for (const method of ['update', 'insert', 'remove'] as const) {
    Reflect.set(adapter, method, () => {
      assert.fail(`MCP must not fall back to ordinary ${method}`);
    });
  }
}

for (const kind of ['update', 'insert', 'delete'] as const) {
  test(`recorded MCP ${kind} uses one writer and publishes physical history with an actual inverse`, async () => {
    await fixture(async (f) => {
      if (kind === 'delete') {
        const preview = successful(await f.call(kind, { table, key: { id: 1 } }));
        assert.equal(preview.deleted, false);
        assert.deepEqual(history(f.owner), []);
        assert.equal(f.row()?.name, 'original');
      }
      const transaction = f.adapter.transaction!.bind(f.adapter);
      forbidOrdinaryWrites(f.adapter);
      let entries = 0;
      f.adapter.transaction = (run) => {
        entries++;
        // A separate connection commits after any transport preflight.
        f.database.exec(`UPDATE ${table} SET name = 'writer-entry original', score = 42 WHERE id = 1`);
        return transaction(run);
      };
      const saved = successful(await f.call(kind, request(kind)));
      assert.equal(entries, 1);
      const [entry, ...extra] = history(f.owner);
      assert.deepEqual(extra, []);
      assert.equal(saved.undoId, entry.id);
      assert.equal(entry.connection, f.owner);
      assert.equal(entry.kind, kind);
      assert.equal(entry.steps[0].table, table);
      if (kind === 'update') {
        assert.deepEqual(entry.steps[0].before, { name: 'writer-entry original' });
        assert.equal(f.row()?.name, 'updated');
      } else if (kind === 'delete') {
        assert.deepEqual(entry.steps[0].before, { id: 1, name: 'writer-entry original', score: 42, private_note: secret });
        assert.equal(f.row(), undefined);
      } else {
        assert.equal(entry.steps[0].wholeRow, true);
        assert.deepEqual(entry.steps[0].after, f.row(9));
        assert.equal(f.row(9)?.private_note, secret);
      }
      f.adapter.transaction = transaction;
      assert.equal(successful(await f.call('revert', { confirm: true, expectedId: entry.id })).reverted, true);
      assert.equal(f.row()?.name, 'writer-entry original');
      assert.equal(f.row()?.score, 42);
      assert.equal(f.row(9), undefined);
      assert.deepEqual(history(f.owner), []);
    });
  });

  test(`recorded MCP ${kind} refuses a missing transaction without ordinary mutation or history`, async () => {
    await fixture(async (f) => {
      const before = f.row();
      forbidOrdinaryWrites(f.adapter);
      f.adapter.transaction = undefined;
      const reply = await f.call(kind, request(kind));
      assert.ok(reply.isError || (reply.structuredContent?.errors as unknown[])?.length, JSON.stringify(reply));
      assert.notEqual(reply.structuredContent?.outcome, 'unknown');
      assert.equal(reply.structuredContent?.undoId, undefined);
      assert.deepEqual(f.row(), before);
      assert.equal(f.row(9), undefined);
      assert.deepEqual(history(f.owner), []);
    });
  });

  test(`recorded MCP ${kind} reports a lost commit acknowledgement truthfully without blind retry`, async () => {
    await fixture(async (f) => {
      const older = successful(await f.call('update', { table, key: { id: 2 }, set: { name: 'older edit' } }));
      const transaction = f.adapter.transaction!.bind(f.adapter);
      forbidOrdinaryWrites(f.adapter);
      let entries = 0;
      let mutations = 0;
      f.adapter.transaction = (run) => {
        entries++;
        return transaction(async (tx) => {
          const result = await run({
            ...tx,
            update: (input) => {
              mutations++;
              return tx.update(input);
            },
            insert: (input) => {
              mutations++;
              return tx.insert(input);
            },
            remove: (input) => {
              mutations++;
              return tx.remove(input);
            },
          });
          const handle = Reflect.get(f.adapter, 'writeDb') as DatabaseSync;
          const exec = handle.exec.bind(handle);
          handle.exec = (sql) => {
            exec(sql);
            if (sql === 'COMMIT') throw new Error(secret);
          };
          return result;
        });
      };
      const reply = await f.call(kind, request(kind));
      assert.equal(reply.isError, false, JSON.stringify(reply));
      const result = reply.structuredContent!;
      assert.equal(result.outcome, 'unknown');
      assert.ok((result.errors as unknown[])?.length);
      assert.equal(result.undoId, undefined);
      assert.equal(result.affected, undefined);
      if (kind === 'insert') assert.equal(result.inserted, null);
      if (kind === 'delete') assert.equal(result.deleted, null);
      assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_RECORDED_MCP_SENTINEL|nothing was changed|rolled back/i);
      assert.equal(entries, 1);
      assert.equal(mutations, 1);
      if (kind === 'insert') assert.equal(f.row(9)?.name, 'created');
      else assert.equal(f.row()?.name, kind === 'delete' ? undefined : 'updated');
      assert.equal(Reflect.get(f.adapter, 'writeDb'), null);
      const [barrier, previous, ...extra] = history(f.owner);
      assert.deepEqual(extra, []);
      assert.equal(previous.id, older.undoId);
      assert.equal(barrier.kind, kind);
      assert.equal(barrier.undoState, 'unknown');
      assert.equal(barrier.revertible, false);
      assert.deepEqual(barrier.steps, [{ table }]);
      assert.doesNotMatch(JSON.stringify(barrier), /created|updated|older edit|PRIVATE_RECORDED_MCP_SENTINEL/);
      f.adapter.transaction = async () => {
        assert.fail('an unknown barrier must stop the older inverse');
      };
      assert.equal(successful(await f.call('revert')).next, undefined);
      const refused = await f.call('revert', { confirm: true, expectedId: older.undoId });
      assert.ok(refused.isError || refused.structuredContent?.reverted === false, JSON.stringify(refused));
      assert.equal(f.row(2)?.name, 'older edit');
      assert.deepEqual(history(f.owner), [barrier, previous]);
    });
  });
}

test('recorded MCP Undo stores the actual numeric original, not caller-supplied expected coercion', async () => {
  await fixture(async (f) => {
    const result = successful(
      await f.call('update', {
        table,
        key: { id: 1 },
        set: { score: 8 },
        expected: { score: '007' },
      }),
    );
    assert.deepEqual(history(f.owner)[0].steps[0].before, { score: 7 });
    assert.equal(successful(await f.call('revert', { confirm: true, expectedId: result.undoId })).reverted, true);
    assert.equal(f.row()?.score, 7);
  });
});

for (const kind of ['update', 'delete'] as const) {
  test(`recorded MCP ${kind} refuses an unlocked transaction before capturing an unsafe original`, async () => {
    await fixture(async (f) => {
      const before = f.row();
      const transaction = f.adapter.transaction!.bind(f.adapter);
      forbidOrdinaryWrites(f.adapter);
      const operations: string[] = [];
      f.adapter.transaction = (run) =>
        transaction((tx) =>
          run({
            ...tx,
            lockRecord: undefined,
            query: (input) => {
              operations.push('query');
              return tx.query(input);
            },
            update: (input) => {
              operations.push('update');
              return tx.update(input);
            },
            remove: (input) => {
              operations.push('remove');
              return tx.remove(input);
            },
          }),
        );
      const reply = await f.call(kind, request(kind));
      assert.ok(reply.isError || (reply.structuredContent?.errors as unknown[])?.length, JSON.stringify(reply));
      assert.notEqual(reply.structuredContent?.outcome, 'unknown');
      assert.equal(reply.structuredContent?.undoId, undefined);
      assert.deepEqual(operations, []);
      assert.deepEqual(f.row(), before);
      assert.deepEqual(history(f.owner), []);
    });
  });
}

for (const boundary of ['connection', 'profile'] as const) {
  test(`recorded MCP cannot bypass the ${boundary} write ceiling by naming a mutation tool directly`, async () => {
    await fixture(async (f) => {
      if (boundary === 'profile') setToolProfile('explore');
      const before = f.row();
      forbidOrdinaryWrites(f.adapter);
      f.adapter.transaction = async () => {
        assert.fail('denied tools must never acquire a writer');
      };
      for (const kind of ['update', 'insert', 'delete'] as const) {
        const reply = await f.call(kind, request(kind));
        assert.equal(reply.isError, true, JSON.stringify(reply));
        assert.equal(reply.structuredContent?.undoId, undefined);
      }
      assert.deepEqual(f.row(), before);
      assert.equal(f.row(9), undefined);
      assert.deepEqual(history(f.owner), []);
    }, boundary !== 'connection');
  });
}
