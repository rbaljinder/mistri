/**
 * The save that did not load: its place, its code, its words and the lines
 * around it, said as one alert over a page that stays usable, and put away by
 * the author's Dismiss.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { AppReloadProblem } from './AppReloadProblem.js';
import type { AppLoadProblem } from '../../shared/appPayload.js';

afterEach(cleanup);

const problem: AppLoadProblem = {
  code: 'unknown-column',
  message: 'views "tasks" shows "titel", which is not a column of task.',
  file: 'views.ts',
  line: 5,
  column: 9,
  frame: [
    { line: 3, text: "  table: 'task'," },
    { line: 4, text: "  label: 'Tasks'," },
    { line: 5, text: "  show: ['titel']," },
    { line: 6, text: '};' },
  ],
  docs: 'https://mistriwork.dev/docs/check-codes/#unknown-column',
};

test('it names the file, line and code, says the message, and marks the line at fault', () => {
  render(<AppReloadProblem problem={problem} onDismiss={() => {}} />);
  const alert = screen.getByRole('alert', { name: 'The last save did not load' });
  expect(alert).toHaveTextContent('views.ts:5:9');
  expect(screen.getByRole('link', { name: 'unknown-column' })).toHaveAttribute('href', problem.docs);
  expect(alert).toHaveTextContent(problem.message);
  const frame = alert.querySelector('pre')!;
  expect(frame).toHaveAttribute('aria-label', 'Lines around views.ts:5');
  const lines = [...frame.querySelectorAll(':scope > span')];
  expect(lines.map((line) => line.textContent)).toEqual(["3  table: 'task',\n", "4  label: 'Tasks',\n", "5  show: ['titel'],\n", '6};\n']);
  expect(lines.filter((line) => line.classList.contains('is-at')).map((line) => line.textContent)).toEqual(["5  show: ['titel'],\n"]);
  expect(alert).toHaveTextContent('Still serving the last good save');
});

test('a problem with no place says its code and message, and draws no frame', () => {
  render(
    <AppReloadProblem
      problem={{ code: 'invalid-app', message: 'the app module did not finish loading within 10s', docs: 'x' }}
      onDismiss={() => {}}
    />,
  );
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('invalid-app');
  expect(alert.querySelector('code')).toBeNull();
  expect(alert.querySelector('pre')).toBeNull();
});

test('Dismiss is the author’s', async () => {
  const dismissed = vi.fn();
  render(<AppReloadProblem problem={problem} onDismiss={dismissed} />);
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(dismissed).toHaveBeenCalledOnce();
});
