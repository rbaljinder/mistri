/* The calendar's code is fetched on first use. A fetch that fails must not be the answer to every later press, and the
   page is told the calendar is open only once it is. Alone in its file: the load is module state, mocked here. */
import process from 'node:process';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const load = vi.hoisted(() => ({ fail: true, attempts: 0 }));
vi.mock('./internal/DateFieldCalendar.js', () => {
  load.attempts += 1;
  if (load.fail) throw new Error('chunk gone');
  return { DateFieldCalendar: () => <div data-testid="calendar-body" /> };
});

import { DateField, type DateFieldWords } from './DateField.js';

afterEach(cleanup);

const words: DateFieldWords = {
  timePattern: 'HH:MM',
  enterDateAndTime: (format) => `Enter a date and time as ${format}.`,
  enterDate: (format) => `Enter a date as ${format}.`,
  dateAndTimeFormat: (format) => `Date and time format: ${format}.`,
  dateFormat: (format) => `Date format: ${format}.`,
  openWithKeys: 'Alt and Down arrow opens the calendar.',
  chooseDate: () => 'Choose date',
  calendar: () => 'Calendar',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  clear: 'Clear',
  today: 'Today',
};

test('a failed calendar load is retried on the next press, and open is reported when it opens', async () => {
  const onOpenChange = vi.fn();
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  render(
    <DateField
      id="due"
      ariaLabel="Due"
      value="2026-09-13"
      onValueChange={() => {}}
      onOpenChange={onOpenChange}
      words={words}
      calendarIcon={<svg aria-hidden="true" />}
      locale="en-US"
    />,
  );
  const trigger = screen.getByRole('button', { name: 'Choose date' });
  fireEvent.click(trigger);
  await waitFor(() => expect(load.attempts).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Nothing opened, so nothing was reported open.
  expect(onOpenChange).not.toHaveBeenCalledWith(true, expect.anything());
  expect(screen.queryByTestId('calendar-body')).toBeNull();

  load.fail = false;
  fireEvent.click(trigger);
  await screen.findByTestId('calendar-body');
  expect(onOpenChange).toHaveBeenCalledWith(true, expect.anything());
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', unhandled);
  expect(unhandled).not.toHaveBeenCalled();
});
