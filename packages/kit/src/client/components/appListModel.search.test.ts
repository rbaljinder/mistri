/**
 * The column a list's search box searches. A record named by a template that reads its parent's name
 * (`'{patient_id.name} · {kind}'`) is searched by that name, so a visit is found by its patient.
 */
import { expect, test, vi } from 'vitest';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

vi.mock('../core.js', () => ({
  findTable: () => undefined,
  state: {},
  recordLabel: (table: TableMeta) => (table.labelTemplate ? '{patient_id.name} · {kind}' : undefined),
  labelPath: (table: TableMeta) => (table.labelTemplate ? '$label' : 'name'),
}));
vi.mock('../shellMode.js', () => ({ shell: () => ({}) }));

const { searchColumn } = await import('./appListModel.js');

const col = (name: string, extra = {}) => ({ name, type: 'TEXT', nullable: true, primaryKey: false, ...extra });
const visit = {
  id: 'visit',
  name: 'visit',
  schema: '',
  isView: false,
  labelTemplate: '{patient_id.name} · {kind}',
  columns: [
    col('id', { primaryKey: true, nullable: false }),
    col('patient_id', { references: { table: 'patient', column: 'id' } }),
    col('kind'),
  ],
} as unknown as TableMeta;

test('a record named through a reference is searched by its whole name', () => {
  expect(searchColumn(visit)).toBe('$label');
  // A name an API cannot filter by still has no box, and a table with no template keeps its own name column.
  expect(
    searchColumn({ ...visit, labelTemplate: undefined, columns: [col('id', { primaryKey: true }), col('name')] } as unknown as TableMeta),
  ).toBe('name');
  expect(searchColumn(undefined)).toBeUndefined();
});
