/**
 * The column a list names its rows by is the one read whole before the others. Where the App names its records, that
 * name wins over the column the schema alone would pick: a ticket named by its description is not named by `number`.
 */
import { expect, test } from 'vitest';
import { labelColumn, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { rowNameColumn } from './Grid.js';

const incident = {
  id: 'incident',
  name: 'incident',
  columns: [
    { name: 'id', type: 'integer', primaryKey: true },
    { name: 'number', type: 'text' },
    { name: 'short_description', type: 'text' },
    { name: 'state', type: 'text' },
  ],
} as TableMeta;
const schema = { label: 'demo', dialect: 'sqlite', readAt: '', tables: [incident], foreignKeys: [] } as unknown as DatabaseSchema;
const asked = ['id', 'number', 'short_description', 'state'];
const words = (name: string) => name !== 'id';

test("the App's record name names the row, not the table's number", () => {
  expect(labelColumn(incident)).toBe('number');
  expect(rowNameColumn({ schema, table: incident, authored: 'short_description' }, asked, words)).toBe('short_description');
  expect(rowNameColumn({ schema, table: incident, authored: '{number} {short_description}' }, asked, words)).toBe('number');
});

test("with no record name of the App's, the table's own label names it, else the first column of words", () => {
  expect(rowNameColumn({ schema, table: incident, authored: undefined }, asked, words)).toBe('number');
  expect(rowNameColumn({ schema, table: incident, authored: 'short_description' }, ['id', 'state'], words)).toBe('state');
  expect(rowNameColumn(undefined, asked, words)).toBe('number');
});

test("a table named by a template is named by the `$label` the grid is handed, else by the template's first column", () => {
  const ticket = { ...incident, labelTemplate: '{short_description} ({number})' } as TableMeta;
  const templated = { ...schema, tables: [ticket] } as DatabaseSchema;
  const authored = '{short_description} ({number})';
  // Handed `$label`, that is the name, whatever text column comes first.
  expect(rowNameColumn({ schema: templated, table: ticket, authored }, ['id', 'number', '$label', 'state'], words)).toBe('$label');
  // Not handed it: the template's first column, not the first column of words (`number`).
  expect(rowNameColumn({ schema: templated, table: ticket, authored }, asked, words)).toBe('short_description');
  expect(rowNameColumn({ schema: templated, table: ticket, authored: undefined }, asked, words)).toBe('short_description');
  // The template's columns not drawn: the first column of words, as before.
  expect(rowNameColumn({ schema: templated, table: ticket, authored }, ['id', 'state'], words)).toBe('state');
});
