/**
 * Resolve a normalized App's authority against a catalog. Keep this separate
 * from manifest/content parsing so transports can share the same grant rules
 * without owning another authorization model. app.ts retains compatibility
 * exports for existing callers.
 */
import { CONNECTION_HIDDEN, findTable, stateStampColumn, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import {
  defaultSourceOf,
  grantsByRole,
  homeSourceOf,
  isTenantApp,
  platformSourceNames,
  resourceCeiling,
  type AppDef,
  type AppRoleFieldAccess,
  type AppNavNode,
  type AppRoleGrant,
  type AppUpdateAction,
  type OperationsGrantAction,
} from './appModel.js';
import { checkedGrants, realmResources } from './appAuthGrants.js';

/**
 * What one principal may read and write, and which columns: one ceiling
 * model, with or without sign-in, resolved against one catalog.
 *
 * With role grants (`auth.roles`) it is default-deny, and the whole policy —
 * every ceiling and every role, inactive ones included — is checked before
 * the verified `roles` are judged, so an invalid grant fails closed. Its
 * names are exact addresses: a bare name never finds a secondary source.
 *
 * Without role grants a reader reads every resource the App declares, and
 * no other table of the connection: an App serves its resources, signed in
 * or not, and the standalone browser is the tool for the rest. A resource
 * writes only where its block says `access: 'write'`; one that does not say
 * so is read-only, and an App whose resources say it nowhere writes nothing.
 * Such an App may serve several connections, so a name this one lacks reads
 * and writes nothing here and is named by appCeilingWarnings rather than refused.
 */
export function resolveAppAccess(app: AppDef, schema: DatabaseSchema, roles: readonly string[], visitor?: 'public'): ResolvedAccess {
  return withFileColumns(
    app,
    schema,
    withMachineColumns(app, schema, withoutHidden(app, schema, grantedAccess(app, schema, roles, visitor))),
  );
}

interface ResolvedAccess {
  readable: ReadonlySet<string>;
  writable: ReadonlySet<string>;
  /** Of `writable`, where a generic insert may make a new row. Absent, all of
      it: present only when some role says `create`, and then every insert,
      New and quick add answers to it. */
  creatable?: ReadonlySet<string>;
  fields?: ReadonlyMap<string, { read: ReadonlySet<string>; write: ReadonlySet<string> }>;
  /** Columns the server reads and writes for its own work, by table id: never in a served catalog, named by no request but its own. */
  internal?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * `hidden` cut from whatever the grants resolved: a column ceiling that holds
 * with sign-in or without, and one no role re-grants. Expressed as the field
 * map every read path already honors (accessibleSchema prunes the column and
 * any edge through it), so there is no second enforcement to keep in step.
 *
 * The map names every readable resource, as a `fields` grant's does: its
 * readers take a resource missing from a map as one with no column to write,
 * so a map holding only the hidden resource would leave every other one
 * unwritten. A resource without a cut keeps all its columns.
 */
function withoutHidden(app: AppDef, schema: DatabaseSchema, access: ResolvedAccess): ResolvedAccess {
  const cuts = hiddenColumns(app, schema);
  if (!cuts.size) return access;
  const fields = new Map(
    [...access.readable].map((id) => {
      const held =
        access.fields?.get(id) ??
        (() => {
          const all = findTable(schema, id)!.columns.map((column) => column.name);
          return { read: new Set(all), write: new Set(access.writable.has(id) ? all : []) };
        })();
      const cut = cuts.get(id);
      return [
        id,
        cut
          ? {
              read: new Set([...held.read].filter((column) => !cut.has(column))),
              write: new Set([...held.write].filter((column) => !cut.has(column))),
            }
          : held,
      ];
    }),
  );
  return { ...access, fields };
}

/**
 * A machine's column, its `since` and its states' stamps, are written by every role that writes
 * its table — a fixed verb is a generic write of them — whatever the role's
 * `fields` rule lists: the rule says what the role edits in place, and the
 * machine says how the state moves. Every generic write of the column is
 * then judged against the graph (appTransitions.ts), so no edit moves it but
 * a verb, and no write says a clock (`since`, a state's stamp) but a verb
 * that sets it: the server stamps them as the state moves.
 */
function withMachineColumns(app: AppDef, schema: DatabaseSchema, access: ResolvedAccess): ResolvedAccess {
  if (!access.fields) return access;
  const moved = new Map<string, readonly string[]>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.machine) continue;
    const table = findTable(schema, name) ?? tableNamed(schema, name);
    if (table && access.writable.has(table.id))
      moved.set(table.id, [
        resource.machine.column,
        ...(resource.machine.since ? [resource.machine.since] : []),
        // A state's own stamp (`ready_at`) is the machine's to write as the record enters it.
        ...resource.machine.states.flatMap((state) => stateStampColumn(state.name, table.columns, resource.machine!)?.name ?? []),
      ]);
  }
  if (!moved.size) return access;
  const fields = new Map(
    [...access.fields].map(([id, held]) => {
      const columns = moved.get(id);
      return [id, columns ? { read: held.read, write: new Set([...held.write, ...columns]) } : held];
    }),
  );
  return { ...access, fields };
}

