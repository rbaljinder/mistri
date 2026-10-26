/**
 * What clicking a column header does to the query.
 *
 * Sorting is expressed in the language rather than held as UI state, which
 * means a header click is a *text edit* — and the edit used to be done with a
 * regex that stripped `[\w.$]+` after the keyword. That is not what a sort
 * clause can contain, and the two things it cannot contain are exactly the two
 * that occur in this tool: a composite reference hop has a `+` in it, and a
 * sort can name more than one column.
 *
 * These tests pin the shape of the edit, including the cases that produced a
 * query the parser would reject.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addSort, nextSort, sortCount, sortDirection } from '../packages/kit/src/client/clauses.js';

describe('clicking a column header', () => {
  test('sorts by the column when nothing was sorted', () => {
    assert.equal(nextSort('customer', 'name'), 'customer sort name');
  });

  test('a second click on the same column reverses it', () => {
    assert.equal(nextSort('customer sort name', 'name'), 'customer sort name desc');
  });

  test('a third click goes back to ascending', () => {
    assert.equal(nextSort('customer sort name desc', 'name'), 'customer sort name');
  });

  test('a different column replaces the sort rather than adding one', () => {
    assert.equal(nextSort('customer sort name desc', 'email'), 'customer sort email');
  });

  test('the filter and the limit survive the edit', () => {
    assert.equal(nextSort('customer active = true sort name limit 50', 'email'), 'customer active = true sort email limit 50');
  });

  test('a composite reference hop is not torn in half', () => {
    /* The bug: the strip stopped at `invoice_id` because `+` was not in its
       character class, leaving the tail behind as `invoice +line_no.sku sort
       reference` — not a query, and not an error either. */
    assert.equal(nextSort('invoice sort invoice_id+line_no.sku', 'reference'), 'invoice sort reference');
  });

  test('a composite hop can itself be sorted by', () => {
    assert.equal(nextSort('shipment', 'invoice_id+line_no.sku'), 'shipment sort invoice_id+line_no.sku');
    // And reverses, which the old code could not do either: the column name
    // went into a RegExp, where `+` means "one or more" rather than "plus".
    assert.equal(nextSort('shipment sort invoice_id+line_no.sku', 'invoice_id+line_no.sku'), 'shipment sort invoice_id+line_no.sku desc');
  });

  test('a multi-field sort is replaced whole, not half-stripped', () => {
    /* `sort a, b` lost only `a`, leaving `invoice , b sort c`. Replacing the
       clause is also the honest answer to the click: reversing one column of
       a two-column sort is not something a single click can express. */
    assert.equal(nextSort('invoice sort total, id', 'reference'), 'invoice sort reference');
    assert.equal(nextSort('invoice sort total, id', 'total'), 'invoice sort total');
  });

  test('order by is understood as well as sort', () => {
    assert.equal(nextSort('invoice order by total', 'total'), 'invoice sort total desc');
  });

  test('an explicit direction is used as given, not toggled', () => {
    /* This is the "adopt the default order" path: the caller is writing down
       what is already happening, and flipping it would invert the very thing
       being adopted. */
    assert.equal(nextSort('ticket', 'opened_at', 'desc'), 'ticket sort opened_at desc');
    assert.equal(nextSort('ticket sort opened_at desc', 'opened_at', 'desc'), 'ticket sort opened_at desc');
    assert.equal(nextSort('ticket sort opened_at', 'opened_at', 'asc'), 'ticket sort opened_at');
  });

  test('a query written out of order comes back canonical', () => {
    // The one visible consequence of rebuilding from the parts, and the order
    // the language documents anyway.
    assert.equal(nextSort('customer limit 5 sort name', 'email'), 'customer sort email limit 5');
  });

  test('a keyword inside a value is not mistaken for the clause', () => {
    assert.equal(nextSort('customer name contains "sort code"', 'email'), 'customer name contains "sort code" sort email');
  });
});

describe('which way a column is sorted', () => {
  test('reports the direction, or nothing', () => {
    assert.equal(sortDirection('customer sort name', 'name'), 'asc');
    assert.equal(sortDirection('customer sort name desc', 'name'), 'desc');
    assert.equal(sortDirection('customer sort name', 'email'), null);
    assert.equal(sortDirection('customer', 'name'), null);
  });

  test('finds a column inside a multi-field sort', () => {
    assert.equal(sortDirection('invoice sort total desc, id', 'id'), 'asc');
    assert.equal(sortDirection('invoice sort total desc, id', 'total'), 'desc');
  });

  test('a composite hop is a name, not a pattern', () => {
    /* Interpolated into a RegExp, `invoice_id+line_no.sku` means "one or more
       `d`, then any character" — a question about a different column. */
    assert.equal(sortDirection('shipment sort invoice_id+line_no.sku', 'invoice_id+line_no.sku'), 'asc');
    assert.equal(sortDirection('shipment sort invoice_id+line_no.sku', 'invoice_i'), null);
  });

  test('a prefix of the sorted column is not a match', () => {
    assert.equal(sortDirection('customer sort credit_limit', 'credit'), null);
  });
});

describe('sorting by more than one column', () => {
  /* `sort a, b desc` was expressible in the language and unreachable by
     clicking: every header click replaced the whole clause. "By title, then by
     hire date" is an ordinary thing to want of a table. */
  test('adds a second column rather than replacing the first', () => {
    assert.equal(addSort('employee sort title', 'hired_on', 'asc'), 'employee sort title, hired_on');
    assert.equal(addSort('employee sort title', 'hired_on', 'desc'), 'employee sort title, hired_on desc');
  });

  test('starts a sort when there is none', () => {
    assert.equal(addSort('employee', 'title', 'asc'), 'employee sort title');
  });

  test('a column already sorted changes direction in place, and does not move', () => {
    /* Sort order is precedence. Re-prioritising the column somebody was only
       reversing would change the answer with nothing on screen to explain
       it. */
    assert.equal(addSort('employee sort title, hired_on', 'title', 'desc'), 'employee sort title desc, hired_on');
    assert.equal(addSort('employee sort title, hired_on desc', 'hired_on', 'asc'), 'employee sort title, hired_on');
  });

  test('the filter and the limit survive it', () => {
    assert.equal(
      addSort('employee title = "Sales Manager" sort title limit 50', 'hired_on', 'desc'),
      'employee title = "Sales Manager" sort title, hired_on desc limit 50',
    );
  });

  test('and a plain click still replaces, because one click cannot say which level', () => {
    assert.equal(nextSort('employee sort title, hired_on', 'last_name'), 'employee sort last_name');
  });

  test('sortCount says how many levels there are', () => {
    assert.equal(sortCount('employee'), 0);
    assert.equal(sortCount('employee sort title'), 1);
    assert.equal(sortCount('employee sort title, hired_on desc'), 2);
  });

  test('every level is readable afterwards', () => {
    const q = addSort(addSort('employee', 'title', 'asc'), 'hired_on', 'desc');
    assert.equal(q, 'employee sort title, hired_on desc');
    assert.equal(sortDirection(q, 'title'), 'asc');
    assert.equal(sortDirection(q, 'hired_on'), 'desc');
  });
});
