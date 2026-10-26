/** Private combined declaration checks, not native admission or token authority. */
import type { AppDef } from '../../shared/app.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { captureTenantData, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import { checkApiCommandCatalog } from './apiCommandCatalog.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { withApiWrites } from './apiGenericWrites.js';
import { apiEventOperations } from './apiEventOperations.js';

/** App/API are parser-normalized, schema is the App's logical schema, registry
 * contains real defineCommand declarations. Connection evidence is trusted host
 * metadata, not user input or proof that a native connection is owned/current.
 * No input/output validator, initial, lookup, availability or handler is invoked.
 * This does not change active read, token issuance, or native context refusals. */
export function checkApiOperationCatalog(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  evidence: Parameters<typeof checkApiCommandCatalog>[4],
) {
  const declared = captureTenantData({ app, schema });
  if (!declared.app.api) throw new Error("API operation validation requires the App's declared API.");
  // Generic writes are commands the platform defines; a caller holding the
  // App's own declaration and registry sees them exactly as the owner does.
  const served = withApiWrites(declared.app, declared.schema, registry);
  const captured = { app: served.app, schema: declared.schema };
  const api = captured.app.api!;
  // Only the read checker sees this projection. The original App and grants
  // remain intact, and the actual command declarations are checked separately.
  const reads = checkApiReadCatalog({ ...api, commands: [] }, captured.app, captured.schema);
  let commands: ReturnType<typeof checkApiCommandCatalog>['operations'] = [];
  if (api.commands.length) {
    registry = served.registry!;
    const options = tenantOptions(evidence, ['connectionFor', 'writableConnection', 'transactionalConnection']);
    commands = checkApiCommandCatalog(api, captured.app, captured.schema, registry, {
      connectionFor: options.connectionFor as typeof evidence.connectionFor,
      writableConnection: options.writableConnection as typeof evidence.writableConnection,
      transactionalConnection: options.transactionalConnection as typeof evidence.transactionalConnection,
    }).operations;
  }
  const operations = Object.freeze(
    [...reads.operations, ...commands, ...apiEventOperations(captured.app)].map((operation) =>
      Object.freeze({
        id: operation.id,
        eligibleRoles: Object.freeze([...operation.eligibleRoles]),
      }),
    ),
  );
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
    throw new Error('API operation identities must be unique.');
  return Object.freeze({
    stage: 'operation-validation-foundation' as const,
    authority: 'pending' as const,
    execution: 'pending' as const,
    publication: 'pending' as const,
    operations,
  });
}