/**
 * A file resource's `object` and `hash` columns are the server's: where its
 * bytes are and their digest. They follow the `content` column — whoever may
 * read the file may have them read for it, whoever may write it may have them
 * written — so no author grants them, and they are `internal`: cut from every
 * catalog a reader is served (accessibleSchema), and refused by the access
 * guard to every request but the server's own (server/serverRequests.ts),
 * so no list, filter, sort, export, view or write ever names them.
 */
function withFileColumns(app: AppDef, schema: DatabaseSchema, access: ResolvedAccess): ResolvedAccess {
  const owned = new Map<string, { content: string; columns: readonly string[] }>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const file = resource.file;
    const columns = [file?.object, file?.hash].filter((column): column is string => Boolean(column));
    if (!file || !columns.length) continue;
    const table = findTable(schema, name) ?? tableNamed(schema, name);
    if (table && access.readable.has(table.id)) owned.set(table.id, { content: file.content, columns });
  }
  if (!owned.size) return access;
  const internal = new Map([...owned].map(([id, { columns }]) => [id, new Set(columns)]));
  if (!access.fields) return { ...access, internal };
  const fields = new Map(
    [...access.fields].map(([id, held]) => {
      const file = owned.get(id);
      if (!file) return [id, held];
      return [
        id,
        {
          read: held.read.has(file.content) ? new Set([...held.read, ...file.columns]) : held.read,
          write: held.write.has(file.content) ? new Set([...held.write, ...file.columns]) : held.write,
        },
      ];
    }),
  );
  return { ...access, fields, internal };
}

/** Each resource's `hidden` columns by table id, judged against this catalog: every one a column, none of the key. */
function hiddenColumns(app: AppDef, schema: DatabaseSchema): Map<string, ReadonlySet<string>> {
  const cuts = new Map<string, ReadonlySet<string>>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.hidden?.length) continue;
    const at = `${app.name}: resources "${name}", "hidden"`;
    const table = findTable(schema, name) ?? tableNamed(schema, name);
    if (!table) throw new Error(`${at}: "${name}" is not a table in this catalog.`);
    for (const column of resource.hidden) {
      const found = table.columns.find((item) => item.name === column);
      // Hidden twice: the connection already keeps it from everything served, this App included.
      if (!found && table[CONNECTION_HIDDEN]?.includes(column)) continue;
      if (!found) throw new Error(`${at} names "${column}", which is not a column of ${table.id}.`);
      if (found.primaryKey) throw new Error(`${at} names "${column}", part of the primary key: every link to a record carries it.`);
    }
    cuts.set(table.id, new Set(resource.hidden));
  }
  return cuts;
}

