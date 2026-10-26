import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  DEFAULT_LIMIT,
  ESTIMATE_ABOVE,
  MAX_LIMIT,
  Refusal,
  type Adapter,
  type BreakdownResult,
  type Filter,
  type QueryRequest,
  type QueryResult,
  type ViewResult,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import { resolveOrder, type DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import {
  readBreakdown,
  readCount,
  readRecords,
  readView,
  ResourceReadError,
} from '../packages/engine/src/server/resourceReadOperations.js';

type Reader = Pick<Adapter, 'query' | 'count' | 'estimateCount' | 'runView' | 'countView' | 'runBreakdown' | 'countBreakdown'>;

const schema: DatabaseSchema = {
  label: 'resource reads',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'item',
      name: 'item',
      schema: '',
      isView: false,
      indexed: ['id'],
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: false, primaryKey: false },
        { name: 'category', type: 'text', nullable: true, primaryKey: false },
      ],
    },
  ],
};

function rows(): QueryResult {
  return { columns: ['id', 'name'], rows: [{ id: 1, name: 'one' }], ms: 7, sql: { text: 'SELECT bound fixture', params: ['one'] } };
}
function viewRows(): ViewResult {
  return { ...rows(), resolved: [], joins: [] };
}
function breakdownRows(): BreakdownResult {
  return { ...rows(), resolved: [] };
}
/* Every group asked for, one past the page included: a full page, the one
   case where a grouped breakdown still needs its count statement (the page
   alone cannot say where the groups end). A short page settles without one. */
