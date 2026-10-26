/**
 * The ordering model every hand-arranged run shares — a board's lane and a
 * list with an `order` column: where a menu's place puts a record, the
 * fewest writes that give it that place, and the writes saved in order,
 * stopping at the first that does not apply.
 */
import { describe, expect, it, vi } from 'vitest';
import { STEP, placeIndex, placements, positionOf, savePlaces, wholeColumn } from './placeOrder.js';

const at = (id: string, position?: number) => ({ id, ...(position === undefined ? {} : { position }) });

describe("a record's place", () => {
  it('is halfway between its new neighbors, a step past either end, and nothing when it is already there', () => {
    const run = [at('a', 1024), at('b', 2048), at('c', 3072)];
    expect(placements(at('d', 9000), run, 1, false)).toEqual([[at('d', 9000), 1536]]);
    expect(placements(at('d', 9000), run, 0, false)).toEqual([[at('d', 9000), 0]]);
    expect(placements(at('d', 9000), run, 3, false)).toEqual([[at('d', 9000), 4096]]);
    expect(placements(at('d', 1536), run, 1, false)).toEqual([]);
    // Alone in its run it takes the first step.
    expect(placements(at('d', 5), [], 0, true)).toEqual([[at('d', 5), STEP]]);
  });

  it('renumbers the run a step apart only when no number is left between, skipping those already on theirs', () => {
    // Whole numbers side by side.
    expect(placements(at('c', 9), [at('a', 1), at('b', 2)], 1, true)).toEqual([
      [at('a', 1), 1024],
      [at('c', 9), 2048],
      [at('b', 2), 3072],
    ]);
    // A fraction has room where whole numbers do not.
    expect(placements(at('c', 9), [at('a', 1), at('b', 2)], 1, false)).toEqual([[at('c', 9), 1.5]]);
    // A neighbor with no place yet: the run is numbered, and a record already on its number is left alone.
    expect(placements(at('c', 9), [at('a', 1024), at('b')], 2, false)).toEqual([
      [at('b'), 2048],
      [at('c', 9), 3072],
    ]);
  });

  it('reads a stored place as a number, and nothing else as one', () => {
    expect(positionOf(3)).toBe(3);
    expect(positionOf('1536.5')).toBe(1536.5);
    for (const value of [null, undefined, '', ' ', 'first', Number.NaN]) expect(positionOf(value)).toBeUndefined();
    expect(wholeColumn('INTEGER')).toBe(true);
    expect(wholeColumn('bigserial')).toBe(true);
    expect(wholeColumn('REAL')).toBe(false);
    expect(wholeColumn(undefined)).toBe(false);
  });
});

describe("a menu's places", () => {
  const ids = ['a', 'b', 'c'];
  it('name the index among the others as they will be, and leave out where the record already stands', () => {
    expect(placeIndex(ids, 'b', 'up')).toBe(0);
    expect(placeIndex(ids, 'b', 'down')).toBe(2);
    expect(placeIndex(ids, 'c', 'top')).toBe(0);
    expect(placeIndex(ids, 'a', 'bottom')).toBe(2);
    expect(placeIndex(ids, 'a', 'up')).toBeUndefined();
    expect(placeIndex(ids, 'a', 'top')).toBeUndefined();
    expect(placeIndex(ids, 'c', 'down')).toBeUndefined();
    expect(placeIndex(ids, 'missing', 'top')).toBeUndefined();
  });
});

describe('saving the places', () => {
  it('writes in order, one at a time, and stops at the first that does not apply', async () => {
    const order: string[] = [];
    const write = vi.fn(async (item: { id: string }) => {
      order.push(item.id);
      return item.id === 'b' ? { message: 'Locked', refused: true } : null;
    });
    const result = await savePlaces(
      [
        [at('a'), 1],
        [at('b'), 2],
        [at('c'), 3],
      ],
      write,
      () => true,
    );
    expect(order).toEqual(['a', 'b']);
    expect(result).toEqual({ applied: 1, failed: { message: 'Locked', refused: true }, stale: false });
  });

  it('stops, and says so, once the page it was asked from has gone', async () => {
    let current = true;
    const write = vi.fn(async () => {
      current = false;
      return null;
    });
    expect(
      await savePlaces(
        [
          [at('a'), 1],
          [at('b'), 2],
        ],
        write,
        () => current,
      ),
    ).toEqual({ applied: 0, stale: true });
    expect(write).toHaveBeenCalledOnce();
  });
});
