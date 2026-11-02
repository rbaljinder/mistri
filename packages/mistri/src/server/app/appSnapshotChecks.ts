/**
 * `[command-snapshot]`: what `snapshot: true` on a command means on the
 * engine its target is read on (snapshotRead.ts). On PostgreSQL it opens the
 * command's transaction REPEATABLE READ. An HTTP source has no transaction to
 * read one snapshot in, so the declaration is a problem; on SQLite the writer
 * already holds the file from its first statement to its last, so it changes
 * nothing there, and check says so once rather than let it look like it did.
 */
import type { Dialect } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';

/** `dialectOf`: the engine a resource is read on, as the App's catalog says it (a table's sourceDialect, else the catalog's). */
export function snapshotCommandChecks(
  commands: BusinessCommandRegistry | undefined,
  dialectOf: (resource: string) => Dialect | undefined,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const [id, command] of Object.entries(commands ?? {})) {
    if (command.snapshot !== true) continue;
    const dialect = dialectOf(command.target);
    if (dialect === 'http')
      problems.push(
        `command "${id}" asks for snapshot: true on "${command.target}", which an HTTP source serves [command-snapshot]: ` +
          'it has no transaction to read one snapshot in. Drop snapshot.',
      );
    else if (dialect === 'sqlite')
      warnings.push(
        `command "${id}" asks for snapshot: true on SQLite [command-snapshot]: its writer reads one snapshot already, ` +
          'so this changes nothing here; on PostgreSQL it opens the transaction REPEATABLE READ.',
      );
  }
  return { problems, warnings };
}
