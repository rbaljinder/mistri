/** An App list's column menu, before anything is drawn: the words each sort says, and which entries there are. */
import { describe, expect, test } from 'vitest';
import { appMenuEntries, sortWords } from './appColumnMenuModel.js';

const base = { sortable: true, current: null, filterable: true, filtered: false, pinned: false } as const;

describe("the sorts, in the column's own words", () => {
  test('text, figures and dates each say what the order is', () => {
    expect(sortWords('text', { type: 'TEXT' })).toEqual(['A → Z', 'Z → A']);
    expect(sortWords('number', { type: 'INTEGER' })).toEqual(['Low → high', 'High → low']);
    // Money is a figure: a numeric column whatever the display rule dresses it in.
    expect(sortWords('text', { type: 'numeric(10,2)' })).toEqual(['Low → high', 'High → low']);
    expect(sortWords('date', { type: 'DATE' })).toEqual(['Oldest first', 'Newest first']);
  });

  test('a flag and a vocabulary name their ends, a vocabulary over text included', () => {
    const say = (value: string) =>
      (({ true: 'Yes', false: 'No', make_ready: 'Make ready', in_progress: 'In progress' }) as Record<string, string>)[value] ??
      value[0].toUpperCase() + value.slice(1);
    expect(sortWords('boolean', { type: 'BOOLEAN' }, say)).toEqual(['No → Yes', 'Yes → No']);
    // A CHECK's vocabulary over text sorts in the order it was declared (schema.ts declaredOrder), as the words say.
    expect(sortWords('text', { type: 'TEXT', allowed: ['vacant', 'occupied', 'make_ready'] }, say)).toEqual([
      'Vacant → Make ready',
      'Make ready → Vacant',
    ]);
    // So does a native enum, by the engine.
    expect(sortWords('text', { type: 'task_status', allowed: ['open', 'in_progress', 'done'] }, say)).toEqual([
      'Open → Done',
      'Done → Open',
    ]);
  });
});

describe('the entries', () => {
  test('at most five, the pin last', () => {
    const all = appMenuEntries({ ...base, words: ['A → Z', 'Z → A'], filtered: true });
    expect(all.map((e) => e.label)).toEqual(['A → Z', 'Z → A', 'Filter…', 'Clear filter', 'Pin column']);
    expect(appMenuEntries({ ...base, words: ['A → Z', 'Z → A'], pinned: true }).at(-1)).toEqual({ key: 'pin', label: 'Unpin column' });
  });

  test('a sort that repeats the current one is dropped', () => {
    expect(appMenuEntries({ ...base, words: ['Low → high', 'High → low'], current: 'asc' }).map((e) => e.key)).toEqual([
      'desc',
      'filter',
      'pin',
    ]);
    expect(appMenuEntries({ ...base, words: ['Low → high', 'High → low'], current: 'desc' }).map((e) => e.key)).toEqual([
      'asc',
      'filter',
      'pin',
    ]);
  });

  test('Clear filter only while the column is filtered; no sort where the header cannot sort; no filter where none is taken', () => {
    expect(appMenuEntries({ ...base, words: ['A → Z', 'Z → A'] }).map((e) => e.key)).not.toContain('clear');
    expect(appMenuEntries({ ...base, words: ['A → Z', 'Z → A'], sortable: false }).map((e) => e.key)).toEqual(['filter', 'pin']);
    expect(appMenuEntries({ ...base, words: ['A → Z', 'Z → A'], filterable: false, filtered: true }).map((e) => e.key)).toEqual([
      'asc',
      'desc',
      'pin',
    ]);
  });
});
