/** The write-mode confirmation names the database and answers once. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { WriteConfirmDialog } from './WriteConfirm.js';

afterEach(cleanup);

test('names the database; the danger button says yes, once', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<WriteConfirmDialog label="production" onDone={onDone} />);
  expect(screen.getByRole('dialog', { name: 'Enable write mode?' })).toBeInTheDocument();
  expect(screen.getByText('production')).toHaveProperty('tagName', 'STRONG');
  await user.click(screen.getByRole('button', { name: 'Enable write mode' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(onDone).toHaveBeenCalledWith(true);
});

test('Escape and "Keep viewing" both answer no', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<WriteConfirmDialog label="demo" onDone={onDone} />);
  await user.click(screen.getByRole('button', { name: 'Keep viewing' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  expect(onDone).toHaveBeenCalledTimes(1);
});
