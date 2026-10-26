/** Private captured command declarations, not native ownership or admission. */
import { isProxy } from 'node:util/types';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { captureTenantData, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import { checkApiOperationCatalog } from '../api/apiOperationCatalog.js';

/** Capture caller-owned declaration containers once; callbacks are trusted host
 * metadata, never user code or proof of connection ownership/currentness. */
export function captureApiTokenCommandContext(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  evidence: Parameters<typeof checkApiOperationCatalog>[3],
) {
  const captured = captureTenantData({ app, schema });
  const declarations = defineCommands(registry);
  const options = tenantOptions(evidence, ['connectionFor', 'writableConnection', 'transactionalConnection']);
  for (const name of ['connectionFor', 'writableConnection', 'transactionalConnection']) {
    if (typeof options[name] !== 'function' || isProxy(options[name])) throw new Error('Command token metadata is unavailable.');
  }
  const trusted = Object.freeze({
    connectionFor: options.connectionFor as typeof evidence.connectionFor,
    writableConnection: options.writableConnection as typeof evidence.writableConnection,
    transactionalConnection: options.transactionalConnection as typeof evidence.transactionalConnection,
  });
  const catalog = checkApiOperationCatalog(captured.app, captured.schema, declarations, trusted);
  return Object.freeze({ ...captured, catalog });
}
