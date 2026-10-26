/** A shared login does not mean shared App authorization. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectSuiteGrant, type SuiteGrantLookup } from '../packages/mistri/src/server/auth/suiteGrantProjection.js';

test('one suite subject has separate App grants, never grants from email or native role', async () => {
  const subject = Object.freeze({
    id: 'opaque-1',
    who: 'reader@example.test',
    role: 'admin',
    name: 'Reader',
    emailVerified: true as const,
  });
  const grants = new Map([
    ['lender', ['reviewer']],
    ['dealer', ['seller']],
  ]);
  const calls: string[] = [];
  const lookup: SuiteGrantLookup = async (id, app) => {
    calls.push(`${id}:${app}`);
    return grants.get(app) ?? null;
  };
  assert.deepEqual(await projectSuiteGrant(subject, 'lender', ['reviewer', 'admin'], lookup), {
    id: 'opaque-1',
    who: subject.who,
    name: 'Reader',
    emailVerified: true,
    role: 'reviewer',
  });
  assert.equal((await projectSuiteGrant(subject, 'dealer', ['seller', 'admin'], lookup))?.role, 'seller');
  assert.equal(await projectSuiteGrant(subject, 'leads', ['admin'], lookup), null);
  assert.deepEqual(calls, ['opaque-1:lender', 'opaque-1:dealer', 'opaque-1:leads']);
  grants.delete('lender');
  assert.equal(
    await projectSuiteGrant(subject, 'lender', ['reviewer', 'admin'], lookup),
    null,
    'revocation is visible on the next request, not hidden by a cached role',
  );
  assert.equal(subject.role, 'admin', 'projection never changes the suite identity');
});

test('missing, foreign, duplicate and malformed roles fail closed as a whole', async () => {
  const subject = { id: 'opaque-1', who: 'same@example.test', role: 'admin' };
  for (const roles of [null, [], ['admin'], ['reader', 'foreign'], ['reader', 'reader'], ['reader,admin'], [1]]) {
    const result = await projectSuiteGrant(subject, 'lender', ['reader'], async () => roles as string[] | null);
    assert.equal(result, null, JSON.stringify(roles));
  }
  const sparse = Array<string>(2);
  sparse[0] = 'reader';
  assert.equal(
    await projectSuiteGrant(subject, 'lender', ['reader', 'admin'], async () => sparse),
    null,
    'a sparse grant never becomes a valid subset',
  );
  assert.equal(
    (await projectSuiteGrant(subject, 'lender', ['reader', 'admin'], async () => ['admin']))?.role,
    'admin',
    'administration requires an explicit grant for the exact App',
  );
});

test('invalid subject, App and declared roles refuse before consulting grants', async () => {
  const subject = { id: 'opaque-1', who: 'reader@example.test' };
  const consulted = () => {
    throw new Error('invalid input reached the grant store');
  };
  assert.equal(await projectSuiteGrant({ ...subject, id: '' }, 'lender', ['reader'], consulted), null);
  assert.equal(await projectSuiteGrant({ ...subject, id: 'bad\0id' }, 'lender', ['reader'], consulted), null);
  assert.equal(await projectSuiteGrant(subject, '../lender', ['reader'], consulted), null);
  assert.equal(await projectSuiteGrant(subject, 'lender', ['reader', 'reader'], consulted), null);
  assert.equal(await projectSuiteGrant(subject, 'lender', ['reader,admin'], consulted), null);
  const sparse = Array<string>(2);
  sparse[0] = 'reader';
  assert.equal(await projectSuiteGrant(subject, 'lender', sparse, consulted), null);
});
