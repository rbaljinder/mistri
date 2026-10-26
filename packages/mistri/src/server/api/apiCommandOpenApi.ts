/** Private command half of the App API document: paths and components for the
 * exposed targeted commands, composed from the same sources the command
 * transport serves — the input declaration, the envelope's key and receipt
 * schemas, the read key codec, the receipt projections and the problem tables.
 * Rendering enables no route. Untargeted commands are refused, as the envelope
 * contract refuses them, never advertised without a route behind them. */
import type { AppDef } from '../../shared/appModel.js';
import { apiSeveralSources } from '../../shared/appApi.js';
import { BULK_LIMIT } from '../../shared/command.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { checkApiCommandCatalog } from './apiCommandCatalog.js';
import { createApiCommandEnvelopeBundle } from './apiCommandEnvelope.js';
import { renderApiInputSchema } from './apiInputSchema.js';
import { createApiReadKeyCodec } from './apiReadKey.js';
import { apiCommandProblemStatuses } from './apiCommandResponse.js';

type Json = Record<string, unknown>;
const name = (value: string) => Buffer.from(value, 'utf8').toString('hex');
const freeze = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
};
const IDEMPOTENCY_PATTERN = '^[A-Za-z0-9_-]{16,128}$(?![\\s\\S])';
// One strong tag holding a canonical revision, as the transport reads it.
const REVISION_TAG_PATTERN = '^"(?:0|[1-9][0-9]{0,15})"$(?![\\s\\S])';
const PROBLEM = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'code'],
  properties: {
    type: { type: 'string', pattern: '^urn:mistri:problem:[a-z_]+$(?![\\s\\S])' },
    title: { type: 'string' },
    status: { type: 'integer', minimum: 400, maximum: 599 },
    code: { type: 'string' },
    outcome: { enum: ['not_applied', 'unknown'] },
    field: { type: 'string' },
    key: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
  },
};

