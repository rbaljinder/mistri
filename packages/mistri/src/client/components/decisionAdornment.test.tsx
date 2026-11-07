/** A record's suggestions at its fields: asked only where the App says a decision answers, drawn only at the suggested column. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { FieldSuggestion } from '../../shared/decisionSuggestions.js';

const { api, app } = vi.hoisted(() => ({ api: vi.fn(), app: { current: null as unknown } }));
vi.mock('../../../../kit/src/client/core.js', () => ({ api }));
vi.mock('../appState.js', () => ({ activeApp: () => app.current }));
vi.mock('./DecisionChip.js', () => ({
  default: ({ suggestion }: { suggestion: FieldSuggestion }) => <span data-testid="chip">{suggestion.label}</span>,
}));

const { useRecordDecisions } = await import('./decisionAdornment.js');

const suggestion: FieldSuggestion = {
  id: 'dec-1',
  decision: 'route',
  field: 'assignee_id',
  command: 'assign',
  answer: 7,
  label: 'Ada Nguyen',
  probability: 0.9,
  filled: false,
  at: '2026-10-20T10:00:00.000Z',
};
const clients: QueryClient[] = [];
const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
const hook = (key: Readonly<Record<string, unknown>> | null = { id: 3 }) =>
  renderHook(() => useRecordDecisions('demo', 'ticket', key ?? undefined, () => {}).adorn, { wrapper });

beforeEach(() => {
  api.mockReset().mockResolvedValue({ suggestions: [suggestion] });
  app.current = { decisions: { ticket: { assignee_id: { decision: 'route', command: 'assign' } } } };
});
afterEach(() => {
  cleanup();
  clients.length = 0;
});

test('an App that declares no decision on the table asks nothing and adorns nothing', async () => {
  app.current = { decisions: { other: {} } };
  const { result } = hook();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api).not.toHaveBeenCalled();
  expect(result.current).toBeUndefined();
});

test('no App at all asks nothing', async () => {
  app.current = null;
  const { result } = hook();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api).not.toHaveBeenCalled();
  expect(result.current).toBeUndefined();
});

test('with suggestions, the adornment draws a chip at the suggested column and nothing at the others', async () => {
  const { result } = hook();
  const at = (column: string) => result.current!({ table: 'ticket', column, key: { id: 3 }, filled: false });
  await waitFor(() => expect(at('assignee_id')).not.toBeNull());
  expect(api).toHaveBeenCalledWith('/api/record-decisions', { table: 'ticket', key: { id: 3 } });
  expect(at('status')).toBeNull();
  render(<>{at('assignee_id')}</>);
  expect(await screen.findByTestId('chip')).toHaveTextContent('Ada Nguyen');
});

test('a record with no waiting suggestion draws no chip, and marks only a filled field a decision answers', async () => {
  api.mockResolvedValue({ suggestions: [] });
  const { result } = hook();
  await waitFor(() => expect(api).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const at = (column: string, filled: boolean) => result.current!({ table: 'ticket', column, key: { id: 3 }, filled });
  // An empty field keeps the page's own empty mark; a field no decision answers is the page's alone.
  expect(at('assignee_id', false)).toBeNull();
  expect(at('status', true)).toBeNull();
  // A filled answered field is marked from the first paint, so a phone gives its value the line a suggestion needs.
  const { container } = render(<>{at('assignee_id', true)}</>);
  expect(container.querySelector('.decision-slot')).not.toBeNull();
  expect(screen.queryByTestId('chip')).toBeNull();
});

test('no record key (a preview) asks nothing', async () => {
  const { result } = hook(null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api).not.toHaveBeenCalled();
  expect(result.current).toBeUndefined();
});

test("the first ask holds a header's facts; its answer, or an error, releases them", async () => {
  let answer!: (value: unknown) => void;
  api.mockReturnValue(new Promise((done) => (answer = done)));
  const { result } = renderHook(() => useRecordDecisions('demo', 'ticket', { id: 3 }, () => {}).held, { wrapper });
  await waitFor(() => expect(result.current).toEqual(['assignee_id']));
  answer({ suggestions: [] });
  await waitFor(() => expect(result.current).toEqual([]));
  api.mockRejectedValue(new Error('down'));
  const failed = renderHook(() => useRecordDecisions('demo', 'ticket', { id: 4 }, () => {}).held, { wrapper });
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(failed.result.current).toEqual([]));
});
