import { recordComparisons } from '../../shared/commandDraft.js';
import { isPromise, isProxy } from 'node:util/types';
import { appZone } from '../../shared/appUi.js';
import { personTable } from '../../shared/appMe.js';
import { ANYONE, type QueryPerson } from '@mistriwork/engine/shared/query.js';
import {
  appCommandGrants,
  homeSourceOf,
  grantsByRole,
  logicalResource,
  resolveAppAccess,
  resourceCeiling,
  type AppDef,
} from '../../shared/app.js';
import { appCommandOccurrences } from '../../shared/appCommandOccurrences.js';
import { FILE_MAX_BYTES_DEFAULT, isTenantApp, type AppFileDef } from '../../shared/appModel.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { TENANT_FILE_MOST } from '@mistriwork/engine/server/http/reply.js';
import { plainImportTargets } from '../../shared/appImport.js';
import { findTable, primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { AppAccessDenied } from '../app/appAccess.js';
import {
  BusinessCommandDefinitionError,
  CommandLookupRefusal,
  callerRead,
  defineCommands,
  type AnyBusinessCommand,
  type BusinessCommandActor,
  type BusinessCommandRegistry,
} from './businessCommands.js';
import { commandCatalog, zonedCatalog, type CommandCatalog } from './commandDb.js';
import { compileWhen, withDerived } from './commandWhen.js';
import { sayRefusal } from '@mistriwork/engine/shared/refusal.js';
import { withSaying } from './commandSaying.js';
import { versionColumn } from './commandRevision.js';
import { commandLookupProblem } from './commandLookupRules.js';
import { captureTenantData, isCapturedTenantData, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { issueTargetColumns, issueTargetUnreadable } from './commandActorColumns.js';
import { genericWriteEntitled, genericWriteOf } from './genericWriteBrand.js';
import { flowCommandOf } from './flowCommandBrand.js';

export interface BusinessCommandAuthorizationOptions {
  app: AppDef;
  registry: BusinessCommandRegistry;
  schema: DatabaseSchema;
  connectionFor: (resource: string) => string;
  writableConnection: (connection: string) => boolean;
  transactionalConnection: (connection: string) => boolean;
  /** Private, already-attested logical ownership, never an App field grant. */
  managedOwnership?: Readonly<Record<string, string>>;
}

export interface BusinessCommandAuthorization {
  readonly command: AnyBusinessCommand;
  readonly resource: string;
  readonly actor: BusinessCommandActor;
  readonly keyColumns: readonly string[];
  /** The target's revision column when it has one (`versionColumn`), else its revision is the row's digest. */
  readonly versionField?: string;
  readonly connection: string;
  readonly read: readonly string[];
  readonly write: readonly string[];
  /** The footprint's tables by local name, for the handler's `db`. */
  readonly catalog: CommandCatalog;
  /** Present when the command looks up: each declared source's tables by local name, and a declared table's logical name. */
  readonly lookupTables?: Readonly<{ catalogs: Readonly<Record<string, CommandCatalog>>; logical(source: string, local: string): string }>;
  /** The machines of the tables it writes, by local name, and when it is a verb of its target's, where that verb leads. */
  readonly machine?: CommandMachine;
  /** The App's `ui.timezone`: the wall clock a write into a zone-less timestamp column is made in (UTC when absent). */
  readonly timezone?: string;
  /** The table people are rows of (`auth.me`), where the command reads it: what `me` writes to a reference to it. */
  readonly people?: Readonly<{ table: string; column: string; key: string; id: string }>;
  /** The file resources it writes, by local name: where a new row's bytes go and the most it may hold (the
      resource's `maxBytes`, and a tenant host's 10 MB), as an upload is held. */
  readonly files?: ReadonlyMap<string, CommandFileRule>;
  table(local: string, writing?: boolean): string;
}

/** A file resource a command writes: the columns its `file` names, the table, and the cap a new row's bytes meet. */
export interface CommandFileRule extends AppFileDef {
  readonly table: string;
  /** Its name in the App's `resources`, which a bucket's keys are filed under. */
  readonly resource: string;
  readonly maxBytes: number;
}

/** What a command's writes are held to by the machines of the tables it writes (appMachine.ts). */
export interface CommandMachine {
  /** Each written table's machine: its column, `since`, the first state and every (from → to) its graph allows. */
  readonly tables: ReadonlyMap<
    string,
    Readonly<{
      column: string;
      since?: string;
      start: string;
      /** The states besides `start` a command may insert a row in (the machine's `entry`). */
      entry: ReadonlySet<string>;
      moves: ReadonlyMap<string, ReadonlySet<string>>;
      /** The moves no verb makes, by the service role that may make them (the machine's `by`). */
      by?: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
    }>
  >;
  /** When the command is a verb of its target's machine: the states it runs from, and the states it may leave the target in. */
  readonly verb?: Readonly<{ from: ReadonlySet<string>; to: ReadonlyMap<string, ReadonlySet<string>> }>;
  /** The machines that move with the command: each table it writes whose machine names it as a verb, the
      reference from its rows to the command's record, the one state each listed state moves to, and the
      states a row is left in (final, or already where the command leads). */
  readonly carried?: readonly Readonly<{
    table: string;
    column: string;
    reference: Readonly<{ from: readonly string[]; to: readonly string[] }>;
    moves: ReadonlyMap<string, string>;
    done: ReadonlySet<string>;
  }>[];
}

const invalid = (message: string): never => {
  throw new BusinessCommandDefinitionError(message);
};

/** A service principal's id: `service:` and the name its jobs module declares. */
const SERVICE_ID = /^service:[a-z][a-z0-9-]{0,62}$/;

/**
 * Why these roles cannot be a service principal's in this App, or undefined
 * when they can. A service runs named commands and nothing else: a role it
 * holds must exist, and may grant no generic write and no operator read, so
 * a jobs module can never reach raw CRUD or the support bundle by naming a
 * role a person also holds.
 */
export function serviceRoleRefusal(app: AppDef, roles: readonly string[]): string | undefined {
  const grants = app.auth?.roles ?? {};
  for (const role of roles) {
    const grant = Object.hasOwn(grants, role) ? grants[role] : undefined;
    if (!grant) return `role "${role}" is not defined in the App`;
    if (grant.write === true || (Array.isArray(grant.write) && grant.write.length)) return `role "${role}" grants generic writes`;
    if (grant.operations?.length) return `role "${role}" grants operations`;
  }
  return undefined;
}

/* What a command-running App lacks, each with the line that supplies it. One
   sentence naming four requirements left the author to guess which. */
function missingCommandRequirements(app: AppDef): string {
  const missing: string[] = [];
  if (!app.sources) {
    // A connection with an identifier's name is already the App's source (parseDataBlocks); this one's name is not one.
    missing.push(
      `named sources (${app.connection ? `connection "${app.connection}" is not a name a source can have` : 'the App names none'}: ` +
        `sources: { main: { connection: ${JSON.stringify(app.connection ?? 'my-database')}, default: true } })`,
    );
  } else if (!homeSourceOf(app)) {
    missing.push('a source of the App\'s own (every source it names is "realm": "platform")');
  }
  if (!grantsByRole(app)) {
    missing.push(
      'sign-in with role grants, since a command runs only for a role granted it ' +
        "(auth: { roles: { staff: { read: true, commands: ['…'] } } }, and BETTER_AUTH_SECRET in the environment)",
    );
  }
  return `Business commands need ${missing.join(', and ')}.`;
}

/**
 * The machines a command's writes meet (appMachine.ts): each table it writes
 * that has one, and — when the command is a verb of its target's — the states
 * it runs from and those it may leave the target in. A command that is a verb
 * runs only from a state that lists it; any write of a machine's column moves
 * along an edge of the graph (businessCommandExecution.ts).
 */
function commandMachine(
  app: AppDef,
  schema: DatabaseSchema,
  id: string,
  command: AnyBusinessCommand,
  logical: (local: string) => string,
): CommandMachine | undefined {
  const tables = new Map<
    string,
    {
      column: string;
      since?: string;
      start: string;
      entry: ReadonlySet<string>;
      moves: Map<string, Set<string>>;
      by?: Map<string, Map<string, Set<string>>>;
    }
  >();
  for (const local of command.write) {
    const machine = app.resources?.[logical(local)]?.machine;
    if (!machine) continue;
    const moves = new Map<string, Set<string>>();
    for (const edge of machine.edges) {
      const next = moves.get(edge.from) ?? new Set<string>();
      for (const to of edge.to) next.add(to);
      moves.set(edge.from, next);
    }
    const by = new Map<string, Map<string, Set<string>>>();
    for (const state of machine.states)
      for (const move of state.by ?? []) {
        const role = by.get(move.role) ?? new Map<string, Set<string>>();
        role.set(state.name, new Set([...(role.get(state.name) ?? []), ...move.to]));
        by.set(move.role, role);
      }
    tables.set(local, {
      column: machine.column,
      ...(machine.since ? { since: machine.since } : {}),
      start: machine.states[0].name,
      entry: new Set(machine.entry ?? []),
      moves,
      ...(by.size ? { by } : {}),
    });
  }
  const own = app.resources?.[logical(command.target)]?.machine;
  const edges = own?.edges.filter((edge) => edge.command === id) ?? [];
  /* A timer's command runs from the state that waits on it. */
  const timed = own?.states.filter((state) => (state.after ?? []).some((timer) => timer.command === id)).map((state) => state.name) ?? [];
  const carried = carriedMachines(app, schema, id, command, logical);
  if (!tables.size && !edges.length && !timed.length) return undefined;
  const destinations = new Map<string, Set<string>>();
  for (const edge of edges) {
    const next = destinations.get(edge.from) ?? new Set<string>();
    for (const to of edge.to) next.add(to);
    destinations.set(edge.from, next);
  }
  const verb =
    edges.length || timed.length ? { from: new Set([...edges.map((edge) => edge.from), ...timed]), to: destinations } : undefined;
  return Object.freeze({ tables, ...(verb ? { verb } : {}), ...(carried.length ? { carried } : {}) });
}

/**
 * The machines as this actor's writes meet them: a service principal holding
 * a role a state's `by` names may also make that state's moves no verb makes
 * (a contract's term ending, moved by the sales clock); anyone else, only the
 * graph's verbs.
 */
function machineFor(machine: CommandMachine, actor: BusinessCommandActor): CommandMachine {
  if (actor.kind !== 'service' || ![...machine.tables.values()].some((table) => table.by)) return machine;
  const tables = new Map(
    [...machine.tables].map(([local, table]) => {
      const held = table.by && actor.roles.filter((role) => table.by!.has(role));
      if (!held?.length) return [local, table] as const;
      const moves = new Map([...table.moves].map(([from, to]) => [from, new Set(to)]));
      for (const role of held) for (const [from, to] of table.by!.get(role)!) moves.set(from, new Set([...(moves.get(from) ?? []), ...to]));
      return [local, Object.freeze({ ...table, moves })] as const;
    }),
  );
  return Object.freeze({ ...machine, tables });
}

/**
 * A verb of another record's machine that names this command, on rows that
 * point at the command's record (a payment's `pending: { on: { cancelOrder:
 * 'voided' } }`), says those rows move with it: cancelling the order voids its
 * pending payment, in the same transaction, with no handler code. Each such
 * machine is judged here: the command writes its table, names its records,
 * reaches its rows by one reference, and each state that lists it moves to one
 * state, unconditionally. A machine whose rows do not point at the record (a
 * purchase order, named by `receiveLine` on one of its lines) is the
 * handler's to move: its verb only says where the handler may take it.
 */
function carriedMachines(
  app: AppDef,
  schema: DatabaseSchema,
  id: string,
  command: AnyBusinessCommand,
  logical: (local: string) => string,
): NonNullable<CommandMachine['carried']> {
  const target = logical(command.target);
  const carried: NonNullable<CommandMachine['carried']>[number][] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const edges = name === target ? [] : (resource.machine?.edges.filter((edge) => edge.command === id) ?? []);
    if (!edges.length) continue;
    const references = schema.foreignKeys.filter((key) => key.from.table === name && key.to.table === target);
    if (!references.length) continue;
    const at = `The machine of "${name}" moves with command "${id}" (${edges.map((edge) => `${edge.from} → ${edge.to.join(' or ')}`).join(', ')})`;
    if (references.length > 1)
      invalid(
        `${at}, and "${name}" has ${references.length} references to "${target}"; its rows move with the record they point at by one.`,
      );
    if (command.targets === 'none') invalid(`${at}, which names no record for its rows to move with.`);
    const local = command.write.find((candidate) => logical(candidate) === name);
    if (local === undefined) invalid(`${at}, so the command writes "${name}": add it to write.`);
    for (const edge of edges) {
      if (edge.to.length !== 1 || edge.fixed)
        invalid(
          `${at}: from "${edge.from}" it moves to one state, unconditionally — no "when" or "bulk", and not ${edge.to.join(' or ')}.`,
        );
    }
    const machine = resource.machine!;
    carried.push(
      Object.freeze({
        table: local!,
        column: machine.column,
        reference: Object.freeze({ from: references[0].from.columns, to: references[0].to.columns }),
        moves: new Map(edges.map((edge) => [edge.from, edge.to[0]])),
        done: new Set([...machine.states.filter((state) => state.final).map((state) => state.name), ...edges.map((edge) => edge.to[0])]),
      }),
    );
  }
  return carried;
}

/** What the App calls a command where it shows it: the label of the action that runs it, else the id as words. */
function commandLabel(app: AppDef, id: string): string {
  for (const resource of Object.values(app.resources ?? {}))
    for (const action of resource.actions ?? []) if (action.command?.id === id && action.label) return action.label;
  return humanName(id);
}

type AccessOf = (roles: readonly string[]) => ReturnType<typeof resolveAppAccess>;

/**
 * One resolution per set of roles for an authorizer's life: its App and
 * catalog are captured and never change, and a resolution walks every
 * readable resource's columns once a role says `fields`. Asked afresh for
 * each command, table and role, a large tenant App spent minutes at
 * startup and looked hung. A deployment binds several authorizers over the
 * same captured App and catalog (the tenant's, the platform's), so the
 * resolutions are kept with those two and shared, and go when they do.
 */
const resolutions = new WeakMap<DatabaseSchema, WeakMap<AppDef, Map<string, ReturnType<typeof resolveAppAccess>>>>();
/** Test-only: how many sets of roles were resolved rather than reused. */
export const accessCounters = { resolved: 0 };
function accessMemo(app: AppDef, schema: DatabaseSchema): AccessOf {
  let resolved: Map<string, ReturnType<typeof resolveAppAccess>> | undefined;
  if (isCapturedTenantData(app) && isCapturedTenantData(schema)) {
    let byApp = resolutions.get(schema);
    if (!byApp) resolutions.set(schema, (byApp = new WeakMap()));
    resolved = byApp.get(app);
    if (!resolved) byApp.set(app, (resolved = new Map()));
  } else resolved = new Map();
  return (roles) => {
    const key = JSON.stringify([...roles].sort());
    let access = resolved.get(key);
    if (!access) {
      accessCounters.resolved++;
      resolved.set(key, (access = resolveAppAccess(app, schema, roles)));
    }
    return access;
  };
}

/**
 * The roles that edit a table a command writes with no word on which of its
 * columns they edit: a role edits in place what its `fields` rule lists, and
 * a machine's column is its graph's, so a role with neither could move what
 * the command's invariant holds.
 */
function unboundedEditors(app: AppDef, schema: DatabaseSchema, table: string, accessOf: AccessOf): string[] {
  if (app.resources?.[table]?.machine) return [];
  const all = findTable(schema, table)?.columns.length ?? 0;
  return Object.keys(app.auth?.roles ?? {}).filter((role) => {
    const access = accessOf([role]);
    if (!access.writable.has(table)) return false;
    const written = access.fields?.get(table)?.write;
    return !written || written.size >= all;
  });
}

/* A table a command writes may also be edited in place, by the roles granted
   that, once the author has said which of its columns the roles edit — a
   role's `fields` rule — or given it a machine, whose column only its verbs
   move. Without either word, a role's edit could move what the command's
   invariant holds, so the pair is refused, naming the ways out. */
function editedWithoutOwnership(id: string, table: string, roles: readonly string[], accessOf: AccessOf): string {
  const fixes = roles.map((role) => {
    const rest = [...accessOf([role]).writable].filter((other) => other !== table);
    return `role "${role}": write: ${rest.length ? `[${rest.map((name) => `'${name}'`).join(', ')}]` : 'false'}`;
  });
  return (
    `Command "${id}" writes "${table}", which ${roles.length === 1 ? 'role' : 'roles'} ${roles.map((role) => `"${role}"`).join(', ')} ` +
    `also ${roles.length === 1 ? 'edits' : 'edit'} in place [command-and-edit]. Say which of its columns the ${roles.length === 1 ? 'role edits' : 'roles edit'}, ` +
    `fields: { ${table}: { read: [...], write: [...] } } in the role, or give "${table}" a machine whose verbs move its state; ` +
    `or leave "${table}" to commands (${fixes.join('; ')}).`
  );
}

/** Metadata and grants only. No connection is opened and no writer is created.
 * The private owner must attest managedOwnership; this cannot establish it. */
export function createBusinessCommandAuthorizer(input: BusinessCommandAuthorizationOptions): Readonly<{
  authorize(id: string, actor: BusinessCommandActor): BusinessCommandAuthorization;
  /** Whether a signed-in form runs this command: then it creates its rows, and its envelope names no key. */
  creates(id: string): boolean;
}> {
  let options: BusinessCommandAuthorizationOptions;
  let app: AppDef, schema: DatabaseSchema, registry: BusinessCommandRegistry;
  let managed: Readonly<Record<string, string>> | undefined;
  try {
    options = tenantOptions(input, [
      'app',
      'registry',
      'schema',
      'connectionFor',
      'writableConnection',
      'transactionalConnection',
      'managedOwnership',
    ]) as unknown as BusinessCommandAuthorizationOptions;
    app = captureTenantData(options.app);
    schema = captureTenantData(options.schema);
    managed = options.managedOwnership === undefined ? undefined : captureTenantData(options.managedOwnership);
    for (const callback of [options.connectionFor, options.writableConnection, options.transactionalConnection]) {
      if (typeof callback !== 'function' || isProxy(callback)) throw new Error();
    }
    // Registry members are genuine defineCommand instances containing trusted
    // code. Inspect only the registry's data descriptors, not that code's data.
    if (!options.registry || typeof options.registry !== 'object' || isProxy(options.registry)) throw new Error();
    const declarations = tenantOptions(options.registry, Object.keys(Object.getOwnPropertyDescriptors(options.registry)));
    registry = defineCommands(declarations as BusinessCommandRegistry);
    if (managed !== undefined) {
      tenantRecord(managed);
      for (const [resource, column] of Object.entries(managed)) {
        const table = findTable(schema, resource);
        if (!table || table.isView || typeof column !== 'string' || !table.columns.some((field) => field.name === column))
          throw new Error();
      }
    }
  } catch {
    return invalid('Business command authorization requires valid captured server metadata.');
  }
  const { connectionFor, writableConnection, transactionalConnection } = options;
  const synchronous = <T>(value: T): T => {
    if (isPromise(value)) {
      void Promise.prototype.then.call(value, undefined, () => {});
      invalid('Business command metadata callbacks must be synchronous.');
    }
    return value;
  };
  const connectionAt = (resource: string): string => {
    const value = synchronous(connectionFor(resource));
    if (typeof value !== 'string' || !value.trim()) invalid('Business commands require a valid source connection.');
    return value;
  };
  if (!grantsByRole(app) || !app.sources || !homeSourceOf(app)) invalid(missingCommandRequirements(app));
  // Normal App validation includes all inactive roles, root ceilings and the
  // complete-readable-PK rule. Managed ownership never relaxes any of these.
  const accessOf = accessMemo(app, schema);
  const declaredRoles = Object.keys(app.auth!.roles!);
  accessOf(declaredRoles);
  /* Each declared role's command grants, read once. `appCommandGrants`
     re-reads and re-checks the App's whole policy on every call, and the
     App here is a captured, frozen copy that cannot change after it checked
     out: asked per command and role, and again per request, a large tenant
     App spent most of its startup re-checking the same grants. A role the
     App does not declare grants nothing, as there. */
  const commandsOf = new Map(declaredRoles.map((role) => [role, appCommandGrants(app, [role])]));
  const granted = (roles: readonly string[], id: string) => roles.some((role) => commandsOf.get(role)?.has(id) === true);
  const allGranted = appCommandGrants(app, declaredRoles);
  for (const id of allGranted) {
    if (!Object.hasOwn(registry, id)) invalid(`Access grants an unregistered command: "${id}".`);
  }
  const rootCeiling = resourceCeiling(app);
  const rootRead = new Set(rootCeiling.read),
    rootWrite = new Set(rootCeiling.write);
  /* A public command is reachable only through a public form, under a
     public principal with no role. Granting it to a role would put a
     record-creating verb behind a session it was never designed for;
     refused at bind time. */
  for (const [id, command] of Object.entries(registry)) {
    if (command.public && allGranted.has(id)) {
      invalid(`Command "${id}" is public and cannot also be granted to a role.`);
    }
  }
  const forms = appCommandOccurrences(app)
    .filter((occurrence) => occurrence.surface === 'form')
    .map(({ view, form, reference }) => [view, form, reference.id] as const);
  /* A public form's principal runs the form's commands and nothing else: its
     own, and on a form saved each step, each step's. */
  const publicForms = new Map<string, Set<string>>();
  for (const [view, form, id] of forms) if (form.public) publicForms.set(view, (publicForms.get(view) ?? new Set()).add(id));
  /* A public page is a door of the same kind (http/pageCommandRoutes.ts): its principal runs the public commands the
     page names, and nothing else. The App's check already refused a public page naming any other. */
  for (const [view, served] of Object.entries(app.views)) {
    const page = (served as { page?: { public?: true; commands?: readonly string[] } }).page;
    if (page?.public !== true) continue;
    for (const id of page.commands ?? [])
      if (registry[id]?.public === true) publicForms.set(view, (publicForms.get(view) ?? new Set()).add(id));
  }
  /* A command that names no record (`targets: 'none'`) creates its rows: a
     signed-in form's, or a job's that runs at a time rather than on a record.
     Its envelope carries an empty key, and nothing else's may. A public one
     is the public principal's alone. */
  const creating = new Set(
    Object.entries(registry)
      .filter(([, command]) => command.targets === 'none' && command.public !== true)
      .map(([id]) => id),
  );
  /* What a role granted the command must still read of its target, whatever
     narrows it — the role's "fields", the resource's own, `hidden`: the
     revision its form submits and every column its `when` judges, or
     preparing and a refusal would say them. */
  const judgedColumnsReadable = (id: string, command: AnyBusinessCommand) => {
    const resource = logicalResource(app, command.source, command.target);
    const table = findTable(schema, resource);
    if (!table) return;
    /* The command's `when`, and each input's that asks it only of some records: read where a granted role
       narrows the target's columns, as before. */
    let judged: Array<{ text: string; said: string }> | undefined;
    const judgedOf = () =>
      (judged ??= [
        ...(command.when === undefined ? [] : [{ text: command.when, said: '"when"' }]),
        ...command.fields.flatMap((field) =>
          field.type !== 'group' && field.type !== 'lines' && field.when !== undefined
            ? recordComparisons(field.when).map((text) => ({ text, said: `input "${field.name}"'s "when"` }))
            : [],
        ),
      ]);
    /* Its own columns, and those under the rollups and computed columns it derives (commandWhen.ts): a `when`
       the command's own binding refuses is said there, with its reason. What a condition reads is the
       command's, not a role's, so it is compiled once and each granted role's columns judged against it:
       compiled again for every role, a large App's ten roles made it a tenth of startup. */
    const logicalOf = (local: string) => logicalResource(app, command.source, local);
    let derived: ReturnType<typeof withDerived> | undefined | null;
    const readsOf = new Map<string, readonly string[] | undefined>();
    const readsBy = (text: string): readonly string[] | undefined => {
      if (readsOf.has(text)) return readsOf.get(text);
      let reads: readonly string[] | undefined;
      try {
        if (derived === undefined) {
          const footprint = commandCatalog(schema, command.read, logicalOf);
          derived = footprint ? withDerived(footprint, app, schema, logicalOf) : null;
        }
        reads = derived ? compileWhen(derived[command.target], text, new Date(), ANYONE).reads : undefined;
      } catch {
        reads = undefined;
      }
      readsOf.set(text, reads);
      return reads;
    };
    for (const role of declaredRoles) {
      if (!granted([role], id)) continue;
      const seen = accessOf([role]).fields?.get(resource)?.read;
      if (!seen) continue;
      const hidden = (column: string) => !seen.has(column);
      for (const { text, said } of judgedOf()) {
        const reads = readsBy(text);
        if (reads?.some(hidden)) {
          invalid(
            `Command "${id}" is granted to role "${role}", which does not read a column of "${resource}" its ${said} judges ` +
              '(a "fields" rule or "hidden" leaves it out). Let the role read it, or judge the state in the handler.',
          );
        }
      }
    }
  };
  /* The command-and-edit conflicts are said together, across every command and role: each is a separate edit to
     the roles, and meeting them one a run (a table, then its revision column, then the next command's) was the
     slow part of wiring a second command into an App. */
  const conflicts: string[] = [];
  const bindings = new Map(
    Object.entries(registry).map(([id, command]) => {
      if (!Object.hasOwn(app.sources!, command.source)) invalid(`Command "${id}" has an unknown source.`);
      const logical = (local: string) => logicalResource(app, command.source, local);
      const read = Object.freeze(command.read.map(logical)),
        write = Object.freeze(command.write.map(logical));
      /* What the caller must read for the grant to hold: the footprint less what
       the command reads under its own authority (`elevate`). Under row policy
       the handler's reads are the actor's rows (scopedBusinessCommandAccess.ts),
       so there is no authority of the command's own to read under: refused. */
      const callerReads = Object.freeze(callerRead(command).map(logical));
      if (command.elevate && app.auth?.rows === 'policy') {
        invalid(
          `Command "${id}" elevates its read of ${command.elevate.read.map((table) => `"${table}"`).join(', ')}, but the App's rows are its policy's: ` +
            "a handler reads the caller's rows there, so no read is elevated. Grant the role the table, or drop elevate.",
        );
      }
      /* A column rule on a table the command reads — a role's, the
       resource's own, `hidden` — narrows the generic reads of those it binds:
       lists, records, the API, history. It never narrows the handler's `db`,
       which is the App's own server code reading its footprint as a service
       does (in a tenant App too: tenantCommandTransaction.ts); what reaches
       the actor is the command's declared output, the author's to shape. So
       a rule is kept (Commons hides members' emails from each other; a leads
       desk keeps the SSN from a salesperson) wherever the command itself
       cannot show what it hides:
         - a role granted the command still reads the target's revision and
           the columns its `when` judges, or preparing and a refusal would
           say them;
         - `initial` and `availability`, whose answers reach the actor as a
           prefilled form and a button, are given the target as the actor
           reads it (commandActorColumns.ts);
         - a generic write never names a column only commands change.
       A public command never runs under a role, so a role's rule on the
       table it creates rows in is the point. */
      if (!command.public) judgedColumnsReadable(id, command);
      /* Named with the rule: a command reads and writes only within the
       resources' own ceilings, and its target is always written. */
      for (const table of read) {
        if (!rootRead.has(table) || !findTable(schema, table)) {
          invalid(
            `Command "${id}" reads "${table}", which is outside the App's resource ceiling [outside-ceiling]: ` +
              `a command reads only resources the App declares. Declare resources.${table}, or drop it from the command's footprint.`,
          );
        }
      }
      /* A target's revision is its non-null integer `version` column when it has one, else the row's digest (commandRevision.ts). */
      const targetId = logical(command.target);
      const versionField = command.targets === 'none' ? undefined : versionColumn(findTable(schema, targetId)?.columns);
      for (const table of write) {
        const meta = findTable(schema, table);
        if (meta?.isView) invalid(`Command "${id}" writes "${table}", which is a view: a command writes tables.`);
        if (!rootWrite.has(table) || meta?.isView !== false) {
          invalid(
            `Command "${id}" ${table === logical(command.target) ? 'targets' : 'writes'} "${table}", which is outside the App's write ceiling [outside-ceiling]: ` +
              `a command's target and every table it writes need access: 'write' on their resource. Give resources.${table}.access: 'write'.`,
          );
        }
        /* A generic write is the in-place edit itself, held to the role's own
         editor rules by its handler: no invariant of its own to protect. */
        /* A flow's own command writes only the columns the App lists in `flows.set`, held to the App's validation: no invariant of its own either. */
        const generic = genericWriteOf(command) !== undefined || flowCommandOf(command) !== undefined;
        const editors = generic ? [] : unboundedEditors(app, schema, table, accessOf);
        if (editors.length) conflicts.push(editedWithoutOwnership(id, table, editors, accessOf));
        /* The revision a command's form was prepared at is the command's to
         move: an in-place edit that could set it back would let a stale form
         through, or refuse every fresh one. */
        if (table === logical(command.target) && versionField !== undefined) {
          const editing = Object.keys(app.auth?.roles ?? {}).filter(
            (role) =>
              accessOf([role]).fields?.get(table)?.write.has(versionField) ||
              (accessOf([role]).writable.has(table) && !accessOf([role]).fields?.get(table)),
          );
          if (editing.length) {
            const said = editing.map((role) => `"${role}"`).join(', ');
            conflicts.push(
              `Command "${id}" keeps its revision in "${versionField}" of "${table}", which ${editing.length === 1 ? 'role' : 'roles'} ${said} also ${editing.length === 1 ? 'edits' : 'edit'} in place [command-and-edit]. ` +
                `Leave "${versionField}" out of the role's fields write: a table's non-null integer "version" column is its revision, which only commands move.`,
            );
          }
        }
        /* A plain import is the generic insert, many times: it would go around
         the command that owns these rows unless a machine says where a new
         one starts and how it moves. */
        const plain = plainImportTargets(app).find((target) => target.resource === table);
        if (plain && !generic && !app.resources?.[table]?.machine) {
          invalid(
            `${plain.at} imports rows into "${table}", which command "${id}" writes. Give "${table}" a machine, whose first state a new row starts in, ` +
              `name the command each row runs, as import: { command, match: ['…'] }, or drop "import".`,
          );
        }
      }
      const resource = logical(command.target),
        connection = connectionAt(resource);
      const keyColumns = Object.freeze(
        schema.tables
          .find((table) => table.id === resource)!
          .columns.filter((column) => column.primaryKey)
          .map((column) => column.name),
      );
      if (!keyColumns.length) invalid(`Command "${id}" requires a target with a primary key.`);
      if (read.some((table) => connectionAt(table) !== connection)) invalid(`Command "${id}" spans physical database connections.`);
      if (synchronous(writableConnection(connection)) !== true || synchronous(transactionalConnection(connection)) !== true) {
        invalid(`Command "${id}" requires a writable source with transaction support.`);
      }
      // What its handler's `db` and the target's read are built on, and what
      // the command says of its target, judged against it now rather than on
      // the first request.
      const catalog = zonedCatalog(
        withSaying(
          withDerived(
            commandCatalog(schema, command.read, logical) ?? invalid(`Command "${id}" reads outside the application resource ceiling.`),
            app,
            schema,
            logical,
          ),
          app,
          schema,
          logical,
        ),
        appZone(app.ui),
      );
      const target = catalog[command.target];
      /* `me` is the actor at run time (whenPerson): judged here as someone signed in, with a row where the
         command reads the people table, so a `me` no actor could be — on a reference to another table — is
         refused now rather than on the first request. */
      const found = peopleIn(app, schema, catalog).people;
      const someone: QueryPerson = { email: 'someone@example.invalid', ...(found ? { person: { table: found.id, key: 0 } } : {}) };
      if (command.when !== undefined) {
        try {
          compileWhen(target, command.when, new Date(), someone);
        } catch (error) {
          // A `me` on a reference is the actor's row only where the command reads the people table, as a handler's `me` is.
          const hint =
            !found && app.auth?.me && /\bme\b/.test((error as Error).message)
              ? " Add the people table (auth.me) to the command's reads."
              : '';
          invalid(`Command "${id}" when: ${(error as Error).message}${hint}`);
        }
      }
      for (const field of command.fields) {
        if (field.type === 'group' || field.type === 'lines' || field.when === undefined) continue;
        try {
          for (const comparison of recordComparisons(field.when)) compileWhen(target, comparison, new Date(), someone);
        } catch (error) {
          invalid(`Command "${id}" input "${field.name}" when: ${(error as Error).message}`);
        }
      }
      // A lookup reads the App's other sources before the transaction: judged
      // like a read — inside the root ceiling, no field rule narrowing it — and
      // held to the App's own rule for lookups (commandLookupRules.ts).
      let lookup: Readonly<{ tables: readonly string[]; reader: NonNullable<BusinessCommandAuthorization['lookupTables']> }> | undefined;
      if (command.sources) {
        const problem = commandLookupProblem(app, id, command.sources);
        if (problem) throw new CommandLookupRefusal(problem);
        const sources = command.sources;
        const catalogs: Record<string, CommandCatalog> = {},
          tables: string[] = [];
        for (const [source, locals] of Object.entries(sources)) {
          const named = (local: string) => logicalResource(app, source, local);
          for (const local of locals) {
            const looked = named(local),
              table = findTable(schema, looked);
            if (!rootRead.has(looked) || !table)
              invalid(`Command "${id}" looks up "${looked}", which is outside the application resource ceiling.`);
            // A lookup is the handler's own read, before its transaction: a
            // column rule narrows generic reads, never it (as above).
            tables.push(looked);
          }
          catalogs[source] = zonedCatalog(
            commandCatalog(schema, locals, named) ?? invalid(`Command "${id}" looks up outside the application resource ceiling.`),
            appZone(app.ui),
          );
        }
        lookup = Object.freeze({
          tables: Object.freeze(tables),
          reader: Object.freeze({
            catalogs: Object.freeze(catalogs),
            logical(source: string, local: string): string {
              if (!Object.hasOwn(sources, source) || !sources[source].includes(local)) throw new AppAccessDenied();
              return logicalResource(app, source, local);
            },
          }),
        });
      }
      /* A lookup that only calls integrations reads no source: its reader holds no table, only the target as it stands. */
      if (!lookup && command.integrations)
        lookup = Object.freeze({
          tables: Object.freeze([]),
          reader: Object.freeze({
            catalogs: Object.freeze({}),
            logical(): string {
              throw new AppAccessDenied();
            },
          }),
        });
      const machine = commandMachine(app, schema, id, command, logical);
      /* A file resource it writes takes bytes only as an upload would: in its content column, within its cap. */
      const files = new Map<string, CommandFileRule>();
      for (const local of command.write) {
        const file = app.resources?.[logical(local)]?.file;
        if (!file) continue;
        const most = file.maxBytes ?? FILE_MAX_BYTES_DEFAULT;
        files.set(
          local,
          Object.freeze({
            ...file,
            table: local,
            resource: logical(local),
            maxBytes: isTenantApp(app) ? Math.min(most, TENANT_FILE_MOST) : most,
          }),
        );
      }
      return [
        id,
        {
          command,
          resource,
          connection,
          logical,
          read,
          callerReads,
          write,
          keyColumns,
          catalog,
          lookup,
          machine,
          versionField,
          ...(appZone(app.ui) ? { timezone: appZone(app.ui) } : {}),
          ...peopleIn(app, schema, catalog),
          ...(files.size ? { files } : {}),
        },
      ] as const;
    }),
  );
  if (conflicts.length) invalid([...new Set(conflicts)].join('\n'));
  return Object.freeze({
    creates: (id: string): boolean => creating.has(id),
    authorize(id: string, actor: BusinessCommandActor): BusinessCommandAuthorization {
      const binding = bindings.get(id);
      let identity: BusinessCommandActor;
      try {
        if (!actor || typeof actor !== 'object' || isProxy(actor)) throw new Error();
        const own = (key: keyof BusinessCommandActor) => {
          const descriptor = Object.getOwnPropertyDescriptor(actor, key);
          if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error();
          return descriptor.value;
        };
        const optional = (key: 'kind' | 'form' | 'support' | 'email' | 'name') => (Object.hasOwn(actor, key) ? own(key) : undefined);
        const captured = captureTenantData({
          id: own('id'),
          appId: own('appId'),
          roles: own('roles'),
          kind: optional('kind'),
          form: optional('form'),
          support: optional('support'),
          email: optional('email'),
          name: optional('name'),
        });
        if (
          typeof captured.id !== 'string' ||
          !captured.id.trim() ||
          captured.appId !== app.id ||
          !Array.isArray(captured.roles) ||
          captured.roles.some((role) => typeof role !== 'string')
        )
          throw new Error();
        /* Who a person is, in words: a verified session's email and name. A
           public or service principal is nobody's account, so carrying
           either is malformed rather than quietly dropped. */
        const said = (value: unknown, max: number) =>
          value === undefined || (typeof value === 'string' && value.trim() !== '' && value.length <= max && !value.includes('\0'));
        if (
          !said(captured.email, 320) ||
          !said(captured.name, 200) ||
          (captured.kind !== undefined && (captured.email !== undefined || captured.name !== undefined))
        )
          throw new Error();
        // Inside a dealer, or not there at all: a marker that is anything but
        // true is malformed. A public or service principal is never inside one,
        // so the combination is refused rather than quietly ignored.
        if (captured.support !== undefined && (captured.support !== true || captured.kind !== undefined)) throw new Error();
        if (captured.kind === 'service') {
          // A declared service principal: the id its declaration derives,
          // the roles it declares, and no public form.
          if (captured.form !== undefined || !captured.roles.length || !SERVICE_ID.test(captured.id)) throw new Error();
        } else if (captured.kind !== undefined || captured.form !== undefined) {
          // A public principal is whole or nothing: the kind, the public form
          // it came through, no roles, and the id the form route derives.
          if (
            captured.kind !== 'public' ||
            typeof captured.form !== 'string' ||
            !publicForms.has(captured.form) ||
            captured.roles.length ||
            captured.id !== `public:${captured.form}`
          )
            throw new Error();
        }
        // Rebuilt, not adopted: only these properties survive, so a forged extra
        // one on the caller's object reaches nothing below.
        identity = Object.freeze({
          id: captured.id,
          appId: captured.appId,
          roles: Object.freeze([...captured.roles]),
          ...(captured.kind === 'public'
            ? { kind: 'public' as const, form: captured.form as string }
            : captured.kind === 'service'
              ? { kind: 'service' as const }
              : {}),
          ...(captured.support === true ? { support: true as const } : {}),
          ...(typeof captured.email === 'string' ? { email: captured.email } : {}),
          ...(typeof captured.name === 'string' ? { name: captured.name } : {}),
        });
      } catch {
        throw new AppAccessDenied();
      }
      if (!binding) throw new AppAccessDenied();
      if (identity.kind === 'public') {
        /* No role, so no grant and no role ceiling: the command must be
           public and be the one the public form names. Its reads were bounded
           by the root ceiling at bind time; that is all a public handler gets. */
        if (binding.command.public !== true || publicForms.get(identity.form!)?.has(id) !== true) throw new AppAccessDenied();
        issueTargetUnreadable(identity);
      } else {
        // A generic write is granted where the role's editor could make the change; a flow's own command, to its runner alone.
        const generic = genericWriteOf(binding.command);
        const flow = flowCommandOf(binding.command);
        if (
          binding.command.public === true ||
          !(flow
            ? identity.kind === 'service' && identity.id === `service:${flow.runAs}`
            : generic
              ? genericWriteEntitled(app, schema, identity.roles, generic)
              : granted(identity.roles, id))
        )
          /* An ordinary command the roles simply do not hold says so, by the label the App shows for it; the rest
             (a flow's, a public one, a generic write) keep the fixed sentence. */
          throw !flow && !generic && binding.command.public !== true
            ? sayRefusal(new AppAccessDenied(), `Your role has no grant for "${commandLabel(app, id)}".`)
            : new AppAccessDenied();
        if (identity.kind === 'service' && serviceRoleRefusal(app, identity.roles)) throw new AppAccessDenied();
        /* A command the App withholds from a lender's operator inside a dealer
           (`support: 'refuse'`). Today a support visit is read-only: the tenant
           contexts refuse every command before it reaches here (tenantContexts.ts),
           and nothing yet mints a principal carrying `support`. This is the guard
           for the day a visit may act, so an App can already keep an operation whose
           consequence leaves the dealer's records theirs to run. The dealer's own
           members are unaffected. */
        if (identity.support === true && binding.command.support === 'refuse') throw new AppAccessDenied();
        const access = accessOf(identity.roles);
        if (binding.callerReads.some((table) => !access.readable.has(table))) throw new AppAccessDenied();
        if (binding.lookup?.tables.some((table) => !access.readable.has(table))) throw new AppAccessDenied();
        // A job's service principal prepares no form and presses no button.
        const seen = access.fields?.get(binding.resource)?.read;
        if (seen && identity.kind !== 'service') issueTargetColumns(identity, seen);
        if (!access.readable.has(binding.resource) && identity.kind !== 'service') issueTargetUnreadable(identity);
      }
      return Object.freeze({
        command: binding.command,
        resource: binding.resource,
        actor: identity,
        // A form's command creates its rows: the envelope names no key. A
        // signed-in form's is still granted like any command, above.
        keyColumns: identity.kind === 'public' || creating.has(id) ? Object.freeze([]) : binding.keyColumns,
        connection: binding.connection,
        read: binding.read,
        write: binding.write,
        catalog: binding.catalog,
        ...(binding.versionField ? { versionField: binding.versionField } : {}),
        ...(binding.lookup ? { lookupTables: binding.lookup.reader } : {}),
        ...(binding.machine ? { machine: machineFor(binding.machine, identity) } : {}),
        ...(binding.timezone ? { timezone: binding.timezone } : {}),
        ...(binding.people ? { people: binding.people } : {}),
        ...(binding.files ? { files: binding.files } : {}),
        table(local: string, writing = false): string {
          if (!(writing ? binding.command.write : binding.command.read).includes(local)) throw new AppAccessDenied();
          return binding.logical(local);
        },
      });
    },
  });
}

/* The people table by its local name in the command's catalog, where the command reads it: a handler's `me`
   on a reference to it is the actor's row, looked up in the same transaction as the write. */
function peopleIn(
  app: AppDef,
  schema: DatabaseSchema,
  catalog: CommandCatalog,
): { people?: { table: string; column: string; key: string; id: string } } {
  const { table, column } = personTable(app, schema);
  if (!table || !column) return {};
  const local = Object.keys(catalog).find((name) => catalog[name].meta.id === table.id);
  return local ? { people: Object.freeze({ table: local, column, key: primaryKey(table)[0], id: table.id }) } : {};
}
