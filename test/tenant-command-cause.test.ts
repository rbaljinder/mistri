/**
 * A tenant member's command refusal carries its cause where the host serves an App from its source on this machine,
 * as the single-App host's does (refusalReport.ts), and the test kit reads it. A fixed sentence like "This record is
 * not eligible for this command." names nothing to fix; the cause is what the host log had and the kit did not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.ts';
import { tenantCommandDomain } from '../packages/mistri/src/server/tenant/tenantCommands.ts';
import { refusalSaid, sayRefusal } from '../packages/engine/src/shared/refusal.ts';
import { startClinic } from './support/clinicFixture.ts';

test('a tenant command refusal carries its cause for the author at a source host', async (t) => {
  const { host } = await startClinic(t, 'sqlite');
  const north = await host.tenant('north', { roles: ['reception'] });
  // A record that is another clinic's: refused as every denial is, with the cause only the author is told.
  const foreign = await north.command('recordPayment', { id: 'ap-south-1' }, { amount_cents: 1, method: 'card' });
  assert.ok(!foreign.ok);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.cause, 'The command transaction did not complete successfully.');
  assert.equal(foreign.message, 'This command is not available to this account.');
  assert.equal((foreign.body as { cause?: unknown }).cause, foreign.cause);
  // A refusal that recorded nothing has no cause to tell: the kit adds none.
  const plain = await north.command('postNotice', {}, { clinic_id: 'north', body: 'x' });
  assert.ok(!plain.ok);
  assert.equal(plain.cause, undefined);
  assert.equal('cause' in (plain.body as object), false);
});

test("a tenant member's refused grant says the sentence its rule said, as a single-tenant member's does", () => {
  const said = 'Your role has no grant for "Record payment".';
  const refusal = tenantCommandDomain(sayRefusal(new AppAccessDenied(), said));
  assert.equal(refusal?.code, 'forbidden');
  assert.equal(refusal?.message, said);
  assert.equal(refusal?.reason, said);
  // A denial that said nothing keeps the fixed sentence.
  assert.equal(tenantCommandDomain(new AppAccessDenied())?.message, 'This command is not available to this account.');
  assert.equal(refusalSaid(new AppAccessDenied()), undefined);
});
