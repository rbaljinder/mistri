/**
 * A command's lookup: what it reads from its App's other sources before its
 * transaction opens — reference data in another database, or an HTTP
 * connection read through egress and its description.
 *
 *   sources: { valuations: ['estimate'] },
 *   async lookup({ sources, record }) {
 *     return { estimate: await sources.valuations.estimate.find({ stock_ref: record.stock_ref }) };
 *   },
 *
 * The handles read only: `get`, `find` and `where`, under the same resource
 * ceiling and role grants as the command's own reads. There is no `count`,
 * because an API reports no totals and one rule is kept for both kinds of
 * source. What `lookup` returns is JSON, bounded and frozen, and reaches the
 * handler as `lookup`; it is not part of the fingerprint, since it is read,
 * not asked for. A lookup that fails does not refuse at once: the
 * transaction still finds the request's receipt, so a replay answers as it
 * always did, and only a first attempt is refused, `temporarily_unavailable`
 * and not applied. A `refuse(...)` inside lookup keeps its own code.
 *
 * A tenant App looks up only resources every tenant already reads (`owner:
 * 'global'`), through the tenant's own row scope; the platform realm does
 * the same. A row-policy App looks up nothing yet. Both are checked when the
 * commands bind, so startup and mistri check refuse them.
 */
