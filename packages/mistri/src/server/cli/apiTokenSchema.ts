/** Invocation-owned logical catalog snapshot, not issuance authority or a
 * transaction shared with the auth store. Never bootstraps an auth/command host. */
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { homeSourceOf } from '../../shared/app.js';
import { Registry, type ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { appProblems, type LoadedApp } from '../app/apps.js';
import { loadAppRuntimeResources, type RuntimeResources } from '../app/appRuntimeResources.js';
import { assertAppApiContext, readApiApp } from '../api/appApiValidation.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { commandsOf } from '../stores/commandStores.js';

/** Command-catalog evidence from the same catalog read as the schema, for
 * command token issuance only: where each logical resource is bound, whether
 * that connection is configured writable, and whether its adapter offers a
 * command transaction. Configuration facts, not authority: serving recomputes
 * every command operation from its own runtime before any token observes it. */
export type TokenCommandEvidence = Readonly<{
  connectionFor(resource: string): string;
  writableConnection(id: string): boolean;
  transactionalConnection(id: string): boolean;
}>;

export function captureTokenCommandEvidence(runtime: RuntimeResources, selected: ConnectionConfig): TokenCommandEvidence {
  const id = selected.id,
    writable = selected.writable === true;
  const transactional = typeof commandsOf(runtime.forConnection(id)).commandTransaction === 'function';
  return Object.freeze({
    connectionFor: runtime.connectionFor,
    writableConnection: (owner: string) => owner === id && writable,
    transactionalConnection: (owner: string) => owner === id && transactional,
  });
}

export async function loadSqliteTokenSchema(
  loaded: LoadedApp,
  configured: readonly ConnectionConfig[],
  capture?: (evidence: TokenCommandEvidence) => void,
): Promise<DatabaseSchema> {
  const registry = new Registry();
  try {
    if (!loaded.app.api) throw new Error('An explicit API declaration is required.');
    assertAppApiContext(readApiApp(loaded.app));
    const connections = captureTenantData(configured);
    if (!Array.isArray(connections) || !connections.length || connections.length > 128) throw new Error('Invalid connections.');
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
        throw new Error('Invalid connection.');
      ids.add(connection.id);
    }
    const reference = loaded.app.sources ? loaded.app.sources[homeSourceOf(loaded.app)!]?.connection : loaded.app.connection;
    const matches = connections.filter(
      (connection) => reference === undefined || connection.id === reference || connection.name === reference,
    );
    if (matches.length !== 1) throw new Error('Unconfigured or ambiguous App connection.');
    const selected = matches[0];
    const url = selected.url;
    if (
      selected.http ||
      !url ||
      url.trim() !== url ||
      /[\p{Cc}\p{Cs}]/u.test(url) ||
      /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(url) ||
      url.startsWith('~') ||
      /^[a-z][a-z0-9+.-]*:/i.test(url)
    )
      throw new Error('A literal SQLite file path is required.');
    const path = resolve(url);
    const observe = () => {
      const canonical = realpathSync(path),
        stat = statSync(canonical, { bigint: true });
      if (!stat.isFile()) throw new Error('An existing regular SQLite file is required.');
      return `${canonical}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    };
    const before = observe();
    registry.add({ ...selected, url: path, writable: false });
    const runtime = await loadAppRuntimeResources(registry, loaded.app, selected.id);
    const problems = appProblems(loaded, runtime.schema);
    if (problems.length) throw new Error('The App catalog is invalid.');
    if (observe() !== before) throw new Error('The SQLite source changed while reading its catalog.');
    capture?.(captureTokenCommandEvidence(runtime, selected));
    return runtime.schema;
  } catch {
    // Neither connection credentials nor App/schema details belong in errors.
    throw new Error('SQLite token issuance schema is unavailable.');
  } finally {
    await registry.closeAll();
  }
}
