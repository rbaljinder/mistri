/**
 * Schema-typed names: emit a .d.ts from a live connection so the editor
 * squiggles a mistyped table before the server ever refuses it.
 *
 * The output pairs with the veneer's TypedAppConfig: table fields become
 * a union of the real tables, and display keys become the real
 * "table.column" pairs. The references say where each hop of a label
 * path lands, so `owner_id.name` is checked segment by segment. `Columns`
 * gives each column's kind, a declared vocabulary as its values, and the
 * file registers it with `References` in @mistriwork/mistri/app's `Register`: a
 * helper that knows its table reads its query strings against them
 * (packages/mistri/schema/query.d.ts), and passes what it cannot read for certain, which
 * the server still judges. Regenerate after a migration; the file says
 * where it came from.
 *
 * An App export also names the server's configured connections, so a
 * mistyped `connection` or `sources.*.connection` fails the typecheck
 * instead of the first start.
 */
import { TAGS_COLUMN } from '@mistriwork/engine/shared/tagLists.js';
import { rollupColumnMeta } from '@mistriwork/engine/shared/rollups.js';
import {
  columnKind,
  CONNECTION_HIDDEN,
  isFlagColumn,
  type ColumnMeta,
  type DatabaseSchema,
  type Dialect,
} from '@mistriwork/engine/shared/schema.js';
import { hopName } from '@mistriwork/engine/shared/view.js';

/** A property key, quoted only when it must be. */
const key = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));

/* The value a command's `db` hands out for a column, which is what the
   driver returns: PostgreSQL's bigint and numeric arrive as text (they do
   not fit a double), MySQL's decimal too. A column declared to hold 64-bit
   or arbitrary-precision numbers — BIGINT, INT8, NUMERIC, DECIMAL — can read
   as a number or, past 2^53, as a lossless string, and is typed so. An
   INTEGER is typed a number: every handler narrowed `qty` before arithmetic
   for a value no quantity reaches, and a column that does hold ids past 2^53
   says so by being declared BIGINT (it still reads losslessly either way). A
   boolean reads true or false on every engine (the handle turns SQLite's 0
   and 1 into them); a date is its text; JSON and bytes are whatever they hold. */
const WIDE_INTEGER = /bigint|int8|big int/;
function valueType(column: ColumnMeta, dialect: Dialect): string {
  const type = (column.type ?? '').toLowerCase();
  const kind = columnKind(column.type);
  const value = /json/.test(type)
    ? 'unknown'
    : kind === 'boolean'
      ? 'boolean'
      : kind === 'number'
        ? (dialect === 'postgres' && /int8|bigint|bigserial|numeric|decimal|money/.test(type)) ||
          (dialect === 'mysql' && /decimal|numeric/.test(type))
          ? 'string'
          : (dialect === 'sqlite' && (WIDE_INTEGER.test(type) || (!/int/.test(type) && !/real|floa|doub/.test(type)))) ||
              ((dialect === 'mysql' || dialect === 'http') && /bigint/.test(type))
            ? 'number | string'
            : 'number'
        : kind === 'date' || kind === 'text'
          ? 'string'
          : 'unknown';
  return column.nullable && value !== 'unknown' ? `${value} | null` : value;
}

/* A column's kind as a query string's checker reads it (packages/mistri/schema/query.d.ts):
   a declared vocabulary is its values, a flag is true or false. */
function kindType(column: ColumnMeta): string {
  /* A machine's groups are words of its column too, which `is` reads (`status is onBench`), beside its states. */
  const groups = Object.keys(column.states?.groups ?? {});
  if (column.allowed?.length) return `[${[...column.allowed, ...groups].map((value) => JSON.stringify(value)).join(', ')}]`;
  if (isFlagColumn(column)) return "'boolean'";
  const kind = columnKind(column.type);
  return kind === 'other' ? "'other'" : `'${kind}'`;
}

/* Each table's hops as a label path writes them — the column, or `a+b` for a
   composite key — and the table each lands on. Two keys over the same columns
   make that name ambiguous, and the path resolver then asks for the
   constraint's name, so those hops are keyed by it instead. A hop landing
   outside the typed tables is left out: the resolver refuses to follow it. */
