import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';

test('typed tenant policy binds ownership to generated logical resources/columns without publishing loader authority', () => {
  const filename = resolve('test/.tenant-policy-typecheck.ts');
  const source = `
    import { type AppConfig, type TypedAppConfig } from '../packages/mistri/schema/app.js';
    import { defineAppTenantPolicy, type AppTenantPolicy } from '../packages/mistri/src/server/policy.js';
    import * as policy from '../packages/mistri/src/server/policy.js';
    type Schema = { item: 'id' | 'tenant_id' | 'name'; country: 'code' };
    const grants = { rows: 'tenant', roles: { staff: { read: true } } } satisfies NonNullable<AppConfig['auth']>;
    const typed: TypedAppConfig<Schema>['auth'] = { ...grants, roles: { staff: { read: ['item'] } } };
    const definition = defineAppTenantPolicy<Schema>({ kind: 'tenant', appId: 'app', storeId: 'store',
      ownership: { item: { kind: 'tenant', column: 'tenant_id' }, country: { kind: 'global', access: 'read-only' } },
      resolveMembershipRows: principal => ({ item: principal.roles.includes('staff'), country: true }),
      resolveRows: async principal => ({ item: principal.tenantId === 'north', country: true }),
      authorizeDeletedRecord: async (principal, image) => principal.tenantId === image.row.tenant_id,
      resultReferences: { assign: () => [{ table: 'item', key: { id: 'opaque' } }] }
    });
    // @ts-expect-error Enrollment is a row scope, not a tenant selector.
    const badMarker: typeof typed = { ...typed, rows: 'north' };
    // @ts-expect-error Policy fields are not public manifest fields.
    const privateField: typeof typed = { ...typed, storeId: 'private' };
    // @ts-expect-error Every logical resource needs ownership.
    const missing: AppTenantPolicy<Schema>['ownership'] = { item: { kind: 'tenant', column: 'tenant_id' } };
    // @ts-expect-error Ownership columns use that resource's schema type.
    const column: AppTenantPolicy<Schema>['ownership']['item'] = { kind: 'tenant', column: 'code' };
    // @ts-expect-error Globals are never writable.
    const global: AppTenantPolicy<Schema>['ownership']['country'] = { kind: 'global', access: 'write' };
    // @ts-expect-error No extra logical resources.
    const resource: AppTenantPolicy<Schema>['ownership'] = { ...definition.ownership, secret: { kind: 'tenant', column: 'tenant_id' } };
    // @ts-expect-error Captured authority is readonly.
    definition.ownership.item = { kind: 'tenant', column: 'id' };
    // @ts-expect-error A policy cannot supply account authentication.
    const auth: AppTenantPolicy<Schema> = { ...definition, verifySession: () => ({ id: 'forged' }) };
    // @ts-expect-error Loader is private, not part of @mistriwork/mistri/policy.
    policy.loadAppTenantPolicy;
    // @ts-expect-error Enrollment runtime is private.
    policy.createTenantEnrollment;
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source }, options: { target: 'ES2023' } }), '');
});

test("a row policy's db is typed by the App's generated rows, and reads only", () => {
  const filename = resolve('test/.row-policy-db-typecheck.ts');
  const source = `
    import { defineAppRowPolicy } from '../packages/mistri/src/server/policy.js';
    type Rows = { dealer_user: { id: number; dealer_id: string; account_id: string | null }; dealer: { id: string; name: string } };
    export default defineAppRowPolicy<Rows>({ appId: 'dealer', async resolveRows(principal, { db }) {
      const seats = await db.dealer_user.where({ account_id: principal.id });
      const dealers: string[] = seats.map(seat => seat.dealer_id);
      // @ts-expect-error A seat's dealer is text, not a number.
      const wrong: number[] = seats.map(seat => seat.dealer_id);
      // @ts-expect-error The policy's db reads; it never writes.
      await db.dealer_user.insert({ dealer_id: 'x' });
      // @ts-expect-error Only the App's tables are there.
      await db.vehicle.count();
      // @ts-expect-error A where names the table's own columns.
      await db.dealer.where({ owner: 'x' });
      void wrong;
      return { dealer: { groups: [[{ column: 'id', op: 'in', value: dealers }]] } };
    } });
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source }, options: { target: 'ES2023' } }), '');
});