function fullPage(def: BreakdownDef): BreakdownResult {
  return { ...breakdownRows(), rows: Array.from({ length: def.limit ?? 1 }, (_, i) => ({ id: i + 1, name: 'one' })) };
}
function view(): ViewDef {
  return {
    id: 'items',
    name: 'Items',
    base: 'item',
    columns: [{ path: 'name' }],
    filter: { groups: [[{ path: 'id', op: 'in', value: [1, 2] }]] },
    orderBy: [{ path: 'name', direction: 'asc' }],
    limit: 4,
  };
}
function breakdown(): BreakdownDef {
  return {
    base: 'item',
    by: [{ path: 'category' }],
    measures: [{ fn: 'count', alias: 'n' }],
    filter: { groups: [[{ path: 'id', op: 'in', value: [1, 2] }]] },
    orderBy: [{ name: 'n', direction: 'desc' }],
    limit: 4,
  };
}
function filter(): Filter {
  return { groups: [[{ column: 'id', op: 'in', value: [1, 2] }]] };
}
function fake(overrides: Partial<Reader> = {}) {
  const calls: string[] = [];
  const reader: Reader = {
    async query() {
      assert.equal(this, reader);
      calls.push('query');
      return rows();
    },
    async count() {
      assert.equal(this, reader);
      calls.push('count');
      return 3;
    },
    async runView() {
      assert.equal(this, reader);
      calls.push('runView');
      return viewRows();
    },
    async countView() {
      assert.equal(this, reader);
      calls.push('countView');
      return 3;
    },
    async runBreakdown(def) {
      assert.equal(this, reader);
      calls.push('runBreakdown');
      return fullPage(def);
    },
    async countBreakdown() {
      assert.equal(this, reader);
      calls.push('countBreakdown');
      return 3;
    },
    ...overrides,
  };
  return { reader, calls };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
// Snapshot objects deliberately have no prototype; compare their data without
// imposing a prototype on the service's private representation.
function assertData(actual: unknown, expected: unknown) {
  assert.deepEqual(structuredClone(actual), structuredClone(expected));
}
function status(expected: number) {
  return (error: unknown) => {
    assert.ok(error instanceof ResourceReadError);
    assert.equal(error.status, expected);
    return true;
  };
}

type ReadKind = 'records' | 'count' | 'view' | 'breakdown';
function readWithFilter(kind: ReadKind, reader: Reader, value: unknown) {
  if (kind === 'records') return readRecords(reader, schema, { table: 'item', filter: value as Filter }, 'estimate');
  if (kind === 'count') return readCount(reader, schema, { table: 'item', filter: value as Filter });
  if (kind === 'view') return readView(reader, schema, { ...view(), filter: value as ViewDef['filter'] });
  return readBreakdown(reader, schema, { ...breakdown(), filter: value as BreakdownDef['filter'] });
}

for (const kind of ['records', 'count', 'view', 'breakdown'] as const) {
  const field = kind === 'records' || kind === 'count' ? 'column' : 'path';
  const condition = { [field]: 'id', op: '=', value: 1 };

  for (const [category, cases] of [
    [
      'shape',
      [
        ['missing groups', {}],
        ['object group', { groups: [{}] }],
        ['string groups', { groups: '' }],
        ['object groups', { groups: {} }],
        ['null groups', { groups: null }],
        ['array filter', []],
        ['string filter', ''],
        ['boolean filter', false],
        ['number filter', 0],
        ['null group', { groups: [null] }],
        ['unexpected filter field', { groups: [], where: 'id = 1' }],
        ['string group', { groups: [''] }],
        ['number group', { groups: [1] }],
        ['valid group followed by malformed group', { groups: [[condition], {}] }],
      ],
    ],
    [
      'condition',
      [
        ['null condition', { groups: [[null]] }],
        ['array condition', { groups: [[[]]] }],
        ['string condition', { groups: [['id = 1']] }],
        ['number condition', { groups: [[1]] }],
        ['missing name', { groups: [[{ op: '=', value: 1 }]] }],
        ['number name', { groups: [[{ ...condition, [field]: 1 }]] }],
        ['empty name', { groups: [[{ ...condition, [field]: '' }]] }],
        ['missing operator', { groups: [[{ [field]: 'id', value: 1 }]] }],
        ['unknown operator', { groups: [[{ ...condition, op: 'bogus' }]] }],
        ['injected operator', { groups: [[{ ...condition, op: '= 1 OR 1=1 --' }]] }],
        ['object operator', { groups: [[{ ...condition, op: {} }]] }],
        ['unexpected condition field', { groups: [[{ ...condition, sql: 'OR 1=1' }]] }],
        ['valid condition followed by malformed condition', { groups: [[condition, {}]] }],
      ],
    ],
    [
      'value',
      [
        ['object comparison', { groups: [[{ ...condition, value: {} }]] }],
        ['array comparison', { groups: [[{ ...condition, value: [1] }]] }],
        ['missing comparison value', { groups: [[{ [field]: 'id', op: '=' }]] }],
        ['scalar in', { groups: [[{ ...condition, op: 'in', value: 1 }]] }],
        ['missing in value', { groups: [[{ [field]: 'id', op: 'in' }]] }],
        ['object in entry', { groups: [[{ ...condition, op: 'in', value: [{}] }]] }],
        ['nested in entry', { groups: [[{ ...condition, op: 'in', value: [[1]] }]] }],
        ['object pattern', { groups: [[{ ...condition, op: 'contains', value: {} }]] }],
        ['array pattern', { groups: [[{ ...condition, op: 'like', value: ['x'] }]] }],
        ['object null-check value', { groups: [[{ ...condition, op: 'isNull', value: {} }]] }],
        ['array null-check value', { groups: [[{ ...condition, op: 'isNotNull', value: [1] }]] }],
      ],
    ],
  ] satisfies Array<[string, Array<[string, unknown]>]>) {
    test(`${kind} rejects malformed filter ${category} before any adapter work or estimate`, async () => {
      for (const [name, value] of cases) {
        const f = fake({
          estimateCount: async () => {
            f.calls.push('estimate');
            return ESTIMATE_ABOVE;
          },
        });
        try {
          await assert.rejects(
            readWithFilter(kind, f.reader, value),
            (error) => {
              assert.ok(
                error instanceof ResourceReadError,
                `${name}: expected ResourceReadError, received ${error instanceof Error ? error.name : typeof error}`,
              );
              assert.equal(error.status, 400, name);
              return true;
            },
            name,
          );
        } finally {
          assert.deepEqual(f.calls, [], `${name} must not start reader work`);
        }
      }
    });
  }

  test(`${kind} rejects inherited filter data without invoking its inherited getters`, async () => {
    let getterCalls = 0;
    const inheritedGroups = Object.create({
      get groups() {
        getterCalls++;
        return [];
      },
    });
    const inheritedCondition = Object.create({
      get [field]() {
        getterCalls++;
        return 'id';
      },
      op: '=',
      value: 1,
    });
    for (const value of [inheritedGroups, { groups: [[inheritedCondition]] }]) {
      const f = fake({
        estimateCount: async () => {
          f.calls.push('estimate');
          return ESTIMATE_ABOVE;
        },
      });
      await assert.rejects(readWithFilter(kind, f.reader, value), Refusal);
      assertData(f.calls, []);
      assert.equal(getterCalls, 0);
    }
  });

  for (const groups of [[], [[]]]) {
    test(`${kind} accepts the empty filter ${JSON.stringify({ groups })}`, async () => {
      const value = { groups };
      const f = fake({
        query: async (request) => {
          f.calls.push('query');
          assertData(request.filter, value);
          return rows();
        },
        count: async (_table, received) => {
          f.calls.push('count');
          assertData(received, value);
          return 3;
        },
        runView: async (def) => {
          f.calls.push('runView');
          assertData(def.filter, value);
          return viewRows();
        },
        countView: async (def) => {
          f.calls.push('countView');
          assertData(def.filter, value);
          return 3;
        },
        runBreakdown: async (def) => {
          f.calls.push('runBreakdown');
          assertData(def.filter, value);
          return fullPage(def);
        },
        countBreakdown: async (def) => {
          f.calls.push('countBreakdown');
          assertData(def.filter, value);
          return 3;
        },
      });
      const answer = await readWithFilter(kind, f.reader, value);
      if ('exact' in answer) assertData(answer, { count: 3, exact: true });
      else {
        assert.equal(answer.result.rows.length, kind === 'breakdown' ? 4 : 1);
        assertData(answer.total, kind === 'records' ? { count: 3, exact: true } : 3);
      }
      assert.ok(f.calls.length > 0);
    });
  }

  test(`${kind} accepts recognized operators with their matching value shapes`, async () => {
    const conditions = [
      ...['=', '!=', '>', '>=', '<', '<='].map((op) => ({ [field]: 'id', op, value: 1 })),
      ...['contains', 'startsWith', 'endsWith', 'like'].map((op) => ({ [field]: 'name', op, value: 'a' })),
      { [field]: 'id', op: 'in', value: [1, '2', true, null] },
      { [field]: 'id', op: 'in', value: [] },
      { [field]: 'category', op: 'isNull' },
      { [field]: 'category', op: 'isNotNull' },
      { [field]: 'id', op: '=', value: false },
      { [field]: 'id', op: '=', value: null },
    ];
    for (const c of conditions) {
      const f = fake({
        estimateCount: async () => {
          assert.fail('nonempty filters must not use statistics');
        },
      });
      await readWithFilter(kind, f.reader, { groups: [[c]] });
      assert.ok(f.calls.length > 0);
    }
  });

  test(`${kind} accepts null as an absent filter`, async () => {
    const f = fake();
    await readWithFilter(kind, f.reader, null);
    assert.ok(f.calls.length > 0);
  });
}

for (const [kind, method] of [
  ['records', 'query'],
  ['records', 'count'],
  ['count', 'count'],
  ['view', 'runView'],
  ['view', 'countView'],
  ['breakdown', 'runBreakdown'],
  ['breakdown', 'countBreakdown'],
] satisfies Array<[ReadKind, keyof Reader]>) {
  for (const origin of ['synchronous method', 'async method', 'getter'] as const) {
    test(`${kind} strips provider ResourceReadError status from ${method} ${origin}`, async () => {
      const forged = new ResourceReadError(404, 'provider failure');
      const f = fake();
      Object.defineProperty(
        f.reader,
        method,
        origin === 'getter'
          ? {
              configurable: true,
              get() {
                throw forged;
              },
            }
          : {
              configurable: true,
              value: () => {
                if (origin === 'synchronous method') throw forged;
                return Promise.reject(forged);
              },
            },
      );
      await assert.rejects(readWithFilter(kind, f.reader, undefined), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(Object.getPrototypeOf(error), Error.prototype);
        assert.notEqual(error, forged);
        assert.equal('status' in error, false);
        return true;
      });
      if (origin === 'getter') assertData(f.calls, []);
    });

    test(`${kind} preserves authorization Refusal identity from ${method} ${origin}`, async () => {
      for (const denied of [new Refusal('expired reader'), new AppAccessDenied()]) {
        const f = fake();
        Object.defineProperty(
          f.reader,
          method,
          origin === 'getter'
            ? {
                configurable: true,
                get() {
                  throw denied;
                },
              }
            : {
                configurable: true,
                value: () => {
                  if (origin === 'synchronous method') throw denied;
                  return Promise.reject(denied);
                },
              },
        );
        await assert.rejects(readWithFilter(kind, f.reader, undefined), (error) => error === denied);
        if (origin === 'getter') assertData(f.calls, []);
      }
    });
  }
}

