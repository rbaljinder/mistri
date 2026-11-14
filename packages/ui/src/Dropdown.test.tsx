/** The listbox: actions ride under a divider, walked with the same arrows, and run rather than chosen. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Dropdown } from './Dropdown.js';
import { createRef, useState } from 'react';

afterEach(cleanup);

test('an action is listed after the options, runs on click, and never becomes the value', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const reread = vi.fn();
  render(
    <Dropdown
      ariaLabel="Database connection"
      value="a"
      items={[
        { value: 'a', label: 'app' },
        { value: 'b', label: 'billing' },
      ]}
      onChange={onChange}
      actions={[{ label: '↻ Re-read the schema', onSelect: reread }]}
    />,
  );
  const trigger = screen.getByRole('button', { name: /^Database connection\b/ });
  // Named by its label and then by the value it shows.
  expect(trigger).toHaveAttribute('aria-label', 'Database connection');
  expect(trigger).toHaveAttribute('aria-labelledby', `${trigger.id} ${trigger.querySelector('[data-slot="select-value"]')!.id}`);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  const options = await screen.findAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['app', 'billing', '↻ Re-read the schema']);
  // The chosen one says so to a reader; no mark is drawn as text.
  expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
  // The rule stands between the options and the actions.
  const rule = document.querySelector('[data-slot="select-separator"]')!;
  expect(rule.previousElementSibling).toBe(options[1]);
  expect(rule.nextElementSibling).toBe(options[2]);
  const list = screen.getByRole('listbox', { name: 'Database connection' });
  expect(list).not.toHaveAttribute('aria-labelledby');
  await user.click(options[2]);
  expect(reread).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
});

test('choosing an option reports it and closes; the arrows walk options and actions alike', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const reread = vi.fn();
  render(
    <Dropdown
      ariaLabel="Pick"
      value="a"
      items={[
        { value: 'a', label: 'app' },
        { value: 'b', label: 'billing' },
      ]}
      onChange={onChange}
      actions={[{ label: 'Re-read', onSelect: reread }]}
    />,
  );
  await user.click(screen.getByRole('button', { name: /^Pick\b/ }));
  await screen.findAllByRole('option');
  await user.keyboard('{End}');
  // The one row the keyboard is on.
  expect(screen.getAllByRole('option')[2]).toHaveAttribute('data-highlighted');
  expect(screen.getAllByRole('option').filter((o) => o.hasAttribute('data-highlighted'))).toHaveLength(1);
  await user.keyboard('{Enter}');
  expect(reread).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();

  await waitFor(() => expect(screen.getByRole('button', { name: /^Pick\b/ })).toHaveAttribute('aria-expanded', 'false'));
  await user.click(screen.getByRole('button', { name: /^Pick\b/ }));
  await user.click((await screen.findAllByRole('option'))[1]);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('b', expect.objectContaining({ reason: 'item-press', source: 'pointer' }));
  await waitFor(() => expect(screen.getByRole('button', { name: /^Pick\b/ })).toHaveAttribute('aria-expanded', 'false'));
});

test('optional ownership props expose the real portal and open state without changing selection', async () => {
  const user = userEvent.setup();
  const popupRef = createRef<HTMLDivElement>();
  const open = vi.fn();
  const change = vi.fn();
  const view = render(
    <Dropdown
      value="a"
      items={[{ value: 'a', label: 'Alpha' }]}
      ariaLabel="Select"
      onChange={change}
      popupRef={popupRef}
      onOpenChange={open}
    />,
  );
  expect(popupRef.current).toBeNull();
  await user.click(screen.getByRole('button', { name: /^Select\b/ }));
  // The popup itself: the element that holds the options, drawn outside the control.
  expect(popupRef.current).toHaveAttribute('role', 'listbox');
  expect(popupRef.current?.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(view.container.contains(popupRef.current)).toBe(false);
  expect(open).toHaveBeenLastCalledWith(true, expect.objectContaining({ reason: 'trigger-press', source: 'pointer' }));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.getByRole('button', { name: /^Select\b/ })).toHaveAttribute('aria-expanded', 'false'));
  expect(open).toHaveBeenLastCalledWith(false, expect.objectContaining({ reason: 'escape-key', source: 'keyboard' }));
  expect(change).not.toHaveBeenCalled();
  view.unmount();
  expect(popupRef.current).toBeNull();
});

test('each of the five tones styles its option through its own class', async () => {
  const user = userEvent.setup();
  render(
    <Dropdown
      ariaLabel="Tones"
      value="good"
      items={(['good', 'warn', 'bad', 'info', 'neutral'] as const).map((tone) => ({ value: tone, label: tone, tone }))}
      onChange={() => {}}
    />,
  );
  await user.click(screen.getByRole('button', { name: /^Tones\b/ }));
  const options = await screen.findAllByRole('option');
  // The tone is an attribute on the option, which the stylesheet dresses.
  expect(options.map((o) => o.getAttribute('data-tone'))).toEqual(['good', 'warn', 'bad', 'info', 'neutral']);
});

test('pressing the option that is already chosen changes nothing', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  function One() {
    const [value, set] = useState('a');
    return (
      <Dropdown
        ariaLabel="Pick"
        value={value}
        items={[
          { value: 'a', label: 'app' },
          { value: 'b', label: 'billing' },
        ]}
        onChange={(next, details) => {
          onChange(next, details);
          set(next);
        }}
      />
    );
  }
  render(<One />);
  const trigger = screen.getByRole('button', { name: /^Pick\b/ });
  await user.click(trigger);
  await user.click((await screen.findAllByRole('option'))[0]);
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  expect(onChange).not.toHaveBeenCalled();
  expect(trigger).toHaveTextContent('app');
});

test('a letter typed on the closed button moves the choice, and says it followed the keyboard', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <Dropdown
      ariaLabel="Pick"
      value="a"
      items={[
        { value: 'a', label: 'app', detail: 'billing is next door' },
        { value: 'b', label: 'billing' },
      ]}
      onChange={onChange}
    />,
  );
  screen.getByRole('button', { name: /^Pick\b/ }).focus();
  await user.keyboard('b');
  // Not a press on an option: the value followed a key, and the option is found by its word, not its detail.
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('b', expect.objectContaining({ reason: 'sync', source: 'keyboard' }));
});
