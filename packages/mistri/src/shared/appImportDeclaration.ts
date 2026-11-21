/*
 * Which import a list offers, apart from everything else about importing
 * (appImport.ts): the list's Import button asks it on every App list, so it
 * stays small enough to stand in the first paint, while the parsers, the
 * cell readers and the dialog that uses them arrive when Import is pressed.
 */
import type { AppCommandReference } from './command.js';

/** The command an import runs: one that targets the record `match` finds, or one that creates (`targets: 'none'`). */
export type ImportCommandReference = AppCommandReference | (Omit<AppCommandReference, 'targets'> & { targets: 'none' });

/** How much one import may carry. The server refuses more before reading it; here, beside
    the declaration, so a route or transport that only sizes a request loads no parser. */
export const IMPORT_LIMITS = Object.freeze({
  /** The file, in UTF-8 bytes. */
  bytes: 5 * 1024 * 1024,
  /** Rows after the header. */
  rows: 5000,
  /** Columns in a line. */
  columns: 200,
  /** Characters in one cell. */
  field: 20_000,
});

/**
 * What a resource or a view opts into. Empty (`import: true`) imports rows
 * as new records through the ordinary insert. With `command`, each row runs
 * that business command on the record `match` finds — for a resource whose
 * writes are the commands', where a plain insert is refused. A creating
 * command (`targets: 'none'`) runs where `match` is absent or finds nothing.
 * With `group`, consecutive rows that agree on those columns are one run:
 * one command input, its repeated group filled from every row of the run.
 */
export interface AppImportDef {
  command?: ImportCommandReference;
  /** A command import's columns that find the record a row runs on. */
  match?: string[];
  /** A command import's columns that say which rows are one parent: consecutive rows that agree are one run. */
  group?: string[];
}

export type ImportApp = {
  resources?: Record<string, { import?: AppImportDef }>;
  views?: Record<string, unknown>;
};

/**
 * The import a list offers: its view's own, else its resource's; nothing
 * where the view says `import: false`. The view's standing `query` is part
 * of it, since a command import finds each row's record among the rows the
 * view lists (the Count sheet imports into the counts that are open).
 */
export function importDeclaration(
  app: ImportApp,
  table: string,
  view?: string,
): { def: AppImportDef; view?: string; query?: string } | undefined {
  if (view !== undefined) {
    const listed =
      app.views && Object.hasOwn(app.views, view)
        ? (app.views[view] as { table?: string; query?: string; import?: AppImportDef | false })
        : undefined;
    if (!listed || listed.table !== table) return undefined;
    if (listed.import === false) return undefined;
    const def = listed.import ?? resourceImport(app, table);
    return def ? { def, view, ...(listed.query ? { query: listed.query } : {}) } : undefined;
  }
  const def = resourceImport(app, table);
  return def ? { def } : undefined;
}

function resourceImport(app: ImportApp, table: string): AppImportDef | undefined {
  return app.resources && Object.hasOwn(app.resources, table) ? app.resources[table].import : undefined;
}
