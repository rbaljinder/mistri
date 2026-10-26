/** The App API's generic writes: `expose(fields, { create, update, delete })`.
 *
 * Each opted-in verb becomes a command the platform defines here — never the
 * App's commands module — and the API serves it on the command routes, so a
 * generic write has what every command has: a receipt, `Idempotency-Key`
 * replay and recovery, `If-Match` against the record's revision, and the
 * 403/409/410/422 refusals. Its grant is the signed-in editor's
 * (genericWriteBrand.ts), and its handler writes through the role's own
 * resource access — field ceilings, `creatable`, validation, transitions and
 * stamps — exactly as the UI's write path does (http/source.ts). The default
 * stays read-only: nothing here exists until a resource says `create`,
 * `update` or `delete`. */
import { homeSourceOf, logicalResource, resolveAppAccess, resourceCeiling, appDeletable, type AppDef } from '../../shared/app.js';
import { apiWrites, type ApiWrite } from '../../shared/appApi.js';
import {
  columnKind,
  isFlagColumn,
  primaryKey,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { defineCommand, defineCommands, type AnyBusinessCommand, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { defineSource } from '../commands/commandDb.js';
import { field } from '../commands/commandFields.js';
import { int, oneOf, shape, text } from '../commands/commandShapes.js';
import { BusinessCommandExecutionError, refuse } from '../commands/commandErrors.js';
import { apiDialectOf } from './apiValueCodec.js';
import { genericWriteEntitled, genericWriteOf, markGenericWrite } from '../commands/genericWriteBrand.js';
import { AppAccessDenied, authorizeTransaction, type ResourceAccess } from '../app/appAccess.js';
import { AppValidationDenied, ConsumesRefused } from '../app/appValidationDenied.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import { AppTransitionDenied, compileAppTransitions } from '../app/appTransitions.js';
import { compileAppStamps, stampInsert, stampUpdate } from '../app/appStamps.js';
import { lookupPerson, personKey } from '../app/appMe.js';

export { apiWrites, apiExposesCommands } from '../../shared/appApi.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTEGER =
  /^(?:tinyint|smallint|mediumint|int(?:eger|2|4|8)?|bigint|serial|bigserial|smallserial)(?:\s*\(\s*\d+\s*\))?(?:\s+unsigned)?$/i;

/** A key a database assigns: an identity, a default, or SQLite's integer rowid alias. */
const assigned = (column: ColumnMeta, schema: DatabaseSchema, table: string) =>
  column.identity !== undefined ||
  column.default !== undefined ||
  column.hasDefault === true ||
  (apiDialectOf(schema, table) === 'sqlite' && column.primaryKey && INTEGER.test(column.type.trim()));

/** Every problem with the App's generic writes, judged against its logical
 * schema, each with its check code. The registry, when given, is the App's
 * commands module: a synthesized id must not shadow one of its commands. */
export function apiWriteProblems(app: AppDef, schema: DatabaseSchema, registry?: BusinessCommandRegistry): string[] {
  const writes = apiWrites(app.api);
  if (!writes.length) return [];
  const problems: string[] = [];
  const home = homeSourceOf(app);
  /* Each refusal names the one thing in the way: "one source" read as wrong to an App bound by `connection`,
     which has one, when what stood in the way was its connection's name. */
  if (app.auth?.rows !== 'all') {
    return [
      `api: generic writes run where every role reads all rows, and this App's roles read ${app.auth?.rows === 'tenant' ? "a tenant's" : 'what its row policy allows'} [api-write-unsupported]. ` +
        'A tenant App or a row-policy App writes through the commands it exposes.',
    ];
  }
  if (Object.keys(app.sources ?? {}).length > 1) {
    return [
      `api: generic writes run on an App with one source, and this App has ${Object.keys(app.sources!).length} [api-write-unsupported]. ` +
        'Write through a command the App exposes.',
    ];
  }
  if (!home) {
    return [
      `api: generic writes keep their receipts beside the App's own source, and connection "${app.connection ?? ''}" is not a name a source can have ` +
        `[api-write-unsupported]. Name it: sources: { main: { connection: ${JSON.stringify(app.connection ?? 'my-database')}, default: true } }.`,
    ];
  }
  const ceiling = new Set(resourceCeiling(app).write),
    deletes = appDeletable(app, schema);
  for (const write of writes) {
    const at = `api.resources.${write.resource}`;
    const table = schema.tables.find((item) => item.id === write.resource);
    if (!table || table.isView || !primaryKey(table).length || logicalResource(app, home, write.resource) !== write.resource) {
      problems.push(
        `${at}.${write.verb}: "${write.resource}" is not a table of the App's own source with a primary key [api-write-unsupported].`,
      );
      continue;
    }
    if (!ceiling.has(write.resource)) {
      problems.push(
        `${at}.${write.verb}: "${write.resource}" is read-only in the App [api-write-unsupported]. Give resources.${write.resource}.access: 'write'.`,
      );
      continue;
    }
    if (write.verb === 'delete' && !deletes.has(write.resource)) {
      problems.push(
        `${at}.delete: the App does not delete "${write.resource}" records [api-write-unsupported]. Give resources.${write.resource}.delete: true, or drop delete.`,
      );
    }
    for (const name of write.fields) {
      const column = table.columns.find((item) => item.name === name);
      if (!IDENTIFIER.test(name) || !column) {
        problems.push(
          `${at}: "${name}" is not a column of "${write.resource}", so a generic write cannot set it [api-write-field]. Expose its columns only, or write it with a command.`,
        );
      }
      const file = app.resources?.[write.resource]?.file;
      if (column && (name === file?.object || name === file?.hash))
        problems.push(
          `${at}: "${name}" is the file's own column, which only the server writes [api-write-field]. Leave it out; an upload fills it.`,
        );
    }
    if (write.verb === 'create') {
      const missing = table.columns.filter(
        (column) => !column.nullable && !assigned(column, schema, table.id) && !write.fields.includes(column.name),
      );
      if (missing.length) {
        problems.push(
          `${at}.create: "${write.resource}" needs ${missing.map((column) => `"${column.name}"`).join(', ')}, which the exposure leaves out [api-write-field]. Add ${missing.length === 1 ? 'it' : 'them'} to fields.`,
        );
      }
    }
    const roles = app.api!.roles.filter((role) =>
      genericWriteEntitled(app, schema, [role], { verb: write.verb, resource: write.resource }),
    );
    if (!roles.length) {
      problems.push(
        `${at}.${write.verb}: no API role ${write.verb === 'create' ? 'creates' : write.verb === 'delete' ? 'deletes' : 'edits'} "${write.resource}" in the App [api-write-no-role]. ` +
          `Grant a role in api.roles write${write.verb === 'create' ? ' and create' : ''} on it, or drop ${write.verb}.`,
      );
    }
    const taken = registry && Object.hasOwn(registry, write.id) ? registry[write.id] : undefined;
    if (taken && !genericWriteOf(taken)) {
      problems.push(
        `${at}.${write.verb}: the commands module registers "${write.id}", the name the generic ${write.verb} runs as [api-write-name-taken]. Rename the command.`,
      );
    }
  }
  return problems;
}

/** The input field a column takes. Integers past 2^53 are not a generic write's to carry: a command writes them. */
function columnField(column: ColumnMeta, optional: boolean) {
  const options = { label: column.name, ...(optional ? { optional: true as const } : {}) };
  if (column.allowed?.length && column.allowed.every((value) => typeof value === 'string' || typeof value === 'number')) {
    return field.choice(column.allowed as readonly (string | number)[], options);
  }
  if (isFlagColumn(column)) return field.bool(options);
  const kind = columnKind(column.type);
  if (kind === 'number') return field.number({ ...options, ...(INTEGER.test(column.type.trim()) ? { integer: true } : {}) });
  if (kind === 'date' && /^date$/i.test(column.type.trim())) return field.date(options);
  return field.textarea(options);
}

/** The role's own editor access, as the UI's write path composes it. */
function editorAccess(app: AppDef, schema: DatabaseSchema) {
  const validation = compileAppDefinitionValidation(schema, app);
  const transitions = compileAppTransitions(schema, app);
  const stamps = compileAppStamps(schema, app);
  return (roles: readonly string[], who: string | undefined, now: Date): ResourceAccess => ({
    ...resolveAppAccess(app, schema, [...roles]),
    ...(validation ? { validation } : {}),
    ...(transitions ? { transitions } : {}),
    ...(stamps
      ? {
          stamp: (request, reader) =>
            stampUpdate(stamps, request, { now, ...(who ? { who } : {}), person: () => personKey(app, schema, who, reader) }),
          fill: (request, reader) =>
            stampInsert(stamps, request, { now, ...(who ? { who } : {}), person: () => personKey(app, schema, who, reader) }),
        }
      : {}),
    me: (reader) => lookupPerson(app, schema, who, reader),
  });
}

function synthesize(app: AppDef, schema: DatabaseSchema, write: ApiWrite): AnyBusinessCommand {
  const table = schema.tables.find((item) => item.id === write.resource) as TableMeta;
  const key = primaryKey(table);
  const columns = write.fields.map((name) => table.columns.find((column) => column.name === name)!);
  const access = editorAccess(app, schema);
  const source = defineSource(homeSourceOf(app)!);
  const input =
    write.verb === 'delete'
      ? {}
      : Object.fromEntries(
          columns
            .filter((column) => write.verb === 'create' || !column.primaryKey)
            .map((column) => [
              column.name,
              columnField(column, write.verb === 'update' || column.nullable || assigned(column, schema, table.id)),
            ]),
        );
  const keyOf = (row: Readonly<Record<string, unknown>>) => Object.fromEntries(key.map((name) => [name, row[name] as string | number]));
  const run = async (
    ctx: {
      actor: { roles: readonly string[]; email?: string };
      now: () => Date;
      tx: Parameters<typeof authorizeTransaction>[2];
      record?: Readonly<Record<string, unknown>>;
    },
    values: Record<string, unknown>,
  ) => {
    // The role's editor rules over the command's own transaction: what the UI would refuse, this refuses.
    const tx = authorizeTransaction(schema, access(ctx.actor.roles, ctx.actor.email, ctx.now()), ctx.tx);
    const given = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<
      string,
      string | number | boolean | null
    >;
    try {
      if (write.verb === 'create') {
        const result = await tx.insert({ table: write.resource, values: given });
        return { key: Object.fromEntries(key.map((name) => [name, result.key[name]])) };
      }
      if (write.verb === 'update') {
        if (!Object.keys(given).length) refuse('invalid_input');
        const result = await tx.update({ table: write.resource, key: keyOf(ctx.record!), values: given });
        if (result.affected !== 1) refuse('stale_record');
        return undefined;
      }
      const removed = await tx.remove({ table: write.resource, key: keyOf(ctx.record!) });
      if (removed.affected !== 1) refuse('stale_record');
      return undefined;
    } catch (error) {
      // The UI's own refusals, said in the command vocabulary the API speaks.
      if (error instanceof ConsumesRefused)
        throw new BusinessCommandExecutionError('consumes_refused', 'not_applied', undefined, undefined, error.sentence);
      if (error instanceof AppValidationDenied) refuse('invalid_input', error.fields[0]);
      if (error instanceof AppTransitionDenied) refuse('ineligible_state');
      if (error instanceof AppAccessDenied) throw error;
      throw error;
    }
  };
  const keyShape = shape(Object.fromEntries(key.map((name) => [name, oneOf(int(), text())])));
  const command =
    write.verb === 'create'
      ? defineCommand({
          source,
          target: write.resource,
          targets: 'none',
          input,
          output: shape({ key: keyShape }),
          handle: (ctx, values) => run(ctx as never, values as Record<string, unknown>) as never,
        })
      : defineCommand({
          source,
          target: write.resource,
          input,
          handle: async (ctx, values) => {
            await run(ctx as never, values as Record<string, unknown>);
          },
        });
  markGenericWrite(command, { verb: write.verb, resource: write.resource });
  return command as AnyBusinessCommand;
}

const synthesized = new WeakMap<object, Map<string, AnyBusinessCommand>>();

/** The App and registry the API's command routes serve: the App's own, plus
 * one command and one exposure per generic write. Idempotent — a registry or
 * App that already carries them comes back with the same commands — and
 * refusing, with the check's words, where a write is not sound. */
export function withApiWrites(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry | undefined,
): { app: AppDef; registry: BusinessCommandRegistry | undefined } {
  const writes = apiWrites(app.api);
  if (!writes.length) return { app, registry };
  const problems = apiWriteProblems(app, schema, registry);
  if (problems.length) throw new Error(problems.join(' '));
  // No commands module is an empty registry: the receipts' journal is the platform's, not the module's.
  registry ??= defineCommands({});
  // One command per write per schema, so every owner of this App runs the same instances.
  const cache = synthesized.get(schema) ?? new Map<string, AnyBusinessCommand>();
  synthesized.set(schema, cache);
  const added: Record<string, AnyBusinessCommand> = {};
  for (const write of writes) {
    if (Object.hasOwn(registry, write.id)) continue;
    const cacheKey = `${app.id}\0${write.id}\0${write.fields.join(',')}`;
    const command = cache.get(cacheKey) ?? synthesize(app, schema, write);
    cache.set(cacheKey, command);
    added[write.id] = command;
  }
  const served = Object.keys(added).length ? defineCommands({ ...registry, ...added }) : registry;
  const exposed = new Set(app.api!.commands.map((entry) => entry.command.id));
  const exposures = writes
    .filter((write) => !exposed.has(write.id))
    .map((write) => {
      const command = served[write.id];
      return {
        command:
          write.verb === 'create'
            ? { id: write.id, version: command.version, input: structuredClone(command.fields) as never }
            : { id: write.id, version: command.version, target: write.resource, input: structuredClone(command.fields) as never },
      };
    });
  return {
    app: exposures.length ? { ...app, api: { ...app.api!, commands: [...app.api!.commands, ...exposures] } } : app,
    registry: served,
  };
}
