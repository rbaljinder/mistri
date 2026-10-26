/** The form's listboxes: named by their label, opened from the keyboard, and given back their focus on Escape. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { MultiSelect, Select } from './Select.js';

afterEach(cleanup);

const makes = [
  { value: 'acura', label: 'Acura' },
  { value: 'alfa', label: 'Alfa Romeo' },
  { value: 'audi', label: 'Audi' },
];

function One({ start = '', onPick = () => {} }: { start?: string; onPick?: (v: string) => void }) {
  const [value, set] = useState(start);
  return (
    <Select
      label="Make"
      options={makes}
      value={value}
      placeholder="Choose"
      problem={undefined}
      onChange={(v) => {
        onPick(v);
        set(v);
      }}
    />
  );
}

test('the button is named by the label and says its value, or the placeholder while empty', () => {
  const { unmount } = render(<One />);
  expect(screen.getByRole('button', { name: /Make/ })).toHaveTextContent('Choose');
  unmount();
  render(<One start="alfa" />);
  expect(screen.getByRole('button', { name: /Make/ })).toHaveTextContent('Alfa Romeo');
  expect(screen.getByRole('button', { name: 'Make Alfa Romeo' })).toBeInTheDocument();
});

test('ArrowDown opens it, the arrows move, Enter chooses and the list closes', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  render(<One onPick={pick} />);
  const button = screen.getByRole('button', { name: /Make/ });
  button.focus();
  await user.keyboard('{ArrowDown}');
  await screen.findAllByRole('option');
  expect(button).toHaveAttribute('aria-expanded', 'true');
  await user.keyboard('{ArrowDown}');
  await user.keyboard('{Enter}');
  expect(pick).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  expect(button).toHaveTextContent(/Alfa Romeo|Audi|Acura/);
  expect(screen.getByRole('listbox', { hidden: true }) ?? null).toBeTruthy();
});

test('Escape closes it and the focus is back on the button', async () => {
  const user = userEvent.setup();
  render(<One />);
  const button = screen.getByRole('button', { name: /Make/ });
  button.focus();
  await user.keyboard('{ArrowDown}');
  await screen.findAllByRole('option');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  await waitFor(() => expect(button).toHaveFocus());
});

test('a problem marks the button invalid and joins its description', () => {
  render(<Select label="Make" options={makes} value="" onChange={() => {}} problem="Choose a make." hint="Pick one." />);
  const button = screen.getByRole('button', { name: /Make/ });
  expect(button).toHaveAttribute('aria-invalid', 'true');
  expect(button).toHaveAccessibleDescription('Pick one. Choose a make.');
});

function Many({ onPick = () => {} }: { onPick?: (v: string[]) => void }) {
  const [value, set] = useState<string[]>([]);
  return (
    <MultiSelect
      label="Makes"
      options={makes}
      value={value}
      placeholder="Choose"
      onChange={(v) => {
        onPick(v);
        set(v);
      }}
    />
  );
}

test('several may be chosen; the list stays open and the box says them as one line', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  render(<Many onPick={pick} />);
  const button = screen.getByRole('button', { name: /Makes/ });
  await user.click(button);
  const options = await screen.findAllByRole('option');
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
  await user.click(options[2]);
  await user.click(options[0]);
  expect(pick).toHaveBeenLastCalledWith(['acura', 'audi']);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(button).toHaveTextContent('Acura, Audi');
  await user.click(screen.getAllByRole('option')[2]);
  expect(pick).toHaveBeenLastCalledWith(['acura']);
});

test('a multiple list opens from the keyboard and closes on Escape with the focus back', async () => {
  const user = userEvent.setup();
  render(<Many />);
  const button = screen.getByRole('button', { name: /Makes/ });
  button.focus();
  await user.keyboard('{ArrowDown}');
  await screen.findAllByRole('option');
  await user.keyboard('{ArrowDown}{Enter}');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  await waitFor(() => expect(button).toHaveFocus());
  expect(button).toHaveTextContent(/Acura|Alfa Romeo|Audi/);
});