function grantedAccess(app: AppDef, schema: DatabaseSchema, roles: readonly string[], visitor?: 'public'): ResolvedAccess {
  if (!grantsByRole(app)) {
    /* The declared resources, and nothing else of the connection: a table
       the App does not name is not there, as with role grants. A name this
       connection lacks reads nothing here (the App may serve several). */
    const served = (names: string[]) => new Set(names.flatMap((name) => (findTable(schema, name) ?? tableNamed(schema, name))?.id ?? []));
    const readable = served(Object.keys(app.resources ?? {}));
    const ceiling = resourceCeiling(app);
    return { readable, writable: ceiling.read.length ? served(ceiling.write) : readable };
  }
  const access = checkedGrants(app);
  /* A refusal names where its name or column rule was authored: the
     resource's own block, or the role that grants it. */
  const resourceAt = (resource: string) => `${app.name}: resources "${resource}"`;
  const roleAt = (role: string) => `${app.name}: "auth", role "${role}"`;
  const resolve = (names: string[], unknown: (name: string) => string): Set<string> =>
    new Set(
      names.map((name) => {
        // Authorization names are exact addresses; never infer a secondary source from a bare name.
        const table = findTable(schema, name);
        if (!table) throw new Error(unknown(name));
        return table.id;
      }),
    );
  const unknownResource = (name: string) =>
    `${resourceAt(name)} is not a table in this catalog. ` + 'Resource names are exact: a secondary source\'s is "source.name".';
  const read = resolve(access.read, unknownResource);
  const write = resolve(access.write, unknownResource);
  type Fields = Map<string, { read: Set<string>; write: Set<string> }>;
  const hasFields =
    access.fields !== undefined ||
    Object.values(access.roles).some((grant) => grant.fields !== undefined) ||
    access.public?.fields !== undefined;
  const resolveFields = (
    rules: Record<string, AppRoleFieldAccess> | undefined,
    readable: Set<string>,
    writable: Set<string>,
    at: (resource: string) => string,
    ceiling?: Fields,
  ): Fields => {
    for (const resource of Object.keys(rules ?? {})) {
      if (!readable.has(resource)) throw new Error(`${at(resource)} narrows columns of a resource that is not read.`);
    }
    return new Map(
      [...readable].map((resource) => {
        const table = findTable(schema, resource)!;
        const all = new Set(table.columns.map((column) => column.name));
        const cap = ceiling?.get(resource) ?? { read: all, write: all };
        const rule = rules && Object.hasOwn(rules, resource) ? rules[resource] : undefined;
        const fieldRead = new Set(rule?.read ?? cap.read);
        const fieldWrite = new Set(rule ? (rule.write ?? []) : writable.has(resource) ? cap.write : []);
        if (fieldWrite.size && !writable.has(resource))
          throw new Error(`${at(resource)} writes columns of a resource that is not written.`);
        for (const column of fieldRead)
          if (!all.has(column) || !cap.read.has(column)) {
            throw new Error(`${at(resource)}: column "${column}" is unknown or outside the read ceiling.`);
          }
        for (const column of fieldWrite)
          if (!fieldRead.has(column) || !cap.write.has(column)) {
            throw new Error(`${at(resource)}: column "${column}" is outside the write ceiling.`);
          }
        if (table.columns.some((column) => column.primaryKey && !fieldRead.has(column.name))) {
          throw new Error(`${at(resource)} must keep the complete primary key readable.`);
        }
        return [resource, { read: fieldRead, write: fieldWrite }];
      }),
    );
  };
  const ceiling = hasFields ? resolveFields(access.fields, read, write, (resource) => `${resourceAt(resource)}, "fields"`) : undefined;
  /* A signed-out visitor reads what `auth.public` names, within the ceilings, and writes nothing. */
  if (visitor === 'public') {
    const none = new Set<string>();
    if (!access.public) return { readable: none, writable: none };
    const readable = resolve(
      access.public.read,
      (name) => `${app.name}: "auth", "public", "read" names "${name}", which is not a table in this catalog.`,
    );
    return {
      readable,
      writable: none,
      ...(hasFields
        ? {
            fields: resolveFields(
              access.public.fields,
              readable,
              none,
              (resource) => `${app.name}: "auth", "public", "fields" for "${resource}"`,
              ceiling,
            ),
          }
        : {}),
    };
  }
  const grants = new Map(
    Object.entries(access.roles).map(([name, grant]) => {
      const unknownGrant = (key: 'read' | 'write' | 'export') => (resource: string) =>
        `${roleAt(name)}, "${key}" names "${resource}", which is not a table in this catalog.`;
      // A tenant role's `true` is its realm's whole ceiling: a platform-owned
      // resource is never a tenant's, whatever the word covers.
      const realm = (names: Set<string>) => new Set(realmResources(app, grant.realm, names));
      const readable =
        grant.read === true ? realm(read) : grant.read === false ? new Set<string>() : resolve(grant.read, unknownGrant('read'));
      const writable =
        grant.write === true ? realm(write) : grant.write === false ? new Set<string>() : resolve(grant.write, unknownGrant('write'));
      const creatable =
        grant.create === undefined ? writable : grant.create === false ? new Set<string>() : resolve(grant.create, unknownGrant('write'));
      // Judged here so an unknown name fails closed with the rest of the policy; appMayExport reads the same list.
      if (grant.export) resolve(grant.export, unknownGrant('export'));
      return [
        name,
        {
          readable,
          writable,
          creatable,
          fields: hasFields
            ? resolveFields(grant.fields, readable, writable, (resource) => `${roleAt(name)}, "fields" for "${resource}"`, ceiling)
            : undefined,
        },
      ];
    }),
  );
  const creates = Object.values(access.roles).some((grant) => grant.create !== undefined);
  const readable = new Set<string>();
  const writable = new Set<string>();
  const creatable = new Set<string>();
  const fields: Fields = new Map();
  for (const role of roles) {
    const grant = grants.get(role);
    grant?.readable.forEach((id) => readable.add(id));
    grant?.writable.forEach((id) => writable.add(id));
    grant?.creatable.forEach((id) => creatable.add(id));
    grant?.fields?.forEach((scope, resource) => {
      const combined = fields.get(resource) ?? { read: new Set<string>(), write: new Set<string>() };
      scope.read.forEach((column) => combined.read.add(column));
      scope.write.forEach((column) => combined.write.add(column));
      fields.set(resource, combined);
    });
  }
  return { readable, writable, ...(creates ? { creatable } : {}), ...(hasFields ? { fields } : {}) };
}

