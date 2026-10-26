import { basename, resolve } from 'node:path';
import { connectionFailure } from '../storeConnection.js';
import { pathToFileURL } from 'node:url';
import { appCommandGrants, isFormView, logicalResource, type AppAction, type AppDef } from '../../shared/app.js';
import type { AppTagsDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppCommandReference, AppFormCommandReference } from '../../shared/command.js';
import { unformedCommands } from './commandContracts.js';
import { appCommandOccurrences } from '../../shared/appCommandOccurrences.js';
import { importCommandOccurrences } from '../../shared/appImport.js';
import type { AppImportDef } from '../../shared/appImportDeclaration.js';
import { commandReferenceCatalogProblem } from './businessCommandReferenceChecks.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { bindBusinessCommands } from './businessCommandAccess.js';
import { consumesValidation } from '../app/appValidation.js';
import { effectiveTrack } from './commandTrack.js';
import { publicFormProblems, publicFormsNeedKey } from '../forms/savedFormChecks.js';
import { assertFormKey, FormKeyMissing } from '../forms/formKey.js';
import { BusinessCommandDefinitionError, callerRead, defineCommands, type BusinessCommandRegistry } from './businessCommands.js';
import { moduleFailure } from '../moduleFailure.js';
import { recordRefusalCause } from '@mistriwork/engine/shared/refusal.js';
import { commandsOf } from '../stores/commandStores.js';

/** Trusted deployment code runs once in the server, with its private environment. */
export async function loadBusinessCommands(file: string): Promise<BusinessCommandRegistry> {
  let module: { default?: unknown };
  try {
    module = await import(pathToFileURL(resolve(file)).href);
  } catch (error) {
    /* Module errors can contain private environment values or identity
       mapping data, so the sentence is fixed; what failed, and on which line,
       is recorded for the operator's console alone (`because:`), as a row
       policy's is. The sentence alone sent authors to bisect their module. */
    throw recordRefusalCause(
      new BusinessCommandDefinitionError('The commands module could not be loaded. Export a default defineCommands registry.'),
      `The commands module "${basename(file)}" did not load: ${moduleFailure(resolve(file), error)}`,
    );
  }
  /* The registry is the module's default export; without one, defineCommands said only "Command
     registry must be a plain object", and the named exports beside it read as if they should count. */
  const shape = `The commands module "${basename(file)}" must default-export its registry: export default defineCommands({ … }), every command by its id`;
  if (module.default === undefined) throw new BusinessCommandDefinitionError(`${shape}; it has no default export.`);
  try {
    // A declaration refusal names the command and the rule it broke: said as it is.
    return defineCommands(module.default as Parameters<typeof defineCommands>[0]);
  } catch (error) {
    if (error instanceof BusinessCommandDefinitionError && /^Command registry |must be created with defineCommand/.test(error.message)) {
      throw new BusinessCommandDefinitionError(`${shape}. ${error.message}`);
    }
    throw error;
  }
}

/**
 * What the App's command names resolved to, checked against the catalog it
 * runs on: each served reference by id (what prepare and execution find a
 * request's command by). The references were resolved from this registry
 * when the App loaded (shared/command.ts), so their input, target, version
 * and realm are the registration's by construction; what is left to judge is
 * where each is used.
 */
