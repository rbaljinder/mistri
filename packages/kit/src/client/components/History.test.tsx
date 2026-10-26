/** The history panel: recent queries with their age, run on click, cleared in one. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { HistoryPanel } from './History.js';

afterEach(cleanup);

test('lists what ran with how long ago, runs one on click, and offers to clear them all', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const onClear = vi.fn();
  const now = Date.now();
  render(
    <HistoryPanel
      entries={[
        { q: 'invoice status = open', at: now - 5_000 },
        { q: 'customer', at: now - 7_200_000 },
      ]}
      onRun={onRun}
      onClear={onClear}
    />,
  );
  const items = screen.getAllByRole('listitem');
  expect(items[0]).toHaveTextContent('invoice status = open');
  expect(items[0].querySelector('.history-age')).toHaveTextContent('just now');
  expect(items[1].querySelector('.history-age')).toHaveTextContent('2h ago');
  await user.click(screen.getByText('customer'));
  expect(onRun).toHaveBeenCalledWith('customer');
  await user.click(screen.getByRole('button', { name: 'Clear 2 queries' }));
  expect(onClear).toHaveBeenCalledTimes(1);
});

test('nothing yet says so', () => {
  render(<HistoryPanel entries={[]} onRun={() => {}} onClear={() => {}} />);
  expect(screen.getByText('Nothing yet. Queries appear here once they run.')).toBeInTheDocument();
});
