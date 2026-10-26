import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/**
 * `operations: ['support']` reads a support session's history, and the role's
 * realm says which half: a dealer's own role reads its own dealer's sessions
 * (held as `supportLog`), a lender's role reads every dealer's (`supportAudit`).
 * It is a capability grant like the other operations — named, default-deny,
 * never implied by a data or command grant — and it means nothing without the
 * platform realm, because a support session is a platform member inside a
 * tenant.
 */
const ROLES = {
  dealer_admin: { realm: 'tenant', read: true, write: ['lead'], operations: ['support'] },
  dealer_staff: { realm: 'tenant', read: true },
  reviewer: { realm: 'platform', read: true, operations: ['support', 'readiness'] },
  manager: { realm: 'platform', read: true },
};
const lender = (roles: Record<string, unknown>) =>
  parseAppConfig(
    {
      name: 'Lending',
      sources: { business: { connection: 'db' } },
      resources: { dealer: { owner: 'platform' }, lead: { access: 'write', owner: 'tenant' } },
      auth: {
        store: 'auth.db',
        signUp: 'invite',
        rows: 'tenant',
        tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
        roles,
      },
      views: { leads: { kind: 'list', from: 'lead' }, dealers: { kind: 'list', from: 'dealer' } },
      nav: [
        { id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] },
        { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
      ],
      home: 'leads',
    },
    'lending.ts',
  );
/** An App with no platform realm, so no support session can exist in it. */
const flat = (roles: Record<string, unknown>) =>
  parseAppConfig(
    {
      name: 'Loans',
      resources: { loan: {} },
      auth: { roles },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
    },
    'loans.ts',
  );
const withRole = (name: string, grant: Record<string, unknown>) => ({ ...structuredClone(ROLES), [name]: grant });

test("a dealer role reads its own support sessions, a lender role reads every dealer's, and neither is implied", () => {
  const parsed = lender(structuredClone(ROLES));
  assert.equal(parsed.auth?.roles?.dealer_admin.supportLog, true);
  assert.equal(parsed.auth?.roles?.dealer_admin.supportAudit, undefined);
  assert.equal(parsed.auth?.roles?.reviewer.supportAudit, true);
  assert.equal(parsed.auth?.roles?.reviewer.supportLog, undefined);
  // Default deny: reading and writing the business is not reading its history.
  assert.equal(parsed.auth?.roles?.dealer_staff.supportLog, undefined);
  assert.equal(parsed.auth?.roles?.manager.supportAudit, undefined);
});

test('the support word is captured at parse, and kept out of the operator reads it sits beside', () => {
  const input = structuredClone(ROLES) as Record<string, Record<string, unknown>>;
  const parsed = lender(input);
  assert.equal(parsed.auth?.roles?.dealer_admin.operations, undefined);
  assert.deepEqual(parsed.auth?.roles?.reviewer.operations, ['readiness']);
  // Changing the authored object after parsing changes nothing that runs.
  input.dealer_admin.operations = ['readiness'];
  input.reviewer.operations = ['readiness'];
  assert.equal(parsed.auth?.roles?.dealer_admin.supportLog, true);
  assert.equal(parsed.auth?.roles?.reviewer.supportAudit, true);
});

test('the old grant keys are refused with the word that replaced them', () => {
  assert.throws(
    () => lender(withRole('dealer_admin', { realm: 'tenant', read: true, supportLog: true })),
    /"supportLog", which is now "operations": \["support"\]/,
  );
  assert.throws(
    () => lender(withRole('reviewer', { realm: 'platform', read: true, supportAudit: true })),
    /"supportAudit", which is now "operations": \["support"\]/,
  );
});

test('without the platform realm there is no support history to read', () => {
  assert.throws(
    () => flat({ viewer: { read: true, operations: ['support'] } }),
    /"operations": \["support"\], which needs the platform realm/,
  );
});

test('a feature never grants the support word', () => {
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'Loans',
          resources: { loan: {} },
          auth: { roles: { viewer: { read: true } } },
          features: [{ id: 'support-desk', auth: { roles: { viewer: { operations: ['support'] } } } }],
          views: { loans: { kind: 'list', from: 'loan' } },
          home: 'loans',
        },
        'loans.ts',
      ),
    /"operations" names "support", which only the App's own roles grant/,
  );
});

test('the JSON schema offers support among the role operations, and never as a feature grant', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const json = JSON.parse(readFileSync(join(root, 'packages', 'mistri', 'schema', 'app.schema.json'), 'utf8')) as {
    $defs: {
      roleGrant: { additionalProperties: boolean; properties: Record<string, { items?: { enum?: unknown[] } }> };
      featureGrant: { properties: Record<string, { items?: { enum?: unknown[] } }> };
    };
  };
  const role = json.$defs.roleGrant;
  assert.equal(role.additionalProperties, false);
  assert.ok(role.properties.operations.items?.enum?.includes('support'));
  for (const key of ['supportLog', 'supportAudit']) assert.equal(role.properties[key], undefined, key);
  // Widening who reads a dealer's history is the App's to declare, never a feature's.
  assert.ok(!json.$defs.featureGrant.properties.operations.items?.enum?.includes('support'));
});
