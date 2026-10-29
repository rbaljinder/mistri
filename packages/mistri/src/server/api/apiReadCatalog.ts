/** Inactive read-catalog foundation. No transport, wire schema, command
 * registry, policy principal or publication authority is constructed here. */
import { hasFilterOf } from '@mistriwork/engine/shared/listFilters.js';
import type { parseAppApi } from '../../shared/appApi.js';
import { resolveAppAccess } from '../../shared/appAccess.js';
import { defaultSourceOf, type AppDef, type AppListView } from '../../shared/appModel.js';
import { andQuery, expandSegments } from '@mistriwork/engine/shared/query.js';
import { mentionsMe } from '../../shared/appMe.js';
import { columnKind, primaryKey, resolveOrder, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { resolvePath, type ViewDef } from '@mistriwork/engine/shared/view.js';
import { apiDialectOf, apiFieldCodec, apiSingleDialect } from './apiValueCodec.js';
import { withDeclaredSegments } from '../../shared/appSegments.js';
import { parseApiStandingQuery } from './apiStandingQuery.js';
import { validateResourceView, type ResourceAccess } from '../app/appAccess.js';
import { tabKey } from '@mistriwork/engine/shared/addressParams.js';
import { reservedKeys } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { opensTo } from '../../shared/appViewRoles.js';

type Exposure = NonNullable<ReturnType<typeof parseAppApi>>;
interface Dependency {
  readonly resource: string;
  readonly fields: readonly string[];
}
interface StandingQuery {
  readonly query: string;
  readonly order: readonly { readonly path: string; readonly direction: 'asc' | 'desc' }[];
}
interface StandingView extends StandingQuery {
  readonly clock: 'request-required';
  readonly tabs: readonly (StandingQuery & { readonly id: string; readonly label: string })[];
  readonly defaultTab: string | null;
  /** Authored view affordances only; cannot widen the API filter allowlist. */
  readonly filters: readonly string[];
}
export interface ReadOperation {
  readonly id: string;
  readonly kind: 'list' | 'item' | 'view';
  readonly resource: string;
  readonly fields: readonly string[];
  readonly filters: readonly string[];
  readonly sorts: readonly string[];
  readonly primaryKey: readonly string[];
  readonly dependencies: readonly Dependency[];
  readonly eligibleRoles: readonly string[];
  readonly source: string | null;
  readonly standing?: StandingView;
  /** A resource list's segments (`?segment=`): those that read only its own exposed fields, so naming one widens nothing. */
  readonly segments?: readonly string[];
}
export interface ReadCatalog {
  readonly stage: 'read-validation-foundation';
  readonly operations: readonly ReadOperation[];
}
const SQL: ReadonlySet<string> = new Set(['sqlite', 'postgres']);
function fail(at: string, message: string): never {
  throw new Error(`${at}: ${message}.`);
}

/** Authored API exposure and App have already passed their parsers. The schema
 * must be the App's logical catalog, never the active connection's raw schema.
 * Unsupported stages refuse locally; they do not constrain ordinary Apps. */
export function checkApiReadCatalog(api: Exposure, app: AppDef, schema: DatabaseSchema): ReadCatalog {
  /* A row policy narrows rows, never what a role may read: its catalog is
     the same per-role grant, and its rows are the deployment's to narrow per
     principal when the read runs (policyApiOwner.ts). A tenant App's grants
     are its tenant-visible ones (apiTenantReadCatalog). */
  if (app.auth?.rows !== 'all' && app.auth?.rows !== 'policy') fail('api', 'tenant contexts are not supported by this read foundation');
  return scopedReadCatalog(api, app, schema, (role) => resolveAppAccess(app, schema, [role]));
}

/** The same validation over a caller's visible schema and per-role grants: the
 * tenant catalog's entry (apiTenantReadCatalog), whose grants are the web UI's
 * tenant-visible ones. Not an ordinary App path; it checks no row context. */
export function scopedReadCatalog(
  api: Exposure,
  app: AppDef,
  schema: DatabaseSchema,
  grant: (role: string) => ResourceAccess,
): ReadCatalog {
  // A view's tab names its resource's segment, and a list offers them by name (`?segment=`): both read them here.
  schema = withDeclaredSegments(app, schema);
  /* Several sources are served when each request reads one connection: every
     table an operation reaches is judged below by the engine that reads it
     (apiDialectOf), and a path across two connections is refused. A
     one-connection catalog that is not SQL refuses as a whole, as before. */
  const single = apiSingleDialect(schema);
  if (single !== undefined && !SQL.has(single)) fail('api', 'non-SQL source catalogs are not supported [api-source-unsupported]');
  if (api.commands.length) fail('api.commands', 'command registry validation is not implemented by this read foundation');
  if (!api.roles.length || api.roles.some((role) => !Object.hasOwn(app.auth?.roles ?? {}, role)))
    fail('api.roles', 'every role must be declared by this App');
  // Resolve all policies eagerly: malformed inactive grants must not be
  // mistaken for an ordinary role that simply cannot call an operation.
  const grants = new Map(api.roles.map((role) => [role, grant(role)]));
  const operations: ReadOperation[] = [];
  const construct = (kind: ReadOperation['kind'], name: string, base: string, list?: AppListView) => {
    const at = `api.${kind === 'view' ? 'views' : 'resources'}.${name}`;
    const exposure = api.resources[base];
    if (!exposure) return fail(at, `resource "${base}" must be explicitly exposed`);
    const table = schema.tables.find((item) => item.id === base);
    if (!table || !app.resources?.[base]) return fail(at, `"${base}" is not a declared readable logical resource`);
    const key = primaryKey(table);
    if (!key.length || key.some((column) => !exposure.fields.includes(column)))
      fail(at, 'fields must include a complete nonempty primary key');
    const dependencies = new Map<string, Set<string>>();
    const add = (resource: string, fields: string[]) => {
      const declared = app.resources?.[resource];
      if (!declared) fail(at, `path reaches undeclared resource "${resource}"`);
      const dialect = apiDialectOf(schema, resource);
      if (!SQL.has(dialect))
        fail(at, `"${resource}" is read from a ${dialect} source, which the App API does not serve [api-source-unsupported]`);
      const current = dependencies.get(resource) ?? new Set<string>();
      for (const field of fields) {
        if (declared.file?.content === field) fail(at, `file content "${resource}.${field}" is not exposed by this foundation`);
        /* Where a file's bytes are and their digest are the server's (appAccess.ts `internal`): no door names them. */
        if (field === declared.file?.object || field === declared.file?.hash)
          fail(
            at,
            `"${resource}.${field}" is the file's own ${field === declared.file?.object ? 'object' : 'hash'} column, which only the server reads`,
          );
        if (declared.fields && !declared.fields.read.includes(field)) fail(at, `"${resource}.${field}" is outside its read ceiling`);
        current.add(field);
      }
      dependencies.set(resource, current);
    };
    const path = (field: string, sort = false) => {
      if (!exposure.fields.includes(field)) fail(at, `dependency "${field}" is not an exposed field of "${base}"`);
      const resolved = resolvePath(schema, base, field);
      /* A stitched reference is the one edge between two connections
         (appSourceCatalog.ts): following it would read a second database in
         the same request, outside the snapshot the first one is read in. */
      const crossing = resolved.hops.find((hop) => hop.stitched);
      if (crossing)
        fail(
          at,
          `"${field}" reaches "${crossing.to.table}", on another connection; one App API request reads one connection [api-multi-source]`,
        );
      add(resolved.table.id, [resolved.column.name]);
      for (const hop of resolved.hops) {
        add(hop.from.table, hop.from.columns);
        add(hop.to.table, hop.to.columns);
      }
      // A nullable column sorts with its nulls last (apiReadView); a path does not sort at all.
      if (sort && resolved.hops.length) fail(at, `sort "${field}" goes through a reference join; sort by a column of "${base}"`);
      return resolved;
    };
    /* The wire codec runs here too, so a column the API cannot say is refused when the App is checked, not when the spec is exported. */
    const represent = (field: string, use: string) => {
      const resolved = path(field, use === 'sort'),
        column = resolved.column;
      let kind: string;
      try {
        kind = apiFieldCodec({ type: column.type }, apiDialectOf(schema, resolved.table.id), 'decimal-string').kind;
      } catch {
        return fail(at, `${use} "${field}" has type ${column.type}, which the API cannot represent`);
      }
      // Exact comparison and keyset order over these need per-kind rules the API does not have yet.
      if (use !== 'field' && (kind === 'decimal' || kind === 'timestamp' || kind === 'json'))
        fail(at, `${use} "${field}" has type ${column.type}, which the API does not filter or sort by`);
    };
    exposure.fields.forEach((field) => represent(field, 'field'));
    exposure.filters.forEach((field) => represent(field, 'filter'));
    exposure.sorts.forEach((field) => represent(field, 'sort'));
    const checks: ViewDef[] = [];
    const columns = () => exposure.fields.map((field) => ({ path: field }));
    const parse = (text: string) => {
      // Validation-only parse: computed relative dates never leave this
      // function. Request planning evaluates the captured authored text anew.
      const parsed = parseApiStandingQuery(schema, base, text, new Date('2000-01-01T00:00:00Z'));
      if (parsed.errors.length) fail(at, parsed.errors[0].message);
      if (parsed.columns.length) fail(at, 'a standing question cannot replace the explicit API projection');
      if (parsed.limit !== undefined) fail(at, 'a standing question limit is unsupported and cannot be silently dropped');
      for (const group of parsed.filter.groups)
        for (const condition of group) {
          // The rows that point at a record are another resource's, which one App API operation does not read.
          if (condition.any) fail(at, `"${condition.path}" asks about rows of another resource, which an App API question does not read`);
          path(condition.path);
        }
      for (const sort of parsed.orderBy) path(sort.path, true);
      return parsed;
    };
    if (list) {
      // A `has` filter is about the rows that point at the record (listFilters.ts): no field of this resource.
      for (const field of list.filters ?? []) if (!hasFilterOf(field)) path(field);
      for (const field of list.totals ?? []) {
        if (columnKind(path(field).column.type) !== 'number') fail(at, `total "${field}" is not numeric`);
      }
      for (const choice of list.sorts ?? []) parse(`sort ${choice.sort}`);
      const ownSort = list.sort ?? list.order;
      if (ownSort) parse(`sort ${ownSort}`);
      // The unrefined standing question and every tab are checked; none can
      // hide a dependency that a role sees only by choosing another tab.
      for (const query of [list.query, ...(list.tabs ?? []).map((tab) => andQuery(list.query, tab.query))]) {
        const parsed = parse(query ?? '');
        const orderBy = parsed.orderBy.length ? parsed.orderBy : ownSort ? parse(`sort ${ownSort}`).orderBy : [];
        checks.push({ id: name, name, base, columns: columns(), filter: parsed.filter, orderBy });
      }
    } else checks.push({ id: name, name, base, columns: columns() });
    for (const check of checks) {
      if (!check.orderBy?.length)
        check.orderBy = resolveOrder(table, undefined).order.map((order) => ({ path: order.column, direction: order.direction }));
      for (const order of check.orderBy) path(order.path, true);
    }
    // Check the API-narrowed graph too: pruning a relationship must not make
    // the full compiler resolve an ambiguous hop differently.
    const ceiling: ResourceAccess = {
      readable: new Set(dependencies.keys()),
      writable: new Set(),
      fields: new Map([...dependencies].map(([resource, fields]) => [resource, { read: fields, write: new Set<string>() }])),
    };
    const shape: ViewDef = { id: name, name, base, columns: columns() };
    validateResourceView(schema, ceiling, shape);
    checks.forEach((check) => validateResourceView(schema, ceiling, check));
    /* A view that names its roles is read through the API by those roles alone, as the browser serves it (appViewRoles.ts). */
    const eligibleRoles = [...grants]
      .filter(([role]) => !list || opensTo(list, [role], app.auth))
      .filter(([, access]) => {
        try {
          // All parameter-only dependencies matter as well as the default query.
          for (const [resource, fields] of dependencies)
            validateResourceView(schema, access, {
              id: name,
              name,
              base: resource,
              columns: [...fields].map((field) => ({ path: field })),
            });
          validateResourceView(schema, access, shape);
          checks.forEach((check) => validateResourceView(schema, access, check));
          return true;
        } catch {
          return false;
        }
      })
      .map(([role]) => role)
      .sort();
    if (!eligibleRoles.length)
      fail(
        at,
        list?.roles && !api.roles.some((role) => list.roles!.includes(role))
          ? `the view names roles (${list.roles.join(', ')}) none of which api.roles lists`
          : 'no declared API role reads the complete operation shape and dependencies',
      );
    /* A segment the API offers reads the list's own exposed fields and nothing else: no reference, no
       rollup (the API's catalog has none), so it asks nothing of a role that the operation does not. */
    const segments =
      kind === 'list'
        ? Object.keys(table.segments ?? {}).filter((segment) => {
            /* Nor one about `me`: the API reads no person, and unread `me` is a word — `owner != me` would be every
               row. It is left out of the enum, and naming it is refused like any segment the list does not offer. */
            if (mentionsMe(expandSegments(segment, table.segments).text)) return false;
            const parsed = parseApiStandingQuery(schema, base, segment, new Date('2000-01-01T00:00:00Z'));
            return (
              !parsed.errors.length &&
              parsed.filter.groups.every((group) =>
                group.every((condition) =>
                  [condition.path, ...('other' in condition && typeof condition.other === 'string' ? [condition.other] : [])].every(
                    (field) => !field.includes('.') && exposure.fields.includes(field),
                  ),
                ),
              )
            );
          })
        : [];
    let standing: StandingView | undefined;
    if (list) {
      const order = (check: ViewDef) =>
        Object.freeze((check.orderBy ?? []).map((value) => Object.freeze({ path: value.path, direction: value.direction })));
      const used = new Set<string>();
      const tabs = Object.freeze(
        (list.tabs ?? []).map((tab, index) => {
          // The tab's word in the App's address (`?tab=`): a segment's tab is the segment's name, any other its label's slug.
          const id = tabKey(tab);
          if (!id || reservedKeys.has(id) || used.has(id))
            fail(at, 'tab labels must have distinct nonempty, nonreserved address identifiers');
          used.add(id);
          return Object.freeze({ id, label: tab.label, query: andQuery(list.query, tab.query), order: order(checks[index + 1]) });
        }),
      );
      standing = Object.freeze({
        query: list.query ?? '',
        order: order(checks[0]),
        clock: 'request-required',
        tabs,
        defaultTab: tabs[0]?.id ?? null,
        filters: Object.freeze([...(list.filters ?? [])]),
      });
    }
    operations.push(
      Object.freeze({
        id: `${kind}:${name}`,
        kind,
        resource: base,
        fields: Object.freeze([...exposure.fields]),
        filters: Object.freeze([...exposure.filters]),
        sorts: Object.freeze([...exposure.sorts]),
        primaryKey: Object.freeze([...key]),
        dependencies: Object.freeze(
          [...dependencies]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([resource, fields]) => Object.freeze({ resource, fields: Object.freeze([...fields].sort()) })),
        ),
        eligibleRoles: Object.freeze(eligibleRoles),
        source: app.resources![base].source ?? defaultSourceOf(app) ?? null,
        ...(standing ? { standing } : {}),
        ...(segments.length ? { segments: Object.freeze(segments) } : {}),
      }),
    );
  };
  for (const resource of Object.keys(api.resources).sort()) {
    construct('list', resource, resource);
    construct('item', resource, resource);
  }
  for (const entry of [...api.views].sort((a, b) => a.view.localeCompare(b.view))) {
    const view = app.views[entry.view];
    if (!view || !('table' in view)) fail(`api.views.${entry.view}`, 'only declared list views are supported');
    construct('view', entry.view, view.table, view);
  }
  return Object.freeze({ stage: 'read-validation-foundation', operations: Object.freeze(operations) });
}
