import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { homeSourceOf, type AppDef } from '../../shared/app.js';
import type { AppPolicyAcquisition } from './appPolicyDeployment.js';
import { AppRowPolicyDefinitionError, AppUnderPolicyStartupError, policyStartupFailure } from './appRowPolicy.js';
import { recordRefusalCause } from '@mistriwork/engine/server/evidence.js';
import { appSourceConnections, loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';

/** Startup adapter for the deployment's lease-provider contract. Take all leases
 * before opening; partial failures wait for the existing allSettled source loader
 * before releasing. Registry shutdown/retarget timeouts are NOT indefinite pins:
 * the host must retire its policy deployment before closing or replacing sources. */
export async function acquireAppPolicyResources(registry: Registry, input: AppDef): Promise<AppPolicyAcquisition> {
  const releases: Array<() => void> = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    let failed = false;
    for (const cleanup of releases.reverse()) {
      try {
        cleanup();
      } catch {
        failed = true;
      }
    }
    if (failed) throw new AppRowPolicyDefinitionError();
  };
  try {
    const app = snapshotScopedData(input);
    const defaultSource = homeSourceOf(app);
    const refuse = (reason: string): never => {
      throw recordRefusalCause(new AppUnderPolicyStartupError(), reason);
    };
    if (!app.sources || !defaultSource) return refuse('A row-policy App names its sources: sources: { <name>: { connection } }.');
    const bindings = appSourceConnections(registry, app);
    const entry = bindings.get(defaultSource);
    if (!entry) return refuse(`The App's source "${defaultSource}" names a connection this server does not have.`);
    // Detect registry configuration changes during async acquisition without
    // exposing configuration (including credential references) to the caller.
    const configurations = new Map(
      [...bindings.values()].map((owner) => {
        const config = registry.configOf(owner);
        if (!config) refuse(`The connection "${owner}" has no configuration on this server.`);
        return [owner, JSON.stringify(snapshotScopedData(config))];
      }),
    );
    for (const owner of bindings.values()) releases.push(registry.lease(owner));
    const resources = await loadAppRuntimeResources(registry, app, entry);
    const current = appSourceConnections(registry, app);
    if (
      current.size !== bindings.size ||
      [...bindings].some(([source, owner]) => current.get(source) !== owner) ||
      [...configurations].some(([owner, snapshot]) => JSON.stringify(snapshotScopedData(registry.configOf(owner))) !== snapshot)
    ) {
      refuse("The server's connections changed while the row policy started; start it again.");
    }
    return { resources, sourceConnections: bindings, release };
  } catch (error) {
    try {
      release();
    } catch {
      /* Never return private driver/configuration errors. */
    }
    // Never returned; recorded for the operator's console (evidence.ts), as the App's own failure.
    throw policyStartupFailure(error);
  }
}
