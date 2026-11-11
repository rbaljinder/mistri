/**
 * A choice read from a table (`field.choice({ from, labelColumn })`): the column it is shown by is `labelColumn`, as a
 * reference's is, so `label` is the field's own title; and the rows are offered in the order of that column unless the
 * field says `sort` (a field report: a form offered its rows by name, and the App wanted them by rank).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { choiceOrder } from '../packages/mistri/src/server/forms/choiceCache.js';

const parse = (input: object) => parseCommandInput(input, 'command "ask"', { publicForm: false });

test('labelColumn names the column and label is the field’s own title', () => {
  const [made] = parse({ make: field.choice({ from: 'make', labelColumn: 'name', label: 'Which make?' }) });
  assert.equal(made!.label, 'Which make?');
  assert.deepEqual((made as { source?: unknown }).source, { from: 'make', by: 'id', labelColumn: 'name' });
  const [bare] = parse({ make: field.choice({ from: 'make', labelColumn: 'name' }) });
  assert.equal(bare!.label, 'Make', 'the title is read from the key unless it is given');
});

test('label alone no longer names the column: the refusal says what to write', () => {
  assert.throws(
    () => parse({ make: field.choice({ from: 'make', label: 'name' } as never) }),
    /needs labelColumn[^]*label is the field's own title/,
  );
});

test('sort is a column and a direction, kept on the source; the rows are in the label’s order without one', () => {
  const [many] = parse({ make: field.choices({ from: 'make', labelColumn: 'name', sort: { column: 'rank', direction: 'desc' } }) });
  assert.deepEqual((many as { source?: unknown }).source, {
    from: 'make',
    by: 'id',
    labelColumn: 'name',
    sort: { column: 'rank', direction: 'desc' },
  });
  const [one] = parse({ make: field.choice({ from: 'make', labelColumn: 'name', sort: { column: 'rank' } }) });
  assert.deepEqual((one as { source: { sort?: unknown } }).source.sort, { column: 'rank', direction: 'asc' });
  assert.deepEqual(choiceOrder({ labelColumn: 'name' }), [{ column: 'name', direction: 'asc' }]);
  assert.deepEqual(choiceOrder({ labelColumn: 'name', sort: { column: 'rank', direction: 'desc' } }), [
    { column: 'rank', direction: 'desc' },
  ]);
});

test('a sort that is not a column and a direction, or that has no table to read, is refused', () => {
  assert.throws(
    () => parse({ make: field.choice({ from: 'make', labelColumn: 'name', sort: { column: 'rank', direction: 'up' as never } }) }),
    /direction/,
  );
  assert.throws(
    () => parse({ make: field.choice({ from: 'make', labelColumn: 'name', sort: { direction: 'asc' } as never }) }),
    /sort\.column/,
  );
  assert.throws(() => parse({ make: field.choice(['a', 'b'], { sort: { column: 'rank' } } as never) }), /sort/);
});