function referencesOf(schema: DatabaseSchema, ids: ReadonlySet<string>): Map<string, [string, string][]> {
  const byTable = new Map<string, [string, string][]>();
  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
    const outgoing = schema.foreignKeys.filter((fk) => fk.from.table === id && ids.has(fk.to.table));
    const hops: [string, string][] = [];
    for (const fk of outgoing) {
      const name = hopName(fk);
      hops.push([outgoing.filter((other) => hopName(other) === name).length > 1 ? fk.name : name, fk.to.table]);
    }
    const unique = [...new Map(hops).entries()].sort(([a], [b]) => a.localeCompare(b));
    if (unique.length) byTable.set(id, unique);
  }
  return byTable;
}

/**
 * Whether a generated types file says what freshly generated types say: the
 * header line (which command wrote it) and trailing blank lines are not the
 * types. `check` and `build` both ask this, so a file check just wrote is one
 * build agrees with; build compared the text whole, with a newline of its own
 * after it, and called every file check wrote stale (field report N3).
 */
export const sameTypes = (a: string, b: string): boolean =>
  a.split('\n').slice(1).join('\n').trimEnd() === b.split('\n').slice(1).join('\n').trimEnd();

/** The text a generated types file is written as: the types, ending in one newline. */
export const typesFileText = (types: string): string => `${types.trimEnd()}\n`;

/**
 * `hidden` holds, by table, the columns no reader of the App is served — its
 * `hidden` lists, and what every role's column ceiling leaves out. They are
 * still the App's columns: `hidden` and the access rules name them, and a
 * command's handler reads and writes them. So they are typed apart, as
 * `Hidden`, rather than left out: a place that shows a column takes `Tables`
 * alone, and one that governs access takes both.
 */
