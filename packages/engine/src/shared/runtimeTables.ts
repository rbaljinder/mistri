/** The prefix every table of the App framework's own runtime state carries on SQLite, in
 * the App's own database. On PostgreSQL the runtime has a schema of its own instead (`RUNTIME_SCHEMA`),
 * but an App table named with the prefix is still refused there (adapters/reservedSql.ts), so one
 * rule about names holds on every engine. */
const RUNTIME_TABLE_PREFIX = '__mistri_';
export const RUNTIME_TABLE_PREFIXES = Object.freeze([RUNTIME_TABLE_PREFIX] as const);

/** Reserved physical table names are runtime state, never App resources.
 * Pass an unqualified table name, not a SQL fragment or logical alias. */
export const isRuntimeTable = (name: string): boolean => {
  const lower = name.toLowerCase();
  return RUNTIME_TABLE_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

export type RuntimeDialect = 'postgres' | 'sqlite';

/** The PostgreSQL schema every runtime table lives in, under its plain name: the command journal,
 * the tenant store, sign-in (Better Auth's tables, renamed `auth_*`), flags (`flag_*`),
 * experiments (`experiment_*`), analytics (`analytics_*`) and a suite's stores (`suite_*`).
 * A schema rather than a prefix in `public` because a grant on `public` then reaches none of it,
 * `pg_dump -n` splits the App from the runtime, and the migration diff, scoped to the App's
 * schema, never sees it. The database browser and the App catalog hide it by this name. */
export const RUNTIME_SCHEMA = 'mistri';

/** Where each dialect puts the runtime tables. */
const PLACEMENT = Object.freeze({
  postgres: RUNTIME_SCHEMA,
  sqlite: 'main',
} as const);

/** A runtime table's logical name, whether the caller holds it bare (`history_change`) or as the
 * physical name its store pins on SQLite (`__mistri_history_change`). Anything else is not
 * a table name, so it is refused here instead of being quoted. */
const logicalName = (name: string): string => {
  const bare = name.startsWith(RUNTIME_TABLE_PREFIX) ? name.slice(RUNTIME_TABLE_PREFIX.length) : name;
  if (bare === '' || /[^a-z0-9_$]/i.test(bare)) throw new Error(`Not a runtime table name: ${JSON.stringify(name)}.`);
  return bare;
};

/** The one placement function: a runtime table's qualified, quoted SQL name. Postgres
 * `mistri."x"`, SQLite `main."__mistri_x"`. */
export const runtimeTable = (dialect: RuntimeDialect, name: string): string => {
  const { schema, relname } = runtimeRelation(dialect, name);
  return `${schema}."${relname}"`;
};

/** The schema a dialect's runtime tables sit in: for the pinned layouts and catalog readers that
 * name a schema without a table. */
export const runtimeSchema = (dialect: 'postgres' | 'sqlite'): string => PLACEMENT[dialect];

/** The same placement as catalog coordinates: what `information_schema`, `pg_class` and
 * `sqlite_schema` readers compare against. Postgres names the table plainly; the others keep the prefix. */
export const runtimeRelation = (dialect: RuntimeDialect, name: string): { schema: string; relname: string } => ({
  schema: PLACEMENT[dialect],
  relname: dialect === 'postgres' ? logicalName(name) : `${RUNTIME_TABLE_PREFIX}${logicalName(name)}`,
});

/** A runtime name as this dialect spells it, unqualified: an index, a sequence or a key a store
 * pins beside its tables, or a store's name prefix for a catalog scan (`__mistri_job_` is
 * `job_` inside the Postgres schema). */
export const runtimeName = (dialect: RuntimeDialect, name: string): string => runtimeRelation(dialect, name).relname;

/** Whether a catalog relation is runtime state on this dialect: on Postgres anything in the
 * runtime schema, whatever it is called; elsewhere a prefixed name (in `main` on SQLite). */
export const isRuntimeRelation = (dialect: RuntimeDialect, schema: string | null, name: string): boolean => {
  if (dialect === 'postgres') return schema !== null && schema.toLowerCase() === RUNTIME_SCHEMA;
  if (dialect === 'sqlite' && schema !== PLACEMENT.sqlite) return false;
  return isRuntimeTable(name);
};

/** The functions the runtime schema may hold beside its tables, each a store's own (the epoch
 * trigger's, and the append-only triggers of flags, experiments and analytics). Ownership checks
 * count anything else there, a function, operator or type, as planted: Better Auth resolves its
 * unqualified names through this schema. */
export const RUNTIME_SCHEMA_FUNCTIONS: readonly string[] = Object.freeze([
  'schema_epoch_bump',
  'flag_immutable',
  'experiment_immutable',
  'analytics_append_only',
]);

/** The store prefixes whose owner may be a role other than the schema's: a suite's flag or
 * experiment control can run as its own role, granted USAGE and CREATE on the runtime schema.
 * Such a grant is not a foreign one (adapters/postgresRuntimeSchema.ts). */
export const RUNTIME_CONTROL_PREFIXES: readonly string[] = Object.freeze(['flag_', 'experiment_']);

/** A store's table names (each as its SQLite layout pins it) as PostgreSQL spells them
 * inside the runtime schema: what its pinned PostgreSQL layout and the names derived from a
 * table's (`<table>_pkey`, `<table>_id_seq`) are built from. */
export const postgresRuntimeNames = <T extends Readonly<Record<string, string>>>(tables: T): { readonly [K in keyof T]: string } =>
  Object.freeze(Object.fromEntries(Object.entries(tables).map(([key, name]) => [key, runtimeName('postgres', name)]))) as {
    readonly [K in keyof T]: string;
  };
