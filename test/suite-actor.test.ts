import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operatorActor } from '../packages/mistri/src/server/cli/suiteGrant.js';

const absent = () => {
  throw Object.assign(new Error('ENOENT: no passwd entry'), { code: 'ENOENT' });
};

test('an explicit --actor wins over the account name', () => {
  assert.equal(
    operatorActor('ci-bot', {}, () => 'someone'),
    'operator:ci-bot',
  );
});

test('the account name is used when present', () => {
  assert.equal(
    operatorActor(undefined, {}, () => 'someone'),
    'operator:someone',
  );
});

test('a missing passwd entry falls back to USER, LOGNAME, then the uid and never throws', () => {
  assert.equal(operatorActor(undefined, { USER: 'u', LOGNAME: 'l' }, absent), 'operator:u');
  assert.equal(operatorActor(undefined, { LOGNAME: 'l' }, absent), 'operator:l');
  assert.equal(
    operatorActor('  ', {}, () => ' '),
    `operator:uid-${process.getuid?.() ?? 'unknown'}`,
  );
  assert.equal(operatorActor(undefined, {}, absent), `operator:uid-${process.getuid?.() ?? 'unknown'}`);
});
