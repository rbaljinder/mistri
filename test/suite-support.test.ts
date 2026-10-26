/** Suite identity supplies native support proofs, while App grants and tenant
 * memberships retain their separate authority and revocation fences. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureNativeDisplayName, captureNativeSignInAge, captureNativeStepUpProvider } from '../packages/mistri/src/server/auth/auth.js';
import { nativeAccountEmailOf, findNativeAccountByEmail, createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import { tenantSupportFixture, appId } from './support/tenantSupportFixture.js';
import { SUPPORT_REFUSAL_CODES } from '../packages/mistri/src/shared/tenantSupport.js';

test('shared support uses genuine native age and display proofs and loses authority with its App grant', async (t) => {
  const denied = (answer: { status: number; text: string }) => assert.ok(answer.status >= 400 && answer.status < 500, answer.text);
  const f = await tenantSupportFixture(t, 'sqlite', { sharedIdentity: true });
  const { olivia, oscar } = f.accounts;
  const proof = await f.proof(olivia.cookie);
  const age = captureNativeSignInAge(f.auth()),
    display = captureNativeDisplayName(f.auth()),
    provider = captureNativeStepUpProvider(f.auth());
  assert.equal(display.displayName(proof), 'Olivia Operator');
  assert.equal(provider.provider(proof), undefined);
  await age.observeRecent(proof, Date.now(), 300000);
  assert.throws(() => display.displayName({ ...proof }));
  assert.throws(() => age.assertAge({ ...proof }, Date.now(), 300000));
  denied(await f.open(oscar, 'north', 'dealer_staff')); // An App role never supplies a platform membership.
  const opened = await f.open(olivia, 'north', 'dealer_staff');
  assert.equal(opened.status, 200, opened.text);
  assert.equal((opened.body.receipt as { session: { operatorName: string } }).session.operatorName, 'Olivia Operator');
  assert.equal(await nativeAccountEmailOf(f.auth(), olivia.accountId), olivia.email);
  assert.equal(await findNativeAccountByEmail(f.auth(), olivia.email), olivia.accountId);
  await assert.rejects(
    createNativeAccount(f.auth(), { email: 'new@example.test', name: 'New', password: 'long-test-password' }, { by: 'maintenance' }),
    /could not be created/,
    'a projected App does not acquire global account creation',
  );
  f.grants!.change({
    appId,
    subjectId: olivia.accountId,
    actorId: 'operator',
    roles: [],
    declaredRoles: ['reviewer'],
    expectedRevision: 1,
  });
  assert.throws(() => display.displayName(proof));
  assert.throws(() => age.assertAge(proof, Date.now(), 300000));
  denied(await f.support(olivia, 'status'));
  assert.equal(await nativeAccountEmailOf(f.auth(), olivia.accountId), null);
  assert.equal(await findNativeAccountByEmail(f.auth(), olivia.email), null);
  f.grants!.change({
    appId,
    subjectId: olivia.accountId,
    actorId: 'operator',
    roles: ['reviewer'],
    declaredRoles: ['reviewer'],
    expectedRevision: 2,
  });
  assert.throws(() => display.displayName(proof), 'restoring the same grant never revives an issued proof');
  await f.native.age(olivia.cookie, 310000);
  const stale = await f.open(olivia, 'north', 'dealer_staff');
  denied(stale);
  assert.equal(stale.body.code, SUPPORT_REFUSAL_CODES.signInRequired);
  const fresh = { ...olivia, cookie: await f.signIn(olivia.email, olivia.password) };
  assert.equal((await f.open(fresh, 'north', 'dealer_staff')).status, 200);
  const signedOut = await f.call('/api/auth/sign-out', {
    body: {},
    headers: { cookie: fresh.cookie, 'x-mistri-account': fresh.accountId },
  });
  assert.equal(signedOut.status, 200, signedOut.text);
  denied(await f.support(fresh, 'status'));
});
