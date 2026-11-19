/**
 * A tenant's custom-domain limit on live PostgreSQL (docs/tenant-domains.md §4): an add counts the tenant's claimed
 * domains and then writes one, so two adds in flight would each count the others' absence and both pass. The tenant's
 * anchor row is read FOR UPDATE first (tenantMaintenance.ts addCustomTenantHost), so the adds take turns and the
 * limit holds. The test races real connections; it owns a UUID-named database.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { addCustomTenantHost, listTenantHosts, putTenant } from '../packages/mistri/src/server/tenant/tenantMaintenance.js';
import { liveSkip } from './live.js';
import { uuidPostgresDatabase } from './support/tenantDialects.js';

const skip = liveSkip('postgres', process.env.TABLEWALK_TEST_PG);
const binding = { appId: 'store', source: { id: 'business', connection: 'db' }, storeId: 'store-tenants' };

test('concurrent adds for one tenant cannot pass its limit', { skip }, async (t) => {
  const database = await uuidPostgresDatabase('domains');
  t.after(() => database.drop());
  await maintenance.provisionStores(
    { postgres: database.url },
    { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration'] },
  );
  const where = { postgres: database.url };
  for (const tenantId of ['acme', 'bright'])
    await putTenant(where, binding, { tenantId, status: 'active', expectedVersion: null, operator: 'ops' });

  const race = (tenantId: string, hosts: string[], limit: number) =>
    Promise.allSettled(hosts.map((host) => addCustomTenantHost(where, binding, { tenantId, host, operator: 'ops', limit })));
  const mine = async (tenantId: string) =>
    (await listTenantHosts(where, binding)).filter((row) => row.tenantId === tenantId && row.kind === 'custom' && row.source === 'claimed');

  // Eight at once against a limit of three: exactly three get in, and the rest are refused for the limit, not for a clash.
  const eight = await race(
    'acme',
    Array.from({ length: 8 }, (_, i) => `a${i}.example.com`),
    3,
  );
  assert.equal(eight.filter((each) => each.status === 'fulfilled').length, 3);
  for (const each of eight) if (each.status === 'rejected') assert.match((each.reason as Error).message, /may add 3 custom domains/);
  assert.equal((await mine('acme')).length, 3);

  // A limit of one, two racing: one wins. Another tenant's count is its own.
  const two = await race('bright', ['b1.example.com', 'b2.example.com'], 1);
  assert.deepEqual(two.map((each) => each.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await mine('bright')).length, 1);
  assert.equal((await mine('acme')).length, 3);
});
