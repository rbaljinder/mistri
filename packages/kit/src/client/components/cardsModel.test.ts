/**
 * What a list asks of its cards before it draws them (cardsModel.ts):
 * a presentation stands in only when the answer carries every column it
 * reads, and a file row's inline address names its table, key and variant.
 */
import { expect, test } from 'vitest';
import { canShowCards, inlineFileAddress } from './cardsModel.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppCardsList } from '@mistriwork/engine/shared/appCards.js';

const table = {
  name: 'project',
  schema: '',
  id: 'project',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true },
    { name: 'name', type: 'text', nullable: false, primaryKey: false },
    { name: 'status', type: 'text', nullable: true, primaryKey: false },
  ],
} as TableMeta;

const spec = { kind: 'cards', primary: 'name', badge: 'status' } as AppCardsList;

test('cards stand in only when the answer carries the card columns and the key', () => {
  expect(canShowCards(table, ['id', 'name', 'status'], spec)).toBe(true);
  expect(canShowCards(table, ['id', 'name'], spec)).toBe(false);
  expect(canShowCards(table, ['name', 'status'], spec)).toBe(false);
  expect(canShowCards(undefined, ['id', 'name', 'status'], spec)).toBe(false);
  expect(canShowCards(table, undefined, spec)).toBe(false);
});

test('a card without a key cannot stand in, however complete its columns', () => {
  const keyless = { ...table, columns: table.columns.map((column) => ({ ...column, primaryKey: false })) } as TableMeta;
  expect(canShowCards(keyless, ['id', 'name', 'status'], spec)).toBe(false);
});

test('a file row address names its table, key and thumbnail variant', () => {
  const address = inlineFileAddress('project_file', { id: 7 }, null, 'thumb');
  expect(address).toContain('/api/file?');
  expect(address).toContain('table=project_file');
  expect(address).toContain('variant=thumb');
  expect(address).toContain('inline=1');
  expect(inlineFileAddress('project_file', { id: 7 }, null)).not.toContain('variant=');
});
