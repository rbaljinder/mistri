/** A list's marks: asked once for the page of rows, only for a table a decision answers, and drawn at the row and column they belong to. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const { api, app } = vi.hoisted(() => ({ api: vi.fn(), app: { current: null as unknown } }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api,
  state: { activeConnection: 'demo' },
  emptyWord: () => '—',
  keyOf: (_t: unknown, row: Record<string, unknown>) => (row.id === undefined ? null : { id: row.id }),
}));
vi.mock('../../../../kit/src/client/components/Icon.js', () => ({ Icon: () => <i data-testid="glyph" /> }));
vi.mock('../appState.js', () => ({ activeApp: () => app.current }));

const { useDecisionMarks } = await import('./decisionMarks.js');

const ticket = { id: 'ticket', name: 'ticket', schema: '', isView: false, columns: [] } as unknown as TableMeta;
const rows = [{ id: 10 }, { id: 11 }, { id: 12 }];
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

beforeEach(() => {
  app.current = {
    decisions: {
      ticket: { assignee_id: { decision: 'route', command: 'assign' }, priority: { decision: 'rank', command: 'rank' } },
    },
  };
  api.mockReset().mockResolvedValue({
    marks: [
      { row: 1, field: 'assignee_id', label: 'Ada Nguyen' },
      { row: 2, field: 'priority', label: 'High' },
    ],
  });
});
afterEach(cleanup);

test('marks map back to their row and column, and nowhere else', async () => {
  const { result } = renderHook(() => useDecisionMarks(ticket, rows), { wrapper });
  await waitFor(() => expect(result.current?.(rows[1], 'assignee_id')).toBeDefined());
  expect(api).toHaveBeenCalledWith('/api/record-decisions/marks', { table: 'ticket', keys: [{ id: 10 }, { id: 11 }, { id: 12 }] });
  const adorn = result.current!;
  const drawn = (row: Record<string, unknown>, column: string) => {
    const node = adorn(row, column);
    if (node === undefined) return undefined;
    const view = render(<>{node}</>);
    const text = view.container.textContent;
    const title = view.container.querySelector('.decision-mark')?.getAttribute('title');
    view.unmount();
    return { text, title };
  };
  expect(drawn(rows[1], 'assignee_id')).toEqual({ text: 'Ada Nguyen', title: 'Suggested: Ada Nguyen' });
  expect(drawn(rows[2], 'priority')).toEqual({ text: 'High', title: 'Suggested: High' });
  // The right row with the wrong column, and the right column on the wrong row.
  expect(drawn(rows[1], 'priority')).toBeUndefined();
  expect(drawn(rows[0], 'assignee_id')).toBeUndefined();
  expect(drawn(rows[2], 'assignee_id')).toBeUndefined();
});

test('a table no decision answers asks nothing', async () => {
  app.current = { decisions: { other: {} } };
  const { result } = renderHook(() => useDecisionMarks(ticket, rows), { wrapper });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api).not.toHaveBeenCalled();
  expect(result.current).toBeUndefined();
});

test('rows with no key are not asked about', async () => {
  const { result } = renderHook(() => useDecisionMarks(ticket, [{ name: 'no id' }]), { wrapper });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api).not.toHaveBeenCalled();
  expect(result.current?.({ name: 'no id' }, 'priority')).toBeUndefined();
});

test("a phone's summary keeps a decided empty fact's box from the first paint, and lays the glyph over it", async () => {
  let answer: (value: unknown) => void = () => {};
  api.mockReset().mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const { result } = renderHook(() => useDecisionMarks(ticket, rows), { wrapper });
  const drawn = (row: Record<string, unknown>, column: string) => {
    const node = result.current!(row, column, 'summary');
    if (node === undefined) return undefined;
    const view = render(<>{node}</>);
    const fact = view.container.querySelector('.decision-fact')!;
    const said = {
      marked: fact.classList.contains('is-marked'),
      empty: fact.querySelector('.null')?.textContent,
      name: fact.querySelector('.decision-fact-mark')?.getAttribute('aria-label') ?? null,
    };
    view.unmount();
    return said;
  };
  // Before the marks answer: the decided fact is already in its box, with its empty mark; any other fact is the summary's own.
  expect(drawn(rows[1], 'assignee_id')).toEqual({ marked: false, empty: '—', name: null });
  expect(result.current!(rows[1], 'title', 'summary')).toBeUndefined();
  answer({ marks: [{ row: 1, field: 'assignee_id', label: 'Ada Nguyen' }] });
  // (Not drawn inside the wait: each drawing changes the document, which asks the wait again before the answer lands.)
  await waitFor(() => expect(result.current!(rows[1], 'assignee_id')).toBeDefined());
  // The same box, its empty mark kept (hidden) under the glyph, the words its name.
  expect(drawn(rows[1], 'assignee_id')).toEqual({ marked: true, empty: '—', name: 'Suggested: Ada Nguyen' });
  expect(drawn(rows[0], 'assignee_id')).toEqual({ marked: false, empty: '—', name: null });
});