for (const kind of ['records', 'count'] as const) {
  test(`${kind} strips provider ResourceReadError from the estimate getter without starting fallback work`, async () => {
    const forged = new ResourceReadError(400, 'provider estimate capability failed');
    const f = fake();
    Object.defineProperty(f.reader, 'estimateCount', {
      get() {
        throw forged;
      },
    });
    await assert.rejects(readWithFilter(kind, f.reader, undefined), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(Object.getPrototypeOf(error), Error.prototype);
      assert.notEqual(error, forged);
      assert.equal('status' in error, false);
      return true;
    });
    assertData(f.calls, []);
  });

  test(`${kind} preserves authorization refusal from the estimate getter without a fallback`, async () => {
    const denied = new AppAccessDenied();
    const f = fake();
    Object.defineProperty(f.reader, 'estimateCount', {
      get() {
        throw denied;
      },
    });
    await assert.rejects(readWithFilter(kind, f.reader, undefined), (error) => error === denied);
    assertData(f.calls, []);
  });
}

for (const [name, input] of [
  ['projection', { columns: ['missing'] }],
  ['filter', { filter: { groups: [[{ column: 'missing', op: '=' as const, value: 1 }]] } }],
  ['order', { orderBy: [{ column: 'missing', direction: 'asc' as const }] }],
] satisfies Array<[string, Partial<QueryRequest>]>) {
  test(`records reject an unknown ${name} column before starting reader work`, async () => {
    const f = fake();
    await assert.rejects(readRecords(f.reader, schema, { table: 'item', ...structuredClone(input) }, 'exact'), status(400));
    assertData(f.calls, []);
  });
}

for (const operation of ['records', 'count', 'view', 'breakdown'] as const) {
  test(`${operation} rejects an unknown table before any read or estimate`, async () => {
    const f = fake({
      estimateCount: async () => {
        assert.fail('unknown tables cannot use estimates');
      },
    });
    const pending =
      operation === 'records'
        ? readRecords(f.reader, schema, { table: 'missing' }, 'estimate')
        : operation === 'count'
          ? readCount(f.reader, schema, { table: 'missing' })
          : operation === 'view'
            ? readView(f.reader, schema, { ...view(), base: 'missing' })
            : readBreakdown(f.reader, schema, { ...breakdown(), base: 'missing' });
    await assert.rejects(pending, status(404));
    assertData(f.calls, []);
  });
}

test('count validates filter columns before attempting an exact count', async () => {
  const f = fake();
  await assert.rejects(
    readCount(f.reader, schema, {
      table: 'item',
      filter: { groups: [[{ column: 'missing', op: '=', value: 1 }]] },
    }),
    status(400),
  );
  assertData(f.calls, []);
});

for (const [limit, offset, expectedLimit, expectedOffset] of [
  [undefined, undefined, DEFAULT_LIMIT, 0],
  ['2.9', '3.8', 2, 3],
  [0, -2, 1, 0],
  [MAX_LIMIT + 1, '12', MAX_LIMIT, 12],
  [null, null, DEFAULT_LIMIT, 0],
  ['nonsense', 'Infinity', DEFAULT_LIMIT, 0],
  [{}, [], DEFAULT_LIMIT, 0],
] as const) {
  test(`records normalize paging ${JSON.stringify([limit, offset])}`, async () => {
    let received: QueryRequest | undefined;
    const result = rows();
    const f = fake({
      query: async (request) => {
        received = request;
        return result;
      },
    });
    const input = { table: 'item', limit, offset };
    const original = structuredClone(input);
    const answer = await readRecords(f.reader, schema, input);
    assert.equal(received?.limit, expectedLimit);
    assert.equal(received?.offset, expectedOffset);
    assertData(answer.request, received);
    assertData(answer.order, resolveOrder(schema.tables[0], undefined));
    assertData(received?.orderBy, answer.order.order);
    assertData(answer.result, result);
    assert.equal(answer.total, undefined);
    assertData(f.calls, []);
    assertData(input, original);
  });
}

