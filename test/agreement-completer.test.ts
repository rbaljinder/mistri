/**
 * The database browser's completer, held to the server's reading of the language: what it offers after a column is
 * what shared/schema.ts calls a date, and the tables it offers after `any` are the ones the parser finds a reference
 * from. The kit's own readings are test/agreement.test.ts, over the same fixture (test/support/agreementFixture.ts).
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeDate } from '../packages/engine/src/shared/schema.js';
import { parseViewQuery } from '../packages/engine/src/shared/view.js';
import { named, SCHEMA, stubDom } from './support/agreementFixture.js';

type Client = {
  core: typeof import('../packages/kit/src/client/core.js');
  complete: typeof import('../packages/tablewalk/src/client/complete.js');
};

let client: Client;

before(async () => {
  stubDom();
  client = {
    core: await import('../packages/kit/src/client/core.js'),
    complete: await import('../packages/tablewalk/src/client/complete.js'),
  };
  /* The completer reads the one schema out of core's module-level `state`. */
  client.core.state.schema = SCHEMA;
});

describe('the completer offers relative dates', () => {
  test('the completer offers relative dates on exactly the date columns', () => {
    /* End to end through the suggester rather than at its date test, because
       the copy that had drifted was inside it. Every column of the wide
       fixture is typed into the bar and the suggestions inspected: an offer of
       `= last 30 days` has to line up with what shared/schema.ts calls a date,
       column by column. */
    for (const column of named('work_order').columns) {
      const text = `work_order ${column.name} `;
      const suggestions = client.complete.suggestionsFor(text, text.length) as Array<{ detail: string }>;
      const offersDates = suggestions.some((s) => s.detail === 'date range');
      assert.equal(
        offersDates,
        looksLikeDate(column),
        `work_order.${column.name} (${column.type}): completer ${offersDates ? 'offers' : 'withholds'} relative dates`,
      );
    }
  });
});

describe('the completer offers the rows that point here as the parser reads them', () => {
  /* `customer any …`: the tables offered after `any` are the ones the parser
     finds a reference from, `via` only where it needs one, and after `where`
     the child's own columns — never the record's, which the parser would
     refuse inside the child's condition. */
  const offered = (text: string) => (client.complete.suggestionsFor(text, text.length) as Array<{ value: string }>).map((s) => s.value);
  test('after any, the tables that point here; then where; then their columns', () => {
    const children = offered('customer any ');
    assert.deepEqual([...children].sort(), ['invoice', 'work_order']);
    for (const child of children) assert.deepEqual(parseViewQuery(SCHEMA, 'customer', `any ${child}`).errors, [], child);
    assert.deepEqual(offered('customer any invoice '), ['where']);
    const columns = offered('customer any invoice where ');
    assert.ok(columns.includes('total') && !columns.includes('name'), columns.join(', '));
    assert.deepEqual(parseViewQuery(SCHEMA, 'customer', `any invoice where ${columns[0]} is empty`).errors, []);
    // Out of the child's condition, the record's own columns again.
    assert.ok(offered('customer any invoice where total > 5 and ').includes('name'));
  });
});
