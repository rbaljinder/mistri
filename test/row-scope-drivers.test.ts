import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Filter, QueryRequest, SqlFragment } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import {
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const filter = (value: string | number): Filter => ({ groups: [[{ column: 'tenant', op: '=', value }]] });
const policy = (value: string | number): RowScope => ({ 'shop.item': filter(value) });
const view = (): ViewDef => ({ id: 'items', name: 'Items', base: 'shop.item', columns: [{ path: 'id' }], limit: 7 });
const breakdown = (): BreakdownDef => ({ base: 'shop.item', by: [{ path: 'tenant' }], measures: [{ fn: 'count', alias: 'n' }], limit: 7 });
const request = (): QueryRequest => ({ table: 'shop.item', columns: ['id'], limit: 7, offset: 3 });

/** Replace driver creation, not the reader/compiler paths. Catalog setup is
 * injected independently so these tests need neither servers nor credentials. */
function fixture(dialect: 'postgres') {
  const schema: DatabaseSchema = {
    dialect,
    label: 'scoped driver fixture',
    readAt: '2026-09-07',
    foreignKeys: [],
    tables: [
      {
        id: 'shop.item',
        schema: 'shop',
        name: 'item',
        isView: false,
        columns: [
          { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
          { name: 'tenant', type: 'text', nullable: false, primaryKey: false },
          { name: 'name', type: 'text', nullable: false, primaryKey: false },
          { name: 'bytes', type: 'blob', nullable: true, primaryKey: false },
          { name: 'stamp', type: 'timestamp', nullable: true, primaryKey: false },
        ],
      },
    ],
  };
  const statements: SqlFragment[] = [];
  const setup: string[] = [];
  const opened: boolean[] = [];
  let ended = 0;
  let released = 0;
  let hook: (statement: SqlFragment) => Promise<void> = async () => {};
  let rows: Record<string, unknown>[] = [{ n: '2' }];
  let fields = [{ name: 'n' }];
  const execute = async (text: string, params: unknown[] = []) => {
    if (text.startsWith('SET ')) {
      setup.push(text);
      return { rows: [], fields: [], rowCount: 0 };
    }
    const statement = { text, params: [...params] };
    statements.push(statement);
    await hook(statement);
    return { rows, fields, rowCount: rows.length };
  };

  class FakePool extends EventEmitter implements PgPool {
    private closed = false;
    constructor(readonly options: PgPoolOptions) {
      super();
      opened.push(options.max === 4);
    }
    async connect(): Promise<PgClient> {
      assert.equal(this.closed, false);
      let active = true;
      const client: PgClient = {
        query: (async (input: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
          assert.equal(active, true, 'query on released lease');
          return execute(typeof input === 'string' ? input : input.text, typeof input === 'string' ? params : input.values);
        }) as PgClient['query'],
        release: () => {
          assert.equal(active, true);
          active = false;
          released++;
        },
      };
      await this.options.onConnect(client);
      return client;
    }
    query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
    query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
    async query(
      input: string | { text: string; values?: unknown[]; rowMode?: string },
      params?: unknown[],
    ): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
      const client = await this.connect();
      try {
        return await (typeof input === 'string' ? client.query(input, params) : client.query(input));
      } finally {
        client.release();
      }
    }
    async end() {
      this.closed = true;
      ended++;
    }
  }

  const adapter = new PostgresAdapter(
    'postgres://localhost/shop',
    'fixture',
    [],
    new PgConnectionManager('postgres://localhost/shop', undefined, async () => ({ Pool: FakePool })),
  );
  Reflect.set(adapter, 'cachedSchema', schema);
  Reflect.set(adapter, 'cachedEpoch', 'fixture');
  return {
    adapter,
    schema,
    statements,
    setup,
    opened,
    ended: () => ended,
    released: () => released,
    beforeQuery: (next: typeof hook) => {
      hook = next;
    },
    results: (next: typeof rows, names: string[]) => {
      rows = next;
      fields = names.map((name) => ({ name }));
    },
  };
}

for (const dialect of ['postgres'] as const) {
  test(`${dialect} scoped capability executes all six reads on existing readers with correct bindings`, async () => {
    const f = fixture(dialect);
    try {
      const reads = await f.adapter.scopeReads(policy(11));
      assert.deepEqual(
        Object.keys(reads).sort(),
        ['query', 'count', 'countEach', 'runView', 'countView', 'runBreakdown', 'countBreakdown'].sort(),
      );
      for (const forbidden of [
        'runSql',
        'insert',
        'update',
        'remove',
        'transaction',
        'close',
        'scopeReads',
        'introspect',
        'estimateCount',
      ]) {
        assert.equal(forbidden in reads, false, forbidden);
      }
      const v = { ...view(), filter: { groups: [[{ path: 'tenant', op: '=' as const, value: 22 }]] } };
      const b = { ...breakdown(), filter: v.filter };
      const result = await reads.query({ ...request(), filter: filter(22) });
      assert.equal(await reads.count('shop.item', filter(22)), 2);
      await reads.runView(v, 3);
      assert.equal(await reads.countView(v), 2);
      await reads.runBreakdown(b, 3);
      assert.equal(await reads.countBreakdown(b), 2);
      assert.equal(f.statements.length, 6);
      for (const [i, statement] of f.statements.entries()) {
        const paged = i % 2 === 0;
        const tail = [7, 3];
        assert.deepEqual(statement.params, [11, 22, ...(paged ? tail : [])]);
        assert.match(statement.text, /WITH /);
        if (dialect === 'postgres') {
          assert.match(statement.text, /"tenant" = \$1/);
          assert.match(statement.text, /"tenant" = \$2/);
          if (paged) assert.match(statement.text, /LIMIT \$3 OFFSET \$4$/);
        } else {
          assert.equal((statement.text.match(/\?/g) ?? []).length, statement.params.length);
        }
      }
      assert.deepEqual(result.sql, f.statements[0]);
      assert.deepEqual(f.opened, [true]);
      assert.equal(f.ended(), 0, 'scoped operations must not dispose the owning adapter');
      if (dialect === 'postgres') {
        assert.equal(f.released(), 6);
        assert.equal(f.setup.filter((text) => text === 'SET default_transaction_read_only = on').length, 6);
      }
    } finally {
      await f.adapter.close();
    }
    assert.equal(f.ended(), 1);
  });

  test(`${dialect} captures policies before the first metadata await and refuses accessors without I/O`, async () => {
    const f = fixture(dialect);
    const resume = deferred();
    let metadata = 0;
    Reflect.set(f.adapter, 'cachedSchema', null);
    Reflect.set(f.adapter, 'introspect', async () => {
      metadata++;
      await resume.promise;
      return f.schema;
    });
    let invoked = false;
    const invalid = Object.defineProperty({}, 'shop.item', {
      enumerable: true,
      get: () => {
        invoked = true;
        return true;
      },
    });
    try {
      await assert.rejects(f.adapter.scopeReads(invalid), /row scope/i);
      assert.equal(invoked, false);
      assert.equal(metadata, 0);
      const mutable = filter('original');
      const binding = f.adapter.scopeReads({ 'shop.item': mutable });
      mutable.groups[0][0].value = 'changed';
      resume.resolve();
      await (await binding).count('shop.item');
      assert.equal(metadata, 1);
      assert.deepEqual(f.statements[0].params, ['original']);
    } finally {
      resume.resolve();
      await f.adapter.close();
    }
  });

  test(`${dialect} independent interleaved scopes and in-flight request mutations cannot rebind reads`, async () => {
    const f = fixture(dialect);
    const resume = deferred();
    const reached = deferred();
    try {
      const a = await f.adapter.scopeReads(policy('north'));
      const b = await f.adapter.scopeReads(policy('south'));
      await a.count('shop.item'); // Establish the shared reader before interleaving.
      f.statements.length = 0;
      f.beforeQuery(async (statement) => {
        if (statement.params[0] === 'north') {
          reached.resolve();
          await resume.promise;
        }
      });
      const input = { ...request(), filter: filter('original') };
      const pending = a.query(input);
      input.filter.groups[0][0].value = 'changed';
      input.limit = 99;
      input.columns = ['tenant'];
      await reached.promise;
      await b.count('shop.item');
      resume.resolve();
      const result = await pending;
      assert.deepEqual(result.columns, ['id']);
      assert.deepEqual(
        f.statements.map((statement) => statement.params),
        [['north', 'original', ...[7, 3]], ['south']],
      );
      assert.deepEqual(f.opened, [true]);
    } finally {
      resume.resolve();
      await f.adapter.close();
    }
  });

  test(`${dialect} scoped reads preserve driver-safe values and empty projection metadata`, async () => {
    const f = fixture(dialect);
    try {
      const reads = await f.adapter.scopeReads(policy('north'));
      f.results(
        [{ id: 9007199254740993n, bytes: new Uint8Array([1, 2]), stamp: new Date('2026-09-07T12:00:00Z') }],
        ['id', 'bytes', 'stamp'],
      );
      const input = { ...request(), columns: ['id', 'bytes', 'stamp'] };
      const result = await reads.query(input);
      assert.deepEqual(result.rows, [{ id: '9007199254740993', bytes: '<2 bytes>', stamp: '2026-09-07T12:00:00.000Z' }]);
      assert.equal(typeof result.ms, 'number');
      assert.ok(result.ms >= 0);
      if (dialect === 'postgres') {
        const binary = await reads.query({ ...input, binary: true });
        assert.deepEqual(binary.rows, [{ id: '9007199254740993', bytes: new Uint8Array([1, 2]), stamp: '2026-09-07T12:00:00.000Z' }]);
      }
      f.results([], input.columns);
      const empty = await reads.query(input);
      assert.deepEqual(empty.columns, input.columns);
      assert.deepEqual(empty.rows, []);
    } finally {
      await f.adapter.close();
    }
  });

  test(`${dialect} driver failures propagate without fallback, writer creation or disposing the reader`, async () => {
    const f = fixture(dialect);
    const failure = new Error('injected scoped read failure');
    try {
      const reads = await f.adapter.scopeReads(policy('north'));
      f.beforeQuery(async () => {
        throw failure;
      });
      await assert.rejects(reads.query(request()), (error) => error === failure);
      assert.equal(f.statements.length, 1);
      assert.equal(f.ended(), 0);
      f.beforeQuery(async () => {});
      assert.equal(await reads.count('shop.item'), 2);
      assert.deepEqual(f.opened, [true]);
      if (dialect === 'postgres') {
        assert.equal(f.released(), 2);
        await f.adapter.close();
        await assert.rejects(reads.query(request()), /closed/);
        assert.equal(f.statements.length, 2, 'retained capability cannot query a closed manager');
      }
    } finally {
      await f.adapter.close();
    }
    assert.equal(f.ended(), 1);
  });

  test(`${dialect} missing and false policies stay denied without changing ordinary view reads`, async () => {
    const f = fixture(dialect);
    try {
      const cases: RowScope[] = [{}, { 'shop.item': false }];
      for (const scope of cases) {
        const reads = await f.adapter.scopeReads(scope);
        await reads.query(request());
        assert.match(f.statements.at(-1)!.text, /WHERE 1 = 0/);
      }
      const all = await f.adapter.scopeReads({ 'shop.item': true });
      await all.runView(view());
      assert.match(f.statements.at(-1)!.text, /^WITH /);
      assert.doesNotMatch(f.statements.at(-1)!.text, /WHERE 1 = 0/);
      await f.adapter.runView(view(), 3);
      assert.doesNotMatch(f.statements.at(-1)!.text, /_tw_scope/);
      assert.deepEqual(f.statements.at(-1)!.params, [7, 3]);
      assert.deepEqual(f.opened, [true]);
    } finally {
      await f.adapter.close();
    }
  });
}