/** Named command grants are independent of CRUD ceilings; callers supply verified server roles only. */
export function appCommandGrants(app: AppDef, verifiedRoles: readonly string[]): ReadonlySet<string> {
  if (!grantsByRole(app)) return new Set();
  const grants = new Map(Object.entries(checkedGrants(app).roles));
  const commands = new Set<string>();
  for (const role of verifiedRoles) {
    grants.get(role)?.commands?.forEach((command) => commands.add(command));
  }
  return commands;
}

/**
 * The fixed actions verified roles may run without write, by table id: each
 * granted label's action as the resource declares it. A table one of the
 * roles writes is left out — that role runs every action there already, and
 * the generic write is the rule its update answers to. Callers supply
 * verified server roles only.
 */
export function appActionGrants(
  app: AppDef,
  schema: DatabaseSchema,
  verifiedRoles: readonly string[],
): ReadonlyMap<string, readonly AppUpdateAction[]> {
  if (!grantsByRole(app)) return new Map();
  const roles = checkedGrants(app).roles;
  const written = resolveAppAccess(app, schema, verifiedRoles).writable;
  const granted = new Map<string, AppUpdateAction[]>();
  for (const role of verifiedRoles) {
    if (!Object.hasOwn(roles, role)) continue;
    for (const [resource, labels] of Object.entries(roles[role].actions ?? {})) {
      // Exact addresses, as every grant: a bare name never finds a secondary source.
      const table = findTable(schema, resource);
      if (!table || written.has(table.id)) continue;
      const list = granted.get(table.id) ?? [];
      for (const label of labels) {
        const action = app.resources?.[resource]?.actions?.find(
          (candidate) => candidate.id === label && candidate.command === undefined,
        ) as AppUpdateAction | undefined;
        if (action && !list.includes(action)) list.push(action);
      }
      if (list.length) granted.set(table.id, list);
    }
  }
  return granted;
}

/**
 * Operator reads are granted by name to verified server roles, independently of
 * CRUD and command grants; a role that may write every table still cannot read
 * a support bundle unless it says so.
 */
export function appOperationsGrants(app: AppDef, verifiedRoles: readonly string[]): ReadonlySet<OperationsGrantAction> {
  if (!grantsByRole(app)) return new Set();
  const grants = new Map(Object.entries(checkedGrants(app).roles));
  const actions = new Set<OperationsGrantAction>();
  for (const role of verifiedRoles) grants.get(role)?.operations?.forEach((action) => actions.add(action));
  return actions;
}

/**
 * The resources an App declares that its connection has no table for. An App
 * that names its connection and finds none of what it declares is an App
 * whose schema was never applied — the quickstart's, served before its
 * migration — and every screen of it would answer with an error.
 */
