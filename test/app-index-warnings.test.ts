import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appIndexWarnings, LARGE_TABLE_ROWS } from '../packages/mistri/src/shared/appIndexWarnings.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import type { PageDef } from '../packages/engine/src/shared/pageModel.js';

const col = (name: string) => ({ name, type: 'integer', nullable: true, primaryKey: name === 'id' });
const table = (id: string, columns: string[], extra: Partial<TableMeta> = {}): TableMeta =>
  ({ id, name: id, schema: '', isView: false, columns: columns.map(col), ...extra }) as TableMeta;

function schema(indexed: { line?: string[]; invoice?: string[] } = {}, approxRows?: number): DatabaseSchema {
  return {
    dialect: 'postgres',
    tables: [
      table('customer', ['id', 'name']),
      table('invoice', ['id', 'customer_id', 'tenant_id', 'issued_on'], {
        ...(indexed.invoice ? { indexed: indexed.invoice } : {}),
        ...(approxRows ? { approxRows } : {}),
      }),
      table('line', ['id', 'invoice_id', 'amount'], indexed.line ? { indexed: indexed.line } : {}),
    ],
    foreignKeys: [
      { name: 'invoice_customer', from: { table: 'invoice', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
      { name: 'line_invoice', from: { table: 'line', columns: ['invoice_id'] }, to: { table: 'invoice', columns: ['id'] } },
    ],
  } as unknown as DatabaseSchema;
}
const app = (views: Record<string, unknown> = {}) => ({ name: 'Billing', views, nav: [] }) as unknown as AppDef;
const page: PageDef = {
  id: 'customer',
  name: 'Customer',
  base: 'customer',
  sections: [{ kind: 'list', from: 'line', path: 'invoice_id.customer_id' }],
} as unknown as PageDef;

test('a related list warns for each hop of its path whose reference leads no index', () => {
  const warnings = appIndexWarnings(app(), [page], schema({ line: ['id'], invoice: ['id'] }));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /line\.invoice_id/);
  assert.match(warnings[1], /invoice\.customer_id/);
  assert.deepEqual(appIndexWarnings(app(), [page], schema({ line: ['id', 'invoice_id'], invoice: ['id', 'customer_id'] })), []);
});

test('a catalog that does not report indexes is never a finding', () => {
  assert.deepEqual(
    appIndexWarnings(app({ invoices: { table: 'invoice', sort: 'issued_on desc' } }), [page], schema({}, LARGE_TABLE_ROWS * 2), {
      owners: { invoice: 'tenant_id' },
    }),
    [],
  );
});

test('a tenant ownership column that leads no index is said once per table', () => {
  const warnings = appIndexWarnings(app(), [], schema({ invoice: ['id'] }), { owners: { invoice: 'tenant_id' } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invoice\.tenant_id/);
  assert.deepEqual(appIndexWarnings(app(), [], schema({ invoice: ['tenant_id'] }), { owners: { invoice: 'tenant_id' } }), []);
});

test('a default sort without an index is said only past the large-table line', () => {
  const views = { invoices: { table: 'invoice', sort: 'issued_on desc, id' } };
  assert.deepEqual(appIndexWarnings(app(views), [], schema({ invoice: ['id'] }, LARGE_TABLE_ROWS)), []);
  const large = appIndexWarnings(app(views), [], schema({ invoice: ['id'] }, LARGE_TABLE_ROWS + 1));
  assert.equal(large.length, 1);
  assert.match(large[0], /view "invoices".*issued_on/);
  assert.deepEqual(appIndexWarnings(app(views), [], schema({ invoice: ['id', 'issued_on'] }, LARGE_TABLE_ROWS + 1)), []);
});

test('a contains search on a large PostgreSQL table without a trigram index is said once per column', () => {
  const text = (name: string) => ({ name, type: 'text', nullable: true, primaryKey: false });
  const catalog = (trigram: string[] | undefined, approxRows: number): DatabaseSchema =>
    ({
      dialect: 'postgres',
      foreignKeys: [],
      tables: [
        {
          id: 'lead',
          name: 'lead',
          schema: '',
          isView: false,
          indexed: ['id'],
          approxRows,
          ...(trigram ? { trigram } : {}),
          columns: [col('id'), text('name'), text('city'), { ...col('score') }],
        },
      ],
    }) as unknown as DatabaseSchema;
  const views = { leads: { table: 'lead', filters: ['city', 'score'] }, hot: { table: 'lead' } };
  const warned = appIndexWarnings(app(views), [], catalog([], LARGE_TABLE_ROWS + 1));
  assert.equal(warned.length, 2);
  assert.match(warned[0], /view "leads".*lead\.name.*gin_trgm_ops/);
  assert.match(warned[1], /lead\.city/);
  assert.deepEqual(appIndexWarnings(app(views), [], catalog(['name', 'city'], LARGE_TABLE_ROWS + 1)), []);
  // Small, or a catalog that never looked at index methods: nothing to say.
  assert.deepEqual(appIndexWarnings(app(views), [], catalog([], LARGE_TABLE_ROWS)), []);
  assert.deepEqual(appIndexWarnings(app(views), [], catalog(undefined, LARGE_TABLE_ROWS + 1)), []);
  // A list without its filter bar has no search box to warn about.
  assert.deepEqual(appIndexWarnings(app({ leads: { table: 'lead', filterBar: 'none' } }), [], catalog([], LARGE_TABLE_ROWS + 1)), []);
});