import type { QueryRequest, QueryResult, ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { logicalResource, type AppDef } from '../../shared/app.js';
import { canonicalCommandJson } from './commandPayload.js';
import { refuse } from './commandErrors.js';
import type { BusinessCommandAuthorization } from './businessCommandAuthorization.js';
import { TENANT_RULE } from './commandLookupRules.js';
import { CommandLookupRefusal, type BusinessCommandRegistry } from './businessCommands.js';
import {
  canonicalKey,
  compileWhere,
  keyFilter,
  normalizeRow,
  type CommandCatalog,
  type Query,
  type UntypedRow,
  type Where,
} from './commandDb.js';

/** What lookup reads a table with: a query on one declared table of one source, outside any transaction. */
type LookupQuery = (source: string, local: string, request: Omit<QueryRequest, 'table'>) => Promise<QueryResult>;

/** What a binding hands the executor for a command that looks up. */
export interface CommandLookupReader {
  /** Each declared source's tables, by local name. */
  readonly catalogs: Readonly<Record<string, CommandCatalog>>;
  readonly query: LookupQuery;
  /** The target by its canonical key, as it stands before the transaction; undefined when it is not there. */
  target(key: Readonly<Record<string, string | number>>): Promise<Readonly<Record<string, unknown>> | undefined>;
}

/**
 * A tenant's or the platform realm's lookup reader: every read through the
 * context's own row scope, outside the command transaction, so a lookup sees
 * exactly what that context may read — and, in a tenant App, only global rows
 * are ever declared (assertGlobalLookups).
 */
export function scopedLookupReader(
  authorization: Pick<BusinessCommandAuthorization, 'lookupTables' | 'resource'>,
  reads: () => Promise<ScopedReads>,
): CommandLookupReader {
  const tables = authorization.lookupTables!;
  // Scoped reads take App resource names and map them to the tenant's
  // physical tables themselves (mapAppScopedReads); a physical name is unknown to them.
  return Object.freeze<CommandLookupReader>({
    catalogs: tables.catalogs,
    query: async (source, local, request) => (await reads()).query({ ...request, table: tables.logical(source, local) }),
    async target(key) {
      const found = await (await reads()).query({ table: authorization.resource, filter: keyFilter(key), limit: 2, offset: 0 });
      return found.rows.length === 1 ? (found.rows[0] as Readonly<Record<string, unknown>>) : undefined;
    },
  });
}

/** One looked-up table, read only. */
export interface LookupTable<Row> {
  get(key: Readonly<Record<string, string | number>> | string | number): Promise<Row>;
  find(where: Where<Row> | string): Promise<Row | undefined>;
  where(where?: Where<Row> | string): Query<Row>;
  where(strings: TemplateStringsArray, ...values: readonly unknown[]): Query<Row>;
}
/** `sources.<source>.<table>`. */
export type LookupSources = Readonly<Record<string, Readonly<Record<string, LookupTable<UntypedRow>>>>>;

/** The most rows a where reads without a `.limit`: more is refused, never cut. */
const LOOKUP_CAP = 1000;
/** What lookup may hand the handler: JSON, at most this many bytes. */
const LOOKUP_RESULT_BYTES = 65_536;

export function createLookupSources(
  options: Readonly<{ catalogs: Readonly<Record<string, CommandCatalog>>; query: LookupQuery; now: () => Date }>,
): LookupSources {
  const sources: Record<string, Readonly<Record<string, LookupTable<UntypedRow>>>> = {};
  for (const [source, catalog] of Object.entries(options.catalogs)) {
    const tables: Record<string, LookupTable<UntypedRow>> = {};
    for (const [local, table] of Object.entries(catalog)) {
      const rows = async (compiled: ReturnType<typeof compileWhere>, limit: number, orderBy = compiled.orderBy): Promise<UntypedRow[]> => {
        if (compiled.none) return [];
        const result = await options.query(source, local, {
          filter: compiled.filter,
          limit,
          offset: 0,
          ...(orderBy.length ? { orderBy } : {}),
        });
        return result.rows.map((row) => normalizeRow(table, row as Record<string, unknown>) as UntypedRow);
      };
      const handle: LookupTable<UntypedRow> = {
        async get(key) {
          const given =
            key !== null && typeof key === 'object'
              ? (key as Record<string, unknown>)
              : table.key.length === 1
                ? { [table.key[0]]: key }
                : undefined;
          if (!given || Object.keys(given).length !== table.key.length || table.key.some((column) => !Object.hasOwn(given, column))) {
            throw new Error(`${source}.${local}: get takes the key (${table.key.join(', ')}); find takes any other columns.`);
          }
          const exact = canonicalKey(table, given);
          if (!exact) return refuse('not_found');
          const found = await rows({ filter: keyFilter(exact), none: false, orderBy: [] }, 2);
          if (found.length > 1) throw new Error(`${source}.${local}: its key names ${found.length} rows.`);
          return found[0] ?? refuse('not_found');
        },
        async find(where) {
          const found = await rows(compileWhere(table, where, options.now()), 2);
          if (found.length > 1) throw new Error(`${source}.${local}: find matched several rows; narrow the where, or use where().`);
          return found[0];
        },
        where(where?: unknown, ...values: readonly unknown[]): Query<UntypedRow> {
          const order: { column: string; direction: 'asc' | 'desc' }[] = [];
          let cap: number | undefined;
          const run = async (limit?: number): Promise<UntypedRow[]> => {
            const compiled = compileWhere(table, where, options.now(), values);
            const bound = limit ?? cap ?? compiled.limit;
            const found = await rows(compiled, bound ?? LOOKUP_CAP + 1, [...compiled.orderBy, ...order]);
            if (bound === undefined && found.length > LOOKUP_CAP)
              throw new Error(`${source}.${local}: more than ${LOOKUP_CAP} rows match; say how many with .limit(n).`);
            return found;
          };
          const query: Query<UntypedRow> = {
            orderBy(column, direction = 'asc') {
              if (!Object.hasOwn(table.kinds, column)) throw new Error(`${source}.${local}: "${column}" is not one of its columns.`);
              order.push({ column, direction: direction === 'desc' ? 'desc' : 'asc' });
              return query;
            },
            limit(count) {
              if (!Number.isSafeInteger(count) || count < 1)
                throw new RangeError(`${source}.${local}: a limit is a positive whole number.`);
              cap = count;
              return query;
            },
            first: async () => (await run(1))[0],
            // eslint-disable-next-line unicorn/no-thenable -- the lazy thenable is the query's whole interface.
            then: (resolve, reject) => run().then(resolve, reject),
          };
          return query;
        },
      } as LookupTable<UntypedRow>;
      tables[local] = Object.freeze(handle);
    }
    sources[source] = Object.freeze(tables);
  }
  return Object.freeze(sources);
}

/**
 * The tenant rule against a deployment's attested ownership — the tenant and
 * platform bindings' own — whatever the App's authoring says: every table a
 * command looks up holds global rows.
 */
export function assertGlobalLookups(
  app: AppDef,
  registry: BusinessCommandRegistry,
  ownership: Readonly<Record<string, { readonly kind: string }>>,
): void {
  for (const [id, command] of Object.entries(registry)) {
    for (const [source, locals] of Object.entries(command.sources ?? {})) {
      for (const local of locals) {
        const logical = logicalResource(app, source, local);
        const kind = Object.hasOwn(ownership, logical) ? ownership[logical].kind : undefined;
        if (kind === 'global') continue;
        throw new CommandLookupRefusal(
          `Command "${id}" looks up "${logical}", which ${
            kind === 'tenant'
              ? "holds a tenant's rows"
              : kind === 'platform'
                ? "holds the platform's rows"
                : 'this deployment does not hold'
          }. ${TENANT_RULE}`,
        );
      }
    }
  }
}

/** What lookup returned, as the handler receives it: JSON within its bound, detached and frozen. */
export function lookupResult(value: unknown): unknown {
  const json = canonicalCommandJson(value === undefined ? null : value, LOOKUP_RESULT_BYTES);
  const parsed: unknown = JSON.parse(json);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(parsed);
  return parsed;
}
