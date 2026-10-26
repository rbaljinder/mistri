import { afterEach, expect, test } from 'vitest';
import { installShell } from '../shellMode.js';
import { dueOpen } from './dueOpen.js';

afterEach(() => installShell({ app: () => null, inApp: () => false }));

test("a resource's machine says open: any state that is not final", () => {
  const machine = {
    column: 'status',
    path: [],
    states: [
      { value: 'open', label: 'Open' },
      { value: 'closed', label: 'Closed', final: true as const },
    ],
  };
  installShell({ app: () => ({ resources: { ticket: { machine } } }) as never, inApp: () => true });
  expect(dueOpen('ticket', 'due_at', { status: 'open' })).toBe(true);
  expect(dueOpen('ticket', 'due_at', { status: 'closed' })).toBe(false);
  // The machine's column not fetched: not called overdue, and a done-like flag does not stand in for it.
  expect(dueOpen('ticket', 'deadline', { completed: false })).toBe(false);
  expect(dueOpen('ticket', 'deadline', {})).toBe(false);
  // Only a date named like a due date.
  expect(dueOpen('ticket', 'opened_at', { status: 'open' })).toBe(false);
});
