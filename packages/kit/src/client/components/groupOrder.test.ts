import { describe, expect, test } from 'vitest';
import { declaredOrder, isScale, orderDeclared } from './groupOrder.js';

describe('the order groups are read in', () => {
  const keys = (rows: Array<Record<string, unknown>>, key: string) => rows.map((row) => row[key]);

  test('a scale runs in its own order: an age histogram by its buckets, not its counts', () => {
    const ages = [
      { age_days: 0, count: 13 },
      { age_days: 1, count: 11 },
      { age_days: 6, count: 1 },
      { age_days: 3, count: 1 },
      { age_days: 2, count: 1 },
      { age_days: null, count: 4 },
    ];
    expect(keys(orderDeclared(ages, 'age_days', 'count', undefined, true), 'age_days')).toEqual([0, 1, 2, 3, 6, null]);
    // A month bucket is a scale too, read as the calendar reads.
    const months = [
      { month: '2026-09', n: 1 },
      { month: '2026-07', n: 9 },
      { month: '2026-08', n: 4 },
    ];
    expect(keys(orderDeclared(months, 'month', 'n', undefined, true), 'month')).toEqual(['2026-07', '2026-08', '2026-09']);
    // Not a scale, the same groups are read biggest first.
    const plain = [
      { month: 'b', n: 1 },
      { month: 'c', n: 9 },
      { month: 'a', n: 4 },
    ];
    expect(keys(orderDeclared(plain, 'month', 'n'), 'month')).toEqual(['c', 'a', 'b']);
  });

  test('a priority stored 1 to 5 and said Urgent to Planning reads in the order its display rule names', () => {
    const priority = { type: 'integer', primaryKey: false };
    const rule = { values: { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Planning' } };
    const order = declaredOrder(priority, rule, 'priority');
    expect(order).toEqual({ vocabulary: ['1', '2', '3', '4', '5'], scale: true });
    const counted = [
      { priority: 3, count: 13 },
      { priority: 4, count: 7 },
      { priority: 2, count: 4 },
      { priority: 5, count: 3 },
      { priority: 1, count: 1 },
    ];
    expect(keys(orderDeclared(counted, 'priority', 'count', order.vocabulary, order.scale), 'priority')).toEqual([1, 2, 3, 4, 5]);
  });

  test("an enum's options order its groups, and the schema's list wins over a rule's words; neither makes it a scale", () => {
    const stage = { type: 'text', primaryKey: false, allowed: ['qualify', 'discover', 'won', 'lost'] };
    expect(declaredOrder(stage, { values: { won: 'Won', qualify: 'Qualify' } }, 'stage')).toEqual({
      vocabulary: ['qualify', 'discover', 'won', 'lost'],
      scale: false,
    });
    expect(declaredOrder({ type: 'text', primaryKey: false }, null, 'source')).toEqual({ scale: false });
  });

  test('a number is a scale unless it is a key or a reference; a bucket of time always is', () => {
    expect(isScale({ type: 'numeric' }, 'age_days')).toBe(true);
    expect(isScale({ type: 'integer', primaryKey: true }, 'id')).toBe(false);
    expect(isScale({ type: 'integer', references: { table: 'person', column: 'id' } }, 'owner_id')).toBe(false);
    expect(isScale({ type: 'text' }, 'source')).toBe(false);
    expect(isScale(undefined, 'month opened_at')).toBe(true);
    expect(isScale(undefined, 'weekday created_at')).toBe(true);
    // A reference's display words are not a declared order: its keys are ids.
    expect(declaredOrder({ type: 'integer', references: { table: 't', column: 'id' } }, { values: { 1: 'One' } }, 'x')).toEqual({
      scale: false,
    });
  });
});
