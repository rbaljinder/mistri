/**
 * The stock sparkline's examples: one SKU running down over the month and
 * one restocked, each in a grid cell, and a record's field, which draws the
 * figure alone. Storybook draws each as a story; StockSparkline.test.tsx
 * checks them.
 */
import { example, examples, fixtures } from '@mistriwork/mistri/ui/testing';
import { stockSparkline } from '../components.ts';
import StockSparkline from './StockSparkline.tsx';

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
/* The ledger's closing counts: SKU 1 picked down from 40 to 6, SKU 2 restocked from 3 to 60. */
const movements = [
  ...[
    [28, 40],
    [21, 31],
    [14, 22],
    [7, 12],
    [2, 6],
  ].map(([back, count], i) => ({ id: i + 1, product_id: 1, moved_at: `${day(back)}T15:00:00Z`, on_hand_after: count })),
  ...[
    [25, 3],
    [12, 2],
    [4, 60],
  ].map(([back, count], i) => ({ id: i + 20, product_id: 2, moved_at: `${day(back)}T15:00:00Z`, on_hand_after: count })),
];

export default examples(StockSparkline, stockSparkline, { data: fixtures({ stock_movement: movements }) });

/** Falling toward its reorder point, in a grid cell. */
export const Falling = example({
  width: 160,
  record: { id: 1 },
  props: { value: 6, context: 'grid', column: { name: 'on_hand', resource: 'product' } },
});
/** Restocked this week, in a grid cell, in the dark. */
export const Restocked = example({
  width: 160,
  mode: 'dark',
  record: { id: 2 },
  props: { value: 60, context: 'grid', column: { name: 'on_hand', resource: 'product' } },
});
/** A record's field: the figure alone. */
export const Field = example({ width: 160, props: { value: 6, context: 'record', column: { name: 'on_hand', resource: 'product' } } });
