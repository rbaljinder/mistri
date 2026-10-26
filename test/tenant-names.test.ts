import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { wordedField } from '../packages/engine/src/shared/recordLabel.js';
import type { TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { tenantNamePlan, tenantNamesOf, tenantNamesQuery } from '../packages/mistri/src/server/tenant/tenantNames.js';

/**
 * What a tenant is called: its profile row, said by the App's name for that
 * resource's records in the profile's own columns — and nothing, so the id
 * speaks, where the name would say no more than the id or reach elsewhere.
 */
const column = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'TEXT', nullable: true, primaryKey: false, ...extra });
const schema: DatabaseSchema = {
  label: 'names',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [{ name: 'lead.tenant_id', from: { table: 'lead', columns: ['tenant_id'] }, to: { table: 'branch', columns: ['id'] } }],
  tables: [
    {
      id: 'branch',
      name: 'branch',
      schema: '',
      isView: false,
      columns: [
        column('id', { primaryKey: true, nullable: false }),
        column('name'),
        column('region'),
        column('status'),
        column('owner_id'),
      ],
    },
    {
      id: 'lead',
      name: 'lead',
      schema: '',
      isView: false,
      columns: [
        column('id', { primaryKey: true, nullable: false }),
        column('tenant_id', { references: { table: 'branch', column: 'id' } }),
      ],
    },
  ],
};
const owned = {
  appId: 'atlas',
  source: { id: 'main', connection: 'main' },
  schema,
  physicalSchema: schema,
  resources: { branch: 'physical_branch', lead: 'physical_lead' },
  ownership: { branch: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
  profile: 'branch',
} as unknown as TenantOwnershipSnapshot;

test('a profile is named by the columns its template reads, in its words, and a key-only or reaching name is no name', () => {
  assert.deepEqual(tenantNamePlan(owned, '{name}')?.columns, ['name']);
  assert.deepEqual(tenantNamePlan(owned, '{name} ({region})')?.columns, ['name', 'region']);
  // The noun and key a table with no name is given says no more than the id.
  assert.equal(tenantNamePlan(owned, 'Branch #{id}'), undefined);
  // A name that walks a reference, or masks, is not the profile's own columns.
  assert.equal(tenantNamePlan(owned, '{owner_id.name}'), undefined);
  assert.equal(tenantNamePlan(owned, '{name|masked}'), undefined);
  assert.equal(tenantNamePlan(owned, '{nowhere}'), undefined);
  assert.equal(tenantNamePlan(owned, undefined), undefined);
  assert.equal(tenantNamePlan({ ...owned, profile: undefined }, '{name}'), undefined);
});

test('names are read for the asked tenants only, said as the template says them, and a blank one is none', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE physical_branch (id TEXT PRIMARY KEY, name TEXT, region TEXT, status TEXT, owner_id TEXT);
      INSERT INTO physical_branch VALUES ('north', 'North Depot', 'East', 'active', NULL), ('south', '  ', 'West', 'suspended', NULL),
        ('west', 'West Depot', NULL, 'active', NULL);`);
    const read = (template: string, asked: string[]) => {
      const plan = tenantNamePlan(owned, template)!;
      // One statement, with the key and the name's columns only: a template cannot read the rest of the row.
      const sql = tenantNamesQuery(owned, plan, asked.length);
      assert.doesNotMatch(sql, /owner_id|\*/);
      return tenantNamesOf(plan, db.prepare(sql).all(...asked) as Record<string, unknown>[], asked);
    };
    assert.deepEqual({ ...read('{name}', ['north', 'south', 'gone']) }, { north: 'North Depot' });
    assert.deepEqual({ ...read('{name} · {region}', ['west']) }, { west: 'West Depot ·' });
    assert.deepEqual(
      { ...read(wordedField('status', { active: 'Open', suspended: 'Paused' }), ['north', 'south']) },
      { north: 'Open', south: 'Paused' },
    );
  } finally {
    db.close();
  }
});
