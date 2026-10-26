/**
 * The filter boxes' condition grammar, pinned.
 *
 * conditions.js is a client-side reading of the query language — exactly
 * the kind of mirror CLAUDE.md says must be kept honest by tests. Its
 * first cut was regexes of its own and drifted three ways at once: a
 * multi-word date phrase was cut at its first token, a quoted value
 * containing a clause word had the new condition spliced into the string,
 * and removing one arm of an or-group orphaned the other behind a bare
 * `or`. Each of those repros lives here now, against the module itself —
 * it is pure, so node can run it without a browser.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mentionsColumn,
  ownedTails,
  canonicalize,
  conditionTail,
  hasShowClause,
  stripCondition,
  withCondition,
} from '../packages/kit/src/client/conditions.js';

describe('reading a condition out of the text', () => {
  test('a multi-word date phrase is one value, not its first token', () => {
    const text = 'due_on = last month and status = open';
    assert.equal(conditionTail(text, 'due_on'), '= last month');
    assert.equal(stripCondition(text, 'due_on'), 'status = open');
  });

  test('a quoted value keeps its insides, clause words and all', () => {
    const text = 'notes contains "no show" sort due_on';
    assert.equal(conditionTail(text, 'notes'), 'contains "no show"');
    assert.equal(hasShowClause(text), false);
    assert.equal(hasShowClause('status = open show id, name'), true);
  });

  test('emptiness predicates and equality both round-trip', () => {
    assert.equal(conditionTail('shipped_on is empty and line_no = 1', 'shipped_on'), 'is empty');
    assert.equal(conditionTail('shipped_on is empty and line_no = 1', 'line_no'), '= 1');
  });

  test('no box owns half of an or-group', () => {
    const tab = 'status = on_hold or status = awaiting_parts';
    assert.equal(conditionTail(tab, 'status'), '');
    // And stripping the column it cannot own must not destroy the group.
    assert.equal(stripCondition(tab, 'status'), tab);
  });
});

describe('writing a condition into the text', () => {
  test('joins with `and`, ahead of the trailing clauses', () => {
    assert.equal(
      withCondition('status = open show id, name sort due_on', 'is_urgent', '= true'),
      'status = open and is_urgent = true show id, name sort due_on',
    );
  });

  test('an or-group is parenthesised before it is narrowed', () => {
    /* `and` binds tighter than `or`: appending without the parens turns
       "on hold, urgent only" into "on_hold, or awaiting-parts-and-urgent" —
       a different question that looks almost right. */
    assert.equal(
      withCondition('status = on_hold or status = awaiting_parts', 'is_urgent', '= true'),
      '(status = on_hold or status = awaiting_parts) and is_urgent = true',
    );
  });

  test('replaces its own condition rather than stacking a second one', () => {
    assert.equal(withCondition('status = open and is_urgent = true', 'status', '= completed'), 'is_urgent = true and status = completed');
    assert.equal(withCondition('status = open', 'status', ''), '');
  });

  test('a value that is itself quoted survives the splice', () => {
    assert.equal(withCondition('notes contains "sort of urgent"', 'status', '= open'), 'notes contains "sort of urgent" and status = open');
  });
});

describe('one spelling for one question', () => {
  test('redundant outer parens do not make a different tab', () => {
    assert.equal(
      canonicalize('(status = on_hold or status = awaiting_parts) sort due_on'),
      canonicalize('status = on_hold or status = awaiting_parts sort due_on'),
    );
  });
});

describe('mentionsColumn — the "does this tab speak for that column" guard', () => {
  /* conditionTail deliberately refuses to own an or-group, which is right
     for a box reading its value back — but the tab-click guard asked it
     "does the On hold tab constrain status" and heard no, so the old tab's
     `status = open` was ANDed into `(status = on_hold or …)`: zero rows. */
  test('an or-group speaks for its column even though no box owns it', () => {
    assert.equal(mentionsColumn('status = on_hold or status = awaiting_parts', 'status'), true);
    assert.equal(conditionTail('status = on_hold or status = awaiting_parts', 'status'), '');
  });

  test('a different column, a quoted value, a dotted cousin: not mentions', () => {
    assert.equal(mentionsColumn('priority = 3', 'status'), false);
    assert.equal(mentionsColumn('note = "status = open"', 'status'), false);
    assert.equal(mentionsColumn('order.status = open', 'status'), false);
  });

  test('plain conditions and emptiness tests are mentions', () => {
    assert.equal(mentionsColumn('status = open and priority = 1', 'status'), true);
    assert.equal(mentionsColumn('due_on is empty', 'due_on'), true);
    assert.equal(mentionsColumn('due_on between 2026-01-01 and 2026-02-01', 'due_on'), true);
  });
});

describe('ownedTails — every condition a column holds, not just the first', () => {
  test('a two-condition column is two tails', () => {
    assert.deepEqual(ownedTails('stage != closed_won and stage != closed_lost and owner_id = 9', 'stage'), [
      '!= closed_won',
      '!= closed_lost',
    ]);
    assert.deepEqual(ownedTails('owner_id = 9', 'stage'), []);
  });

  test('conditionTail still answers one — the box view — and that is why boxes only speak when touched', () => {
    /* The regression this pins: an untouched box read the first tail back
       and rewrote the column on submit, so "Open pipeline" lost
       `!= closed_lost` the moment another box was used. The fold sites now
       skip untouched boxes; this asserts the two readings really differ so
       nobody "simplifies" them back into one. */
    const text = 'stage != closed_won and stage != closed_lost';
    assert.equal(conditionTail(text, 'stage'), '!= closed_won');
    assert.equal(ownedTails(text, 'stage').length, 2);
  });
});
