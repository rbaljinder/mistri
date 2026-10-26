/**
 * Pay history, drawn as the pay-run page draws it, over fixture runs: the
 * declared read answered with its own show, sort and limit, the current run
 * marked, a run opened as a peek, and the phone's list.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { fixtures, renderSection } from '@mistriwork/mistri/ui/testing';
import type { Rows } from '../mistri-schema.d.ts';
import { payHistory } from '../features/payroll.ts';
import PayrollTimeline from './PayrollTimeline.tsx';

const run = (id: number, title: string, start: string, end: string, paid: string, status: string) => ({
  id,
  title,
  period_start: start,
  period_end: end,
  pay_date: paid,
  status,
  reference: `PAY-${id}`,
});
const data = fixtures<Rows>(
  {
    pay_run: [
      run(1, 'August 1–15 payroll', '2026-08-01', '2026-08-15', '2026-08-18', 'paid'),
      run(2, 'August 16–31 payroll', '2026-08-16', '2026-08-31', '2026-09-04', 'paid'),
      run(3, 'September 1–15 payroll', '2026-09-01', '2026-09-15', '2026-09-18', 'review'),
    ],
  },
  { display: { 'pay_run.status': { tone: { draft: 'neutral', review: 'warn', approved: 'good', paid: 'info' } } } },
);
const record = { id: 3, title: 'September 1–15 payroll' };

test('places each run on the axis, oldest first, this run marked', () => {
  const view = renderSection(PayrollTimeline, payHistory, { data, record });
  const rule = view.getByRole('list', { name: 'Payroll runs by pay period' });
  const runs = within(rule).getAllByRole('button');
  expect(runs.map((button) => button.getAttribute('aria-label'))).toEqual([
    'August 1–15 payroll: Aug 1, 2026 to Aug 15, 2026, paid Aug 18, 2026',
    'August 16–31 payroll: Aug 16, 2026 to Aug 31, 2026, paid Sep 4, 2026',
    'September 1–15 payroll: Sep 1, 2026 to Sep 15, 2026, paid Sep 18, 2026',
  ]);
  expect(runs[2].closest('li')).toHaveAttribute('aria-current', 'true');
  expect(view.getByText(/3 runs/)).toBeInTheDocument();
});

test("opens a run as a peek through the platform's navigation", () => {
  const view = renderSection(PayrollTimeline, payHistory, { data, record });
  fireEvent.click(view.getByRole('button', { name: /^August 16–31 payroll/ }));
  expect(view.navigations).toEqual([{ kind: 'record', resource: 'pay_run', key: { id: 2 }, mode: 'drawer' }]);
});

test('is a list, newest first, each run with its stage, on a phone', () => {
  const view = renderSection(PayrollTimeline, payHistory, { data, record, width: 390, mode: 'dark' });
  const items = view.getAllByRole('listitem');
  expect(items.map((item) => within(item).getByRole('button').textContent)).toEqual([
    'September 1–15 payroll',
    'August 16–31 payroll',
    'August 1–15 payroll',
  ]);
  expect(within(items[0]).getByText('Review')).toHaveClass('tone', 'tone-warn');
  expect(items[0]).toHaveAttribute('aria-current', 'true');
});

test('says so when there is nothing to place', () => {
  const view = renderSection(PayrollTimeline, payHistory, { data: fixtures<Rows>({ pay_run: [] }), record });
  expect(view.getByText('No payroll runs to place yet.')).toBeInTheDocument();
});