export function typesForSchema(
  schema: DatabaseSchema,
  appName?: string,
  connections?: readonly string[],
  hidden: Readonly<Record<string, readonly string[]>> = {},
): string {
  const tables = [...schema.tables].sort((a, b) => a.id.localeCompare(b.id));
  const names = [...new Set(connections ?? [])].sort((a, b) => a.localeCompare(b));
  const cut = (table: string, column: string) => hidden[table]?.includes(column) ?? false;
  /* A hop through a hidden column is one no label path can take: the served catalog drops that edge. */
  const references = referencesOf(
    { ...schema, foreignKeys: schema.foreignKeys.filter((fk) => !fk.from.columns.some((column) => cut(fk.from.table, column))) },
    new Set(tables.map((t) => t.id)),
  );
  /* What the connection hides is not in its catalog at all, and is the
     App's to hide again: `hidden` may name it (appAccess.ts). */
  const concealed = tables
    .map(
      (t) =>
        [t.id, [...new Set([...t.columns.filter((c) => cut(t.id, c.name)).map((c) => c.name), ...(t[CONNECTION_HIDDEN] ?? [])])]] as const,
    )
    .filter(([, columns]) => columns.length);
  const computedTables = tables.filter((t) => t.computed && Object.keys(t.computed).length);
  const generics = (base: string) => (concealed.length ? `${base}, Hidden` : base);
  const lines: string[] = [
    /* An App's file is kept by the authoring loop, so its header names the
       loop: `mistri check` rewrites it when the database or the App's
       resources move (`--app --export types` prints the same file). */
    appName
      ? `// Generated by \`mistri check --app <app>\` from the ${JSON.stringify(appName)} app resources.`
      : `// Generated by \`mistri --export types\` from the ${JSON.stringify(schema.label)} connection.`,
    appName
      ? '// mistri check regenerates it after a migration; do not edit by hand.'
      : '// Regenerate after a migration; do not edit by hand.',
    "import type { TypedAppConfig, TypedFeature, AppFlagValues } from '@mistriwork/mistri/app';",
    '',
    '/** Every table, and every column it had when this file was written.',
    '    A type alias, not an interface: the TypedAppConfig constraint needs',
    '    the structural index an interface refuses to imply. */',
    'export type Tables = {',
    /* An App's rollups and computed columns read like columns wherever a
       column is shown, sorted or dressed (rollups.ts, computed.ts), so they
       are named with the columns here; a row a command reads has none, so
       `Rows` below leaves them out. */
    ...tables.map(
      (t) =>
        `  ${key(t.id)}: ${
          [
            ...t.columns.filter((c) => !cut(t.id, c.name)).map((c) => c.name),
            ...Object.keys(t.rollups ?? {}),
            ...Object.keys(t.computed ?? {}),
            ...(t.tags ? [TAGS_COLUMN] : []),
          ]
            .map((name) => JSON.stringify(name))
            .join(' | ') || 'never'
        };`,
    ),
    '};',
    '',
    ...(computedTables.length
      ? [
          "/** Each computed column's value, by table: a yes-or-no, a number or a date",
          '    (an ISO day), as a list or a custom component reads it. */',
          'export type Computed = {',
          ...computedTables.map(
            (t) =>
              `  ${key(t.id)}: { ${Object.entries(t.computed!)
                .map(
                  ([name, computed]) =>
                    `${key(name)}: ${computed.type === 'boolean' ? 'boolean' : computed.type === 'number' ? 'number | null' : 'string | null'}`,
                )
                .join('; ')} };`,
          ),
          '};',
          '',
        ]
      : []),
    ...(concealed.length
      ? [
          "/** Each table's columns no reader is served (`hidden`, or outside every role's",
          '    ceiling): what `hidden` and the access rules may name, and no place that',
          "    shows a column. A command's `Rows` still carry them. */",
          'export type Hidden = {',
          ...concealed.map(([table, columns]) => `  ${key(table)}: ${columns.map((name) => JSON.stringify(name)).join(' | ')};`),
          '};',
          '',
        ]
      : []),
    "/** Each table's row as a command handler reads it, every column with its",
    "    value's type: what `defineSource<Rows>` in @mistriwork/mistri/commands types. */",
    'export type Rows = {',
    ...tables.map((t) => `  ${key(t.id)}: { ${t.columns.map((c) => `${key(c.name)}: ${valueType(c, schema.dialect)}`).join('; ')} };`),
    '};',
    '',
    "/** Each table's references, by the name a label path follows (`owner_id`",
    '    in `owner_id.name`), and the table each lands on: what lets every hop of',
    '    a path be checked. A table that references nothing is absent. */',
    'export type References = {',
    ...[...references].map(
      ([table, hops]) => `  ${key(table)}: { ${hops.map(([hop, target]) => `${key(hop)}: ${JSON.stringify(target)}`).join('; ')} };`,
    ),
    '};',
    '',
    "/** Each column's kind as a query string reads it — text, number, date, boolean, or",
    '    other — with a declared vocabulary as its values: what `listView`, `metric`',
    '    and the other helpers that name a table check their `query`, `sort`,',
    '    `measure` and `by` against. */',
    'export type Columns = {',
    ...tables.map(
      (t) =>
        `  ${key(t.id)}: { ${[
          ...t.columns.filter((c) => !cut(t.id, c.name)).map((c) => `${key(c.name)}: ${kindType(c)}`),
          ...Object.entries(t.rollups ?? {}).map(([name, rollup]) => `${key(name)}: ${kindType(rollupColumnMeta(name, rollup))}`),
          ...Object.entries(t.computed ?? {}).map(([name, computed]) => `${key(name)}: '${computed.type}'`),
          // A record's tags (tagLists.ts): asked with `has`, any value a label.
          ...(t.tags ? [`${key(TAGS_COLUMN)}: 'other'`] : []),
        ].join('; ')} };`,
    ),
    '};',
    '',
    /* A segment is a word a condition may say, and what a tab or a source names (appSegments.ts): one
       misspelled is a type error where it is written. */
    ...(tables.some((t) => t.segments && Object.keys(t.segments).length)
      ? [
          "/** Each table's segments, by name: what a tab, a `table.segment` source and a bare word in a query may name. */",
          'export type Segments = {',
          ...tables
            .filter((t) => t.segments && Object.keys(t.segments).length)
            .map(
              (t) =>
                `  ${key(t.id)}: ${Object.keys(t.segments!)
                  .map((name) => JSON.stringify(name))
                  .join(' | ')};`,
            ),
          '};',
          '',
        ]
      : []),
    ...(names.length
      ? [
          '/** The server connections this App may bind, by name: what `connection`',
          '    and `sources.*.connection` accept. */',
          `export type Connections = ${names.map((name) => JSON.stringify(name)).join(' | ')};`,
          '',
        ]
      : []),
    '/** The app config with this schema’s own names: use `satisfies App`',
    '    (TS) or a JSDoc `@type` line (JS) on the default export. */',
    `export type App = TypedAppConfig<${generics(`Tables, References${names.length ? ', Connections' : concealed.length ? ', string' : ''}`)}>;`,
    '',
    '/** A feature of the app, in the same names: `defineFeature({ … } satisfies Feature)`. */',
    `export type Feature = TypedFeature<${generics('Tables, References')}>;`,
    '',
    '/** Schema-checked pieces for separate authoring modules. Use `satisfies`',
    "    to retain literal names for defineApp's cross-module reference checks. */",
    "export type Resources = NonNullable<App['resources']>;",
    "export type Views = NonNullable<App['views']>;",
    "export type Pages = NonNullable<App['pages']>;",
    'export type Page = Pages[string];',
    "export type Navigation = NonNullable<App['nav']>;",
    '',
    '/** Pass the authored manifest type (including features) for exact flag names and values. */',
    'export type Flags<Manifest> = AppFlagValues<Manifest>;',
    'export type FlagName<Manifest> = keyof Flags<Manifest>;',
    '',
    /* A method, not a property: a program that reaches two Apps' files merges
       two overloads where two properties would clash, and the checker then
       stands down rather than read one App by the other's columns. */
    "declare module '@mistriwork/mistri/app' {",
    `  interface Register { schema(): { columns: Columns; references: References${
      tables.some((t) => t.segments && Object.keys(t.segments).length) ? '; segments: Segments' : ''
    } } }`,
    '}',
    '',
  ];
  return lines.join('\n');
}