export function validateBusinessCommandReferences(
  app: AppDef,
  registry: BusinessCommandRegistry,
  resources: Pick<RuntimeResources, 'schema'>,
): ReadonlyMap<string, AppCommandReference> {
  const references = new Map<string, AppCommandReference>();
  /* Prepare judges a selection by the `when` its command is offered in bulk
     under (bulkCommandWhen), so one command's bulk actions agree on it. A
     command's actions all live on its target resource: the reference check
     below refuses one anywhere else. */
  const bulk = new Map<string, string | undefined>();
  const invalid = (message: string): never => {
    throw new BusinessCommandDefinitionError(message);
  };
  /* A reference resolved from another registry (an App loaded with one
     module, bound to another) is not this registration's: its contract may
     have moved, so it is refused rather than trusted. */
  const registration = (id: string, version: number, at: string) => {
    const command = registry[id];
    if (!command) return invalid(`${at} names the command "${id}", which the commands module does not register.`);
    if (command.version !== version)
      return invalid(
        `${at}: command "${id}" was resolved at version ${version}, and its registration is at ${command.version}; load the App with this commands module.`,
      );
    return command;
  };
  const occurrences = appCommandOccurrences(app);
  for (const occurrence of occurrences) {
    if (occurrence.surface !== 'action') continue;
    const { resource: name, action, reference } = occurrence;
    const command = registration(reference.id, reference.version, `resources "${name}", action "${action.label}"`);
    // Pruning the graph also rejects selection filters that follow an undeclared resource.
    const problem = commandReferenceCatalogProblem(app, command, reference, name, resources.schema);
    if (problem) invalid(`Command "${reference.id}": ${problem}`);
    references.set(reference.id, structuredClone(reference));
    if (action.bulk === true) {
      if (bulk.has(reference.id) && bulk.get(reference.id) !== action.when) {
        invalid(`Command "${reference.id}" is offered in bulk under different "when" conditions; a selection is prepared against one.`);
      }
      bulk.set(reference.id, action.when);
    }
  }
  /* An import runs its command once per row, on the record the row's `match`
     columns find: a signed-in command on one record of this resource. */
  for (const { at, resource: name, reference } of importCommandOccurrences(app)) {
    const command = registration(reference.id, reference.version, at);
    if (reference.target !== name || (command.targets ?? 'one') !== 'one' || command.public === true) {
      invalid(`${at}: import command "${reference.id}" must be a signed-in command on one "${name}" record.`);
    }
    const problem = commandReferenceCatalogProblem(app, command, reference, name, resources.schema);
    if (problem) invalid(`Command "${reference.id}": ${problem}`);
    references.set(reference.id, structuredClone(reference));
  }
  // API-only targeted commands also have a prepare surface. Keep its
  // reference under the same registration and target checks as a UI action.
  for (const { command: reference } of app.api?.commands ?? []) {
    if (!('target' in reference)) continue;
    const command = registration(reference.id, reference.version, `API command "${reference.id}"`);
    const owner = logicalResource(app, command.source, command.target);
    const problem = commandReferenceCatalogProblem(app, command, reference, owner, resources.schema);
    if (problem) invalid(`Command "${reference.id}": ${problem}`);
    references.set(reference.id, structuredClone(reference));
  }
  /* A form's command is presentation over a handler the server registered;
     whether it is public was judged when its name resolved. */
  for (const occurrence of occurrences) {
    if (occurrence.surface !== 'form') continue;
    const { view: key, form, reference } = occurrence;
    const id = reference.id;
    const command = registration(id, reference.version, `Form "${key}"`);
    // A signed-in form runs in its own realm, so its command must be that realm's.
    if (!form.public && (form.realm ?? 'tenant') !== (command.realm ?? 'tenant'))
      invalid(`Form "${key}": command "${id}" runs in another realm.`);
  }
  /* A command that names no record prepares its form's starting values, over no record, wherever a signed-in
     reader opens it: its form, or a component's `useCommand`. A public one prepares nothing. */
  for (const [id, command] of Object.entries(registry)) {
    if (command.targets !== 'none' || command.public === true || references.has(id)) continue;
    const owner = logicalResource(app, command.source, command.target);
    const problem = commandReferenceCatalogProblem(
      app,
      command,
      { id, version: command.version, input: [...command.fields] },
      owner,
      resources.schema,
    );
    if (problem) invalid(`Command "${id}": ${problem}`);
    references.set(id, {
      id,
      version: command.version,
      target: owner,
      input: structuredClone(command.fields) as AppCommandReference['input'],
    });
  }
  /* A public form is write-only to whoever fills it in, and a saved one needs
     tables that can hold a draft (forms/savedFormChecks.ts). */
  const problem = publicFormProblems(app, registry, resources.schema);
  if (problem) invalid(problem);
  // A keyed input is hashed under the deployment's form key: without one, refuse to start rather than keep a bare digest.
  if (publicFormsNeedKey(app, registry)) {
    try {
      assertFormKey(app.id);
    } catch (error) {
      if (error instanceof FormKeyMissing) invalid(error.message);
      throw error;
    }
  }
  return references;
}

/**
 * The `when` a command is offered in bulk under: prepare judges a selection
 * by it. Undefined when its bulk action has none, or no action offers it in
 * bulk; validateBusinessCommandReferences refuses bulk actions of one
 * command that disagree. Visibility only: execution still refuses whatever
 * the handler refuses.
 */
export function bulkCommandWhen(app: AppDef, command: string): string | undefined {
  for (const resource of Object.values(app.resources ?? {})) {
    const action = resource.actions?.find((candidate) => candidate.bulk === true && candidate.command?.id === command);
    if (action) return action.when;
  }
  return undefined;
}

/** `events` is the App-scope event source startup issued (appCommandEvents.ts),
 * when a command declares events; without it such a registry is refused. */
