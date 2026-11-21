/**
 * A tenant App's picks (tenantPreferences.ts): kept in the preferences store beside the tenant source, scoped to the
 * tenant a member's lease names, so a pick made in one tenant is never read in another, and a member's rows are never
 * another member's. Nothing a request says chooses the member or the tenant: both come from the lease.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSqlitePreferences, provisionSqlitePreferences } from '../packages/mistri/src/adapters/preferences/sqlitePreferences.js';
import { tenantPreferences } from '../packages/mistri/src/server/tenant/tenantPreferences.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';

const site = {
  id: 'site',
  name: 'site',
  schema: '',
  isView: false,
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
};
const app = { id: 'clinic', choose: { site: { from: 'site' } } } as unknown as AppDef;

test('a tenant member’s pick is kept per tenant, and never read in another tenant or by another member', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-choose-'));
  const file = join(directory, 'tenants.db');
  new DatabaseSync(file).close();
  provisionSqlitePreferences(file);
  const store = openSqlitePreferences(file);
  try {
    const picks = tenantPreferences(app, async () => store);
    const reader = { query: async () => ({ rows: [{ id: 4 }] }) };
    const schema = { label: '', dialect: 'sqlite', readAt: '', foreignKeys: [], tables: [site] };
    const member = (account: string, tenant: string) => ({ accountId: account, tenantId: tenant });
    const choose = (who: unknown, value: unknown) => picks.choose(who, schema as never, reader as never, { name: 'site', value });
    assert.equal(await choose(member('ana', 'north'), '4'), true);
    assert.deepEqual(await picks.storedFor(member('ana', 'north'), true), { site: '4' });
    assert.deepEqual(await picks.stored('ana', 'north'), { site: '4' });
    // The same member in another tenant holds nothing: the scope is the tenant.
    assert.deepEqual(await picks.storedFor(member('ana', 'south'), true), {});
    assert.deepEqual(await picks.storedFor(member('bo', 'north'), true), {});
    // A lease that is no member's (a platform or support lease), or names no tenant, holds and keeps nothing.
    assert.deepEqual(await picks.storedFor(member('ana', 'north'), false), {});
    assert.deepEqual(await picks.storedFor({ accountId: 'ana' }, true), {});
    assert.equal((await choose({ accountId: 'ana' }, '4')) !== true, true);
    // Refused, not kept: an undeclared name, a value that is not text, a row the reader cannot read.
    const undeclared = await picks.choose(member('ana', 'north'), schema as never, reader as never, { name: 'region', value: '4' });
    assert.equal((undeclared as { status: number }).status, 400);
    assert.equal(((await choose(member('ana', 'north'), 4)) as { status: number }).status, 400);
    const blind = { query: async () => ({ rows: [] }) };
    assert.equal(
      ((await picks.choose(member('ana', 'north'), schema as never, blind as never, { name: 'site', value: '9' })) as { status: number })
        .status,
      422,
    );
    // The payload's picks are told only where a store exists, and only for what the reader can still read.
    assert.deepEqual(await picks.picksFor(member('ana', 'north'), true, schema as never, reader as never), { site: '4' });
    assert.deepEqual(await picks.picksFor(member('ana', 'north'), true, schema as never, blind as never), {});
    assert.equal(
      await tenantPreferences(app, async () => undefined).picksFor(member('ana', 'north'), true, schema as never, reader as never),
      undefined,
    );
    // Cleared, it is gone for that tenant alone.
    assert.equal(await choose(member('ana', 'north'), null), true);
    assert.deepEqual(await picks.storedFor(member('ana', 'north'), true), {});
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