export function appMissingTables(app: Pick<AppDef, 'resources'>, schema: DatabaseSchema): string[] {
  return Object.keys(app.resources ?? {}).filter((name) => !tableNamed(schema, name));
}

/**
 * Without role grants, a write ceiling this connection lacks writes nothing
 * here: named as a warning, never refused, since such an App may serve
 * several connections. With role grants a missing name refuses startup.
 */
export function appCeilingWarnings(app: AppDef, schema: DatabaseSchema): string[] {
  if (grantsByRole(app)) return [];
  return resourceCeiling(app)
    .write.filter((name) => !tableNamed(schema, name))
    .map((name) => `resources "${name}" has access 'write', and this connection has no table "${name}".`);
}

/**
 * Whether an App lets a table be written, for the verified roles in `role`
 * (comma-separated). No App defers to the connection; otherwise the
 * resolved grant decides. `tableId` undefined is a write that names no
 * table — raw SQL, a graph — which no App admits, because a scope per
 * table cannot vouch for a statement it cannot read.
 */
export function appAllowsWrite(app: AppDef | undefined, schema: DatabaseSchema, tableId: string | undefined, role?: string): boolean {
  if (!app) return true;
  const grant = resolveAppAccess(app, schema, role?.split(',').map((name) => name.trim()) ?? []);
  return tableId !== undefined && grant.writable.has(tableId);
}

/**
 * The tables this reader may export, or undefined where the App does not
 * grant by role (its one switch, `ui.export`, is all there is). Exporting is a
 * grant of its own beside read and write: a person may export a table any of
 * their roles writes, or lists in `export`. A signed-out visitor exports
 * nothing. `roles` are the verified server roles.
 */
export function appExportable(
  app: AppDef,
  schema: DatabaseSchema,
  roles: readonly string[],
  signedIn: boolean,
): ReadonlySet<string> | undefined {
  if (!grantsByRole(app)) return undefined;
  if (!signedIn) return new Set();
  /* Read off the grants by name, against whatever catalog the caller holds (a served one omits tables a person cannot
     read): an unknown name is refused when the whole policy is resolved (resolveAppAccess), not here. */
  const access = checkedGrants(app);
  const out = new Set<string>();
  for (const role of roles) {
    if (!Object.hasOwn(access.roles, role)) continue;
    const grant = access.roles[role];
    const writes = grant.write === true ? realmResources(app, grant.realm, access.write) : grant.write === false ? [] : grant.write;
    for (const name of [...writes, ...(grant.export ?? [])]) {
      const table = findTable(schema, name);
      if (table) out.add(table.id);
    }
  }
  return out;
}

/**
 * The tables an App deletes from: its resources that say `delete: true`, as
 * catalog ids. Deleting is opt-in beside the write grant — a resource edited
 * all day keeps its records unless the App says otherwise — and every
 * transport asks this one rule. Role-grant Apps name exact addresses; the
 * others resolve a name as their ceiling does.
 */
export function appDeletable(app: AppDef, schema: DatabaseSchema): ReadonlySet<string> {
  const exact = grantsByRole(app);
  return new Set(
    Object.entries(app.resources ?? {})
      .filter(([, resource]) => resource.delete)
      .flatMap(([name]) => (exact ? findTable(schema, name) : tableNamed(schema, name))?.id ?? []),
  );
}

/** The sentence a refused write gets, naming what the App does allow. */
export function writeScopeRefusal(app: AppDef, tableId: string | undefined): string {
  const what = tableId ? `"${tableId}"` : 'a write that names no single table (raw SQL, a graph)';
  const whose = `The app "${app.name}"`;
  const writes = resourceCeiling(app).write;
  if (!writes.length) return `${whose} is read-only: it writes nothing, whatever the connection allows.`;
  return `${whose} does not write ${what}. Resources with access 'write': ${writes.join(', ')}.`;
}

/**
 * The shape a row policy binds to: role grants over named sources, one of
 * them the App's own, and not a tenant App, whose tenancy has its own owner.
 * Whether the App asks for a policy (`auth.rows: 'policy'`) is the
 * transport's own check.
 */
export function rowPolicyAppShape(app: AppDef): boolean {
  return grantsByRole(app) && !isTenantApp(app) && homeSourceOf(app) !== undefined;
}

