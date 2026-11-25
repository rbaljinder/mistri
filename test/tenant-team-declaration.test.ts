/**
 * `auth.tenancy.team`: whether a tenant's members read who else is a member (tenantTeamRoute.ts). Left out, they do,
 * as a record's history already names who changed it; `false` closes it, for a tenant whose members must not see each
 * other, and the lock says so.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { parseTestApp } from './support/commandCatalog.js';

const app = (tenancy: Record<string, unknown>) =>
  parseTestApp(
    {
      id: 'desk',
      name: 'Desk',
      auth: { rows: 'tenant', tenancy, roles: { agent: { read: true } } },
      sources: { business: { connection: 'business-db' } },
      resources: { ticket: { owner: 'tenant' } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      nav: ['tickets'],
    },
    'desk',
  );

test('a tenant App says whether its members read the team; left out, they do', () => {
  assert.equal(app({ label: 'Customer' }).auth?.tenancy?.team, undefined);
  assert.equal(app({ label: 'Customer', team: true }).auth?.tenancy?.team, undefined, 'true is the default, said aloud');
  assert.equal(app({ label: 'Customer', team: false }).auth?.tenancy?.team, false);
  assert.throws(() => app({ team: 'managers' }), /"team" that is not true or false/);
  const facts = (tenancy: Record<string, unknown>) => authorityReport(app(tenancy));
  assert.match(facts({ team: false }), /auth tenant team names closed/);
  assert.doesNotMatch(facts({}), /tenant team/, 'an App that says nothing keeps the lock it had');
});