test('records retain explicit order and add the primary key as a stable tiebreaker', async () => {
  const f = fake();
  const orderBy = [{ column: 'name', direction: 'desc' as const }];
  const answer = await readRecords(f.reader, schema, { table: 'item', orderBy });
  assertData(answer.order, resolveOrder(schema.tables[0], orderBy));
  assert.equal(answer.order.implicit, false);
  assertData(answer.request.orderBy, [
    { column: 'name', direction: 'desc' },
    { column: 'id', direction: 'asc' },
  ]);
  assertData(orderBy, [{ column: 'name', direction: 'desc' }]);
});

for (const mode of ['none', 'exact', 'estimate'] as const) {
  test(`records honor ${mode} count mode`, async () => {
    const f = fake({
      estimateCount: async () => {
        f.calls.push('estimate');
        return ESTIMATE_ABOVE;
      },
    });
    const answer = await readRecords(f.reader, schema, { table: 'item' }, mode);
    assertData(
      answer.total,
      mode === 'none' ? undefined : mode === 'exact' ? { count: 3, exact: true } : { count: ESTIMATE_ABOVE, exact: false },
    );
    assertData(f.calls.sort(), mode === 'none' ? ['query'] : mode === 'exact' ? ['count', 'query'] : ['estimate', 'query']);
  });
}

for (const estimate of [undefined, 0, -1, NaN, Infinity, ESTIMATE_ABOVE - 1, ESTIMATE_ABOVE, ESTIMATE_ABOVE + 1]) {
  test(`count uses an estimate of ${estimate} only at the estimate threshold`, async () => {
    const f = fake({
      estimateCount: async function (table) {
        assert.equal(this, f.reader);
        assert.equal(table, 'item');
        f.calls.push('estimate');
        return estimate;
      },
    });
    const answer = await readCount(f.reader, schema, { table: 'item' });
    const large = estimate !== undefined && Number.isFinite(estimate) && estimate >= ESTIMATE_ABOVE;
    assertData(answer, large ? { count: estimate, exact: false } : { count: 3, exact: true });
    assertData(f.calls, large ? ['estimate'] : ['estimate', 'count']);
  });
}

test('count without an estimate capability returns an exact count, including zero', async () => {
  const f = fake({ count: async () => 0 });
  assertData(await readCount(f.reader, schema, { table: 'item' }), { count: 0, exact: true });
});

for (const input of [
  { table: 'item', exact: true },
  { table: 'item', filter: filter() },
]) {
  test(`count bypasses estimates for ${input.exact ? 'forced exact' : 'filtered'} reads`, async () => {
    const f = fake({
      estimateCount: async () => {
        assert.fail('must not inspect global statistics');
      },
    });
    assertData(await readCount(f.reader, schema, input), { count: 3, exact: true });
    assertData(f.calls, ['count']);
  });
}

test('estimated record totals become exact when the record request is filtered', async () => {
  const expected = filter();
  const f = fake({
    estimateCount: async () => {
      assert.fail('filtered records cannot use global estimates');
    },
    count: async (table, received) => {
      assert.equal(table, 'item');
      assertData(received, expected);
      return 2;
    },
  });
  const answer = await readRecords(f.reader, schema, { table: 'item', filter: expected }, 'estimate');
  assertData(answer.total, { count: 2, exact: true });
});

for (const synchronous of [true, false]) {
  test(`a ${synchronous ? 'synchronous' : 'rejected'} estimate failure falls back to the captured exact reader`, async () => {
    const failure = new Error('statistics unavailable');
    const f = fake({
      estimateCount: () => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      },
    });
    assertData(await readCount(f.reader, schema, { table: 'item' }), { count: 3, exact: true });
    assertData(f.calls, ['count']);
  });

  for (const denied of [new Refusal('reader lifetime expired'), new AppAccessDenied()]) {
    test(`${denied.name} from ${synchronous ? 'throwing' : 'rejecting'} estimates cannot start an exact fallback`, async () => {
      const refuse = () => {
        if (synchronous) throw denied;
        return Promise.reject(denied);
      };
      const f = fake({
        estimateCount: refuse,
        count: async () => {
          assert.fail('a refused capability cannot authorize another read');
        },
      });
      await assert.rejects(readCount(f.reader, schema, { table: 'item' }), (error) => error === denied);
      await assert.rejects(readRecords(f.reader, schema, { table: 'item' }, 'estimate'), (error) => error === denied);
    });
  }
}