/**
 * The shape a tenant owner binds to: role grants and exactly one named
 * source of its own, the default — bound, when `bound` names them, to that
 * App id, source and connection. Any other source is a platform-only source
 * (`realm: 'platform'`), which only the platform realm's read owner sees; the
 * others are built from tenantBusinessApp, which has none. Every tenant owner
 * checks it before trusting anything else about the App; a mismatch is a
 * denial, never a repair. Whether the App asks for tenancy (`auth.rows:
 * 'tenant'`) is checked where a tenant App is admitted: startup, enrollment
 * and the tenant transport.
 */
export function tenantAppShape(app: AppDef, bound?: { appId?: string; source: { id: string; connection: string } }): boolean {
  if (!grantsByRole(app) || !app.sources) return false;
  const own = Object.values(app.sources).filter((source) => source.realm !== 'platform');
  if (own.length !== 1 || !own[0].default) return false;
  if (!bound) return true;
  return (
    (bound.appId === undefined || app.id === bound.appId) &&
    defaultSourceOf(app) === bound.source.id &&
    app.sources[bound.source.id]?.connection === bound.source.connection &&
    (app.connection === undefined || app.connection === bound.source.connection)
  );
}

/**
 * A tenant App as its own source sees it: without its platform-only sources,
 * their resources, and every grant and column rule that names one. The
 * tenant, member, command and intake owners are built from this, so a
 * platform-only source is absent from their catalog and schema rather than
 * denied inside them. The platform realm's read owner alone takes the whole
 * App. An App without one is returned as it is.
 */
export function tenantBusinessApp(app: AppDef): AppDef {
  const outside = new Set(platformSourceNames(app));
  if (!outside.size) return app;
  const removed = new Set(
    Object.entries(app.resources ?? {})
      .filter(([, resource]) => outside.has(resource.source ?? ''))
      .map(([name]) => name),
  );
  const names = (value: boolean | string[]) => (Array.isArray(value) ? value.filter((name) => !removed.has(name)) : value);
  const columns = <T>(fields: Record<string, T> | undefined) =>
    fields === undefined ? {} : { fields: Object.fromEntries(Object.entries(fields).filter(([name]) => !removed.has(name))) };
  const sources = Object.fromEntries(Object.entries(app.sources!).filter(([name]) => !outside.has(name)));
  const resources = Object.fromEntries(Object.entries(app.resources ?? {}).filter(([name]) => !removed.has(name)));
  const auth = app.auth!;
  const roles = Object.fromEntries(
    Object.entries(auth.roles ?? {}).map(([role, grant]): [string, AppRoleGrant] => [
      role,
      { ...grant, read: names(grant.read), write: names(grant.write), ...columns(grant.fields) },
    ]),
  );
  // What reads one goes with it: a business owner resolves what is left against
  // a catalog that does not hold those tables, so a view over one would only
  // read as broken. The whole App still reaches the platform realm's own reads.
  const reads = (view: unknown): boolean => {
    const value = view as { table?: string; sections?: readonly { table?: string }[]; aside?: readonly { table?: string }[] };
    return (
      (value.table !== undefined && removed.has(value.table)) ||
      [...(value.sections ?? []), ...(value.aside ?? [])].some((section) => section.table !== undefined && removed.has(section.table))
    );
  };
  const dropped = new Set(
    Object.entries(app.views)
      .filter(([, view]) => reads(view))
      .map(([key]) => key),
  );
  const keep = (nodes: readonly AppNavNode[]): AppNavNode[] =>
    nodes.flatMap((node): AppNavNode[] => {
      if (!('group' in node)) return 'view' in node && dropped.has(node.view) ? [] : [node];
      const children = keep(node.children);
      return children.length ? [{ ...node, children }] : [];
    });
  return {
    ...app,
    sources,
    resources,
    views: Object.fromEntries(Object.entries(app.views).filter(([key]) => !dropped.has(key))),
    nav: keep(app.nav),
    home: app.home.filter((rule) => !dropped.has(rule.view)),
    auth: {
      ...auth,
      roles,
      ...(auth.public ? { public: { ...auth.public, read: names(auth.public.read) as string[], ...columns(auth.public.fields) } } : {}),
    },
  };
}