/** One command as mistri-commands.d.ts describes it: what the App's names are checked against. */
interface TypedCommand {
  target: string;
  targets: 'one' | 'many' | 'none';
  input: readonly string[];
  public?: true;
}

/**
 * mistri-commands.d.ts: the App's commands by name, generated from its
 * commands module, which the App never imports. It fills `Register` in
 * @mistriwork/mistri/app, so `command: 'assignReviewr'`, a record's command on another
 * table, a form over a command that names a record, or a step field that is
 * not one of its command's inputs fails the typecheck, where it used to
 * fail at load or not at all. It also names the App's free-form pages by
 * their paths, which `home` may name beside its views: a page is a file the
 * App definition never imports either. An App with pages and no commands
 * module gets the file for its pages alone (`commands` undefined).
 */
export function commandTypes(
  commands: Readonly<Record<string, TypedCommand>> | undefined,
  appName: string,
  /** The commands module, from beside this file, where it exports page loaders: their results type the pages' `data`. */
  loadersFrom?: string,
  /** The App's free-form pages, by path. */
  pages: readonly string[] = [],
): string {
  const union = (names: readonly string[]) => (names.length ? names.map((name) => JSON.stringify(name)).join(' | ') : 'never');
  const registered = [
    ...(commands ? ['commands: Commands'] : []),
    ...(loadersFrom ? ['loaders: Loaders'] : []),
    ...(pages.length ? ['pagePaths: PagePaths'] : []),
  ];
  return [
    `// Generated by \`mistri check --app <app>\` from the ${JSON.stringify(appName)} app's ${commands ? 'commands module' : 'pages'}.`,
    `// mistri check regenerates it when ${commands ? 'a command' : 'a page'} changes; do not edit by hand.`,
    '',
    ...(commands
      ? [
          '/** Each command by its name: the table it acts on, how many existing records a request names',
          "    (none: a form's command), its input names, and whether a public form runs it. */",
          'export type Commands = {',
          ...Object.keys(commands)
            .sort()
            .map((id) => {
              const command = commands[id];
              return `  ${key(id)}: { target: ${JSON.stringify(command.target)}; targets: ${JSON.stringify(command.targets)}; input: ${union(command.input)}${command.public ? '; public: true' : ''} };`;
            }),
          '};',
          '',
        ]
      : []),
    ...(loadersFrom
      ? [
          "/** Each free-form page's loader by its name, as the commands module exports them: what a page's `data` is typed from. */",
          `export type Loaders = typeof import(${JSON.stringify(loadersFrom)}).loaders;`,
          '',
        ]
      : []),
    ...(pages.length
      ? [
          "/** Each free-form page by its path (pages/<path>.page.tsx): what the App's `home` may name beside its views. */",
          `export type PagePaths = ${union([...pages].sort())};`,
          '',
        ]
      : []),
    "declare module '@mistriwork/mistri/app' {",
    `  interface Register { ${registered.join('; ')} }`,
    '}',
    '',
  ].join('\n');
}
