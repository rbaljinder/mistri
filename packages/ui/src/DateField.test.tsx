import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { DateField as Drawn, type DateFieldProps, type DateFieldWords } from './DateField.js';
import type { ChangeDetails } from './changeDetails.js';
import { Modal } from './Modal.js';

afterEach(cleanup);

/* The words a host lends (the kit lends its catalog's): these are the ones the assertions read. */
const words: DateFieldWords = {
  dateTimePattern: 'YYYY-MM-DD HH:MM',
  enterDateAndTime: 'Enter a date and time as YYYY-MM-DD HH:MM within the allowed range.',
  enterDate: (format) => `Enter a date as ${format} within the allowed range.`,
  dateAndTimeFormat: 'Date and time format: YYYY-MM-DD HH:MM.',
  dateFormat: (format) => `Date format: ${format}.`,
  openWithKeys: 'Alt and Down arrow opens the calendar.',
  chooseDate: (label) => (label ? `Choose date for ${label}` : 'Choose date'),
  calendar: (label) => (label ? `Calendar for ${label}` : 'Choose date'),
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  clear: 'Clear',
  today: 'Today',
};
const DateField = (props: Omit<DateFieldProps, 'words' | 'calendarIcon'>) => (
  <Drawn {...props} words={words} calendarIcon={<svg aria-hidden="true" />} />
);

/* A day of the month in view, by the name it is read out with. */
const day = (name: string) => screen.getByRole('gridcell', { name });

function Field({ blur = () => {}, min, max }: { blur?: () => void; min?: string; max?: string }) {
  const [value, setValue] = useState('2026-09-13');
  return (
    <>
      <DateField id="due" aria-label="Due" value={value} onChange={setValue} onBlur={blur} min={min} max={max} locale="en-US" />
      <button type="button">Outside</button>
    </>
  );
}

