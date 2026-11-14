import { act } from 'react';
import { afterEach, expect, test } from 'vitest';
import { DayPicker } from '../src/DayPicker';
import { clear, draw, focus, key } from './testing';

afterEach(clear);

/* The Days behavior, through the thing composed on it that is not the calendar: a day chosen from a month. */

const cell = (day: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-day="${day}"]`)!;
const active = () => document.activeElement as HTMLElement;
const on = () => active().dataset.day;
const title = () => document.querySelector('[data-slot="day-picker-head"] h3')!.textContent;
const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

function Picker({ chosen = [] as string[] }) {
  return (
    <DayPicker
      label="A day to visit"
      defaultMonth="2026-11"
      today="2026-11-14"
      min="2026-11-10"
      max="2026-12-20"
      unavailable={(day) => day === '2026-11-17'}
      note={(day) => (day === '2026-11-16' ? '3 free' : null)}
      onValueChange={(day) => chosen.push(day)}
    />
  );
}

test('the grid is one stop in the Tab order: today, where the month holds it', () => {
  draw(<Picker />);
  const stops = [...document.querySelectorAll('[role="gridcell"]')].filter((one) => one.getAttribute('tabindex') === '0');
  expect(stops.map((one) => (one as HTMLElement).dataset.day)).toEqual(['2026-11-14']);
  expect(cell('2026-11-14').getAttribute('aria-current')).toBe('date');
  expect(document.querySelector('[role="grid"]')!.getAttribute('aria-label')).toBe('A day to visit, November 2026');
});

test('arrows walk days and weeks, and stop at the first and last day there is', () => {
  draw(<Picker />);
  focus(cell('2026-11-14'));
  key(active(), 'ArrowRight');
  expect(on()).toBe('2026-11-15');
  key(active(), 'ArrowDown');
  expect(on()).toBe('2026-11-22');
  key(active(), 'Home');
  expect(on()).toBe('2026-11-16');
  // The first day that can be had is the 10th: a week up from the 16th stops there.
  key(active(), 'ArrowUp');
  expect(on()).toBe('2026-11-10');
  key(active(), 'ArrowLeft');
  expect(on()).toBe('2026-11-10');
});

test('a page key turns the month and the keyboard goes with the day', async () => {
  draw(<Picker />);
  focus(cell('2026-11-14'));
  key(active(), 'PageDown');
  await frame();
  expect([title(), on()]).toEqual(['December 2026', '2026-12-14']);
  // Past the last day there is, it stops on the last.
  key(active(), 'PageDown');
  await frame();
  expect([title(), on()]).toEqual(['December 2026', '2026-12-20']);
});

test('Enter, Space and a press choose a day; one that cannot be had is walked over and not chosen', () => {
  const chosen: string[] = [];
  draw(<Picker chosen={chosen} />);
  focus(cell('2026-11-16'));
  key(active(), 'Enter');
  expect(chosen).toEqual(['2026-11-16']);
  expect(cell('2026-11-16').getAttribute('aria-selected')).toBe('true');
  expect(cell('2026-11-16').textContent).toContain('chosen');
  key(active(), 'ArrowRight');
  expect(on()).toBe('2026-11-17');
  expect(active().getAttribute('aria-disabled')).toBe('true');
  expect(active().textContent).toContain('not available');
  key(active(), 'Enter');
  key(active(), ' ');
  expect(chosen).toEqual(['2026-11-16']);
  press(cell('2026-11-17'));
  expect(chosen).toEqual(['2026-11-16']);
  press(cell('2026-11-18'));
  expect(chosen).toEqual(['2026-11-16', '2026-11-18']);
});

test('the buttons turn the month, keep a stop in the Tab order, and stop at the months there are', () => {
  draw(<Picker />);
  const [before, after] = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="day-picker-head"] button')];
  expect(before!.disabled).toBe(true);
  press(after!);
  expect(title()).toBe('December 2026');
  const stops = [...document.querySelectorAll('[role="gridcell"]')].filter((one) => one.getAttribute('tabindex') === '0');
  expect(stops.map((one) => (one as HTMLElement).dataset.day)).toEqual(['2026-12-14']);
  expect(after!.disabled).toBe(true);
});
