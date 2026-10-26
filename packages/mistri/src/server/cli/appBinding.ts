/**
 * The database an App binds, as the engine's migrate and seed take a target (migrate/target.ts).
 *
 * A module of its own because cli/appTargets.ts hands the stores and files commands to migrate and imports their
 * usage, and those commands bind their App the same way: in appTargets it was a cycle, and a cycle in ES modules is
 * a usage read before it is written.
 */
import { homeSourceOf, type AppDef } from '../../shared/app.js';
import type { TargetBinding } from '@mistriwork/engine/server/migrate/target.js';

/** The connection an App binds (its own, or its home source's) and the schemas its sources keep, home source first. */
export function appBinding(app: AppDef): TargetBinding {
  const home = homeSourceOf(app);
  const sources = Object.entries(app.sources ?? {}).sort(([a], [b]) => (a === home ? -1 : b === home ? 1 : 0));
  const connection = app.connection ?? (home ? app.sources?.[home]?.connection : undefined);
  return {
    ...(connection !== undefined ? { connection } : {}),
    schemas: sources.flatMap(([, source]) =>
      source.schema !== undefined && source.connection !== undefined ? [{ connection: source.connection, schema: source.schema }] : [],
    ),
  };
}
