/**
 * The rail's rules: what a facet reads out of a question, what it writes
 * back, and the count it asks for — through the same condition helpers the
 * bar's boxes use, so a rail selection composes exactly as a box's does.
 */
import { describe, expect, test } from 'vitest';
import { conditionTail, holdsCondition, WHOLE, withCondition } from '../filterbar.js';
import {
  clearFacets,
  dateMeaning,
  datePresets,
  facetActive,
  facetCountText,
  facetKind,
  hasCountText,
  hasValuesText,
  moreConditions,
  moreOf,
  moreTail,
  rangeOf,
  rangeTail,
  selectedTags,
  selectedValues,
  tagsTail,
  valuesTail,
} from './filterRailModel.js';

describe('a checklist of values', () => {
  test('one ticked value is an equality, several an in, none no condition', () => {
    expect(valuesTail([])).toBe('');
    expect(valuesTail(['open'])).toBe('= open');
    expect(valuesTail(['open', 'done'])).toBe('in (open, done)');
    // Quoted the way the language quotes: a value with a space or a comma survives.
    expect(valuesTail(['In review', 'a,b'])).toBe('in ("In review", "a,b")');
  });

  test('reads back what it wrote, and nothing it cannot draw', () => {
    for (const values of [[], ['open'], ['open', 'done'], ['In review', 'a,b', 'say "hi"']]) {
      expect(selectedValues(valuesTail(values))).toEqual(values);
    }
    expect(selectedValues('in [3, 4]')).toEqual(['3', '4']);
    expect(selectedValues('!= open')).toBeNull();
    expect(selectedValues('is empty')).toBeNull();
  });

  test('composes into the question as the bar would, and back out', () => {
    let q = 'status = open and due_on < today sort due_on';
    q = withCondition(q, 'owner_id', valuesTail(['3', '7']));
    expect(q).toBe('status = open and due_on < today and owner_id in (3, 7) sort due_on');
    expect(selectedValues(conditionTail(q, 'owner_id'))).toEqual(['3', '7']);
    q = withCondition(q, 'owner_id', valuesTail(['7']));
    expect(q).toBe('status = open and due_on < today and owner_id = 7 sort due_on');
    expect(withCondition(q, 'owner_id', valuesTail([]))).toBe('status = open and due_on < today sort due_on');
  });
});

