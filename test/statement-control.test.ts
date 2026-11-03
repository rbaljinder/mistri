/**
 * The engine's statement cap and cancel, as parts (adapters/statementControl.ts): what every
 * long read runs under, whichever server asks. The database browser's MCP tools hold them end to
 * end in its own repository; the parts are the engine's, so they are held here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  onCancel,
  STATEMENT_TIMEOUT_MS,
  statementCap,
  StatementStopped,
  stoppedReason,
} from '../packages/engine/src/adapters/statementControl.js';

describe('the statement cap and the cancel, as parts', () => {
  test('a caller may lower the cap, never raise it, and not below the floor', () => {
    assert.equal(statementCap(), STATEMENT_TIMEOUT_MS);
    assert.equal(statementCap(Number.NaN), STATEMENT_TIMEOUT_MS);
    assert.equal(statementCap(10), 100);
    assert.equal(statementCap(2_500.7), 2_500);
    assert.equal(statementCap(STATEMENT_TIMEOUT_MS * 10), STATEMENT_TIMEOUT_MS);
  });

  test("each engine's own timeout reads as a timeout; anything else is not a stop", () => {
    assert.equal(stoppedReason(new Error('canceling statement due to statement timeout')), 'timeout');
    assert.equal(stoppedReason(new Error('Query execution was interrupted, maximum statement execution time exceeded')), 'timeout');
    assert.equal(stoppedReason(new Error('Query execution was interrupted (max_statement_time exceeded)')), 'timeout');
    assert.equal(stoppedReason(new StatementStopped('cancelled')), 'cancelled');
    assert.equal(stoppedReason(new Error('canceling statement due to user request')), undefined);
    assert.equal(stoppedReason(new Error('no such table: x')), undefined);
  });

  test('a cancel stops once, at once when it has already happened, and not after it is disarmed', () => {
    let stops = 0;
    const live = new AbortController();
    const disarm = onCancel(live.signal, () => {
      stops += 1;
    });
    live.abort();
    live.abort();
    assert.equal(stops, 1);
    disarm();
    const done = new AbortController();
    done.abort();
    onCancel(done.signal, () => {
      stops += 1;
    });
    assert.equal(stops, 2);
    const later = new AbortController();
    onCancel(later.signal, () => {
      stops += 1;
    })();
    later.abort();
    assert.equal(stops, 2);
  });
});
