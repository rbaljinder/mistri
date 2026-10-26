/** A command's date-and-time input: a wall time in the App's zone in the box, the UTC instant in the form and on the wire. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import type { AppCommandField } from '../../shared/app.js';
import { installShell } from '../../../../kit/src/client/shellMode.js';

vi.mock('../../../../kit/src/client/core.js', () => ({
  api: vi.fn(),
  state: { activeConnection: 'desk' },
  findTable: () => null,
  columnLabel: () => null,
  humanName: (name: string) => name,
  prefersPages: () => true,
  toast: vi.fn(),
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));

const { FormSurface } = await import('./FormSurface.js');
const { CommandFields, prefilledCommandValues } = await import('./CommandFields.js');
const { instantWallTime, wallTimeInstant } = await import('./wallTime.js');

const input: AppCommandField[] = [
  { name: 'at', label: 'Visit at', type: 'datetime', required: true, min: '2026-01-01T05:00:00.000Z' },
  { name: 'until', label: 'Until', type: 'datetime', above: 'at' },
];

beforeEach(() => installShell({ format: () => ({ locale: 'en-US', timezone: 'America/New_York' }) }));
afterEach(() => {
  cleanup();
  installShell({ format: () => null });
});

test('a wall time names its instant in the zone, through both of a year’s clock changes', () => {
  expect(wallTimeInstant('2026-10-12 09:30', 'America/New_York')).toBe('2026-10-12T13:30:00.000Z');
  expect(wallTimeInstant('2026-01-12T09:30:15', 'America/New_York')).toBe('2026-01-12T14:30:15.000Z');
  expect(wallTimeInstant('2026-10-12 09:30', 'Asia/Kolkata')).toBe('2026-10-12T04:00:00.000Z');
  // A repeated hour is its earlier moment; a skipped one moves forward by the gap, west and east of Greenwich.
  expect(wallTimeInstant('2026-11-01 01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  expect(wallTimeInstant('2026-10-25 02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z');
  expect(wallTimeInstant('2026-03-08 02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
  expect(wallTimeInstant('2026-03-29 02:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z');
  expect(wallTimeInstant('2026-10-12', 'UTC')).toBeUndefined();
  expect(wallTimeInstant('2026-10-12 9:3', 'UTC')).toBeUndefined();
  expect(instantWallTime('2026-10-12T13:30:00.000Z', 'America/New_York')).toBe('2026-10-12 09:30');
  expect(instantWallTime('2026-10-12 19:16:05-04', 'UTC')).toBe('2026-10-12 23:16:05');
  expect(instantWallTime('2026-10-12T13:30', 'UTC')).toBeUndefined();
});

test('a starting instant is drawn as its wall time, and the keyboard calendar moves the date and keeps the time', async () => {
  const user = userEvent.setup();
  const seen: unknown[] = [];
  function Form() {
    const [values, setValues] = useState(() => prefilledCommandValues(input, { at: '2026-03-08T15:00:00.000Z' }));
    return (
      <CommandFields
        fields={input}
        values={values}
        idPrefix="t"
        identityEpoch={1}
        isCurrent={() => true}
        onChange={(next) => {
          seen.push(next.at);
          setValues(next);
        }}
      />
    );
  }
  render(<Form />);
  const box = await screen.findByRole('textbox', { name: 'Visit at (required)' });
  // 15:00 UTC on the day the clocks went forward is eleven in the morning in New York.
  expect(box).toHaveValue('2026-03-08 11:00');
  expect(box).toHaveAttribute('placeholder', 'YYYY-MM-DD HH:MM');
  await user.click(box);
  await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
  await screen.findByRole('grid');
  await user.keyboard('{ArrowRight}{Enter}');
  await waitFor(() => expect(box).toHaveValue('2026-03-09 11:00'));
  expect(seen.at(-1)).toBe('2026-03-09T15:00:00.000Z');
  // A half-typed time stays in the box as typed, and reaches the form as text, not as some moment.
  await user.clear(box);
  await user.type(box, '2026-11-01 01:3');
  expect(box).toHaveValue('2026-11-01 01:3');
  expect(seen.at(-1)).toBe('2026-11-01 01:3');
  await user.type(box, '0');
  expect(box).toHaveValue('2026-11-01 01:30');
  expect(seen.at(-1)).toBe('2026-11-01T05:30:00.000Z');
});

test('the form sends the UTC instant, and says a time that is not one, or before its bound, in words', async () => {
  const submit = vi.fn().mockResolvedValue({ reference: 'V-1', receipt: { id: 'r1', status: 'applied' } });
  render(<FormSurface form={{ id: 'visit', label: 'Book a visit', input }} appName="Desk" submit={submit} />);
  const at = await screen.findByRole('textbox', { name: 'Visit at (required)' });
  const until = await screen.findByRole('textbox', { name: 'Until' });
  fireEvent.change(at, { target: { value: '2026-10-12 9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Visit at must be a date and time.')).toBeVisible());
  fireEvent.change(at, { target: { value: '2025-12-31 23:59' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Visit at must be on or after Jan 1, 2026, 12:00 AM.')).toBeVisible());
  fireEvent.change(at, { target: { value: '2026-10-12 09:30' } });
  fireEvent.change(until, { target: { value: '2026-10-12 09:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Until must be after Visit at.')).toBeVisible());
  fireEvent.change(until, { target: { value: '2026-10-12T17:45' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][1]).toEqual({ at: '2026-10-12T13:30:00.000Z', until: '2026-10-12T21:45:00.000Z' });
});
