/** App MCP command tool descriptors, projected from the same sources the
 * command routes advertise (apiCommandOpenApi.ts): the read key codec for a
 * one-target key, the envelope's lenient key schema for many targets, the
 * integer revision, the Idempotency-Key pattern, the declared input and the
 * api-v1 receipt bodies. Not a new schema language. The idempotency key is a
 * required argument and never generated, so a retried call replays its
 * receipt instead of repeating effects. `scope` is filtering data only: live
 * discovery passes a command owner's own fresh native observation; nothing
 * else may. */
import { createHash } from 'node:crypto';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { AppDef } from '../../shared/appModel.js';
import { apiSeveralSources } from '../../shared/appApi.js';
import { BULK_LIMIT } from '../../shared/command.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { checkApiCommandCatalog } from './apiCommandCatalog.js';
import { createApiCommandEnvelopeBundle } from './apiCommandEnvelope.js';
import { renderApiInputSchema } from './apiInputSchema.js';
import { createApiReadKeyCodec } from './apiReadKey.js';

type Json = Record<string, unknown>;
const fail = (): never => {
  throw new TypeError('App command-tool projection is unavailable.');
};
const object = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : fail());
const names = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 1024) return fail();
  const result = value.map((name) => {
    if (typeof name !== 'string' || !name.length || name.length > 256 || name.trim() !== name || /[\p{Cc}\p{Cs}]/u.test(name))
      return fail();
    return name;
  });
  if (new Set(result).size !== result.length) return fail();
  return result;
};
// As the routes read them (apiCommandOpenApi.ts / apiCommandEnvelope.ts).
const IDEMPOTENCY = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{16,128}$',
  description:
    'Identifies this request. Sending the same key and request again replays its receipt; a different request under it is refused.',
};
/** Said once per command and process, not per tools/list. */
const logged = new Set<string>();
function skipped(app: string, what: string, cause: string, left: 'tool' | 'input' = 'tool') {
  const line = JSON.stringify({
    event: left === 'tool' ? 'api.mcp_command_left_out' : 'api.mcp_input_undescribed',
    app,
    command: what,
    cause,
  });
  if (logged.has(line)) return;
  logged.add(line);
  process.stderr.write(`${line}\n`);
}
const REVISION = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
const closed = (properties: Json, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

export type ApiMcpCommandBinding = Readonly<{
  name: string;
  command: string;
  version: number;
  kind: 'one' | 'many' | 'recover' | 'prepare';
  resource: string;
}>;

export function projectApiMcpCommandTools(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  evidence: Parameters<typeof checkApiCommandCatalog>[4],
  options: { integers: 'number' | 'decimal-string' },
  rawScope: unknown,
  /** A tenant App's command catalog, from trusted composition; no recovery tool,
   * as its document has no recovery route (apiCommandOpenApi.ts). */
  tenant?: ReturnType<typeof checkApiCommandCatalog>,
) {
  const scope = object(snapshot(rawScope, 262144).value);
  if (Object.keys(scope).length !== 2 || !Object.hasOwn(scope, 'operations') || !Object.hasOwn(scope, 'roles')) return fail();
  const permitted = new Set(names(scope.operations)),
    roles = new Set(names(scope.roles));
  if (!app.api) return fail();
  const declarations = defineCommands(registry);
  const catalog = tenant ?? checkApiCommandCatalog(app.api, app, schema, declarations, evidence);
  const envelopes = new Map(
    createApiCommandEnvelopeBundle(app, schema, registry, evidence, tenant).operations.map((operation) => [operation.id, operation]),
  );
  const several = apiSeveralSources(app);
  const tools: Json[] = [],
    bindings: ApiMcpCommandBinding[] = [],
    used = new Set<string>();
  const named = (kind: ApiMcpCommandBinding['kind'], command: string) => {
    const prefix = kind === 'one' ? 'run' : kind === 'many' ? 'runMany' : kind === 'prepare' ? 'prepare' : 'recover';
    const slug = command.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
    const suffix = createHash('sha256')
      .update(JSON.stringify([app.id, kind, command]))
      .digest('hex')
      .slice(0, 24);
    const name = `${prefix}_${slug}_${suffix}`;
    if (name.length > 64 || used.has(name)) return fail();
    used.add(name);
    return name;
  };
  for (const operation of catalog.operations) {
    if (operation.targets === 'none') continue;
    if (!permitted.has(operation.id) || !operation.eligibleRoles.some((role) => roles.has(role))) continue;
    /* One command's tools are made whole or left out: a command this cannot describe takes its own tools from the
       list, with its cause written to the log, and never the session with it. */
    const marks = { tools: tools.length, bindings: bindings.length, used: new Set(used) };
    try {
      project(operation);
    } catch (error) {
      tools.length = marks.tools;
      bindings.length = marks.bindings;
      used.clear();
      for (const name of marks.used) used.add(name);
      skipped(app.id, operation.command, error instanceof Error ? error.message : 'it could not be described');
    }
  }
  function project(operation: (typeof catalog.operations)[number]) {
    const envelope = envelopes.get(operation.id) ?? fail();
    const table = schema.tables.find((value) => value.id === operation.resource) ?? fail();
    const key = primaryKey(table);
    const codec = createApiReadKeyCodec({ resource: operation.resource, primaryKey: key, fields: key }, schema, options);
    const rendered = renderApiInputSchema({ input: declarations[operation.command]!.input });
    for (const open of rendered.undescribed) skipped(app.id, `${operation.command}.${open.path}`, open.cause, 'input');
    const input = rendered.schema;
    const receipt = (extra: Json) => closed({ id: envelope.receiptIdSchema, status: { const: 'applied' }, ...extra });
    const applied = closed({ receipt: receipt({ replayed: { type: 'boolean' } }), result: operation.outputSchema });
    const push = (kind: ApiMcpCommandBinding['kind'], title: string, description: string, inputSchema: Json, outputSchema: unknown) => {
      const name = named(kind, operation.command);
      tools.push({
        name,
        title: `${app.name}: ${title}`.slice(0, 256),
        description: (
          description + (several ? ` It runs on source "${operation.source}" alone; nothing is promised across calls.` : '')
        ).slice(0, 1024),
        inputSchema,
        outputSchema,
        annotations: { readOnlyHint: kind === 'recover' || kind === 'prepare', idempotentHint: true },
      });
      bindings.push({ name, command: operation.command, version: operation.version, kind, resource: operation.resource });
    };
    push(
      'prepare',
      `prepare ${operation.command} on one ${operation.resource}`,
      `Reads the current revision for ${operation.command} without executing it. Pass version unchanged to its run tool; no version column is required.`,
      closed({ key: codec.schema }),
      closed({ version: REVISION }),
    );
    push(
      'one',
      `${operation.command} on one ${operation.resource}`,
      `Runs ${operation.command} on one ${operation.resource} through the App API, as this token allows; checked again on every call. ` +
        "version is the opaque revision returned by this command's prepare tool; a stale one is refused.",
      closed({ key: codec.schema, version: REVISION, idempotencyKey: IDEMPOTENCY, input }),
      applied,
    );
    if (operation.targets === 'many') {
      push(
        'many',
        `${operation.command} on several ${operation.resource} records`,
        `Runs ${operation.command} on up to ${BULK_LIMIT} ${operation.resource} records at once, in the order given, as this token allows.`,
        closed({
          targets: { type: 'array', minItems: 1, maxItems: BULK_LIMIT, items: closed({ key: envelope.keySchema, version: REVISION }) },
          idempotencyKey: IDEMPOTENCY,
          input,
        }),
        applied,
      );
    }
    if (!tenant)
      push(
        'recover',
        `recover a ${operation.command} receipt`,
        `Recovers this token's own receipt for an earlier ${operation.command} request by its idempotency key, when an answer was lost. Never repeats the command.`,
        closed({ idempotencyKey: IDEMPOTENCY }),
        closed({
          receipt: receipt({ recovered: { const: true } }),
          targets: { type: 'array', minItems: 1, maxItems: operation.targets === 'many' ? BULK_LIMIT : 1, items: codec.schema },
          result: operation.outputSchema,
        }),
      );
  }
  return snapshot({ stage: 'private-command-tool-preview', authorization: 'pending', tools, bindings }, 4194304).value as Readonly<{
    stage: 'private-command-tool-preview';
    authorization: 'pending';
    tools: readonly Readonly<Json>[];
    bindings: readonly ApiMcpCommandBinding[];
  }>;
}
