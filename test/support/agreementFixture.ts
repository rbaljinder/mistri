/**
 * The fixture test/agreement.test.ts (the kit's readings of the language) and test/agreement-completer.test.ts (the
 * database browser's completer) both read: one schema, and the DOM stub the client's modules need to load in Node.
 */
import type { ColumnMeta, DatabaseSchema, ForeignKey, TableMeta } from '../../packages/engine/src/shared/schema.js';

/* ---------- fixtures ----------

   One schema, reused by every case below, so a table added because it broke
   one reading is immediately in front of all the others. Each entry is a shape
   that has actually caused a disagreement:

     invoice        — its only text column is a date, which is what labelColumn's
                      guard exists for
     keyed          — nothing but key columns; every "pick a readable column"
                      rule has to fall back
     invoice_line   — a composite-key child, so hop names have to be joined
     work_order     — twenty-one columns, above the grouping threshold, with an
                      audit column, a self-reference and a text timestamp
     note           — eleven columns, one below the threshold
     customer_view  — a view, which is read-only and still has to be labelled
*/

const col = (name: string, type: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});

const key = (name: string, type = 'INTEGER'): ColumnMeta => col(name, type, { primaryKey: true, nullable: false });

const meta = (name: string, columns: ColumnMeta[], extra: Partial<TableMeta> = {}): TableMeta => ({
  id: name,
  name,
  schema: 'main',
  isView: false,
  columns,
  indexed: columns.filter((c) => c.primaryKey).map((c) => c.name),
  ...extra,
});

const reference = { table: 'customer', column: 'id' };

export const TABLES: TableMeta[] = [
  meta('customer', [key('id'), col('name', 'TEXT'), col('country_code', 'CHAR(2)')]),

  // Every text column here is a date. Without the guard in labelColumn this
  // table's rows are named by `invoice_date`.
  meta('invoice', [
    key('id'),
    col('customer_id', 'INTEGER', { references: reference }),
    col('invoice_date', 'TEXT'),
    col('due_on', 'TEXT'),
    col('total', 'NUMERIC'),
  ]),

  meta('keyed', [key('left_id'), key('right_id')]),

  meta('invoice_line', [
    key('invoice_id'),
    key('line_no'),
    col('sku', 'VARCHAR(40)'),
    col('quantity', 'INTEGER'),
    // A column named after a clause word. Unusual, not rare, and the reason
    // the clause splitter carries a "followed by an operator" rule — without
    // it `limit not in (1, 2)` is read as a limit clause.
    col('limit', 'INTEGER'),
  ]),

  meta('note', [
    key('id'),
    col('body', 'TEXT'),
    col('author', 'TEXT'),
    col('created_at', 'TIMESTAMP'),
    col('kind', 'TEXT'),
    col('pinned', 'BOOLEAN'),
    col('sys_updated_by', 'TEXT'),
    col('etag', 'TEXT'),
    col('locale', 'CHAR(5)'),
    col('length', 'INTEGER'),
    col('slug', 'TEXT'),
  ]),

  meta('work_order', [
    key('id'),
    col('number', 'TEXT'),
    col('customer_id', 'INTEGER', { references: reference }),
    col('parent_id', 'INTEGER', { references: { table: 'work_order', column: 'id' } }),
    col('status', 'TEXT'),
    col('priority', 'INTEGER'),
    col('summary', 'TEXT'),
    col('opened_on', 'TEXT'),
    // A text column named for a timestamp: a date by name, not by type.
    col('event_timestamp', 'TEXT'),
    col('closed_at', 'TIMESTAMP'),
    col('created_at', 'TIMESTAMP'),
    col('sys_updated_at', 'TIMESTAMP'),
    col('sys_created_by', 'TEXT'),
    col('version', 'INTEGER'),
    col('estimate', 'NUMERIC'),
    col('actual', 'NUMERIC'),
    col('site', 'TEXT'),
    col('bay', 'TEXT'),
    col('notes', 'TEXT'),
    col('external_ref', 'uuid'),
    col('payload', 'json'),
  ]),

  meta('customer_view', [col('id', 'INTEGER'), col('name', 'TEXT')], { isView: true }),

  /* The party pattern: employee has no name of its own — its one text column
     is a date — and the name lives one to-one hop away on party. */
  meta('party', [key('id'), col('display_name', 'TEXT'), col('kind', 'TEXT')]),
  meta('employee', [
    key('id'),
    col('party_id', 'INTEGER', { references: { table: 'party', column: 'id' }, nullable: false }),
    col('hired_on', 'TEXT'),
    col('active', 'INTEGER'),
  ]),
];

const FOREIGN_KEYS: ForeignKey[] = [
  {
    name: 'invoice_customer_fk',
    from: { table: 'invoice', columns: ['customer_id'] },
    to: { table: 'customer', columns: ['id'] },
  },
  {
    name: 'line_invoice_fk',
    from: { table: 'invoice_line', columns: ['invoice_id'] },
    to: { table: 'invoice', columns: ['id'] },
  },
  {
    name: 'wo_customer_fk',
    from: { table: 'work_order', columns: ['customer_id'] },
    to: { table: 'customer', columns: ['id'] },
  },
  // A self-reference: the reason paths need a depth cap at all.
  {
    name: 'wo_parent_fk',
    from: { table: 'work_order', columns: ['parent_id'] },
    to: { table: 'work_order', columns: ['id'] },
  },
  // A composite key, whose hop has no single column to be named by.
  {
    name: 'note_line_fk',
    from: { table: 'note', columns: ['id', 'length'] },
    to: { table: 'invoice_line', columns: ['invoice_id', 'line_no'] },
  },
  {
    name: 'employee_party_fk',
    from: { table: 'employee', columns: ['party_id'] },
    to: { table: 'party', columns: ['id'] },
  },
];

export const SCHEMA: DatabaseSchema = {
  label: 'fixtures',
  dialect: 'sqlite',
  tables: TABLES,
  foreignKeys: FOREIGN_KEYS,
  readAt: new Date(0).toISOString(),
};

/* ---------- loading the client ----------

   Some client modules call `document` while they load — the composer waits
   for the page before attaching itself. None of what is tested below touches
   the DOM, so the stub only has to be enough to get through the import;
   anything it does not answer throws rather than passing quietly. */

export function stubDom(): void {
  const node = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    hidden: false,
    textContent: '',
    addEventListener() {},
    removeEventListener() {},
    append() {},
    remove() {},
    setAttribute() {},
    replaceChildren() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  (globalThis as Record<string, unknown>).document = {
    readyState: 'complete',
    body: node(),
    addEventListener() {},
    removeEventListener() {},
    createElement: node,
    createElementNS: node,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  (globalThis as Record<string, unknown>).window = {
    localStorage: undefined,
    location: { hash: '', href: 'http://localhost/' },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
}

export const named = (id: string): TableMeta => TABLES.find((t) => t.id === id)!;