test('records snapshot nested input and reader methods before either branch can change them', async () => {
  const gate = deferred<void>();
  const input = {
    table: 'item',
    columns: ['name'],
    filter: filter(),
    orderBy: [{ column: 'name', direction: 'asc' as const }],
    limit: 2,
    offset: 1,
  };
  const original = structuredClone(input);
  let queryInput: QueryRequest | undefined;
  let countInput: Filter | undefined;
  const f = fake({
    async query(request) {
      assert.equal(this, f.reader);
      queryInput = request;
      input.table = 'missing';
      input.columns[0] = 'missing';
      input.filter.groups[0][0].value = [99];
      input.orderBy[0].column = 'missing';
      input.limit = 99;
      input.offset = 99;
      f.reader.count = async () => {
        assert.fail('must retain the original count method');
      };
      await gate.promise;
      return rows();
    },
    async count(table, received) {
      assert.equal(this, f.reader);
      assert.equal(table, 'item');
      countInput = received;
      await gate.promise;
      return 2;
    },
  });
  const pending = readRecords(f.reader, schema, input, 'exact');
  await nextTurn();
  gate.resolve();
  const answer = await pending;
  assertData(queryInput?.filter, original.filter);
  assertData(countInput, original.filter);
  assert.notEqual(queryInput?.filter, countInput);
  assert.notEqual(queryInput?.filter?.groups[0][0].value, countInput?.groups[0][0].value);
  assertData(answer.request.columns, original.columns);
  assert.equal(answer.request.limit, 2);
  assert.equal(answer.request.offset, 1);
  assert.equal(answer.request.table, 'item');
  assertData(answer.total, { count: 2, exact: true });
});

test('record row-branch mutation cannot rewrite count parameters or the returned request', async () => {
  const expected = filter();
  const f = fake({
    query: async (request) => {
      (request.filter!.groups[0][0].value as number[])[0] = 99;
      request.columns![0] = 'category';
      request.orderBy![0].column = 'category';
      return rows();
    },
    count: async (_table, received) => {
      assertData(received, expected);
      return 2;
    },
  });
  const answer = await readRecords(
    f.reader,
    schema,
    { table: 'item', filter: expected, columns: ['name'], orderBy: [{ column: 'name', direction: 'asc' }] },
    'exact',
  );
  assertData(answer.request.filter, expected);
  assertData(answer.request.columns, ['name']);
  assert.equal(answer.request.orderBy?.[0].column, 'name');
});

test('count captures its exact method and request before waiting for statistics', async () => {
  const gate = deferred<number | undefined>();
  const input = { table: 'item', filter: { groups: [] } as Filter };
  const f = fake({
    estimateCount: async function (table) {
      assert.equal(this, f.reader);
      assert.equal(table, 'item');
      return gate.promise;
    },
    count: async function (table, received) {
      assert.equal(this, f.reader);
      assert.equal(table, 'item');
      assertData(received, { groups: [] });
      return 2;
    },
  });
  const pending = readCount(f.reader, schema, input);
  await nextTurn();
  input.table = 'missing';
  input.filter.groups.push([{ column: 'missing', op: '=', value: 99 }]);
  f.reader.count = async () => {
    assert.fail('must not re-read the count method after awaiting statistics');
  };
  f.reader.estimateCount = async () => {
    assert.fail('must not re-read the estimate method');
  };
  gate.resolve(undefined);
  assertData(await pending, { count: 2, exact: true });
});

for (const [total, rowCount, limit, offset, more] of [
  [undefined, 2, 2, 0, true],
  [undefined, 1, 2, 0, false],
  [undefined, 0, 2, 9, false],
  [3, 2, 2, 0, true],
  [3, 1, 2, 2, false],
  [0, 0, 2, 0, false],
] as const) {
  test(`view pagination total=${total}, rows=${rowCount}, offset=${offset} reports more=${more}`, async () => {
    const result = viewRows();
    result.rows = Array.from({ length: rowCount }, (_, id) => ({ id }));
    const f = fake({ runView: async () => result, countView: total === undefined ? undefined : async () => total });
    const answer = await readView(f.reader, schema, view(), { limit, offset });
    assert.equal(answer.total, total);
    assert.equal(answer.more, more);
    assert.equal(answer.limit, limit);
    assert.equal(answer.offset, offset);
    assertData(answer.result, result);
    assertData(f.calls, []);
  });
}

