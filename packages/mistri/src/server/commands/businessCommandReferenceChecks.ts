/** Registration metadata checks shared by browser and inactive API catalogs.
 * Callers retain their diagnostic wording, validation order and authority.
 */
import { logicalResource, type AppDef } from '../../shared/app.js';
import {
  commandInputProblem,
  commandReferenceProblem,
  type AppCommandReference,
  type AppFormCommandReference,
} from '../../shared/command.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { isCapturedTenantData } from '@mistriwork/engine/server/evidence.js';
import { withRollups } from '../../shared/appRollups.js';
import { accessibleSchema } from '../app/appAccess.js';
import type { AnyBusinessCommand } from './businessCommands.js';

/* The catalog a command's reads bound, by the tables it reads. Startup asks
   for it for every action, import and API reference of every command, once
   per owner that binds the registry, and the commands on one table mostly
   read the same tables; making it each time — pruning the catalog, then
   reading every resource's rollups, tabs and computed columns against it —
   was a large part of a field report's minute-long startup. Kept only for a
   captured App and catalog, which cannot change, and only as long as they
   live: a reload captures new ones and starts afresh. */
const boundedCatalogs = new WeakMap<DatabaseSchema, WeakMap<AppDef, Map<string, DatabaseSchema>>>();
/** Test-only: how many bounded catalogs were made rather than reused. */
export const boundedCatalogCounters = { made: 0 };

function boundedCatalog(app: AppDef, schema: DatabaseSchema, readable: Set<string>): DatabaseSchema {
  const make = () => {
    boundedCatalogCounters.made++;
    /* A picker's query is read through the catalog the App serves (`/api/run`),
       so its rollups — `released = 0` on an order — are columns here too. */
    return withRollups(app, accessibleSchema(schema, { readable, writable: new Set() }));
  };
  if (!isCapturedTenantData(app) || !isCapturedTenantData(schema)) return make();
  let byApp = boundedCatalogs.get(schema);
  if (!byApp) boundedCatalogs.set(schema, (byApp = new WeakMap()));
  let byReads = byApp.get(app);
  if (!byReads) byApp.set(app, (byReads = new Map()));
  const key = JSON.stringify([...readable].sort());
  let bounded = byReads.get(key);
  if (!bounded) byReads.set(key, (bounded = make()));
  return bounded;
}

/** Owner is the action's containing resource (or API's registered logical
 * target), never inferred from the reference whose placement is checked.
 */
export function commandReferenceCatalogProblem(
  app: AppDef,
  registration: AnyBusinessCommand,
  reference: AppCommandReference | AppFormCommandReference,
  owner: string,
  schema: DatabaseSchema,
): string | undefined {
  const readable = new Set(registration.read.map((local) => logicalResource(app, registration.source, local)));
  const bounded = boundedCatalog(app, schema, readable);
  return 'target' in reference ? commandReferenceProblem(reference, owner, bounded) : commandInputProblem(reference.input, bounded);
}
