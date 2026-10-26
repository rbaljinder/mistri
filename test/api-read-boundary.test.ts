import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema, Order } from '../packages/engine/src/shared/schema.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { createApiReadBoundaryCodec } from '../packages/mistri/src/server/api/apiReadBoundary.js';

function fixture() {
  const app = parseAppConfig(
    {
      id: 'boundary',
      name: 'Boundary',
      resources: { item: {} },
      auth: { roles: { reader: { read: true } } },
      home: 'items',
      views: { items: { kind: 'list', from: 'item' } },
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'rank'], sorts: ['rank'] } } },
    },
    'test',
  );
  const schema: DatabaseSchema = {
    label: 'Logical',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: ['id', 'rank', 'secret'].map((name) => ({
          name,
          type: 'INTEGER',
          nullable: false,
          primaryKey: name === 'id',
        })),
      },
    ],
  };
  const operation = checkApiReadCatalog(app.api!, app, schema).operations.find((operation) => operation.kind === 'list')!;
  return { schema, operation };
}

for (const direction of ['asc', 'desc'] as const)
  test(`typed continuation matches the exact suffix with ${direction} ranks and tied values`, () => {
    const f = fixture(),
      order: Order[] = [
        { column: 'rank', direction },
        { column: 'id', direction: 'asc' },
      ];
    const codec = createApiReadBoundaryCodec(f.operation, f.schema, order, { integers: 'decimal-string' });
    const rows = [1, 2, 3].flatMap((rank) => [1, 2, 3].map((id) => ({ rank: String(rank), id: String(rank * 3 + id) })));
    rows.sort((a, b) => (Number(a.rank) - Number(b.rank)) * (direction === 'asc' ? 1 : -1) || Number(a.id) - Number(b.id));
    for (const [index, boundary] of rows.entries()) {
      const branches = codec.after(boundary);
      const matches = rows.filter((row) =>
        branches.some((branch) =>
          branch.every((term) => {
            const left = BigInt(row[term.field as 'rank' | 'id']),
              right = BigInt(String(term.value));
            return term.operator === '=' ? left === right : term.operator === '>' ? left > right : left < right;
          }),
        ),
      );
      assert.deepEqual(matches, rows.slice(index + 1));
      assert.ok(Object.isFrozen(branches) && branches.every((branch) => Object.isFrozen(branch) && branch.every(Object.isFrozen)));
    }
    order[0].direction = direction === 'asc' ? 'desc' : 'asc';
    assert.equal(codec.order[0].direction, direction);
  });

for (const direction of ['asc', 'desc'] as const)
  test(`a vocabulary continues in its declared order, ${direction}, by naming the values past it`, () => {
    const stages = ['new', 'qualified', 'won', 'lost'];
    const app = parseAppConfig(
      {
        id: 'boundary',
        name: 'Boundary',
        resources: { item: {} },
        auth: { roles: { reader: { read: true } } },
        home: 'items',
        views: { items: { kind: 'list', from: 'item' } },
        api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'stage'], sorts: ['stage'] } } },
      },
      'test',
    );
    const schema: DatabaseSchema = {
      label: 'Logical',
      dialect: 'sqlite',
      readAt: '',
      foreignKeys: [],
      tables: [
        {
          id: 'item',
          name: 'item',
          schema: '',
          isView: false,
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
            { name: 'stage', type: 'TEXT', nullable: false, primaryKey: false, allowed: stages },
          ],
        },
      ],
    };
    const operation = checkApiReadCatalog(app.api!, app, schema).operations.find((operation) => operation.kind === 'list')!;
    const codec = createApiReadBoundaryCodec(
      operation,
      schema,
      [
        { column: 'stage', direction },
        { column: 'id', direction: 'asc' },
      ],
      { integers: 'decimal-string' },
    );
    const rows = stages.flatMap((stage, at) => [1, 2].map((id) => ({ stage, id: String(at * 2 + id) })));
    if (direction === 'desc') rows.sort((a, b) => stages.indexOf(b.stage) - stages.indexOf(a.stage) || Number(a.id) - Number(b.id));
    for (const [index, boundary] of rows.entries()) {
      const branches = codec.after(boundary);
      const matches = rows.filter((row) =>
        branches.some((branch) =>
          branch.every((term) => {
            const left = row[term.field as 'stage' | 'id'];
            if (term.operator === 'in') return (term.value as readonly string[]).includes(left);
            if (term.field === 'id') {
              const a = Number(left),
                b = Number(term.value);
              return term.operator === '=' ? a === b : term.operator === '>' ? a > b : a < b;
            }
            return term.operator === '=' && left === term.value;
          }),
        ),
      );
      assert.deepEqual(matches, rows.slice(index + 1));
    }
    // A value outside the vocabulary is no boundary.
    assert.throws(() => codec.after({ stage: 'archived', id: '1' }));
  });

