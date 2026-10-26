/** The prompt dialogs: one answer or none, and a range that is one question. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { PromptDialog, RangeDialog } from './Prompt.js';

afterEach(cleanup);

test('multiline prompts preserve newlines and Enter edits instead of submitting', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<PromptDialog title="Page definition" label="JSON" value={'{\n  "name": "Test"\n}'} multiline onDone={onDone} />);
  const input = screen.getByRole('textbox', { name: 'JSON' });
  expect(input.tagName).toBe('TEXTAREA');
  await user.click(input);
  await user.keyboard('{End}{Enter}');
  expect(onDone).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(onDone).toHaveBeenCalledWith('{\n  "name": "Test"\n}');
});

test('submits the trimmed value once, refuses an empty one, and Cancel answers null', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<PromptDialog title="Save this filter" label="Name" value="Open" hint="invoice status = open" onDone={onDone} />);
  const input = screen.getByRole('textbox', { name: 'Name' });
  await waitFor(() => expect(input).toHaveFocus());
  expect(screen.getByText('invoice status = open')).toHaveClass('confirm-params');
  await user.clear(input);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(onDone).not.toHaveBeenCalled();
  await user.type(input, '  Big ones  ');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledWith('Big ones');
  cleanup();
  const cancelled = vi.fn();
  render(<PromptDialog title="Rename" label="Name" confirmLabel="Rename" onDone={cancelled} />);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancelled).toHaveBeenCalledWith(null);
  expect(cancelled).toHaveBeenCalledTimes(1);
});

test('a range asks for both ends and focuses the one that is missing', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<RangeDialog title="Between" fromLabel="From" toLabel="To" onDone={onDone} />);
  await user.type(screen.getByRole('textbox', { name: 'From' }), '10');
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  expect(onDone).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'To' })).toHaveFocus();
  await user.type(screen.getByRole('textbox', { name: 'To' }), '20');
  fireEvent.submit(screen.getByRole('textbox', { name: 'To' }).closest('form')!);
  expect(onDone).toHaveBeenCalledWith({ from: '10', to: '20' });
});

test('date prompts preserve ISO dates and refuse invalid drafts even on direct submit', async () => {
  const onDone = vi.fn();
  render(<PromptDialog title="Due" label="Date" type="date" value="2026-09-13" onDone={onDone} />);
  const input = screen.getByRole('textbox', { name: 'Date' });
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveValue('09/13/2026');
  expect(screen.getByRole('button', { name: 'Choose date for Date' })).toBeVisible();
  fireEvent.change(input, { target: { value: '2026-02-30' } });
  fireEvent.submit(input.closest('form')!);
  expect(onDone).not.toHaveBeenCalled();
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: '2028-02-29' } });
  fireEvent.submit(input.closest('form')!);
  expect(onDone).toHaveBeenCalledExactlyOnceWith('2028-02-29');
});

test('date range validates both typed ends and keeps the calendar inside the dialog', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<RangeDialog title="Between dates" fromLabel="From" toLabel="To" type="date" onDone={onDone} />);
  const from = screen.getByRole('textbox', { name: 'From' });
  const to = screen.getByRole('textbox', { name: 'To' });
  fireEvent.change(from, { target: { value: '2026-09-13' } });
  fireEvent.change(to, { target: { value: '2026-09-' } });
  fireEvent.submit(from.closest('form')!);
  expect(onDone).not.toHaveBeenCalled();
  expect(to).toHaveFocus();
  const trigger = screen.getByRole('button', { name: 'Choose date for From' });
  await user.click(trigger);
  const popup = document.querySelector<HTMLElement>('.date-field-popup')!;
  expect(from.closest('[role="dialog"]')).toContainElement(popup);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(document.querySelector('.date-field-popup')).toBeNull());
  expect(onDone).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
  fireEvent.change(to, { target: { value: '2026-09-14' } });
  fireEvent.submit(to.closest('form')!);
  expect(onDone).toHaveBeenCalledExactlyOnceWith({ from: '2026-09-13', to: '2026-09-14' });
});

test('datetime prompts use the themed calendar and answer a wall time, refusing an instant', async () => {
  const onDone = vi.fn();
  render(<PromptDialog title="When" label="Local time" type="datetime-local" value="2026-09-13T09:30" onDone={onDone} />);
  const input = screen.getByRole('textbox', { name: 'Local time' });
  expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Choose date for Local time' })).toBeVisible();
  fireEvent.change(input, { target: { value: '2026-09-13T09:30Z' } });
  fireEvent.submit(input.closest('form')!);
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '2026-09-13 18:05' } });
  fireEvent.submit(input.closest('form')!);
  expect(onDone).toHaveBeenCalledExactlyOnceWith('2026-09-13 18:05');
});

test('a datetime range takes the calendar on both ends', () => {
  const onDone = vi.fn();
  render(<RangeDialog title="Between" fromLabel="From" toLabel="To" type="datetime-local" onDone={onDone} />);
  expect(screen.getByRole('button', { name: 'Choose date for From' })).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'From' }), { target: { value: '2026-09-13T09:00' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'To' }), { target: { value: '2026-09-13' } });
  fireEvent.submit(screen.getByRole('textbox', { name: 'To' }).closest('form')!);
  expect(onDone).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'To' })).toHaveFocus();
});
