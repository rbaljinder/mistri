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
import { withRollups } from '../../shared/appRollups.js';
import { accessibleSchema } from '../app/appAccess.js';
import type { AnyBusinessCommand } from './businessCommands.js';

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
  /* A picker's query is read through the catalog the App serves (`/api/run`),
     so its rollups — `released = 0` on an order — are columns here too. */
  const bounded = withRollups(app, accessibleSchema(schema, { readable, writable: new Set() }));
  return 'target' in reference ? commandReferenceProblem(reference, owner, bounded) : commandInputProblem(reference.input, bounded);
}
