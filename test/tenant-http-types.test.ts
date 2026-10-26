import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';

test('tenant HTTP reuses resource bodies while keeping opaque Undo tokens separate from ordinary numeric history', () => {
  const filename = resolve('test/.tenant-http-typecheck.ts');
  const source = `
    import type { TenantHttpResourceBody, TenantHttpResourceSuccess, TenantHttpResourceReply } from '../packages/mistri/src/shared/tenantHttp.js';
    import type { ResourceHttpRequest, ResourceHttpSuccess, ResourceClientArgs, ResourceClientReply } from '../packages/engine/src/shared/resourceHttp.js';
    const update: TenantHttpResourceBody<'/api/update'> = { table: 'item', key: { id: 'large-id' }, values: { name: 'new' } };
    const saved: TenantHttpResourceSuccess<'/api/update'> = { affected: 1, applied: { name: 'new' }, undoId: 'opaque' };
    const undo: TenantHttpResourceBody<'/api/revert'> = { confirm: true, expectedId: 'opaque' };
    const preview: TenantHttpResourceSuccess<'/api/revert'> = { reverted: false, writes: [], next: { id: 'opaque', kind: 'update', at: 'now', summary: 'Change' } };
    const failure: TenantHttpResourceReply<'/api/revert'> = { reverted: false, outcome: 'unknown' };
    const ordinary: ResourceHttpRequest<'/api/revert'> = { confirm: true, expectedId: 123 };
    const ordinarySaved: ResourceHttpSuccess<'/api/update', 'app'> = { affected: 1, applied: {}, undoId: 123 };
    const clientTenantUndo: ResourceClientArgs<'/api/revert'> = [{ confirm: true, expectedId: 'opaque' }];
    const clientOrdinaryUndo: ResourceClientArgs<'/api/revert'> = [{ confirm: true, expectedId: 123 }];
    const clientTenantSave: ResourceClientReply<'/api/update'> = saved;
    const clientOrdinarySave: ResourceClientReply<'/api/update'> = ordinarySaved;
    // @ts-expect-error Bundled token union does not broaden ordinary wire requests.
    const opaqueOrdinaryRequest: ResourceHttpRequest<'/api/revert'> = { confirm: true, expectedId: 'opaque' };
    // @ts-expect-error Routing selectors do not belong to tenant operation data.
    const bodyTenant: typeof update = { ...update, tenant: 'north' };
    // @ts-expect-error App identity uses the canonical URL selector, not a duplicate body spelling.
    const bodyApp: typeof update = { ...update, app: 'app' };
    // @ts-expect-error Tenant Undo tokens must never be coerced to ordinary journal numbers.
    const numberedUndo: typeof undo = { confirm: true, expectedId: 123 };
    // @ts-expect-error Successful tenant writes retain opaque tokens.
    const numberedSave: typeof saved = { ...saved, undoId: 123 };
    // @ts-expect-error Tenant projections do not expose SQL.
    const privateSql: typeof saved = { ...saved, sql: { text: 'private', params: [] } };
    // @ts-expect-error Ordinary consumers retain their existing numeric history contract.
    const changedOrdinary: typeof ordinarySaved = { ...ordinarySaved, undoId: 'opaque' };
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source }, options: { target: 'ES2023' } }), '');
});
