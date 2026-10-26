/**
 * A move drawn before the server has it (optimisticMoves.ts): drawn at once, taken back on a refusal, kept after it
 * applies until the rows read say the same, run one after another, and read again once when the last is done.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useOptimisticMoves } from './optimisticMoves.js';

type Row = { id: string; lane: string };
let hook: ReturnType<typeof useOptimisticMoves<Row>>;
function Host({ rows, idle }: { rows: Row[]; idle?: () => Promise<unknown> }) {
  hook = useOptimisticMoves(rows, (row) => row.id, idle);
  return (
    <ol>
      {hook.rows.map((row) => (
        <li key={row.id}>{`${row.id}:${row.lane}${hook.pending(row.id) ? `:${hook.pending(row.id)}` : ''}`}</li>
      ))}
    </ol>
  );
}
const drawn = () => [...document.querySelectorAll('li')].map((item) => item.textContent);
const rows: Row[] = [
  { id: 'a', lane: 'new' },
  { id: 'b', lane: 'new' },
];
afterEach(cleanup);

test('a move is drawn at once, a refused one goes back, and an applied one stays until the rows agree', async () => {
  const view = render(<Host rows={rows} />);
  let move = 0;
  act(() => void (move = hook.begin([['a', { lane: 'done' }]])));
  expect(drawn()).toEqual(['a:done:saving', 'b:new']);
  act(() => hook.undo(move));
  expect(drawn()).toEqual(['a:new', 'b:new']);
  act(() => void (move = hook.begin([['b', { lane: 'done' }]], 'asking')));
  expect(drawn()).toEqual(['a:new', 'b:done:asking']);
  act(() => hook.saving(move));
  act(() => hook.saved(move));
  // Applied, and the rows still say the old lane: drawn where it was moved, no longer pending.
  expect(drawn()).toEqual(['a:new', 'b:done']);
  view.rerender(<Host rows={[rows[0], { id: 'b', lane: 'done' }]} />);
  expect(drawn()).toEqual(['a:new', 'b:done']);
});

test('moves run one after another, and the rows are read again once, after the last', async () => {
  const idle = vi.fn(async () => undefined);
  render(<Host rows={rows} idle={idle} />);
  const order: string[] = [];
  let first!: () => void;
  act(() => {
    hook.enqueue(() => new Promise<void>((resolve) => (first = () => (order.push('first'), resolve()))));
    hook.enqueue(async () => void order.push('second'));
  });
  expect(hook.busy()).toBe(true);
  await vi.waitFor(() => expect(first).toBeTypeOf('function'));
  expect(order).toEqual([]);
  await act(async () => first());
  await vi.waitFor(() => expect(idle).toHaveBeenCalledTimes(1));
  expect(order).toEqual(['first', 'second']);
  expect(hook.busy()).toBe(false);
});