export function bindHttpBusinessCommands(
  app: AppDef,
  commands: BusinessCommandRegistry,
  resources: RuntimeResources,
  writableConnection: (connection: string) => boolean,
  events?: CommandJournalAppScope,
): HttpBinding {
  /* Once per App, registry, resources and event source, with the writable
     connections as they are now: binding compiles every command's grants,
     footprint and validation, 15–20 ms, and every command request did it
     again. Every input is in the key (the resources are themselves kept per
     App and opened connection, appRuntimeResources.ts), so a reloaded App,
     a reopened connection or a changed config is a new entry, never a stale
     one; the binding reads writability live as it did. */
  const writable = resources.connections.map((connection) => (writableConnection(connection) ? '1' : '0')).join('');
  const byRegistry: ByRegistry = boundCommands.get(app) ?? new WeakMap();
  boundCommands.set(app, byRegistry);
  const byResources: ByResources = byRegistry.get(commands) ?? new WeakMap();
  byRegistry.set(commands, byResources);
  const byEvents: ByEvents = byResources.get(resources) ?? new Map();
  byResources.set(resources, byEvents);
  const key = `${writable}`;
  const kept = byEvents.get(key);
  if (kept && kept.events === events) return kept.bound;
  const bound = bindHttpBusinessCommandsNow(app, commands, resources, writableConnection, events);
  byEvents.set(key, { events, bound });
  return bound;
}

type HttpBinding = ReturnType<typeof bindHttpBusinessCommandsNow>;
type ByEvents = Map<string, { events: CommandJournalAppScope | undefined; bound: HttpBinding }>;
type ByResources = WeakMap<RuntimeResources, ByEvents>;
type ByRegistry = WeakMap<BusinessCommandRegistry, ByResources>;
const boundCommands = new WeakMap<AppDef, ByRegistry>();

function bindHttpBusinessCommandsNow(
  app: AppDef,
  commands: BusinessCommandRegistry,
  resources: RuntimeResources,
  writableConnection: (connection: string) => boolean,
  events?: CommandJournalAppScope,
) {
  /* A line's `consumes` holds on a handler's writes as on every other door
     (appConsumes.ts): the handler's transaction moves the balance as Save does. */
  const consumed = consumesValidation(resources.schema, app);
  const binding = bindBusinessCommands({
    app,
    registry: commands,
    resources,
    writableConnection,
    ...(events ? { events } : {}),
    ...(consumed ? { validation: consumed } : {}),
  });
  const references = validateBusinessCommandReferences(app, commands, resources);
  for (const [id, command] of Object.entries(commands)) {
    const resource = logicalResource(app, command.source, command.target);
    const source = resources.forConnection(resources.connectionFor(resource));
    // MySQL has ordinary transactions and no journal; the capability, not the
    // dialect, is the fact — but naming the engines keeps the refusal honest.
    if (!['sqlite', 'postgres'].includes(source.dialect) || !commandsOf(source).commandTransaction) {
      throw new BusinessCommandDefinitionError(
        `Command "${id}" requires the durable command capability; SQLite and PostgreSQL provide it.`,
      );
    }
  }
  return { binding, references };
}

/**
 * Permission-filter the resources' actions before resolving navigation: a
 * command action this principal cannot run leaves its resource, and every
 * list over the resource stays.
 */
