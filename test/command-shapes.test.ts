/**
 * Output shapes: each builder's value, what it refuses, and that `shape`
 * projects — the receipt keeps the declared keys and nothing else.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bool,
  date,
  id,
  int,
  list,
  literal,
  nullable,
  number,
  oneOf,
  optional,
  shape,
  text,
  type ShapeOf,
} from '../packages/mistri/src/server/commands/commandShapes.js';

test('scalars accept their own kind and refuse the rest', () => {
  assert.equal(text({ max: 3, pattern: /^[a-z]+$/g }).parse('abc'), 'abc');
  // A global pattern keeps no position between parses.
  const lower = text({ pattern: /^[a-z]+$/g });
  assert.equal(lower.parse('abc'), 'abc');
  assert.equal(lower.parse('abc'), 'abc');
  for (const [shaped, bad] of [
    [text({ max: 3 }), 'abcd'],
    [text(), 3],
    [int(), 1.5],
    [int({ min: 1 }), 0],
    [number(), Infinity],
    [number({ max: 1 }), 2],
    [id(), 0],
    [id(), '1'],
    [bool(), 'true'],
    [date(), '2026-02-30'],
    [date(), '2026-2-3'],
    [literal('a', 'b'), 'c'],
    [literal(1), '1'],
  ] as const) {
    assert.throws(() => shaped.parse(bad), /does not match its shape/, JSON.stringify(bad));
  }
  assert.equal(date().parse('2026-02-28'), '2026-02-28');
  assert.equal(literal(true, 'x').parse(true), true);
  assert.equal(nullable(int()).parse(null), null);
  assert.deepEqual(list(id(), { min: 1, max: 2 }).parse([1, 2]), [1, 2]);
  assert.throws(() => list(id(), { max: 1 }).parse([1, 2]), /does not match/);
});

test('shape projects its keys, requires the required, and oneOf takes the first that fits', () => {
  const result = shape({ leadId: id(), note: optional(text()), message: literal('Done.') });
  assert.deepEqual(result.parse({ leadId: 4, message: 'Done.', secret: 'PRIVATE' }), { leadId: 4, message: 'Done.' });
  assert.deepEqual(result.parse({ leadId: 4, note: 'n', message: 'Done.' }), { leadId: 4, note: 'n', message: 'Done.' });
  assert.throws(() => result.parse({ note: 'n', message: 'Done.' }), /expected an id/);
  assert.throws(() => result.parse([]), /expected an object/);
  const either = oneOf(shape({ id: id() }), shape({ ids: list(id()) }));
  assert.deepEqual(either.parse({ ids: [1, 2] }), { ids: [1, 2] });
  assert.throws(() => either.parse({ id: 'x' }), /fits none of its shapes/);
  // The type is the shape's: a required key, an optional one, and the literal kept.
  const typed: ShapeOf<typeof result> = { leadId: 1, message: 'Done.' };
  assert.ok(typed);
  assert.throws(() => shape({ bad: 3 as never }), /is not a shape/);
});
