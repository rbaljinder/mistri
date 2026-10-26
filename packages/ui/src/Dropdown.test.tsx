/** The listbox: actions ride under a divider, walked with the same arrows, and run rather than chosen. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Dropdown } from './Dropdown.js';
import { createRef } from 'react';

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
  const trigger = screen.getByRole('button', { name: 'Database connection' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  const options = await screen.findAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['✓app', 'billing', '↻ Re-read the schema']);
  expect(document.querySelector('.dd-divider')).toBeInTheDocument();
  expect(screen.getByRole('listbox', { name: 'Database connection' })).toBeInTheDocument();
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
  await user.click(screen.getByRole('button', { name: 'Pick' }));
  await screen.findAllByRole('option');
  await user.keyboard('{End}');
  expect(screen.getAllByRole('option')[2]).toHaveClass('active');
  await user.keyboard('{Enter}');
  expect(reread).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Pick' }));
  await user.click((await screen.findAllByRole('option'))[1]);
  expect(onChange).toHaveBeenCalledWith('b');
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
  await user.click(screen.getByRole('button', { name: 'Select' }));
  expect(popupRef.current).toHaveClass('dd-popup');
  expect(view.container.contains(popupRef.current)).toBe(false);
  expect(open).toHaveBeenLastCalledWith(true, expect.anything());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-expanded', 'false'));
  expect(open).toHaveBeenLastCalledWith(false, expect.anything());
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
  await user.click(screen.getByRole('button', { name: 'Tones' }));
  const options = await screen.findAllByRole('option');
  for (const tone of ['good', 'warn', 'bad', 'info', 'neutral']) {
    expect(options.find((o) => o.textContent?.includes(tone))).toHaveClass(`dd-tone-${tone}`);
  }
});
