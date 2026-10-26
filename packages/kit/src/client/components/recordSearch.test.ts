/**
 * The record search engine ⌘K and a find box share: which tables the reader
 * may find records in (only those a served list shows), the line a hit says,
 * and the question each table is asked.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type = 'TEXT', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
const tables: Record<string, TableMeta> = {
  article: { id: 'article', name: 'article', schema: '', isView: false, columns: [col('id', 'INTEGER', true), col('title'), col('topic')] },
  catalog_item: {
    id: 'catalog_item',
    name: 'catalog_item',
    schema: '',
    isView: false,
    columns: [col('id', 'INTEGER', true), col('name'), col('summary'), col('price', 'INTEGER')],
  },
  ticket: { id: 'ticket', name: 'ticket', schema: '', isView: false, columns: [col('id', 'INTEGER', true), col('subject')] },
};
const rooms: Record<string, Record<string, unknown>> = {
  articles: { id: 'articles', label: 'Help articles', table: 'article', show: ['title', 'topic'] },
  catalog: {
    id: 'catalog',
    label: 'Catalog',
    table: 'catalog_item',
    presentation: { kind: 'cards', primary: 'name', description: 'summary', lines: ['price'] },
  },
  broken: { id: 'broken', label: 'Broken', table: 'ticket', error: 'no' },
};
const calls: Array<Record<string, unknown>> = [];
vi.mock('../core.js', async () => ({
  api: async (_path: string, body: Record<string, unknown>) => {
    calls.push(body);
    return {
      rows: [
        { id: 3, name: 'Standard laptop', summary: 'A 14-inch laptop' },
        { id: 4, name: 'Dock', summary: '' },
      ],
    };
  },
  findTable: (id: string) => tables[id],
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => ({ id: row.id }),
  labelPath: (table: TableMeta) => (table.id === 'article' ? 'title' : 'name'),
  openRecord: vi.fn(),
  primaryKey: (await import('../../../../engine/src/shared/schema.js')).primaryKey,
  quote: (await import('../../../../engine/src/shared/query.js')).quoteValue,
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.name),
}));
vi.mock('./appRooms.js', () => ({
  appRooms: () => Object.values(rooms),
  viewRoom: (_app: unknown, key: string) => rooms[key],
  isListRoom: () => true,
}));
const { findRecords, findableTables, lineOf } = await import('./recordSearch.js');
const app = { views: { articles: {}, catalog: {}, broken: {} } } as never;

beforeEach(() => {
  calls.length = 0;
});

test('a table is findable only where a served list shows it; one the reader has no list of is not searched', () => {
  expect(findableTables(app, ['catalog_item', 'ticket', 'article', 'nowhere']).map((each) => [each.table.id, each.label])).toEqual([
    ['catalog_item', 'name'],
    ['article', 'title'],
  ]);
});

test("a hit says its list's first line under a card's title: the description, else a line, else a shown column that is not the name", () => {
  const [catalog, article] = findableTables(app, ['catalog_item', 'article']);
  expect(lineOf(catalog)).toBe('summary');
  expect(lineOf(article)).toBe('topic');
});

test("each table is asked its list search's text filter, by name, with the line beside the name; an empty line is not said", async () => {
  const [catalog] = findableTables(app, ['catalog_item']);
  const found = await findRecords(catalog, 'lap"top', 5, 'summary');
  expect(calls).toEqual([
    { q: 'catalog_item name contains "lap\\"top" show name, id, summary sort name', limit: 5, offset: 0, count: 'none' },
  ]);
  expect(found.map(({ label, line, key }) => ({ label, line, key }))).toEqual([
    { label: 'Standard laptop', line: 'A 14-inch laptop', key: { id: 3 } },
    { label: 'Dock', line: undefined, key: { id: 4 } },
  ]);
});