describe('a date range', () => {
  test('both ends are a between, one end a bound, in order whichever was set first', () => {
    expect(rangeTail('2026-01-01', '2026-01-31')).toBe('between 2026-01-01 and 2026-01-31');
    expect(rangeTail('2026-02-01', '2026-01-01')).toBe('between 2026-01-01 and 2026-02-01');
    expect(rangeTail('2026-01-01', '')).toBe('>= 2026-01-01');
    expect(rangeTail('', '2026-01-31')).toBe('<= 2026-01-31');
    expect(rangeTail('', '')).toBe('');
  });

  test('reads its own tails back, and leaves a preset or a phrase alone', () => {
    expect(rangeOf('between 2026-01-01 and 2026-01-31')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(rangeOf('>= 2026-01-01')).toEqual({ from: '2026-01-01', to: '' });
    expect(rangeOf('<= 2026-01-31')).toEqual({ from: '', to: '2026-01-31' });
    expect(rangeOf('< today')).toEqual({ from: '', to: '' });
    expect(rangeOf('>= today')).toEqual({ from: '', to: '' });
    const q = withCondition('status = open', 'due_on', rangeTail('2026-01-01', '2026-01-31'));
    expect(rangeOf(conditionTail(q, 'due_on'))).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });
});

describe('the counts', () => {
  test("ask under everything else, without the facet's own condition, the sort or the page", () => {
    const q = 'status in (open, done) and is_urgent = true sort due_on desc';
    expect(facetCountText('task', q, 'status')).toBe('task is_urgent = true count by status sort count desc');
    expect(facetCountText('task', q, 'is_urgent')).toBe('task status in (open, done) count by is_urgent sort count desc');
    // A reference is grouped by its id and said by its target's label.
    expect(facetCountText('task', q, 'owner_id', 'owner_id.name')).toBe(
      'task status in (open, done) and is_urgent = true count by owner_id, owner_id.name sort count desc',
    );
    expect(facetCountText('task', '', 'status')).toBe('task count by status sort count desc');
  });
});

describe('clearing', () => {
  test("Clear all takes the rail's conditions out and leaves the lit tab standing", () => {
    const tab = 'status = open sort due_on';
    const q = 'status = open and priority = 2 and owner_id in (3, 7) sort due_on';
    expect(facetActive(q, 'status', tab)).toBe(false);
    expect(facetActive(q, 'priority', tab)).toBe(true);
    expect(clearFacets(q, ['status', 'priority', 'owner_id'], tab)).toBe(tab);
    // A facet that changed the tab's own condition is the rail's to clear.
    expect(facetActive('status in (open, done) sort due_on', 'status', tab)).toBe(true);
    expect(clearFacets('status in (open, done) sort due_on', ['status'], tab)).toBe('sort due_on');
  });
});

test('a vocabulary and a reference are both a checklist', () => {
  expect(['enum', 'ref', 'flag', 'date', 'text'].map(facetKind)).toEqual(['values', 'values', 'flag', 'date', 'text']);
});

describe('a date facet asks what its column means', () => {
  const labels = (column: Parameters<typeof datePresets>[0]) => datePresets(column).map(([label]) => label);
  test('a stamp is asked about the past, never what is overdue', () => {
    expect(dateMeaning({ name: 'created_at' })).toBe('stamp');
    expect(dateMeaning({ name: 'opened_on' })).toBe('stamp');
    expect(dateMeaning({ name: 'logged', default: 'CURRENT_TIMESTAMP' })).toBe('stamp');
    expect(labels({ name: 'created_at', nullable: false })).toEqual(['Today', 'This week', 'Last 7 days', 'Last 30 days']);
  });
  test('a deadline is asked what is overdue and what is coming', () => {
    for (const name of ['due_on', 'due_date', 'expires_at', 'ship_by', 'renewal_date']) expect(dateMeaning({ name })).toBe('deadline');
    expect(labels({ name: 'due_on', nullable: true })).toEqual(['Overdue', 'Today', 'This week', 'Next 7 days', 'No date']);
    expect(datePresets({ name: 'due_on' }).find(([label]) => label === 'Overdue')?.[1]).toBe('< today');
  });
  test('any other date looks both ways, and a required one offers no "No date"', () => {
    expect(dateMeaning({ name: 'start_date' })).toBe('date');
    expect(labels({ name: 'close_date', nullable: false })).toEqual(['Today', 'This week', 'Last 7 days', 'Next 7 days']);
  });
});

describe('the rarer conditions, behind More conditions', () => {
  test('text is asked what it starts with and a pattern; a column that may be empty, whether it is', () => {
    expect(moreConditions('text', { type: 'TEXT' })).toEqual(['startswith', 'like', 'empty', 'notempty']);
    expect(moreConditions('values', { type: 'varchar(20)', nullable: false })).toEqual(['startswith', 'like']);
    expect(moreConditions('text', { type: 'INTEGER' })).toEqual(['empty', 'notempty']);
    expect(moreConditions('values', { type: 'TEXT', allowed: ['open', 'done'] })).toEqual(['empty', 'notempty']);
    // A date's "No date" preset already asks for empty.
    expect(moreConditions('date', { type: 'DATE' })).toEqual(['notempty']);
    expect(moreConditions('flag', { type: 'BOOLEAN', nullable: false })).toEqual([]);
    // An API takes whole values only.
    expect(moreConditions('text', { type: 'TEXT' }, true)).toEqual([]);
  });

  test('each reads back from the tail it writes, through the one condition helper', () => {
    for (const [condition, text, tail] of [
      ['startswith', 'Har', 'startswith Har'],
      ['like', 'Wh%', 'like "Wh%"'],
      ['empty', '', 'is empty'],
      ['notempty', '', 'is not empty'],
    ] as const) {
      expect(moreTail(condition, text)).toBe(tail);
      const question = withCondition('status = open', 'name', tail);
      expect(moreOf(conditionTail(question, 'name'))).toEqual({ condition, text });
    }
    expect(moreTail('startswith', '  ')).toBe('');
    expect(moreOf('= open')).toBeNull();
  });
});

test('a tags facet writes has, any of the ticked tags, and reads it back', () => {
  expect(tagsTail([])).toBe('');
  expect(tagsTail(['bug'])).toBe('has bug');
  expect(tagsTail(['bug', 'good first'])).toMatch(/^has \(bug, ["']good first["']\)$/);
  expect(selectedTags('')).toEqual([]);
  expect(selectedTags('has bug')).toEqual(['bug']);
  expect(selectedTags(tagsTail(['bug', 'good first']))).toEqual(['bug', 'good first']);
  expect(selectedTags('= bug')).toBeNull();
});

describe('a filter across the rows that point at the record', () => {
  const stage = 'any opportunity where stage';
  test('a tail folds onto it as onto a column, and a segment is the whole condition', () => {
    const q = withCondition('rating = hot', stage, valuesTail(['won', 'lost']));
    expect(q).toBe('rating = hot and any opportunity where stage in (won, lost)');
    expect(selectedValues(conditionTail(q, stage))).toEqual(['won', 'lost']);
    const open = 'any opportunity where open';
    const both = withCondition(q, open, WHOLE);
    expect(both).toBe(`${q} and ${open}`);
    expect(holdsCondition(both, open)).toBe(true);
    // The segment's words never own the stage's condition, nor the stage's the segment.
    expect(holdsCondition(withCondition(q, open, ''), open)).toBe(false);
    expect(withCondition(both, open, '')).toBe(q);
  });
  test("a value's count asks for the list's records under everything else, the facet's own pick aside", () => {
    expect(hasCountText('account', `rating = hot and ${stage} = won`, stage, 'owner_id = 3', 'lost')).toBe(
      'account owner_id = 3 and rating = hot and any opportunity where stage = lost count',
    );
    expect(hasCountText('account', '', 'any opportunity where open')).toBe('account any opportunity where open count');
    expect(hasValuesText('account_tag', 'tag_id', 'tag_id.name')).toBe('account_tag count by tag_id, tag_id.name sort count desc');
  });
});
