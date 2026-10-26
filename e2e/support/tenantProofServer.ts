import { startTenantApp } from './tenantServer.js';
import { tenantProofModel, tenantProofRows, type TenantProofKind } from '../../test/support/tenantProofModel.js';
import { tenantAssignmentModel, tenantAssignmentRows } from '../../test/support/tenantAssignmentModel.js';
import { tenantInventoryModel, tenantInventoryRows } from '../../test/support/tenantInventoryModel.js';
import type { TenantEventsFixture } from '../../test/support/tenantAssignmentEvents.js';

/** Both Apps use the existing isolated-process owner and real platform host. */
export async function startTenantProof(kind: TenantProofKind, options: { live?: boolean | 'unasked' } = {}) {
  const model = tenantProofModel(kind);
  const fixture = await startTenantApp({ appId: `tenant-${kind}`, tenantProof: kind, ...(options.live ? { live: options.live } : {}) });
  return {
    ...fixture,
    appName: `${kind === 'ignition' ? 'Ignition' : 'Thread'} · Tenant proof`,
    model,
    rows: tenantProofRows,
    accounts: { member: fixture.accounts.alice, manager: fixture.accounts.bob, viewer: fixture.accounts.visitor },
  };
}
export type TenantProofFixture = Awaited<ReturnType<typeof startTenantProof>>;

export async function startTenantAssignment(options: { tenantEvents?: TenantEventsFixture } = {}) {
  const fixture = await startTenantApp({
    appId: tenantAssignmentModel.appId,
    tenantProof: 'ignition',
    tenantAssignment: true,
    ...(options.tenantEvents ? { tenantEvents: options.tenantEvents } : {}),
  });
  return {
    ...fixture,
    appName: tenantAssignmentModel.appName,
    model: tenantProofModel('ignition'),
    rows: tenantProofRows,
    assignment: tenantAssignmentModel,
    assignmentRows: tenantAssignmentRows,
    accounts: { member: fixture.accounts.alice, manager: fixture.accounts.bob, viewer: fixture.accounts.visitor },
  };
}
export type TenantAssignmentFixture = Awaited<ReturnType<typeof startTenantAssignment>>;

export async function startTenantInventory() {
  const fixture = await startTenantApp({ appId: tenantInventoryModel.appId, tenantProof: 'ignition', tenantInventory: true });
  return {
    ...fixture,
    appName: tenantInventoryModel.appName,
    model: tenantProofModel('ignition'),
    rows: tenantProofRows,
    assignment: tenantAssignmentModel,
    assignmentRows: tenantAssignmentRows,
    inventory: tenantInventoryModel,
    inventoryRows: tenantInventoryRows,
    accounts: { member: fixture.accounts.alice, manager: fixture.accounts.bob, viewer: fixture.accounts.visitor },
  };
}
export type TenantInventoryFixture = Awaited<ReturnType<typeof startTenantInventory>>;