export function renderApiCommandOpenApi(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  evidence: Parameters<typeof checkApiCommandCatalog>[4],
  options: { integers: 'decimal-string' | 'number' },
  /** A tenant App's command catalog, from trusted composition. A tenant token
   * has no receipt recovery — it retries under the same key, which replays an
   * applied receipt — so its document advertises none. */
  tenant?: ReturnType<typeof checkApiCommandCatalog>,
) {
  if (!app.api) throw new Error('The App API command document requires an explicit api declaration.');
  if (!options || !['number', 'decimal-string'].includes(options.integers)) throw new Error('Choose an explicit integer representation.');
  const declarations = defineCommands(registry);
  const catalog = tenant ?? checkApiCommandCatalog(app.api, app, schema, declarations, evidence);
  const several = apiSeveralSources(app);
  // The envelope contract refuses untargeted commands; so does this document.
  const envelopes = new Map(
    createApiCommandEnvelopeBundle(app, schema, registry, evidence, tenant).operations.map((operation) => [operation.id, operation]),
  );
  const problems: Json = Object.fromEntries(
    apiCommandProblemStatuses().map((status) => [
      String(status),
      {
        description: `Refused with problem details (${status})`,
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/CommandProblem' } } },
      },
    ]),
  );
  // A rendered output schema may be a JSON Schema boolean, not only an object.
  const paths: Record<string, Json> = {},
    schemas: Record<string, unknown> = { CommandProblem: PROBLEM };
  const claim = (path: string, value: Json) => {
    if (paths[path]) throw new Error('Duplicate API command path.');
    paths[path] = value;
  };
  for (const operation of catalog.operations) {
    const envelope = envelopes.get(operation.id);
    if (!envelope) throw new Error(`api.commands.${operation.command}: no command envelope.`);
    const table = schema.tables.find((table) => table.id === operation.resource);
    const key = table ? primaryKey(table) : [];
    // The read route's key rule: the same parameter an item read documents.
    const codec = createApiReadKeyCodec({ resource: operation.resource, primaryKey: key, fields: key }, schema, options);
    const keyName = key.length > 1 ? 'key' : key[0];
    const component = name(operation.command);
    schemas[`CommandInput_${component}`] = renderApiInputSchema({ input: declarations[operation.command].input }).schema;
    schemas[`CommandResult_${component}`] = operation.outputSchema;
    const input = { $ref: `#/components/schemas/CommandInput_${component}` };
    const result = { $ref: `#/components/schemas/CommandResult_${component}` };
    const suffix = `/commands/${operation.command}/v${operation.version}`;
    const idempotency = {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', pattern: IDEMPOTENCY_PATTERN },
      description: 'The request locator. The same key and request replay the receipt; a different request under it is 409.',
    };
    const executed = {
      '200': {
        description: 'Applied, or replayed from its receipt (then with Idempotent-Replayed: true).',
        headers: { 'Idempotent-Replayed': { description: 'Present, as true, on a replay.', schema: { type: 'string', enum: ['true'] } } },
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['receipt', 'result'],
              properties: {
                receipt: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'status', 'replayed'],
                  properties: {
                    id: envelope.receiptIdSchema,
                    status: { const: 'applied' },
                    replayed: { type: 'boolean' },
                  },
                },
                result,
              },
            },
          },
        },
      },
      ...problems,
    };
    const extensions = {
      'x-mistri-eligible-roles': [...operation.eligibleRoles],
      // The source this command commits on, when the App has more than one.
      ...(several ? { 'x-mistri-source': operation.source } : {}),
    };
    if (operation.targets === 'none') {
      // A generic create: it names no record, so no revision and no target
      // to recover by; a retry under the same Idempotency-Key replays it.
      claim(`/${operation.resource}${suffix}`, {
        post: {
          operationId: `command_${component}`,
          summary: `Create one ${operation.resource}`,
          parameters: [idempotency],
          requestBody: { required: true, content: { 'application/json': { schema: input } } },
          responses: executed,
          ...extensions,
        },
      });
      continue;
    }
    claim(`/${operation.resource}/{${keyName}}${suffix}/prepare`, {
      get: {
        operationId: `prepare_${component}`,
        summary: `Read the current revision for ${operation.command}`,
        parameters: [{ name: keyName, in: 'path', required: true, ...codec.parameter }],
        responses: {
          '200': {
            description: 'Prepared without executing the command. Pass this revision unchanged to execution.',
            headers: { ETag: { description: 'Use unchanged as If-Match.', schema: { type: 'string', pattern: REVISION_TAG_PATTERN } } },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['version'],
                  properties: { version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 } },
                },
              },
            },
          },
          ...problems,
        },
        ...extensions,
      },
    });
    // Every targeted command takes the one-target route; one key of a many
    // command is the same operation as its single envelope.
    claim(`/${operation.resource}/{${keyName}}${suffix}`, {
      post: {
        operationId: `command_${component}`,
        summary: `Run ${operation.command} on one ${operation.resource}`,
        parameters: [
          { name: keyName, in: 'path', required: true, ...codec.parameter },
          {
            name: 'If-Match',
            in: 'header',
            required: true,
            schema: { type: 'string', pattern: REVISION_TAG_PATTERN },
            description: "The command prepare route's ETag: one strong quoted opaque revision; missing is 428.",
          },
          idempotency,
        ],
        requestBody: { required: true, content: { 'application/json': { schema: input } } },
        responses: executed,
        ...extensions,
      },
    });
    if (operation.targets === 'many') {
      claim(`/${operation.resource}${suffix}`, {
        post: {
          operationId: `commandMany_${component}`,
          summary: `Run ${operation.command} on several ${operation.resource} records`,
          parameters: [idempotency],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['targets', 'input'],
                  properties: {
                    targets: {
                      type: 'array',
                      minItems: 1,
                      maxItems: BULK_LIMIT,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['key', 'version'],
                        properties: {
                          key: envelope.keySchema,
                          version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
                        },
                      },
                      'x-mistri-runtime-validation': ['duplicate-free-keys', 'ordered-targets'],
                    },
                    input,
                  },
                },
              },
            },
          },
          responses: executed,
          ...extensions,
        },
      });
    }
    if (!tenant)
      claim(`/commands/${operation.command}/v${operation.version}/receipts/{idempotencyKey}`, {
        get: {
          operationId: `recover_${component}`,
          summary: `Recover a ${operation.command} receipt by its request key`,
          parameters: [{ name: 'idempotencyKey', in: 'path', required: true, schema: { type: 'string', pattern: IDEMPOTENCY_PATTERN } }],
          responses: {
            '200': {
              description: "The caller's own receipt for that key; 404 with outcome unknown when none is visible.",
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['receipt', 'targets', 'result'],
                    properties: {
                      receipt: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['id', 'status', 'recovered'],
                        properties: {
                          id: envelope.receiptIdSchema,
                          status: { const: 'applied' },
                          recovered: { const: true },
                        },
                      },
                      // Recovered keys answer in this API's integer representation.
                      targets: { type: 'array', minItems: 1, maxItems: operation.targets === 'many' ? BULK_LIMIT : 1, items: codec.schema },
                      result,
                    },
                  },
                },
              },
            },
            ...problems,
          },
          ...extensions,
        },
      });
  }
  const rendered = { paths, schemas };
  freeze(rendered);
  return Object.freeze({ stage: 'private-command-spec-preview' as const, integers: options.integers, ...rendered });
}