test('boundary codec keeps large keys exact, strips unrelated data and validates its actual schema', () => {
  const f = fixture(),
    codec = createApiReadBoundaryCodec(
      f.operation,
      f.schema,
      [
        { column: 'rank', direction: 'desc' },
        { column: 'id', direction: 'asc' },
      ],
      { integers: 'decimal-string' },
    );
  const encoded = codec.encode({ rank: 4, id: '9223372036854775807', secret: 'must not enter a cursor' });
  assert.deepEqual(Object.keys(encoded), ['rank', 'id']);
  assert.equal(encoded.id, '9223372036854775807');
  assert.equal(new Ajv2020({ strict: true }).compile(codec.schema)(encoded), true);
  assert.equal(codec.after(encoded)[1][1].value, '9223372036854775807');
  assert.equal(codec.cursorVerification, 'pending');
  assert.equal(codec.authorization, 'pending');
  assert.equal(codec.collationValidation, 'binary-text');
  let calls = 0;
  assert.throws(() =>
    codec.encode({
      id: 1,
      get rank() {
        calls++;
        return 1;
      },
    }),
  );
  assert.equal(calls, 0);
  for (const value of [{ rank: 4 }, { rank: null, id: 1 }, { rank: 1, id: '9223372036854775808' }])
    assert.throws(() => codec.encode(value));
});

test('boundary ordering refuses incomplete keys, hidden fields, duplicate sorts and nullability', () => {
  const f = fixture();
  for (const order of [
    [],
    [{ column: 'rank', direction: 'asc' }],
    [
      { column: 'secret', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ],
    [
      { column: 'id', direction: 'asc' },
      { column: 'id', direction: 'desc' },
    ],
  ] as Order[][]) {
    assert.throws(() => createApiReadBoundaryCodec(f.operation, f.schema, order, { integers: 'number' }));
  }
  f.schema.tables[0].columns[0].nullable = true;
  assert.throws(() => createApiReadBoundaryCodec(f.operation, f.schema, [{ column: 'id', direction: 'asc' }], { integers: 'number' }));
});

test('composite-key continuation is the exact suffix for every mixed direction and captures metadata', () => {
  for (const rankDirection of ['asc', 'desc'] as const)
    for (const idDirection of ['asc', 'desc'] as const)
      for (const partDirection of ['asc', 'desc'] as const) {
        const f = fixture();
        f.schema.tables[0].columns.push({ name: 'part', type: 'INTEGER', nullable: false, primaryKey: true });
        const operation = { ...f.operation, fields: ['id', 'rank', 'part'], primaryKey: ['id', 'part'] };
        const order: Order[] = [
          { column: 'rank', direction: rankDirection },
          { column: 'id', direction: idDirection },
          { column: 'part', direction: partDirection },
        ];
        assert.throws(() => createApiReadBoundaryCodec(operation, f.schema, order.slice(0, 2), { integers: 'decimal-string' }));
        const codec = createApiReadBoundaryCodec(operation, f.schema, order, { integers: 'decimal-string' });
        const rows = [1, 2].flatMap((rank) =>
          ['9007199254740993', '9007199254740994'].flatMap((id) =>
            [1, 2, 3].map((part) => ({ rank: String(rank), id, part: String(part) })),
          ),
        );
        rows.sort((a, b) => {
          for (const item of order) {
            const left = BigInt(a[item.column as keyof typeof a]),
              right = BigInt(b[item.column as keyof typeof b]);
            if (left !== right) return (left < right ? -1 : 1) * (item.direction === 'asc' ? 1 : -1);
          }
          return 0;
        });
        // All metadata is captured before caller mutations, including scalars.
        operation.fields.length = 0;
        operation.primaryKey.length = 0;
        order.reverse();
        f.schema.tables[0].columns.forEach((column) => {
          column.type = 'TEXT';
          column.nullable = true;
        });
        for (const [index, boundary] of rows.entries()) {
          const branches = codec.after(boundary);
          const matches = rows.filter((row) =>
            branches.some((branch) =>
              branch.every((term) => {
                const left = BigInt(row[term.field as keyof typeof row]),
                  right = BigInt(String(term.value));
                return term.operator === '=' ? left === right : term.operator === '>' ? left > right : left < right;
              }),
            ),
          );
          assert.deepEqual(matches, rows.slice(index + 1));
        }
        assert.throws(() => codec.encode({ rank: 'not-an-integer', id: '9007199254740993', part: 1 }));
      }
});
