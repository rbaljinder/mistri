/** The query modal: starts from the line handed in, Enter runs a flattened line, Escape hands nothing on. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { AskDialog } from './Ask.js';

afterEach(cleanup);

test('Enter runs the line, flattened, and closes; a blank line runs nothing', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const onClose = vi.fn();
  render(<AskDialog initial="invoice count by status" onRun={onRun} onClose={onClose} />);
  const box = screen.getByRole('textbox', { name: 'Query' });
  await waitFor(() => expect(box).toHaveFocus());
  expect(screen.getByRole('dialog', { name: 'Write a query' })).toBeInTheDocument();
  await user.clear(box);
  await user.keyboard('{Enter}');
  expect(onRun).not.toHaveBeenCalled();
  await user.type(box, 'invoice  where total > 100{Shift>}{Enter}{/Shift}sort total');
  await user.keyboard('{Enter}');
  expect(onRun).toHaveBeenCalledWith('invoice where total > 100 sort total');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape cancels without running', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const onClose = vi.fn();
  render(<AskDialog initial="customer" onRun={onRun} onClose={onClose} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Query' })).toHaveFocus());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onRun).not.toHaveBeenCalled();
});
