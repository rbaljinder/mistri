import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinnedPostgresReadOwner } from '../packages/engine/src/adapters/postgresReadCatalog.js';
import type { PostgresReadSnapshot } from '../packages/engine/src/adapters/postgres.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

function fixture() {
  const row = {
    schema: 'public',
    name: 'items',
    oid: '100',
    kind: 'r',
    persistence: 'p',
    partition: false,
    rls: false,
    force: false,
    inheritance: false,
    rules: false,
    policies: false,
    columns: [
      {
        name: 'id',
        number: 1,
        typeOid: '23',
        type: 'int4',
        typeSchema: 'pg_catalog',
        typeKind: 'b',
        modifier: -1,
        notnull: true,
        dropped: false,
        generated: '',
        identity: '',
        collation: '0',
      },
    ],
    primary: [{ oid: '101', index: '102', keys: [1], valid: true, ready: true, deferrable: false }],
  };
  const schema: DatabaseSchema = {
    label: '',
    dialect: 'postgres',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'public.items',
        schema: 'public',
        name: 'items',
        isView: false,
        columns: [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }],
      },
    ],
  };
  const sql: string[] = [];
  let leased = false;
  const lease = {
    client: {
      query: async (text: string) => {
        sql.push(text);
        return { rows: text.startsWith('LOCK') ? [] : [row] };
      },
    },
    assertCurrent: () => {
      assert.equal(leased, true);
    },
    describe: async () => schema,
    execute: async () => {
      assert.equal(leased, true);
      return { columns: ['id'], rows: [{ id: 1 }], ms: 0 };
    },
  } as unknown as PostgresReadSnapshot;
  const run = async <T>(callback: (snapshot: PostgresReadSnapshot) => Promise<T>) => {
    leased = true;
    try {
      return await callback(lease);
    } finally {
      leased = false;
    }
  };
  return { row, schema, sql, lease, run, leased: () => leased };
}

test('private shape owner captures its baseline after locks and lends no raw client', async () => {
  const f = fixture();
  const owner = await createPinnedPostgresReadOwner(f.run, [{ schema: 'public', name: 'items' }], () => {});
  assert.equal(f.sql[0], 'LOCK TABLE ONLY "public"."items" IN ACCESS SHARE MODE');
  assert.ok(Object.isFrozen(owner.schema.tables));
  let escaped: Parameters<Parameters<typeof owner.withSnapshot>[0]>[0] | undefined;
  await owner.withSnapshot(async (read) => {
    escaped = read;
    assert.deepEqual(Object.keys(read).sort(), ['assertCurrent', 'execute', 'schema']);
    read.assertCurrent();
    assert.equal(f.leased(), true);
    assert.deepEqual((await read.execute({ text: 'SELECT id FROM items', params: [] })).rows, [{ id: 1 }]);
  });
  assert.equal(f.leased(), false);
  assert.throws(() => escaped!.assertCurrent());
  await assert.rejects(escaped!.execute({ text: 'SELECT 1', params: [] }));
  await owner.retire();
  await assert.rejects(owner.withSnapshot(async () => 1));
});

test('native catalog identity changes and unsupported relations/types refuse', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.row.oid = '200';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.columns[0].typeOid = '20';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.columns[0].modifier = 12;
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.primary[0].oid = '203';
    },
    (f: ReturnType<typeof fixture>) => {
      f.schema.foreignKeys.push({
        name: 'new_link',
        from: { table: 'public.items', columns: ['id'] },
        to: { table: 'public.items', columns: ['id'] },
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.kind = 'v';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.inheritance = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.columns[0].typeKind = 'd';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.columns[0].typeSchema = 'public';
    },
  ]) {
    const f = fixture(),
      owner = await createPinnedPostgresReadOwner(f.run, [{ schema: 'public', name: 'items' }], () => {});
    mutate(f);
    let called = false;
    await assert.rejects(
      owner.withSnapshot(async () => {
        called = true;
      }),
    );
    assert.equal(called, false);
    await owner.retire();
  }
});

test('exact dependency pairs reject duplicates, sparse arrays and proxy callbacks before I/O', async () => {
  const f = fixture();
  const pair = { schema: 'public', name: 'items' };
  for (const input of [[], [pair, pair], [{ schema: 'pg_catalog', name: 'items' }], Array(1)]) {
    await assert.rejects(createPinnedPostgresReadOwner(f.run, input, () => {}));
  }
  let traps = 0;
  await assert.rejects(
    createPinnedPostgresReadOwner(
      f.run,
      [pair],
      new Proxy(() => {}, {
        apply() {
          traps++;
        },
      }),
    ),
  );
  assert.equal(traps, 0);
  assert.deepEqual(f.sql, []);
});

test('retirement while native execution awaits drains but cannot hand out the result', async () => {
  const f = fixture(),
    owner = await createPinnedPostgresReadOwner(f.run, [{ schema: 'public', name: 'items' }], () => {});
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.lease.execute = async () => {
    entered();
    await wait;
    return { columns: [], rows: [], ms: 0, sql: { text: 'SELECT 1', params: [] } };
  };
  const work = owner.withSnapshot(async (read) => read.execute({ text: 'SELECT 1', params: [] }));
  const refused = assert.rejects(work);
  await started;
  let drained = false;
  const retirement = owner.retire().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  await refused;
  await retirement;
  assert.equal(drained, true);
});
