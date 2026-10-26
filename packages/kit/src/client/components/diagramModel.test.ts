/** The diagram's geometry: column order, node height, the neighbourhood's columns, and depth as layout. */
import { describe, expect, test, vi } from 'vitest';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

vi.mock('../core.js', () => ({ labelColumn: (t: TableMeta) => t.columns.find((c) => c.name === 'name')?.name }));
const m = await import('./diagramModel.js');

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const t = (id: string, cols: unknown[], isView = false) =>
  ({ id, name: id, schema: '', isView, indexed: [], columns: cols }) as unknown as TableMeta;
const customer = t('customer', [
  col('note', 'TEXT'),
  col('name', 'TEXT'),
  col('id', 'INTEGER', { primaryKey: true }),
  col('country', 'TEXT', { references: { table: 'country', column: 'code' } }),
  col('a', 'TEXT'),
  col('b', 'TEXT'),
  col('c', 'TEXT'),
]);
const order = t('order', [col('id', 'INTEGER', { primaryKey: true }), col('customer_id', 'INTEGER')]);
const country = t('country', [col('code', 'TEXT', { primaryKey: true })]);
const fk = (from: string, to: string, column: string) => ({
  name: `${from}_${to}`,
  from: { table: from, columns: [column] },
  to: { table: to, columns: ['id'] },
});
const schema = {
  label: 'shop',
  tables: [customer, order, country],
  foreignKeys: [fk('order', 'customer', 'customer_id'), fk('customer', 'country', 'country'), fk('order', 'order', 'parent_id')],
};

describe('a node', () => {
  test('lists the key first, then references, then the label, then the rest in declared order', () => {
    expect(m.orderedColumns(customer).map((c) => c.name)).toEqual(['id', 'country', 'name', 'note', 'a', 'b', 'c']);
  });
  test('is as tall as the rows it shows plus the "more" line when there are more', () => {
    expect(m.nodeHeight(country, false)).toBe(m.HEAD_H + m.NODE_PAD * 2 + m.FIELD_H);
    expect(m.nodeHeight(customer, false)).toBe(m.HEAD_H + m.NODE_PAD * 2 + (5 + 1) * m.FIELD_H);
    expect(m.nodeHeight(customer, true)).toBe(m.HEAD_H + m.NODE_PAD * 2 + (7 + 1) * m.FIELD_H);
    expect(m.nodeHeight(undefined, false)).toBe(m.HEAD_H);
  });
  test('shortens long type names to their aliases', () => {
    expect(m.shortType('character varying(255)')).toBe('varchar');
    expect(m.shortType('timestamp with time zone')).toBe('timestamptz');
    expect(m.shortType('an_extraordinarily_long_type')).toBe('an_extraord…');
  });
});

describe('the neighbourhood', () => {
  test('puts what a table points at on the left, what points at it on the right, and loops a self-reference', () => {
    const layout = m.neighbourhoodLayout(schema, 'order', () => 60)!;
    expect(layout.left.map((n) => n.table)).toEqual(['customer']);
    expect(layout.right).toEqual([]);
    expect(layout.self).toHaveLength(1);
    const around = m.neighbourhoodLayout(schema, 'customer', () => 60)!;
    expect(around.left.map((n) => n.table)).toEqual(['country']);
    expect(around.right.map((n) => n.table)).toEqual(['order']);
    expect(around.right[0].columns).toEqual(['customer_id']);
    expect(around.width).toBe(m.NODE_W * 3 + m.COL_GAP * 2);
    expect(around.midX).toBe(m.NODE_W + m.COL_GAP);
    expect([...around.drawn]).toEqual(['customer', 'country', 'order']);
    expect(m.neighbourhoodLayout({ ...schema, foreignKeys: [] }, 'customer', () => 60)).toBeNull();
  });
});

describe('the whole schema', () => {
  test('ranks by dependency depth and lays columns out left to right', () => {
    const depth = m.dependencyDepth(schema.tables, schema.foreignKeys);
    expect([depth.get('country'), depth.get('customer'), depth.get('order')]).toEqual([0, 1, 2]);
    const layout = m.schemaLayout(schema, new Set(), false, () => 40)!;
    expect(layout.levels).toBe(3);
    expect(layout.pos.get('country')!.x).toBe(0);
    expect(layout.pos.get('order')!.x).toBe(2 * (m.NODE_W + m.S_COL_GAP));
    expect(layout.trimmed).toBe(false);
  });
  test('a focus keeps the chosen tables and one hop out; a dense schema opens on its hubs', () => {
    expect(m.inScope(schema.tables, schema.foreignKeys, new Set(['order'])).map((t) => t.id)).toEqual(['customer', 'order']);
    const many = {
      label: 'big',
      tables: Array.from({ length: 30 }, (_, i) => t(`t${i}`, [])),
      foreignKeys: Array.from({ length: 29 }, (_, i) => fk(`t${i + 1}`, 't0', 'x')),
    };
    const layout = m.schemaLayout(many, new Set(), false, () => 30)!;
    expect(layout.trimmed).toBe(true);
    expect(layout.tables).toHaveLength(m.HUB_TABLES);
    expect(layout.tables[0].id).toBe('t0');
    expect(m.schemaLayout(many, new Set(), true, () => 30)!.tables).toHaveLength(30);
  });
});
