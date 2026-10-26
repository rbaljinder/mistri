/**
 * A chart that says `auto` (autoChart.ts): the unit chosen from the window, coarsened while the answer is sparse, kept
 * across a refresh, and chosen again only when the reader picks another window.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { renderHook } from '@testing-library/react';

vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => ({ ui: { locale: 'en-GB' } }) }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);

const { useAutoChart } = await import('./autoChart.js');
type Section = Parameters<typeof useAutoChart>[0];
type Read = { data?: { columns?: string[]; rows?: Array<Record<string, unknown>> }; isPlaceholderData?: boolean };

const chart = (extra: Partial<Section> = {}): Section => ({
  kind: 'chart',
  table: 'account',
  by: 'auto created_at',
  over: 'created_at',
  query: 'created_at = last 34 days',
  ...extra,
});

const answer = (rows: Array<[string, number]>, extra: string[] = []): Read => ({
  data: { columns: ['created_at', 'count', ...extra], rows: rows.map(([created_at, count]) => ({ created_at, count })) },
});

/** Three days of data over thirty-four: a bar a day would be thirty-one empty ones. */
const sparse = answer([
  ['2026-09-14', 2],
  ['2026-09-22', 3],
  ['2026-10-12', 4],
]);

function run(initial: Section, reads: (text: string | null) => Read) {
  const asked: Array<string | null> = [];
  const view = renderHook(
    ({ section }) => {
      const auto = useAutoChart(section, (text) => {
        asked.push(text);
        return reads(text);
      });
      const text = auto?.ask?.by ?? null;
      return { auto, text, drawn: auto?.draw(reads(text)) };
    },
    { initialProps: { section: initial } },
  );
  return { view, asked };
}

describe('the unit follows the window', () => {
  test('a window the grammar bounds sets the unit before any read, and the read asks in it', () => {
    const { view } = run(chart(), () => ({}));
    expect(view.result.current.text).toBe('day created_at');
    view.rerender({ section: chart({ query: 'created_at = last 90 days' }) });
    // Weeks add up from days, so the server is asked for days and the browser keeps the weeks.
    expect(view.result.current.text).toBe('day created_at');
  });

  test('a measure that does not add up is asked in the unit it is drawn in', () => {
    const { view } = run(chart({ measure: 'median total', query: 'created_at = last 90 days' }), () => ({}));
    expect(view.result.current.text).toBe('week created_at');
  });

  test('under no window the data says its own extent first, and nothing is drawn until it has', () => {
    const open = chart({ query: undefined });
    const extent = { data: { columns: ['min', 'max'], rows: [{ min: '2020-01-01', max: '2026-10-12' }] } };
    const { view, asked } = run(open, (text) => (text?.startsWith('account min') ? extent : {}));
    expect(asked[0]).toBe('account min created_at, max created_at');
    expect(view.result.current.text).toBe('quarter created_at');
    const pending = run(open, () => ({}));
    expect(pending.view.result.current.auto?.ask).toBeNull();
  });
});

describe('a sparse answer is coarsened where it adds up', () => {
  test('three days over thirty-four draw as weeks, summed', () => {
    const { view } = run(chart(), () => sparse);
    const { drawn } = view.result.current;
    expect(drawn?.unit).toBe('week');
    expect(drawn?.answer?.rows).toEqual([
      { created_at: '2026-09-14', value: 2 },
      { created_at: '2026-09-21', value: 3 },
      { created_at: '2026-10-12', value: 4 },
    ]);
  });

  test('an average is weighed by its rows, not by its days', () => {
    const avg = chart({ measure: 'avg total', query: 'created_at = last 90 days' });
    const { view } = run(avg, () => ({
      data: {
        columns: ['created_at', 'sum', 'count'],
        rows: [
          { created_at: '2026-10-12', sum: 10, count: 1 },
          { created_at: '2026-10-13', sum: 60, count: 3 },
        ],
      },
    }));
    expect(view.result.current.drawn?.answer?.rows).toEqual([{ created_at: '2026-10-12', value: 17.5 }]);
  });

  test('a second key is coarsened within, each series on its own', () => {
    const { view } = run(chart({ by: 'auto created_at, channel', query: 'created_at = last 90 days' }), () => ({
      data: {
        columns: ['created_at', 'channel', 'count'],
        rows: [
          { created_at: '2026-10-12', channel: 'web', count: 1 },
          { created_at: '2026-10-13', channel: 'web', count: 2 },
          { created_at: '2026-10-13', channel: 'phone', count: 5 },
        ],
      },
    }));
    expect(view.result.current.drawn?.answer?.rows).toEqual([
      { created_at: '2026-10-12', channel: 'phone', value: 5 },
      { created_at: '2026-10-12', channel: 'web', value: 3 },
    ]);
    expect(view.result.current.drawn?.dots).toBe(false);
  });

  test('a median is drawn as the server answered it, in the unit of the span', () => {
    const median = chart({ measure: 'median total' });
    const read = { data: { columns: ['created_at', 'median'], rows: [{ created_at: '2026-09-14', median: 5 }] } };
    const { view } = run(median, () => read);
    expect(view.result.current.drawn?.answer).toBe(read.data);
    expect(view.result.current.drawn?.unit).toBe('day');
  });

  test('a line with fewer than three filled buckets keeps its shape and draws its points alone', () => {
    const two = answer([
      ['2026-10-10', 1],
      ['2026-10-11', 1],
    ]);
    const { view } = run(chart({ query: 'created_at = last 7 days' }), () => two);
    expect(view.result.current.drawn?.dots).toBe(true);
    const { view: bars } = run(chart({ shape: 'bar', query: 'created_at = last 7 days' }), () => two);
    expect(bars.result.current.drawn?.dots).toBe(false);
    const { view: many } = run(chart(), () => sparse);
    expect(many.result.current.drawn?.dots).toBe(false);
  });
});

describe('the unit stays while the reader looks', () => {
  test('a refresh that finds the data denser keeps the unit it was drawn in', () => {
    let current = sparse;
    const { view } = run(chart(), () => current);
    expect(view.result.current.drawn?.unit).toBe('week');
    current = answer(Array.from({ length: 20 }, (_, i) => [`2026-09-${String(i + 10).padStart(2, '0')}`, 1] as [string, number]));
    view.rerender({ section: chart() });
    expect(view.result.current.drawn?.unit).toBe('week');
  });

  test("another window is chosen afresh, and the last window's answer is held, untouched, until the next arrives", () => {
    let current: Read = sparse;
    const { view } = run(chart(), () => current);
    expect(view.result.current.drawn?.unit).toBe('week');
    current = { ...answer([['2026-10-12', 1]]), isPlaceholderData: true };
    view.rerender({ section: chart({ query: 'created_at = last 7 days' }) });
    expect(view.result.current.drawn?.unit).toBe('week');
    expect(view.result.current.drawn?.answer?.rows).toHaveLength(3);
    current = answer([
      ['2026-10-10', 1],
      ['2026-10-11', 1],
      ['2026-10-12', 1],
    ]);
    view.rerender({ section: chart({ query: 'created_at = last 7 days' }) });
    expect(view.result.current.drawn?.unit).toBe('day');
  });
});
