import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseApiTokenArgs } from '../packages/mistri/src/server/cli/apiTokenArgs.js';

const id = '12345678-1234-4abc-8def-123456789abc';
const common = ['--app', './app', '--config', './connections.json', '--store-id', id];
const issue = [
  'issue',
  ...common,
  '--subject',
  'native',
  '--actor',
  'operator',
  '--role',
  'reader',
  '--label',
  'Automation',
  '--expires-at',
  '2030-01-01T00:00:00Z',
];
const denied = (argv: unknown) =>
  assert.throws(
    () => parseApiTokenArgs(argv),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'Invalid api-token arguments.');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    },
  );

test('explicit verbs share no scope/store/path defaults and return immutable data', () => {
  assert.deepEqual(parseApiTokenArgs(['provision', ...common]), {
    verb: 'provision',
    app: './app',
    config: './connections.json',
    storeId: id,
  });
  const inspect = parseApiTokenArgs(['inspect', ...common, '--token-id', id]);
  assert.equal(inspect.verb, 'inspect');
  assert.ok(Object.isFrozen(inspect));
  const revoke = parseApiTokenArgs([
    'revoke',
    ...common,
    '--token-id',
    id,
    '--expected-version',
    '9'.repeat(128),
    '--actor',
    'é'.repeat(1024),
  ]);
  assert.equal(revoke.verb, 'revoke');
  for (const verb of ['provision', 'inspect', 'revoke', 'issue']) denied([verb]);
  for (const flag of ['--app', '--config', '--store-id']) {
    const at = common.indexOf(flag);
    denied(['provision', ...common.slice(0, at), ...common.slice(at + 2)]);
  }
});

test('issue preserves absent operations versus explicit deny-all and exact repeated names', () => {
  const unspecified = parseApiTokenArgs(issue);
  assert.equal(Object.hasOwn(unspecified, 'operations'), false);
  const empty = parseApiTokenArgs([...issue, '--deny-all-operations']);
  assert.equal(empty.verb, 'issue');
  if (empty.verb !== 'issue') return;
  assert.deepEqual(empty.operations, []);
  assert.ok(Object.isFrozen(empty.operations));
  const selected = parseApiTokenArgs([...issue, '--role', 'reviewer', '--operation', 'list:person', '--operation', 'item:person']);
  assert.equal(selected.verb, 'issue');
  if (selected.verb !== 'issue') return;
  assert.deepEqual(selected.roles, ['reader', 'reviewer']);
  assert.deepEqual(selected.operations, ['list:person', 'item:person']);
  assert.ok(Object.isFrozen(selected.roles));
  denied([...issue, '--deny-all-operations', '--operation', 'list:person']);
  denied([...issue, '--role', 'reader']);
  denied([...issue, '--operation', 'list:person', '--operation', 'list:person']);
});

test('UTC expiry is a real exact calendar instant, never a local or relative date', () => {
  for (const value of ['2032-02-29T12:34:56Z', '2032-02-29T12:34:56.123Z']) {
    const result = parseApiTokenArgs([...issue.slice(0, -1), value]);
    assert.equal(result.verb, 'issue');
    if (result.verb === 'issue') assert.equal(result.expiresAt, Date.parse(value));
  }
  for (const value of [
    'tomorrow',
    '2030-02-29T00:00:00Z',
    '2030-01-01',
    '2030-01-01T24:00:00Z',
    '2030-01-01T00:00:00+00:00',
    '2030-01-01T00:00:00',
    '2030-01-01T00:00:00.1Z',
    '1969-01-01T00:00:00Z',
    '2030-01-01T00:00:00Z\n',
  ])
    denied([...issue.slice(0, -1), value]);
});

test('unknown, duplicate, secret, mixed-server and cross-verb arguments fail without echoing inputs', () => {
  for (const flag of ['--token', '--secret', '--port', '--write-authority', '--help', '--app=other', '--unknown'])
    denied([...issue, flag, 'SENSITIVE_VALUE']);
  denied(['api-token', ...issue]);
  denied([...issue, 'extra']);
  denied([...issue, '--label']);
  denied([...issue, '--app', './other']);
  denied([...issue, '--deny-all-operations', '--deny-all-operations']);
  denied(['provision', ...common, '--actor', 'operator']);
  denied(['inspect', ...common, '--token-id', id, '--role', 'reader']);
  for (const version of ['0', '01', '-1', '1.0', '1e2', '1'.repeat(129)])
    denied(['revoke', ...common, '--token-id', id, '--expected-version', version, '--actor', 'operator']);
});

test('hostile argv, sparse arrays and excessive values refuse before coercion or getters', () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error('SECRET_DETAIL');
  };
  const sparse = Array(2);
  sparse[0] = 'issue';
  for (const value of [
    null,
    undefined,
    {},
    sparse,
    new Proxy([], { get: trap, ownKeys: trap }),
    Object.defineProperty([], '0', { get: trap, enumerable: true }),
    [new String('issue')],
    Array(2401).fill('x'),
  ])
    denied(value);
  denied([...issue, '--role', '\ud800']);
  denied([...issue, '--operation', 'x'.repeat(257)]);
  const actor = issue.indexOf('--actor') + 1;
  const tooLong = [...issue];
  tooLong[actor] = 'a'.repeat(1025);
  denied(tooLong);
  assert.equal(calls, 0);
});
