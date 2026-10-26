/** Native tenant service authority for experiment conversion delivery. Lives
 * with tenant sources so the experiment foundation does not acquire native
 * tenant authority or depend on tenant runtime implementation details. */
import { canonicalCommandJson, snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { captureEventDeliveryPolicy, type EventDeliveryPolicy } from '../../adapters/events/eventDeliveryTypes.js';
import { sameEventSource } from '../../adapters/events/eventSourceIdentity.js';
import { ensure, type CommitGuard, type RegisteredEpoch } from '../experiments/contracts.js';
import type { NativeConversionAuthorityRequest } from '../experiments/conversionOwner.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { getTenantSourceIdentity } from './tenantSourceIdentity.js';

const canonical = (value: unknown) => canonicalCommandJson(value, 262_144);

/** Native tenant service authority for a deployment-enrolled destination. Uses
 * the same genuine-source anchor reads as tenant jobs. Historical membership
 * is not reauthorized: suspension/version changes of current tenant/platform
 * anchors revoke the lease, and retiring this deployment revokes every lease.
 * App-scope hosts supply their own native deployment authority via authorize.
 */
export function createTenantExperimentConversionAuthority(options: {
  readonly reader: TenantReadSource;
  readonly epoch: RegisteredEpoch;
  readonly policy: EventDeliveryPolicy;
}) {
  const reader = captureTenantReadSource(options.reader),
    identity = getTenantSourceIdentity(reader);
  const policy = captureEventDeliveryPolicy(options.policy),
    epoch = snapshot(options.epoch, 65_536).value as unknown as RegisteredEpoch;
  const tenantId = epoch.declaration.scope.evaluationTenantId;
  ensure(
    tenantId !== null &&
      identity.appId === policy.source.appId &&
      identity.storeId === policy.source.storeId &&
      identity.source.id === policy.source.sourceId &&
      epoch.declaration.scope.appId === identity.appId &&
      policy.routes.every((route) => route.scope === 'tenant' && route.tenantId === tenantId),
  );
  let retired = false;
  return Object.freeze({
    async authorize(request: NativeConversionAuthorityRequest): Promise<CommitGuard> {
      ensure(
        !retired &&
          ['observe', 'complete'].includes(request.operation) &&
          canonical(request.epoch) === canonical(epoch) &&
          request.serviceId === policy.serviceId &&
          request.destinationId === policy.destinationId &&
          sameEventSource(request.source, policy.source),
      );
      const captured = await reader.readServiceAnchors(tenantId);
      ensure(captured.tenantVersion !== null && captured.platformVersion !== null, 'Native service anchors are inactive.');
      return async () => {
        ensure(!retired, 'Native conversion authority retired.');
        const current = await reader.readServiceAnchors(tenantId);
        ensure(
          !retired && current.tenantVersion === captured.tenantVersion && current.platformVersion === captured.platformVersion,
          'Native conversion service authority changed.',
        );
      };
    },
    close() {
      retired = true;
    },
  });
}