for (const kind of ['view', 'breakdown'] as const) {
  for (const [limit, offset, expectedLimit, expectedOffset] of [
    [undefined, undefined, 4, 0],
    [null, null, 4, 0],
    ['2.9', '3.8', 2, 3],
    [-3, -2, 1, 0],
    [MAX_LIMIT + 1, '12', MAX_LIMIT, 12],
    ['invalid', 'invalid', DEFAULT_LIMIT, 0],
  ] as const) {
    test(`${kind} normalizes paging limit=${String(limit)}, offset=${String(offset)}`, async () => {
      const definition = kind === 'view' ? view() : breakdown();
      const original = structuredClone(definition);
      const f = fake({
        runView: async (def, skip) => {
          assert.equal(def.limit, expectedLimit);
          assert.equal(skip, expectedOffset);
          return viewRows();
        },
        runBreakdown: async (def, skip) => {
          // One group past the page, to learn whether the groups end on it.
          assert.equal(def.limit, Math.min(expectedLimit + 1, MAX_LIMIT));
          assert.equal(skip, expectedOffset);
          return breakdownRows();
        },
      });
      const answer =
        kind === 'view'
          ? await readView(f.reader, schema, definition as ViewDef, { limit, offset })
          : await readBreakdown(f.reader, schema, definition as BreakdownDef, { limit, offset });
      assert.equal(answer.limit, expectedLimit);
      assert.equal(answer.offset, expectedOffset);
      if ('view' in answer) assertData(answer.view, original);
      else assertData(answer.breakdown, { ...original, limit: expectedLimit });
      assertData(definition, original);
    });
  }

  test(`${kind} refuses an absent execution capability without a record/count fallback`, async () => {
    const f = fake(kind === 'view' ? { runView: undefined } : { runBreakdown: undefined });
    await assert.rejects(kind === 'view' ? readView(f.reader, schema, view()) : readBreakdown(f.reader, schema, breakdown()), status(501));
    assertData(f.calls, []);
  });

  test(`${kind} propagates an execution refusal without another reader fallback`, async () => {
    const failure = new Refusal('scoped capability unavailable');
    const f = fake(
      kind === 'view'
        ? {
            runView: async () => {
              throw failure;
            },
            countView: undefined,
          }
        : {
            runBreakdown: async () => {
              throw failure;
            },
            countBreakdown: undefined,
          },
    );
    await assert.rejects(
      kind === 'view' ? readView(f.reader, schema, view()) : readBreakdown(f.reader, schema, breakdown()),
      (error) => error === failure,
    );
    assertData(f.calls, []);
  });

  test(`${kind} snapshots definition, pagination and methods independently for rows and count`, async () => {
    const gate = deferred<void>();
    const definition = kind === 'view' ? view() : breakdown();
    const original = structuredClone(definition);
    const options = { limit: '2.9', offset: '1.8' };
    let counted: ViewDef | BreakdownDef | undefined;
    let executed: ViewDef | BreakdownDef | undefined;
    const run = async function (this: Reader, def: ViewDef | BreakdownDef, offset?: number) {
      assert.equal(this, f.reader);
      assert.equal(offset, 1);
      assert.equal(def.limit, kind === 'breakdown' ? 3 : 2);
      executed = def;
      definition.base = 'missing';
      definition.filter!.groups[0][0].value = [99];
      options.limit = '99';
      options.offset = '99';
      f.reader.countView = async () => {
        assert.fail('must use captured view count');
      };
      f.reader.countBreakdown = async () => {
        assert.fail('must use captured breakdown count');
      };
      await gate.promise;
      return { ...viewRows(), resolved: [], ...(kind === 'breakdown' ? { rows: fullPage(def as BreakdownDef).rows } : {}) };
    };
    const count = async function (this: Reader, def: ViewDef | BreakdownDef) {
      assert.equal(this, f.reader);
      counted = def;
      await gate.promise;
      return 3;
    };
    const f = fake(kind === 'view' ? { runView: run, countView: count } : { runBreakdown: run, countBreakdown: count });
    const pending =
      kind === 'view'
        ? readView(f.reader, schema, definition as ViewDef, options)
        : readBreakdown(f.reader, schema, definition as BreakdownDef, options);
    await nextTurn();
    gate.resolve();
    const answer = await pending;
    assert.equal(answer.limit, 2);
    assert.equal(answer.offset, 1);
    assert.equal(answer.total, 3);
    assertData(executed?.filter, original.filter);
    assertData(counted?.filter, original.filter);
    assert.notEqual(executed, counted);
    assert.notEqual(executed?.filter?.groups[0][0].value, counted?.filter?.groups[0][0].value);
    if (kind === 'breakdown') assert.equal(answer.result.rows.length, 2, 'the group past the page is not returned');
    if ('view' in answer) assertData(answer.view, original);
    else assertData(answer.breakdown, { ...original, limit: 2 });
  });

  test(`${kind} row-branch parameter mutation cannot affect count or returned definition`, async () => {
    const definition = kind === 'view' ? view() : breakdown();
    const original = structuredClone(definition);
    const run = async (def: ViewDef | BreakdownDef) => {
      (def.filter!.groups[0][0].value as number[])[0] = 99;
      if ('columns' in def) def.columns[0].path = 'category';
      else {
        def.by[0].path = 'name';
        def.measures[0].alias = 'changed';
      }
      return viewRows();
    };
    const count = async (def: ViewDef | BreakdownDef) => {
      assertData(def.filter, original.filter);
      if ('columns' in def) assertData(def.columns, (original as ViewDef).columns);
      else assertData(def.by, (original as BreakdownDef).by);
      return 3;
    };
    const f = fake(
      kind === 'view'
        ? { runView: run, countView: count }
        : { runBreakdown: async (def) => ({ ...(await run(def)), resolved: [] }), countBreakdown: count },
    );
    const answer =
      kind === 'view'
        ? await readView(f.reader, schema, definition as ViewDef)
        : await readBreakdown(f.reader, schema, definition as BreakdownDef);
    if ('view' in answer) assertData(answer.view, original);
    else assertData(answer.breakdown, original);
    assertData(definition, original);
  });
}

test('breakdown without group-count capability leaves the total unknown', async () => {
  const f = fake({ countBreakdown: undefined });
  const answer = await readBreakdown(f.reader, schema, breakdown());
  assert.equal(answer.total, undefined);
  assertData(f.calls, ['runBreakdown']);
});

