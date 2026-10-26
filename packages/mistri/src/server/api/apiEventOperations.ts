/** The event feed's token operations (apiEventFeed.ts), kept apart from the
 * feed's store readers so the token modules can name them without loading those. */
import type { AppDef } from '../../shared/app.js';
import type { AppApiDef } from '../../shared/appApi.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';

/** One operation per opted-in event, open to every API role: the feed itself
 * narrows each row by what the token's roles read. */
export function apiEventOperations(app: AppDef): { id: string; eligibleRoles: readonly string[] }[] {
  const api = app.api;
  if (!api || app.auth?.rows !== 'all') return [];
  return (api.events ?? []).map((name) => Object.freeze({ id: `event:${name}`, eligibleRoles: Object.freeze([...api.roles]) }));
}

/** The operations a read-only token context scopes by: the reads, and the feed's events. */
export function apiReadTokenCatalog(api: AppApiDef, app: AppDef, schema: DatabaseSchema) {
  const reads = checkApiReadCatalog(api, app, schema).operations.map((operation) =>
    Object.freeze({ id: operation.id, eligibleRoles: operation.eligibleRoles }),
  );
  return Object.freeze({ operations: Object.freeze([...reads, ...apiEventOperations(app)]) });
}