test('calendar walks dates with one day tab stop, clamps months, and selects ISO dates', async () => {
  const user = userEvent.setup();
  render(<Field />);
  const trigger = screen.getByRole('button', { name: 'Choose date for Due' });
  await user.click(trigger);
  const grid = await screen.findByRole('grid');
  // A day is a cell of the grid, named and focusable itself.
  await waitFor(() => expect(day('Sunday, September 13, 2026')).toHaveFocus());
  expect(grid.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  await user.keyboard('{ArrowRight}{ArrowDown}{Home}');
  await waitFor(() => expect(day('Monday, September 21, 2026')).toHaveFocus());
  await user.keyboard('{End}{PageDown}');
  await waitFor(() => expect(day('Tuesday, October 27, 2026')).toHaveFocus());
  expect(screen.getByRole('grid').querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  await user.keyboard('{PageUp}');
  await waitFor(() => expect(day('Sunday, September 27, 2026')).toHaveFocus());
  await user.keyboard('{Enter}');
  expect(screen.getByRole('textbox', { name: 'Due' })).toHaveValue('09/27/2026');
  await waitFor(() => expect(trigger).toHaveFocus());
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
});

test('bounds disable outside days and navigation and preserve typed invalid text', async () => {
  const user = userEvent.setup();
  render(<Field min="2026-09-10" max="2026-09-20" />);
  await user.click(screen.getByRole('button', { name: 'Choose date for Due' }));
  // A day or an arrow that cannot be had says so and stays where the keyboard can read it.
  expect(await screen.findByRole('gridcell', { name: 'Wednesday, September 9, 2026' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('button', { name: 'Previous month' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('button', { name: 'Next month' })).toHaveAttribute('aria-disabled', 'true');
  await waitFor(() => expect(day('Sunday, September 13, 2026')).toHaveFocus());
  // A week up is past the first day that can be had, so the keyboard stops on that day.
  await user.keyboard('{ArrowUp}');
  await waitFor(() => expect(day('Thursday, September 10, 2026')).toHaveFocus());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  const input = screen.getByRole('textbox', { name: 'Due' });
  await user.clear(input);
  await user.type(input, '2026-02-30');
  expect(input).toHaveValue('2026-02-30');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toBeInvalid();
});

function Stamp({ max, onOpen = () => {} }: { max?: string; onOpen?: (open: boolean, details: ChangeDetails) => void }) {
  const [value, setValue] = useState('2026-09-13T09:30');
  return <DateField id="at" aria-label="At" value={value} onChange={setValue} withTime max={max} locale="en-US" onOpenChange={onOpen} />;
}

test('with a time, the calendar picks the date and keeps the time typed; the whole value is bounded', async () => {
  const user = userEvent.setup(),
    open = vi.fn();
  render(<Stamp max="2026-09-20T12:00" onOpen={open} />);
  const input = screen.getByRole('textbox', { name: 'At' });
  expect(input).toHaveAttribute('placeholder', 'YYYY-MM-DD HH:MM');
  await user.click(screen.getByRole('button', { name: 'Choose date for At' }));
  expect(open).toHaveBeenLastCalledWith(true, expect.objectContaining({ reason: 'trigger-press', source: 'pointer' }));
  await user.click(await screen.findByRole('gridcell', { name: 'Tuesday, September 15, 2026' }));
  expect(input).toHaveValue('2026-09-15 09:30');
  // A day chosen closes the calendar, and says so.
  expect(open).toHaveBeenLastCalledWith(false, expect.objectContaining({ reason: 'day-press', source: 'pointer' }));
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  expect(input).toBeValid();
  await user.clear(input);
  await user.type(input, '2026-09-20 12:01');
  expect(input).toBeInvalid();
  await user.clear(input);
  await user.type(input, '2026-09-20 12:00');
  expect(input).toBeValid();
  await user.clear(input);
  await user.type(input, '2026-09-14T09:30Z');
  expect(input).toHaveAttribute('aria-invalid', 'true');
});

test('opening, navigating and closing calendar does not blur the composite field', async () => {
  const user = userEvent.setup(),
    blur = vi.fn();
  render(<Field blur={blur} />);
  await user.click(screen.getByRole('textbox', { name: 'Due' }));
  await user.click(screen.getByRole('button', { name: 'Choose date for Due' }));
  await screen.findByRole('grid');
  await user.keyboard('{ArrowRight}{Escape}');
  expect(blur).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Outside' }));
  await waitFor(() => expect(blur).toHaveBeenCalledTimes(1));
});

test('calendar lives inside enclosing dialog; Escape closes only the calendar first', async () => {
  const user = userEvent.setup(),
    close = vi.fn();
  render(
    <Modal className="test-dialog" ariaLabel="Edit task" onClose={close}>
      <Field />
    </Modal>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
  await user.click(screen.getByRole('button', { name: 'Choose date for Due' }));
  expect(await within(dialog).findByRole('grid')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  expect(close).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

test('locale captions, explicit-zone Today, Clear, and disabled/required inputs', async () => {
  const user = userEvent.setup(),
    change = vi.fn();
  const view = render(
    <DateField id="date" aria-label="Date" value="2026-09-13" onChange={change} locale="fr-FR" timezone="Pacific/Kiritimati" required />,
  );
  expect(screen.getByRole('textbox')).toBeRequired();
  await user.click(screen.getByRole('button', { name: 'Choose date for Date' }));
  expect(await screen.findByRole('grid', { name: 'septembre 2026' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(change).toHaveBeenLastCalledWith('', expect.objectContaining({ reason: 'day-press' }));
  await user.click(screen.getByRole('button', { name: 'Choose date for Date' }));
  await user.click(await screen.findByRole('button', { name: 'Today' }));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Kiritimati',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  expect(change).toHaveBeenLastCalledWith(`${part('year')}-${part('month')}-${part('day')}`, expect.anything());
  view.rerender(<DateField id="date" value="" onChange={change} disabled />);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Choose date' })).toBeDisabled();
});

test('changed bounds retain a day tab stop; malformed draft bounds disable selection without throwing', async () => {
  const user = userEvent.setup();
  const props = { id: 'date', value: '2026-09-13', onChange: vi.fn(), locale: 'en-US' };
  const view = render(<DateField {...props} />);
  await user.click(screen.getByRole('button', { name: 'Choose date' }));
  await screen.findByRole('grid');
  view.rerender(<DateField {...props} min="2026-10-01" />);
  await waitFor(() => expect(day('Thursday, October 1, 2026')).toHaveAttribute('tabindex', '0'));
  expect(screen.getByRole('grid').querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  view.rerender(<DateField {...props} min="2026-10-" />);
  expect(screen.getByRole('button', { name: 'Choose date' })).toBeDisabled();
  expect(screen.getByRole('textbox')).toBeInvalid();
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  view.rerender(<DateField {...props} min="2026-10-01" max="2026-09-01" />);
  expect(screen.getByRole('button', { name: 'Choose date' })).toBeDisabled();
});

test('composite blur observes the last typed value through the current callback', async () => {
  const user = userEvent.setup(),
    committed = vi.fn();
  function Draft() {
    const [value, setValue] = useState('');
    return (
      <>
        <DateField id="draft" value={value} onChange={setValue} onBlur={() => committed(value)} />
        <button>Leave</button>
      </>
    );
  }
  render(<Draft />);
  await user.type(screen.getByRole('textbox'), '2026-10-12');
  await user.click(screen.getByRole('button', { name: 'Leave' }));
  await waitFor(() => expect(committed).toHaveBeenCalledExactlyOnceWith('2026-10-12'));
});

test('Alt+Down opens from text entry and an outside click commits once', async () => {
  const user = userEvent.setup(),
    blur = vi.fn();
  render(<Field blur={blur} />);
  await user.click(screen.getByRole('textbox', { name: 'Due' }));
  await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
  await screen.findByRole('grid');
  expect(blur).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Outside' }));
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  await waitFor(() => expect(blur).toHaveBeenCalledTimes(1));
});

test('pointer selection of an adjacent month day does not replace the target before click', async () => {
  const user = userEvent.setup();
  render(<Field />);
  await user.click(screen.getByRole('button', { name: 'Choose date for Due' }));
  const adjacent = await screen.findByRole('gridcell', { name: 'Monday, August 31, 2026' });
  await user.pointer({ target: adjacent, keys: '[MouseLeft>]' });
  expect(adjacent.isConnected).toBe(true);
  expect(screen.getByRole('grid', { name: 'September 2026' })).toBeInTheDocument();
  await user.pointer({ keys: '[/MouseLeft]' });
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  expect(screen.getByRole('textbox', { name: 'Due' })).toHaveValue('08/31/2026');
});

test('outside Apply click sees the new composite blur value before submitting', async () => {
  const user = userEvent.setup(),
    submit = vi.fn();
  let applied = '';
  function Filter() {
    const [draft, setDraft] = useState('');
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(applied);
        }}
      >
        <DateField
          id="from"
          value={draft}
          onChange={setDraft}
          onBlur={() => {
            applied = draft;
          }}
        />
        <button type="submit">Show results</button>
      </form>
    );
  }
  render(<Filter />);
  await user.type(screen.getByRole('textbox'), '2026-11-04');
  const apply = screen.getByRole('button', { name: 'Show results' });
  // Preserve the browser's focusout→click ordering without a test helper's
  // timer delay accidentally letting a deferred commit win the race.
  fireEvent.blur(screen.getByRole('textbox'), { relatedTarget: apply });
  fireEvent.click(apply);
  expect(submit).toHaveBeenCalledExactlyOnceWith('2026-11-04');
});

test('selection restores focus before publishing a value that can unmount the field', async () => {
  const user = userEvent.setup(),
    selected = vi.fn();
  render(
    <DateField
      id="date"
      value="2026-09-13"
      locale="en-US"
      onChange={(value) => {
        selected(value, document.activeElement?.getAttribute('aria-label'));
      }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Choose date' }));
  await user.click(await screen.findByRole('gridcell', { name: 'Monday, September 14, 2026' }));
  expect(selected).toHaveBeenCalledExactlyOnceWith('2026-09-14', 'Choose date');
});

test('the day already chosen, pressed again, is chosen again and the calendar closes', async () => {
  const user = userEvent.setup(),
    change = vi.fn();
  render(<DateField id="date" value="2026-09-13" locale="en-US" onChange={change} />);
  const trigger = screen.getByRole('button', { name: 'Choose date' });
  await user.click(trigger);
  // The reader opened the calendar, saw the day was right, and said so: that is an answer, though no day changed.
  await user.click(await screen.findByRole('gridcell', { name: 'Sunday, September 13, 2026' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('2026-09-13', expect.objectContaining({ reason: 'day-press', source: 'pointer' }));
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
  await user.click(trigger);
  await waitFor(() => expect(day('Sunday, September 13, 2026')).toHaveFocus());
  await user.keyboard('{Enter}');
  expect(change).toHaveBeenCalledTimes(2);
  expect(change).toHaveBeenLastCalledWith('2026-09-13', expect.objectContaining({ reason: 'day-press', source: 'keyboard' }));
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
});

test('the box is described by how a date is typed and the key that opens the calendar', () => {
  render(<DateField id="date" value="" locale="en-US" onChange={() => {}} aria-describedby="own" />);
  const [own, hint] = screen.getByRole('textbox').getAttribute('aria-describedby')!.split(' ');
  expect(own).toBe('own');
  expect(document.getElementById(hint!)).toHaveTextContent('Date format: MM/DD/YYYY. Alt and Down arrow opens the calendar.');
});

test('a date and a time has a clock beside the text where the caller names one: it writes the time and keeps the date', () => {
  function Clocked({ start }: { start: string }) {
    const [value, setValue] = useState(start);
    return (
      <Drawn
        id="at"
        aria-label="At"
        value={value}
        onChange={setValue}
        withTime
        locale="en-US"
        now={new Date('2026-09-13T12:00:00Z')}
        timezone="UTC"
        words={{ ...words, time: (label) => (label ? `Time for ${label}` : 'Time') }}
        calendarIcon={<svg aria-hidden="true" />}
      />
    );
  }
  const { unmount } = render(<Clocked start="2026-09-13 09:30" />);
  const clock = screen.getByLabelText('Time for At');
  expect(clock).toHaveValue('09:30');
  fireEvent.change(clock, { target: { value: '14:05' } });
  expect(screen.getByRole('textbox', { name: 'At' })).toHaveValue('2026-09-13 14:05');
  unmount();
  // With no date yet the clock starts on today's; with no word for it, no clock is drawn.
  render(<Clocked start="" />);
  fireEvent.change(screen.getByLabelText('Time for At'), { target: { value: '08:00' } });
  expect(screen.getByRole('textbox', { name: 'At' })).toHaveValue('2026-09-13 08:00');
  cleanup();
  render(<Stamp />);
  expect(screen.queryByLabelText('Time for At')).toBeNull();
});
