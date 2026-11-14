import { act, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { type TimedEvent, WeekCalendar } from '../src/WeekCalendar';
import { clear, draw, focus, key } from './testing';

afterEach(clear);

const START: TimedEvent[] = [
  { id: 'boiler', day: '2026-11-14', start: '09:00', end: '10:00', title: 'Boiler' },
  { id: 'hob', day: '2026-11-14', start: '11:30', end: '12:30', title: 'Hob glass' },
  { id: 'survey', day: '2026-11-15', start: '10:00', end: '11:00', title: 'Survey', fixed: true },
  { id: 'later', day: '2026-11-18', start: '10:00', end: '11:00', title: 'Next week' },
];
function Week({ heard }: { heard: string[] }) {
  const [events, setEvents] = useState(START);
  return (
    <WeekCalendar
      label="Visits"
      events={events}
      today="2026-11-14"
      onChange={(event, when) => {
        heard.push(`${event.id} ${when.day} ${when.start}-${when.end}`);
        setEvents((now) => now.map((each) => (each.id === event.id ? { ...each, ...when } : each)));
      }}
    />
  );
}
const blocks = () => [...document.querySelectorAll<HTMLElement>('[data-kind="week-event"]')];
const block = (title: string) => blocks().find((each) => each.textContent?.includes(title))!;
const active = () => document.activeElement as HTMLElement;
const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/* What a pointer carries and pulls is run in a real browser; this is the keyboard's part. */
test('a week shows its own seven days, Monday first, and says each thing with its day and its times', () => {
  draw(<Week heard={[]} />);
  expect(document.querySelector('[data-slot="week"] h2')?.textContent).toBe('Nov 9 – Nov 15, 2026');
  expect(blocks().map((each) => each.textContent)).toEqual([
    '9:00 AMBoilerSaturday, until 10:00 AM',
    '11:30 AMHob glassSaturday, until 12:30 PM',
    '10:00 AMSurveySunday, until 11:00 AM',
  ]);
  expect(blocks().filter((each) => each.tabIndex === 0).length).toBe(1);
});

test('Alt with Up or Down moves a thing a quarter of an hour, and with Shift its end', () => {
  const heard: string[] = [];
  draw(<Week heard={heard} />);
  focus(block('Hob glass'));
  key(active(), 'ArrowDown', { altKey: true });
  key(active(), 'ArrowDown', { altKey: true, shiftKey: true });
  expect(heard).toEqual(['hob 2026-11-14 11:45-12:45', 'hob 2026-11-14 11:45-13:00']);
});

test('Alt with Left or Right takes a thing to the day beside, and the keyboard goes with it', async () => {
  const heard: string[] = [];
  draw(<Week heard={heard} />);
  focus(block('Boiler'));
  key(active(), 'ArrowRight', { altKey: true });
  await frame();
  expect(heard).toEqual(['boiler 2026-11-15 09:00-10:00']);
  expect(active().textContent).toBe('9:00 AMBoilerSunday, until 10:00 AM');
});

test('a thing that is fixed keeps its time and its day', () => {
  const heard: string[] = [];
  draw(<Week heard={heard} />);
  focus(block('Survey'));
  key(active(), 'ArrowDown', { altKey: true });
  key(active(), 'ArrowLeft', { altKey: true });
  expect(heard).toEqual([]);
});
