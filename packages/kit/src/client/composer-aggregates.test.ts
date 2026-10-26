import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DatabaseSchema, TableMeta } from '../../../engine/src/shared/schema.js';
import { resolveAggregate, type ViewAggregate } from '../../../engine/src/shared/view.js';

const column = (name: string) => ({ name, type: name === 'amount' ? 'REAL' : 'TEXT', nullable: false, primaryKey: name === 'id' });
const table = (id: string, columns: string[]): TableMeta => ({ id, name: id, schema: '', isView: false, columns: columns.map(column) });
const schema: DatabaseSchema = {
  dialect: 'sqlite',
  label: 'composer relations',
  readAt: '',
  tables: [
    table('parent', ['id']),
    table('other', ['id', 'parent_id', 'amount']),
    table('child', ['id', 'ref_fk_0', 'amount']),
    table('holder', ['id', 'parent_id']),
  ],
  foreignKeys: [
    { name: 'child.ref_fk_0', from: { table: 'other', columns: ['parent_id'] }, to: { table: 'parent', columns: ['id'] } },
    { name: 'db_child_fk_0', from: { table: 'child', columns: ['ref_fk_0'] }, to: { table: 'parent', columns: ['id'] } },
    { name: 'holder_parent', from: { table: 'holder', columns: ['parent_id'] }, to: { table: 'parent', columns: ['id'] } },
  ],
};
const prompt = vi.fn();
const api = vi.fn(async () => ({ errors: [{ message: 'No transport in store tests.' }] }));
vi.mock('./core.js', () => ({
  $: () => null,
  state: { schema, activeConnection: 'fixture' },
  findTable: (id: string) => schema.tables.find((table) => table.id === id),
  currentEntry: () => ({ kind: 'table', table: 'parent', tab: 'view' }),
  go: vi.fn(),
  tableView: (table: string, _label: string, tab: string) => ({ kind: 'table', table, tab }),
  loadJson: (_key: string, fallback: unknown) => fallback,
  api,
}));
vi.mock('./menu.js', () => ({ addMenuItem: vi.fn() }));
vi.mock('./url.js', () => ({ toHash: vi.fn() }));
vi.mock('./prompt.js', () => ({ confirmFor: vi.fn(), promptFor: prompt }));
vi.mock('./components/mount.js', () => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock('./components/Composer.js', () => ({ Composer: () => null }));

const { aggregateLabel, shortAggregate, sameAggregate, composerActions: act, composerState } = await import('./composer.js');
const load = (aggregates: ViewAggregate[] = [], base = 'parent') =>
  act.openSaved({
    id: 'fixture',
    name: 'Fixture',
    base,
    columns: [{ path: 'id' }],
    aggregates,
    query: '',
  });
beforeEach(() => {
  vi.useFakeTimers();
  load();
  prompt.mockReset();
  api.mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test('aggregate labels and chips prefer qualified endpoints over colliding constraint names', () => {
  const spec = { fn: 'count', via: 'child.ref_fk_0' };
  expect(aggregateLabel(spec)).toBe('a count of childs');
  expect(shortAggregate(spec)).toBe('count(child)');
  expect(sameAggregate(spec, { fn: 'count', via: 'other.parent_id' })).toBe(false);
});

test('legacy unambiguous constraints stay equivalent for deduplication and removal', () => {
  const legacy = { fn: 'count' as const, via: 'db_child_fk_0' };
  const qualified = { fn: 'count' as const, via: 'child.ref_fk_0' };
  load([legacy]);
  expect(aggregateLabel(legacy)).toBe(aggregateLabel(qualified));
  expect(sameAggregate(legacy, qualified)).toBe(true);
  act.addAggregate(qualified);
  expect(composerState().draft.aggregates).toHaveLength(1);
  act.removeAggregate(qualified);
  expect(composerState().draft.aggregates).toEqual([]);
});

test('colliding references cannot remove the other relationship', () => {
  const child = { fn: 'count' as const, via: 'child.ref_fk_0' };
  const other = { fn: 'count' as const, via: 'other.parent_id' };
  load([child, other]);
  act.removeAggregate(child);
  expect(composerState().draft.aggregates).toEqual([other]);
});

test('resolution honors the current base and an aggregate parent prefix', () => {
  load([], 'holder');
  const spec = { fn: 'count', via: 'child.ref_fk_0', on: 'parent_id' };
  expect(aggregateLabel(spec)).toBe('a count of childs on its parent_id');
  expect(shortAggregate(spec)).toBe('count(parent_id.child)');
  expect(sameAggregate(spec, { ...spec, on: '' })).toBe(false);
  // This FK exists elsewhere but does not point to the current base.
  expect(shortAggregate({ fn: 'count', via: 'db_child_fk_0' })).toBe('count(db_child_fk_0)');
});

for (const on of ['', 'parent_id'])
  test('rename finds the compiler output for a qualified aggregate on=' + on, async () => {
    const spec: ViewAggregate = { fn: 'sum', via: 'child.ref_fk_0', column: 'amount', ...(on ? { on } : {}) };
    const base = on ? 'holder' : 'parent';
    load([spec], base);
    const name = resolveAggregate(schema, base, spec).name;
    prompt.mockResolvedValue('Total');
    await act.renameColumn({ name, aggregate: 'sum', table: 'child' }, name);
    expect(composerState().draft.aggregates[0].alias).toBe('Total');
  });

test('invalid saved aggregates remain removable without resolving an unrelated FK', () => {
  const spec = { fn: 'count' as const, via: 'missing' };
  load([spec]);
  expect(aggregateLabel(spec)).toBe('a count of missings');
  expect(shortAggregate(spec)).toBe('count(missing)');
  act.removeAggregate(spec);
  expect(composerState().draft.aggregates).toEqual([]);
});