export function visibleBusinessCommandActions(
  app: AppDef,
  commands: BusinessCommandRegistry | undefined,
  readableSchema: DatabaseSchema,
  roles: readonly string[],
): AppDef {
  const grants = appCommandGrants(app, [...roles]);
  const readable = new Set(readableSchema.tables.map((table) => table.id));
  const runs = (reference: { id: string; version: number }): boolean => {
    const command = commands?.[reference.id];
    return Boolean(
      command &&
      grants.has(reference.id) &&
      command.version === reference.version &&
      callerRead(command).every((local) => readable.has(logicalResource(app, command.source, local))),
    );
  };
  const runnable = (action: AppAction): boolean => !action.command || runs(action.command);
  /* An action whose command keeps nothing when the browser runs it says so,
     so its form checks a lost answer on the record (effectiveTrack). */
  const tracked = (action: AppAction): AppAction => {
    const command = action.command ? commands?.[action.command.id] : undefined;
    return command && effectiveTrack(command.track ?? app.track, 'ui') === 'none' ? ({ ...action, untracked: true } as AppAction) : action;
  };
  /* An import whose command this principal cannot run is not offered, as its action is not. */
  const importable = <T extends { import?: AppImportDef | false }>(block: T): T =>
    block.import && block.import.command && !runs(block.import.command) ? { ...block, import: undefined } : block;
  /* A tag picker's commands are served, like an action's, to a principal who runs both; one who does
     not gets the picker over the link table, which its own writes judge. */
  const taggable = <T extends { tags?: AppTagsDef }>(block: T): T =>
    block.tags?.add && block.tags.remove && !(runs(block.tags.add) && runs(block.tags.remove))
      ? { ...block, tags: { through: block.tags.through, to: block.tags.to, ...(block.tags.toneOf ? { toneOf: block.tags.toneOf } : {}) } }
      : block;
  /* A signed-in form is served only to a principal who could submit it, so
     its room and its nav entry go with the grant. A public form is left to
     its own route, which serves it to everyone. */
  const views = Object.fromEntries(
    Object.entries(app.views)
      .filter(([, view]) => !isFormView(view) || view.public === true || runs(view.command))
      .map(([key, view]) => [
        key,
        'table' in view && !isFormView(view) && view.import ? { ...view, import: importable(view).import ?? false } : view,
      ]),
  );
  return {
    ...app,
    views,
    ...(app.resources
      ? {
          resources: Object.fromEntries(
            Object.entries(app.resources).map(([name, resource]) => [
              name,
              taggable(importable(resource.actions ? { ...resource, actions: resource.actions.filter(runnable).map(tracked) } : resource)),
            ]),
          ),
        }
      : {}),
  };
}

/**
 * The commands this principal runs that name no record and that no signed-in
 * form runs (unformedCommands), under the same grant and reads an action's
 * command is offered under: what a component's `useCommand` reaches by name.
 */
export function grantedFormCommands(
  app: AppDef,
  commands: BusinessCommandRegistry | undefined,
  readableSchema: DatabaseSchema,
  roles: readonly string[],
  realm: 'tenant' | 'platform' = 'tenant',
): Record<string, AppFormCommandReference> {
  if (!commands || !roles.length) return {};
  const grants = appCommandGrants(app, [...roles]);
  const readable = new Set(readableSchema.tables.map((table) => table.id));
  return unformedCommands(
    app,
    commands,
    (id, command) => grants.has(id) && callerRead(command).every((local) => readable.has(logicalResource(app, command.source, local))),
    realm,
  );
}

/** Attest the existing journal through its runtime capability; never migrate on startup/request. */
export async function validateBusinessCommandStartup(
  app: AppDef,
  commands: BusinessCommandRegistry,
  resources: RuntimeResources,
  writableConnection: (connection: string) => boolean,
  events?: CommandJournalAppScope,
): Promise<void> {
  // Startup judges what is there now: never a binding kept from before.
  bindHttpBusinessCommandsNow(app, commands, resources, writableConnection, events);
  const connections = new Set(
    Object.values(commands).map((command) => resources.connectionFor(logicalResource(app, command.source, command.target))),
  );
  for (const connection of connections) {
    const adapter = resources.forConnection(connection);
    try {
      await commandsOf(adapter).commandTransaction!(async () => {});
    } catch (error) {
      const unreachable = connectionFailure(error);
      if (unreachable !== undefined) {
        throw new BusinessCommandDefinitionError(
          `The command journal on connection "${connection}" could not be checked: the database could not be reached (${unreachable}). ` +
            'The journal is not the problem; fix the connection and start again.',
        );
      }
      throw new BusinessCommandDefinitionError(journalUnavailable(connection, adapter.dialect));
    }
  }
}

/* The refusal names the one call that provisions the journal, since startup
   never migrates it: "run its explicit migration" sent people searching the
   examples for which function that was. The URL or path is the caller's to
   supply — a Postgres URL carries a password and never belongs in a log. */
function journalUnavailable(connection: string, dialect: string): string {
  const at = `The command journal on connection "${connection}" is unavailable`;
  /* One command makes it, and the event store beside it when a command records events. */
  const once =
    "it is provisioned once, never on startup. Run `mistri migrate stores up --app <the App's directory>` with the server stopped";
  if (dialect === 'sqlite')
    return `${at}: ${once} (or migrateSqliteCommandJournal(path) from @mistriwork/mistri/commands), then start again.`;
  if (dialect === 'postgres') {
    return `${at}: ${once}, as a role that may create tables (or migratePostgresCommandJournal(url) from @mistriwork/mistri/commands), then start again.`;
  }
  return `${at}: commands keep their journal in SQLite or PostgreSQL, and this connection is ${dialect}.`;
}