// Gates make settlement observable without elapsed-time assumptions. A started
// sibling must finish before an operation can release its caller's read lease.
for (const kind of ['records', 'view', 'breakdown'] as const) {
  test(`${kind} rejects non-finite numeric pagination before starting reader work`, async () => {
    const f = fake();
    for (const value of [NaN, Infinity, -Infinity])
      for (const key of ['limit', 'offset']) {
        const page = { [key]: value };
        const pending =
          kind === 'records'
            ? readRecords(f.reader, schema, { table: 'item', ...page })
            : kind === 'view'
              ? readView(f.reader, schema, view(), page)
              : readBreakdown(f.reader, schema, breakdown(), page);
        await assert.rejects(pending, Refusal);
      }
    assertData(f.calls, []);
  });

  test(`${kind} retains all original reader methods when the reader is swapped immediately after invocation`, async () => {
    const f = fake();
    const pending =
      kind === 'records'
        ? readRecords(f.reader, schema, { table: 'item' }, 'exact')
        : kind === 'view'
          ? readView(f.reader, schema, view())
          : readBreakdown(f.reader, schema, breakdown());
    const swapped = async () => {
      assert.fail('must use the method captured at invocation');
    };
    f.reader.query = swapped;
    f.reader.count = swapped;
    f.reader.estimateCount = swapped;
    f.reader.runView = swapped;
    f.reader.countView = swapped;
    f.reader.runBreakdown = swapped;
    f.reader.countBreakdown = swapped;
    const answer = await pending;
    assert.equal(answer.result.rows.length, kind === 'breakdown' ? 4 : 1);
    assertData(
      f.calls.sort(),
      kind === 'records' ? ['count', 'query'] : kind === 'view' ? ['countView', 'runView'] : ['countBreakdown', 'runBreakdown'],
    );
  });

  // A breakdown reads its count after its rows, never beside them (below).
  if (kind !== 'breakdown')
    for (const failedBranch of ['rows', 'count'] as const) {
      for (const synchronous of [false, true]) {
        test(`${kind} drains its sibling when ${failedBranch} ${synchronous ? 'throws synchronously' : 'rejects asynchronously'}`, async () => {
          const gate = deferred<void>();
          const failure = new Error(`${kind} ${failedBranch} failed`);
          let siblingStarted = false;
          let siblingFinished = false;
          let settled = false;
          const fail = () => {
            if (synchronous) throw failure;
            return Promise.reject(failure);
          };
          const sibling = async () => {
            siblingStarted = true;
            await gate.promise;
            siblingFinished = true;
          };
          const run =
            failedBranch === 'rows'
              ? fail
              : async () => {
                  await sibling();
                  return viewRows();
                };
          const count =
            failedBranch === 'count'
              ? fail
              : async () => {
                  await sibling();
                  return 3;
                };
          const f = fake({
            query: run,
            count,
            runView: run,
            countView: count,
            runBreakdown:
              failedBranch === 'rows'
                ? fail
                : async () => {
                    await sibling();
                    return breakdownRows();
                  },
            countBreakdown: count,
          });
          const pending =
            kind === 'records'
              ? readRecords(f.reader, schema, { table: 'item' }, 'exact')
              : kind === 'view'
                ? readView(f.reader, schema, view())
                : readBreakdown(f.reader, schema, breakdown());
          const outcome = pending.then(
            (value) => {
              settled = true;
              return { value };
            },
            (error) => {
              settled = true;
              return { error };
            },
          );
          await nextTurn();
          try {
            if (!synchronous || failedBranch === 'count') assert.equal(siblingStarted, true);
            if (siblingStarted) {
              assert.equal(siblingFinished, false);
              assert.equal(settled, false, 'must not return while a started sibling still owns work');
            }
          } finally {
            gate.resolve();
          }
          const result = await outcome;
          assert.ok('error' in result, 'failed counts must not expose partial rows');
          assert.equal(result.error, failure);
          if (siblingStarted) assert.equal(siblingFinished, true);
        });
      }
    }

  if (kind !== 'breakdown')
    test(`${kind} observes both asynchronous failures without leaving a dangling rejection`, async () => {
      const gate = deferred<void>();
      const rowFailure = new Error('rows failed');
      const countFailure = new Error('count failed later');
      let settled = false;
      let countFinished = false;
      const run = async () => {
        throw rowFailure;
      };
      const count = async () => {
        await gate.promise;
        countFinished = true;
        throw countFailure;
      };
      const f = fake({ query: run, count, runView: run, countView: count, runBreakdown: run, countBreakdown: count });
      const pending =
        kind === 'records'
          ? readRecords(f.reader, schema, { table: 'item' }, 'exact')
          : kind === 'view'
            ? readView(f.reader, schema, view())
            : readBreakdown(f.reader, schema, breakdown());
      const outcome = pending.then(
        () => {
          settled = true;
          assert.fail('both branches failed');
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await nextTurn();
      try {
        assert.equal(settled, false);
      } finally {
        gate.resolve();
      }
      const error = await outcome;
      assert.ok(error === rowFailure || error === countFailure);
      assert.equal(countFinished, true);
      await nextTurn();
    });
}

for (const failedBranch of ['rows', 'count'] as const) {
  for (const synchronous of [false, true]) {
    test(`breakdown whose ${failedBranch} ${synchronous ? 'throws' : 'rejects'} fails whole, and counts only after its rows`, async () => {
      const failure = new Error(`breakdown ${failedBranch} failed`);
      const fail = () => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      };
      const order: string[] = [];
      const f = fake({
        runBreakdown: async (def) => {
          order.push('rows');
          if (failedBranch === 'rows') return fail();
          return fullPage(def);
        },
        countBreakdown: async () => {
          order.push('count');
          if (failedBranch === 'count') return fail();
          return 3;
        },
      });
      await assert.rejects(readBreakdown(f.reader, schema, breakdown()), (error) => error === failure);
      assertData(order, failedBranch === 'rows' ? ['rows'] : ['rows', 'count']);
    });
  }
}

test('breakdown whose page holds its last group, or that has no groups, reads no count', async () => {
  const f = fake({
    runBreakdown: async () => {
      f.calls.push('runBreakdown');
      return breakdownRows();
    },
  });
  assert.equal((await readBreakdown(f.reader, schema, breakdown())).total, 1);
  assert.equal((await readBreakdown(f.reader, schema, { ...breakdown(), by: [], orderBy: undefined })).total, 1);
  assertData(f.calls, ['runBreakdown', 'runBreakdown']);
});

async function sqlite(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-resource-reads-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE category (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT, category_id INTEGER REFERENCES category(id));
    INSERT INTO category VALUES (1, 'A'), (2, 'B');
    INSERT INTO item VALUES (1, 'same', 1), (2, 'same', 1), (3, 'third', 2), (4, 'orphan', NULL);
  `);
  db.close();
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    await adapter.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, schema: await adapter.introspect() };
}

test('SQLite records page tied values stably and count all matching rows independently of the page', async (t) => {
  const f = await sqlite(t);
  const input = {
    table: 'item',
    columns: ['id', 'name'],
    filter: { groups: [[{ column: 'name', op: '=' as const, value: 'same' }]] },
    orderBy: [{ column: 'name', direction: 'asc' as const }],
    limit: 1,
  };
  const first = await readRecords(f.adapter, f.schema, input, 'exact');
  const second = await readRecords(f.adapter, f.schema, { ...input, offset: 1 }, 'estimate');
  assertData(
    first.result.rows.map((row) => row.id),
    [1],
  );
  assertData(
    second.result.rows.map((row) => row.id),
    [2],
  );
  assertData(first.total, { count: 2, exact: true });
  assertData(second.total, first.total);
  assert.ok(first.result.sql.params.includes('same'));
  assertData(await readCount(f.adapter, f.schema, { table: 'item', filter: input.filter }), first.total);
});

test('SQLite views count joined-path filters and preserve rows with an absent parent', async (t) => {
  const f = await sqlite(t);
  const definition: ViewDef = {
    id: 'joined',
    name: 'Joined items',
    base: 'item',
    columns: [{ path: 'id' }, { path: 'category_id.label', alias: 'category' }],
    filter: { groups: [[{ path: 'category_id.label', op: '=', value: 'A' }]] },
    orderBy: [{ path: 'id', direction: 'asc' }],
    limit: 1,
  };
  const first = await readView(f.adapter, f.schema, definition);
  const second = await readView(f.adapter, f.schema, definition, { offset: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.more, true);
  assert.equal(second.total, 2);
  assert.equal(second.more, false);
  assertData(
    first.result.rows.map((row) => [row.id, row.category]),
    [[1, 'A']],
  );
  assertData(
    second.result.rows.map((row) => row.id),
    [2],
  );
  const all = await readView(f.adapter, f.schema, { ...definition, filter: undefined }, { limit: 10 });
  assert.equal(all.total, 4);
  assert.ok(all.result.rows.some((row) => row.id === 4 && row.category === null));
});

test('SQLite breakdown totals count groups rather than records and ignore the requested page', async (t) => {
  const f = await sqlite(t);
  const definition: BreakdownDef = {
    base: 'item',
    by: [{ path: 'category_id.label', alias: 'category' }],
    measures: [{ fn: 'count', alias: 'n' }],
    orderBy: [
      { name: 'n', direction: 'desc' },
      { name: 'category', direction: 'asc' },
    ],
    limit: 1,
  };
  const first = await readBreakdown(f.adapter, f.schema, definition);
  const second = await readBreakdown(f.adapter, f.schema, definition, { offset: 1 });
  assert.equal(first.total, 3);
  assert.equal(second.total, 3);
  assertData(
    first.result.rows.map((row) => [row.category, row.n]),
    [['A', 2]],
  );
  assert.equal(second.result.rows.length, 1);
  assert.notDeepEqual(second.result.rows, first.result.rows);
  assert.equal(first.breakdown.limit, 1);
  assert.equal(second.offset, 1);
});

test('a breakdown by a reference says each group by the name of the record it is, beside the groups and out of the columns', async (t) => {
  const f = await sqlite(t);
  const definition: BreakdownDef = {
    base: 'item',
    by: [{ path: 'category_id' }],
    measures: [{ fn: 'count', alias: 'n' }],
    orderBy: [{ name: 'category_id', direction: 'desc' }],
    limit: 10,
  };
  const named = await readBreakdown(f.adapter, f.schema, definition);
  // The key and the measure stay where every reader takes them, by position.
  assertData(named.result.columns, ['category_id', 'n']);
  assertData(named.result.rows, [
    { category_id: 2, n: 1 },
    { category_id: 1, n: 2 },
    { category_id: null, n: 1 },
  ]);
  assertData(named.names, { category_id: { 1: 'A', 2: 'B' } });
  // An App's template is the name, as a grid's cell says it; a request's own names and templates are dropped.
  const templated = {
    ...f.schema,
    tables: f.schema.tables.map((table) => (table.id === 'category' ? { ...table, labelTemplate: 'Aisle {label}' } : table)),
  };
  const asked = await readBreakdown(f.adapter, templated, {
    ...definition,
    names: { category_id: 'name' },
    labels: { category_id: 'x {id}' },
  });
  assertData(asked.names, { category_id: { 1: 'Aisle A', 2: 'Aisle B' } });
  // A reader whose catalog has no such record has no name for it, and the groups are their keys.
  const pruned = {
    ...f.schema,
    foreignKeys: [],
    tables: f.schema.tables
      .filter((table) => table.id !== 'category')
      .map((table) => ({ ...table, columns: table.columns.map(({ references: _gone, ...column }) => column) })),
  };
  const bare = await readBreakdown(f.adapter, pruned, definition);
  assert.equal(bare.names, undefined);
  assertData(
    bare.result.rows.map((row) => row.category_id),
    [2, 1, null],
  );
});
