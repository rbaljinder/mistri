/**
 * `tenant.<column>` on the left of a `when` — `tenant.plan = 'pro'` — as a menu's and a command input's are written,
 * now in a record page's section and list and in an action's `when` too (a field report). It is a constant of the
 * request, not of the row: one that holds asks nothing of the row, one that does not matches no row, and check
 * (which holds no tenant) lets it through. An unshared column, no tenant, or a column on the right are refused.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTestApp } from './support/commandCatalog.js';
import { resolveResources } from '../packages/mistri/src/shared/app.js';
import { validatePage } from '../packages/engine/src/shared/page.js';
import { parseQuery } from '../packages/engine/src/shared/query.js';
import { ANYONE, type QueryPerson } from '../packages/engine/src/shared/queryOperands.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const col = (name: string, type = 'TEXT', extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const schema = {
  tables: [
    {
      id: 'customer',
      name: 'customer',
      columns: [col('id', 'TEXT', { primaryKey: true, nullable: false }), col('plan', 'TEXT', { allowed: ['free', 'pro'] })],
    },
    {
      id: 'ticket',
      name: 'ticket',
      columns: [col('id', 'TEXT', { primaryKey: true, nullable: false }), col('tenant_id'), col('tier'), col('priority')],
    },
  ],
  foreignKeys: [],
} as unknown as DatabaseSchema;

const as = (plan: string | null): QueryPerson => ({ email: 'eve@example.invalid', tenant: { plan } });
const read = (when: string, me: QueryPerson) => parseQuery(`ticket ${when}`, { schema, me });
const said = (when: string, me: QueryPerson) =>
  read(when, me)
    .errors.map((error) => error.message)
    .join('\n');
const groups = (when: string, me: QueryPerson) => {
  const parsed = read(when, me);
  assert.deepEqual(parsed.errors, [], when);
  return parsed.query!.filter.groups;
};
const NONE = [[{ column: 'id', op: 'in', value: [] }]];

test("a tenant's value holds or matches nothing, by each test", () => {
  assert.deepEqual(groups("tenant.plan = 'pro'", as('pro')), []);
  assert.deepEqual(groups("tenant.plan = 'pro'", as('free')), NONE);
  assert.deepEqual(groups('tenant.plan != pro', as('free')), []);
  assert.deepEqual(groups('tenant.plan in (free, pro)', as('pro')), []);
  assert.deepEqual(groups('tenant.plan not in (pro)', as('pro')), NONE);
  assert.deepEqual(groups('tenant.plan is empty', as(null)), []);
  assert.deepEqual(groups('tenant.plan is not empty', as(null)), NONE);
  // A profile that holds nothing meets no comparison, as a menu's when meets none.
  assert.deepEqual(groups("tenant.plan = 'pro'", as(null)), NONE);
  assert.deepEqual(groups("tenant.plan != 'pro'", as(null)), NONE);
});

test('it joins the row conditions beside it, and an or that holds is every row', () => {
  const tier = { column: 'tier', op: '=', value: 'gold' };
  const never = { column: 'id', op: 'in', value: [] };
  assert.deepEqual(
    groups("tenant.plan = 'pro' and tier = gold", as('pro')).map((group) => group.map(({ column, op, value }) => ({ column, op, value }))),
    [[tier]],
  );
  assert.deepEqual(
    groups("tenant.plan = 'pro' or tier = gold", as('free')).map((group) => group.map(({ column, op, value }) => ({ column, op, value }))),
    [[never], [tier]],
  );
  assert.deepEqual(groups("tenant.plan = 'pro' or tier = gold", as('pro')), []);
});

test('check holds it for anyone; no tenant, an unshared column and a column on the right are refused', () => {
  assert.equal(said("tenant.plan = 'pro'", ANYONE), '');
  assert.match(said("tenant.plan = 'pro'", { email: 'eve@example.invalid' }), /no tenant/);
  assert.match(said("tenant.name = 'North'", as('pro')), /auth\.tenancy\.shared/);
  assert.match(said('tenant.plan = tier', as('pro')), /compared with a value/);
});

test("a record page's section and an action's when accept it at check", () => {
  for (const when of ["tenant.plan = 'pro'", 'tier = tenant.plan']) {
    const app = parseTestApp(
      {
        id: 'desk',
        name: 'Desk',
        auth: {
          rows: 'tenant',
          tenancy: { label: 'Customer', profile: 'customer', shared: ['plan'], platform: { label: 'Operator' } },
          roles: { agent: { realm: 'tenant', read: ['ticket'], write: ['ticket'] } },
        },
        sources: { business: { connection: 'b' } },
        resources: {
          customer: { owner: 'platform' },
          ticket: { owner: 'tenant', access: 'write', actions: { escalate: { label: 'Escalate', set: { priority: 'high' }, when } } },
        },
        views: { tickets: { kind: 'list', from: 'ticket', realm: 'tenant' } },
        home: 'tickets',
      },
      'tenant when fixture',
    );
    assert.deepEqual(resolveResources(app, schema).problems, [], when);
    const page = validatePage(schema, { name: 'ticket', base: 'ticket', sections: [{ kind: 'fields', paths: ['tier'], when }] } as never);
    assert.equal((page as { error?: string }).error, undefined, when);
  }
});
