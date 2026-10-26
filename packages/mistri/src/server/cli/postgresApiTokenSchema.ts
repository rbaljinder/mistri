/** Private one-shot logical catalog acquisition, not auth/issuance authority.
 * Inputs must come from the trusted loaded invocation and PG context resolver.
 * Context excludes are already resolved secrets, never credential references. */
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { homeSourceOf } from '../../shared/app.js';
import { Registry, type ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { appProblems, type LoadedApp } from '../app/apps.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { assertAppApiContext, readApiApp } from '../api/appApiValidation.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import type { PostgresSeparationConnection } from '../auth/authStoreSeparation.js';
import { captureTokenCommandEvidence, type TokenCommandEvidence } from './apiTokenSchema.js';

const refuse = (): never => {
  throw new Error('PostgreSQL token issuance schema is unavailable.');
};
export async function loadPostgresTokenSchema(
  loaded: LoadedApp,
  configured: readonly ConnectionConfig[],
  capturedExclusions: readonly PostgresSeparationConnection[],
  capture?: (evidence: TokenCommandEvidence) => void,
): Promise<DatabaseSchema> {
  const registry = new Registry();
  try {
    if (!loaded.app.api) return refuse();
    assertAppApiContext(readApiApp(loaded.app));
    const connections = captureTenantData(configured),
      exclusions = captureTenantData(capturedExclusions);
    if (
      !Array.isArray(connections) ||
      !connections.length ||
      connections.length > 128 ||
      !Array.isArray(exclusions) ||
      exclusions.length > 128
    )
      return refuse();
    const ids = new Set<string>();
    for (const connection of connections) {
      if (
        typeof connection.id !== 'string' ||
        !connection.id ||
        ids.has(connection.id) ||
        typeof connection.name !== 'string' ||
        !connection.name ||
        typeof connection.url !== 'string'
      )
        return refuse();
      ids.add(connection.id);
    }
    for (const exclusion of exclusions) {
      if (
        !exclusion ||
        typeof exclusion !== 'object' ||
        typeof exclusion.name !== 'string' ||
        !exclusion.name ||
        exclusion.source !== 'session' ||
        typeof exclusion.url !== 'string' ||
        !/^postgres(?:ql)?:\/\//i.test(exclusion.url) ||
        exclusion.url !== exclusion.url.trim() ||
        /[\p{Cc}\p{Cs}]/u.test(exclusion.url)
      )
        return refuse();
    }
    const reference = loaded.app.sources ? loaded.app.sources[homeSourceOf(loaded.app)!]?.connection : loaded.app.connection;
    const matches = connections.filter(
      (connection) => reference === undefined || connection.id === reference || connection.name === reference,
    );
    if (matches.length !== 1 || matches[0].http) return refuse();
    const selected = matches[0];
    // Existing context records names, not config IDs. Require global name
    // uniqueness rather than guessing which same-named credential it captured.
    if (connections.filter((connection) => connection.name === selected.name).length !== 1) return refuse();
    const targets = exclusions.filter((exclusion) => exclusion.name === selected.name);
    if (targets.length !== 1) return refuse();
    registry.add({ ...selected, url: targets[0].url, source: 'session', writable: false }, { resolved: true });
    const runtime = await loadAppRuntimeResources(registry, loaded.app, selected.id);
    if (runtime.schema.dialect !== 'postgres' || appProblems(loaded, runtime.schema).length) return refuse();
    capture?.(captureTokenCommandEvidence(runtime, selected));
    return runtime.schema;
  } catch {
    return refuse();
  } finally {
    await registry.closeAll();
  }
}
