import { act, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Calendar, type CalendarEvent } from '../src/Calendar';
import { all, clear, draw, focus, key } from './testing';

afterEach(clear);

const START: CalendarEvent[] = [
  { id: 'a', day: '2026-11-14', time: '09:00', title: 'Boiler' },
  { id: 'b', day: '2026-11-14', time: '11:30', title: 'Hob glass' },
  { id: 'c', day: '2026-11-14', time: '14:00', title: 'Extractor' },
  { id: 'd', day: '2026-11-14', time: '15:30', title: 'Lock' },
  { id: 'e', day: '2026-11-17', title: 'Move-in', fixed: true },
];

function Visits({ heard, added }: { heard?: string[]; added?: string[] }) {
  const [events, setEvents] = useState(START);
  return (
    <Calendar
      label="Visits"
      events={events}
      today="2026-11-14"
      accepts={(_event, day) => day >= '2026-11-14'}
      onAdd={(day) => added?.push(day)}
      onMove={(event, day) => {
        heard?.push(`${event.id} to ${day}`);
        setEvents((now) => now.map((one) => (one.id === event.id ? { ...one, day } : one)));
      }}
    />
  );
}

const cell = (day: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-day="${day}"]`)!;
const on = () => document.activeElement?.closest('[role="gridcell"]')?.getAttribute('data-day');
const title = () => document.querySelector('[data-slot="month-head"] h2')?.textContent;
const active = () => document.activeElement as HTMLElement;

test('a month is whole weeks, Monday first, with one stop for the keyboard on today', () => {
  draw(<Visits />);
  expect(title()).toBe('November 2026');
  const days = all('gridcell').map((day) => day.getAttribute('data-day'));
  expect(days.length).toBe(42);
  expect([days[0], days[41]]).toEqual(['2026-10-26', '2026-12-06']);
  expect(
    all('gridcell')
      .filter((day) => day.tabIndex === 0)
      .map((day) => day.getAttribute('data-day')),
  ).toEqual(['2026-11-14']);
  expect(cell('2026-11-14').querySelector('[data-slot="month-day"]')?.textContent).toBe('Saturday, November 14, 4 things');
  expect(cell('2026-11-14').getAttribute('aria-current')).toBe('date');
});

/* A month's cells are not there until it is drawn, so the keyboard follows a day into another month a frame later. */
const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

test('arrows walk days and weeks, Home and End a week, and a page key turns the month', async () => {
  draw(<Visits />);
  focus(cell('2026-11-14'));
  key(active(), 'ArrowRight');
  expect(on()).toBe('2026-11-15');
  key(active(), 'ArrowDown');
  expect(on()).toBe('2026-11-22');
  key(active(), 'Home');
  expect(on()).toBe('2026-11-16');
  key(active(), 'End');
  expect(on()).toBe('2026-11-22');
  key(active(), 'PageDown');
  await frame();
  expect([title(), on()]).toEqual(['December 2026', '2026-12-22']);
  // A day another month is too short for lands on that month's last.
  key(active(), 'PageUp');
  await frame();
  key(active(), 'PageUp');
  await frame();
  focus(cell('2026-10-31'));
  key(active(), 'PageDown');
  await frame();
  expect([title(), on()]).toEqual(['November 2026', '2026-11-30']);
});

test('Enter goes into a day and Escape comes back out; a day that holds nothing is added to', () => {
  const added: string[] = [];
  draw(<Visits added={added} />);
  focus(cell('2026-11-14'));
  key(active(), 'Enter');
  expect(active().textContent).toContain('Boiler');
  key(active(), 'ArrowDown');
  expect(active().textContent).toContain('Hob glass');
  key(active(), 'Escape');
  expect(active()).toBe(cell('2026-11-14'));
  focus(cell('2026-11-20'));
  key(active(), 'Enter');
  expect(added).toEqual(['2026-11-20']);
});

test('Alt with an arrow takes a thing a day or a week on, and the keyboard goes with it', () => {
  const heard: string[] = [];
  draw(<Visits heard={heard} />);
  focus(cell('2026-11-14'));
  key(active(), 'Enter');
  key(active(), 'ArrowRight', { altKey: true });
  expect(heard).toEqual(['a to 2026-11-15']);
  expect([active().textContent, on()]).toEqual(['9:00 AMBoiler', '2026-11-15']);
  key(active(), 'ArrowDown', { altKey: true });
  expect(on()).toBe('2026-11-22');
});

test('a day that will not take a thing is not asked, and a thing that is fixed does not move', () => {
  const heard: string[] = [];
  draw(<Visits heard={heard} />);
  focus(cell('2026-11-14'));
  key(active(), 'Enter');
  key(active(), 'ArrowLeft', { altKey: true });
  expect([heard, on()]).toEqual([[], '2026-11-14']);
  focus(cell('2026-11-17'));
  key(active(), 'Enter');
  key(active(), 'ArrowRight', { altKey: true });
  expect([heard, on()]).toEqual([[], '2026-11-17']);
});

test('a day shows its first three and says how many more', () => {
  draw(<Visits />);
  const day = cell('2026-11-14');
  expect([...day.querySelectorAll('li:not([hidden]) [data-slot="month-event"]')].map((one) => one.textContent)).toEqual([
    '9:00 AMBoiler',
    '11:30 AMHob glass',
    '2:00 PMExtractor',
  ]);
  expect(day.querySelector('[data-slot="month-more"]')?.textContent).toBe('+1 more');
});

test('Today comes back to today from another month', () => {
  draw(<Visits />);
  const press = (name: string) =>
    act(() =>
      [...document.querySelectorAll('button')]
        .find((button) => (button.getAttribute('aria-label') ?? button.textContent) === name)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
  press('Next month');
  press('Next month');
  expect(title()).toBe('January 2027');
  press('Today');
  expect(title()).toBe('November 2026');
  expect(
    all('gridcell')
      .filter((day) => day.tabIndex === 0)
      .map((day) => day.getAttribute('data-day')),
  ).toEqual(['2026-11-14']);
});
