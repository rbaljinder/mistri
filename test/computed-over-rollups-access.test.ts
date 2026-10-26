/**
 * A computed column over two rollups, one narrowed through a reference (A company's group pipeline,
 * `open_pipeline + family_pipeline`), passes the reader check on a catalog that carries no rollups — a tenant's read
 * catalog is one — because the check finds each rollup pinned beside the expression, and only there. Refused, a
 * tenant read said "The tenant context could not be verified" and nothing about the column.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppAccessDenied, validateResourceView } from '../packages/mistri/src/server/app/appAccess.js';
import { parseAppConfig, withRollups } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import { withViewComputed } from '../packages/engine/src/shared/viewLabels.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const catalog = {
  label: 'crm',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      id: 'company',
      name: 'company',
      schema: '',
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('parent_id', 'INTEGER'),
        column('tenant_id', 'TEXT'),
      ],
    },
    {
      id: 'deal',
      name: 'deal',
      schema: '',
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('company_id', 'INTEGER'),
        column('amount', 'NUMERIC'),
        column('stage', 'TEXT'),
        column('tenant_id', 'TEXT'),
      ],
    },
  ],
  foreignKeys: [
    { name: 'deal_company', from: { table: 'deal', columns: ['company_id'] }, to: { table: 'company', columns: ['id'] } },
    { name: 'company_parent', from: { table: 'company', columns: ['parent_id'] }, to: { table: 'company', columns: ['id'] } },
  ],
} as unknown as DatabaseSchema;

const app = parseAppConfig(
  {
    id: 'crm',
    name: 'CRM',
    resources: {
      company: {
        rollups: {
          open_pipeline: { fn: 'sum', from: 'deal', column: 'amount', whose: 'company_id', query: 'stage = open' },
          // The subsidiaries' deals: through the deal's company to that company's parent.
          family_pipeline: { fn: 'sum', from: 'deal', column: 'amount', whose: 'company_id.parent_id', query: 'stage = open' },
        },
        computed: { group_pipeline: { type: 'number', value: 'open_pipeline + family_pipeline' } },
      },
      deal: {},
    },
    views: { companies: { kind: 'list', from: 'company' } },
    home: 'companies',
  },
  'G83 fixture',
);

test('a computed column over two rollups is read by a reader granted their rows, on a catalog with no rollups', () => {
  const served = withRollups(app, catalog, new Date('2026-10-09T00:00:00Z'), null);
  const view = withViewComputed(served, {
    id: 'company',
    name: 'company',
    base: 'company',
    columns: [{ path: 'id' }, { path: 'group_pipeline' }],
    filter: { groups: [[{ path: 'id', op: '=', value: 1 }]] },
  } as ViewDef);
  const tenant: RowScope = {
    company: { groups: [[{ column: 'tenant_id', op: '=', value: 'north' }]] },
    deal: { groups: [[{ column: 'tenant_id', op: '=', value: 'north' }]] },
  };
  const access = (readable: string[]) => ({ readable: new Set(readable), writable: new Set<string>(), rows: tenant });
  assert.ok(validateResourceView(catalog, access(['company', 'deal']), view).expressions?.group_pipeline);
  // The rollups' rows are still the reader's to read: without the deals, the sum is not served.
  assert.throws(() => validateResourceView(catalog, access(['company']), view), AppAccessDenied);
});
