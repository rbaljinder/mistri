import { toast } from '@ui-sdk/react/toast';
import { useState } from 'react';
import { Gantt, type GanttTask } from '../../src';

/* Lintel's planned works as a Gantt. The days are made from today, so the room always opens with work in
   progress. A bar is carried to move its days or pulled from an end to move one; the inspection keeps its day. */
const NOW = new Date();
const from = (days: number): string =>
  new Date(Date.UTC(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days)).toISOString().slice(0, 10);
const TODAY = from(0);

const START: GanttTask[] = [
  { id: 'w1', label: 'Roof membrane, Alder Court', start: from(-6), end: from(4), progress: 0.6 },
  { id: 'w2', label: 'Boiler replacement, AC-204', start: from(-1), end: from(2), tone: 'critical', progress: 0.3 },
  { id: 'w3', label: 'Stairwell repaint, Birch House', start: from(3), end: from(11) },
  { id: 'w4', label: 'Fire door inspection', start: from(6), end: from(6), tone: 'warning', fixed: true },
  { id: 'w5', label: 'Window seals, Cedar Mews', start: from(9), end: from(20) },
  { id: 'w6', label: 'Courtyard lighting', start: from(14), end: from(18), tone: 'good' },
  { id: 'w7', label: 'Gutter clearing, all buildings', start: from(-12), end: from(-9), tone: 'neutral', progress: 1 },
];

export function Works() {
  const [tasks, setTasks] = useState(START);
  const place = (id: string, days: { start: string; end: string }) =>
    setTasks((now) => now.map((task) => (task.id === id ? { ...task, ...days } : task)));
  return (
    <div data-part="today">
      <header data-slot="list-head">
        <h1>
          Planned works <span data-slot="list-count">{tasks.length}</span>
        </h1>
      </header>
      <Gantt
        label="Planned works"
        tasks={tasks}
        today={TODAY}
        from={from(-14)}
        to={from(35)}
        onOpen={(task) => toast(`${task.label} would open here`)}
        onChange={(task, days) => {
          place(task.id, days);
          toast.success(`${task.label} moved`, {
            action: { label: 'Undo', onAction: () => place(task.id, { start: task.start, end: task.end }) },
          });
        }}
      />
    </div>
  );
}
