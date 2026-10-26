/**
 * The stock sparkline, drawn as its stories draw it: the ledger's closing
 * counts carried across quiet days to today's figure, a fall said in the
 * warning tone, and a record's field left as the figure alone.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import { renderExample } from '@mistriwork/mistri/ui/testing';
import spark, { Falling, Field, Restocked } from './StockSparkline.examples.tsx';
import { dailyOnHand } from './StockSparkline.tsx';

test("carries each day's closing count across the days nothing moved", () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const days = dailyOnHand(
    new Map([
      ['2026-09-02', 10],
      ['2026-09-20', 4],
    ]),
    now,
  );
  expect(days).toHaveLength(30);
  expect(days[0]).toBeUndefined();
  expect(days.slice(1, 3)).toEqual([10, 10]);
  expect(days.at(-1)).toBe(4);
});

test('a falling SKU draws its month as a line in the warning tone, beside the figure', async () => {
  const view = renderExample(spark, Falling);
  const line = await view.findByRole('img', { name: 'Last 30 days: from 40 to 6' });
  expect(line.closest('.c-stock-sparkline')).toHaveAttribute('data-trend', 'down');
  expect(view.getByText('6')).toHaveClass('c-stock-sparkline-figure');
});

test('a restocked SKU is not a fall', async () => {
  const view = renderExample(spark, Restocked);
  expect((await view.findByRole('img', { name: /from 3 to 60/ })).closest('.c-stock-sparkline')).toHaveAttribute('data-trend', 'flat');
});

test("a record's field is the figure alone", () => {
  const view = renderExample(spark, Field);
  expect(view.queryByRole('img')).toBeNull();
  expect(view.getByText('6')).toBeInTheDocument();
});
