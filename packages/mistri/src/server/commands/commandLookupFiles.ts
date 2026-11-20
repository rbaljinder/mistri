/**
 * A lookup's file reads: `sources.<source>.<file>.readFile`, the handler's `db.<file>.readFile` made for a source's
 * table. Kept apart from createLookupSources (commandLookup.ts), which only asks for the reader, so the command's
 * execution says where the bytes come from and not how a kept file is found.
 */
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import { AppAccessDenied } from '../app/appAccess.js';
import type { CommandFile } from '../../../schema/command.js';
import type { FileScope } from '../files/fileStorage.js';
import type { CommandFileRule } from './businessCommandAuthorization.js';
import { readKeptFile, type CommandCatalog, type FileReadBudget } from './commandDb.js';

/** The lookup's own reader, audited as its other reads are (businessCommandExecution.ts lookupQuery). */
type LookupRows = (source: string, local: string, request: Omit<QueryRequest, 'table'>) => Promise<QueryResult>;

/** The reader `createLookupSources` takes as `readFile`: undefined for a table that is not a file resource. */
export function lookupSourceFiles(
  reader: Readonly<{
    catalogs: Readonly<Record<string, CommandCatalog>>;
    files?(source: string, local: string): CommandFileRule | undefined;
  }>,
  query: LookupRows,
  scope: FileScope | undefined,
  budget: FileReadBudget,
): (source: string, local: string) => ((given: unknown) => Promise<CommandFile>) | undefined {
  return (source, local) => {
    const rule = reader.files?.(source, local);
    const looked = reader.catalogs[source]?.[local];
    if (!rule || !looked) return undefined;
    const name = `${source}.${local}`;
    return async (given) => {
      // A column rule that keeps the file from the role keeps it from the lookup, as from the handler.
      if (!Object.hasOwn(looked.kinds, rule.content)) throw new AppAccessDenied();
      /* The row through the lookup's own reader, audited as its other reads are: the person's scope,
         a link's one record, so a row it cannot see is not found and no object is opened. */
      const rows = { query: (read: QueryRequest) => query(source, local, read) };
      const { file } = await readKeptFile(
        rows,
        { name, verb: 'readFile', via: `sources.${name}`, table: looked, rule, scope, budget },
        given,
      );
      return file;
    };
  };
}
