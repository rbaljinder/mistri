/**
 * The first-run screen: the promise first, two ways in, and the broken
 * connections named rather than hidden behind "nothing connected".
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

let fail = false;
const added = vi.fn();
const opened = vi.fn();
vi.mock('../../../../kit/src/client/core.js', () => ({
  $: () => null,
  api: async () => {
    if (fail) throw new Error('no sqlite here');
    return {};
  },
}));
vi.mock('../connmanager.js', () => ({ addConnection: (...a: unknown[]) => added(...a), openConnections: () => opened() }));

const { Welcome } = await import('./Welcome.js');

afterEach(() => {
  cleanup();
  fail = false;
  added.mockClear();
  opened.mockClear();
});

test('leads with what the tool is, focuses the sample, and offers a connection beside it', async () => {
  const user = userEvent.setup();
  render(<Welcome />);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Follow the data.');
  expect(screen.getByRole('button', { name: 'Open the sample database' })).toHaveFocus();
  expect(document.querySelector('.welcome-assure')).toHaveTextContent('Read only.');
  expect(screen.queryByText(/configured/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Connect a database' }));
  expect(added).toHaveBeenCalledTimes(1);
});

test('a sample that will not build says why, and the button comes back', async () => {
  const user = userEvent.setup();
  fail = true;
  render(<Welcome />);
  await user.click(screen.getByRole('button', { name: 'Open the sample database' }));
  await screen.findByText('Could not build the sample database: no sqlite here');
  expect(screen.getByRole('button', { name: 'Open the sample database' })).toBeEnabled();
});

test('connections that did not open are listed with their reasons', async () => {
  const user = userEvent.setup();
  render(<Welcome listed={[{ name: 'prod', error: 'unable to open database file' }, { name: 'ok' }]} />);
  const trouble = document.querySelector('.welcome-trouble')!;
  expect(trouble).toHaveTextContent('One connection is configured, and it did not open.');
  expect(trouble).toHaveTextContent('prod');
  expect(trouble).toHaveTextContent('unable to open database file');
  expect(trouble).not.toHaveTextContent('ok');
  await user.click(screen.getByRole('button', { name: 'Open connections' }));
  expect(opened).toHaveBeenCalledTimes(1);
});
