import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Gantt, type GanttTask } from '../src/Gantt';
import { clear, draw, focus, key } from './testing';

afterEach(clear);

const START: GanttTask[] = [
  { id: 'roof', label: 'Roof membrane', start: '2026-11-08', end: '2026-11-18' },
  { id: 'boiler', label: 'Boiler', start: '2026-11-13', end: '2026-11-16' },
  { id: 'inspection', label: 'Fire door inspection', start: '2026-11-20', end: '2026-11-20', fixed: true },
];
function Works({ heard, opened }: { heard: string[]; opened?: string[] }) {
  const [tasks, setTasks] = useState(START);
  return (
    <Gantt
      label="Planned works"
      tasks={tasks}
      from="2026-11-01"
      to="2026-11-30"
      today="2026-11-14"
      onOpen={(task) => opened?.push(task.id)}
      onChange={(task, days) => {
        heard.push(`${task.id} ${days.start} ${days.end}`);
        setTasks((now) => now.map((each) => (each.id === task.id ? { ...each, ...days } : each)));
      }}
    />
  );
}
const bars = () => [...document.querySelectorAll<HTMLElement>('[data-kind="gantt-bar"]')];
const active = () => document.activeElement as HTMLElement;
const on = () => active().getAttribute('aria-label');

/* What a pointer carries and pulls is run in a real browser; this is the keyboard's part. */
test('a bar says its task, its days and how long, and the bars are one stop', () => {
  draw(<Works heard={[]} />);
  expect(bars().map((bar) => bar.getAttribute('aria-label'))).toEqual([
    'Roof membrane, Nov 8 to Nov 18, 11 days',
    'Boiler, Nov 13 to Nov 16, 4 days',
    'Fire door inspection, Nov 20, 1 day',
  ]);
  expect(bars().filter((bar) => bar.tabIndex === 0).length).toBe(1);
  // The same days are written beside each name, for a reader who does not read a bar's length.
  expect([...document.querySelectorAll('[data-slot="gantt-name"] span')].map((line) => line.textContent)).toEqual([
    'Nov 8 to Nov 18',
    'Nov 13 to Nov 16',
    'Nov 20',
  ]);
});

test('Alt with an arrow moves a task a day, and with Shift moves its last day', () => {
  const heard: string[] = [];
  draw(<Works heard={heard} />);
  focus(bars()[1]!);
  key(active(), 'ArrowRight', { altKey: true });
  expect([heard, on()]).toEqual([['boiler 2026-11-14 2026-11-17'], 'Boiler, Nov 14 to Nov 17, 4 days']);
  key(active(), 'ArrowRight', { altKey: true, shiftKey: true });
  expect(on()).toBe('Boiler, Nov 14 to Nov 18, 5 days');
  key(active(), 'ArrowLeft', { altKey: true, shiftKey: true });
  key(active(), 'ArrowLeft', { altKey: true });
  expect(on()).toBe('Boiler, Nov 13 to Nov 16, 4 days');
});

test('a task cannot be made shorter than a day, and one that is fixed keeps its days', () => {
  const heard: string[] = [];
  draw(<Works heard={heard} />);
  focus(bars()[2]!);
  key(active(), 'ArrowRight', { altKey: true });
  key(active(), 'ArrowLeft', { altKey: true, shiftKey: true });
  expect([heard, on()]).toEqual([[], 'Fire door inspection, Nov 20, 1 day']);
});

test('Enter opens a task', () => {
  const opened: string[] = [];
  draw(<Works heard={[]} opened={opened} />);
  focus(bars()[0]!);
  key(active(), 'Enter');
  expect(opened).toEqual(['roof']);
});
