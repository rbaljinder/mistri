/**
 * Opening a store fails two different ways: the database could not be
 * reached, or the store is not there. Only the second is cured by
 * provisioning, so the first must be told apart and say what it is.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connectionFailure } from '../packages/mistri/src/server/storeConnection.js';

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('connectionFailure', () => {
  test('a Postgres server out of connections is a connection failure, with its own words', () => {
    assert.equal(connectionFailure(coded('sorry, too many clients already', '53300')), '53300: sorry, too many clients already');
  });

  test('a refused socket is a connection failure', () => {
    assert.match(connectionFailure(coded('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED')) ?? '', /ECONNREFUSED/);
  });

  test('a wrapped error is read one level down', () => {
    const wrapped = new Error('could not open', { cause: coded('connect ECONNREFUSED ::1:5432', 'ECONNREFUSED') });
    assert.match(connectionFailure(wrapped) ?? '', /connect ECONNREFUSED/);
  });

  test('a pg error without a code is read by its message', () => {
    assert.match(connectionFailure(new Error('Connection terminated unexpectedly')) ?? '', /Connection terminated/);
  });

  test('a missing table is not a connection failure: that is what provisioning is for', () => {
    assert.equal(connectionFailure(coded('relation "jobs" does not exist', '42P01')), undefined);
    assert.equal(connectionFailure(new Error('the job store is not the layout this tablewalk provisions')), undefined);
    assert.equal(connectionFailure('ECONNREFUSED'), undefined);
  });
});
