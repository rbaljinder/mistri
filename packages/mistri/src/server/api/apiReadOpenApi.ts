/** The App API's read document, over checked metadata and the real row
 * encoder. Rendering it enables no route: serving is the transports', and
 * every operation it lists still needs a token whose scope includes it. */
import type { AppDef } from '../../shared/appModel.js';
import { API_CONSISTENCY, apiSeveralSources } from '../../shared/appApi.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { createApiReadRowCodec } from './apiReadRowCodec.js';
import { createApiReadEnvelopeCodec } from './apiReadEnvelope.js';
import { createApiReadKeyCodec } from './apiReadKey.js';
import { createApiFilterParameter } from './apiFilterParameter.js';
import { parseApiListParams } from './apiListParams.js';

type Json = Record<string, unknown>;
const name = (value: string) => Buffer.from(value, 'utf8').toString('hex');
const freeze = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
};

/** The private read transport's fixed, value-free error vocabulary. This is
 * documentation, not route activation or a substitute for bearer admission. */
function errorResponses(): Record<string, Json> {
  return Object.fromEntries(
    [
      ['400', 'invalid_request'],
      ['401', 'unauthenticated'],
      ['403', 'forbidden'],
      ['404', 'not_found'],
      ['405', 'method_not_allowed'],
      ['429', 'rate_limited'],
      ['503', 'temporarily_unavailable'],
    ].map(([status, code]) => [
      status,
      {
        description: status === '405' ? 'The read namespace accepts GET only' : `API request refused: ${code}`,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['error'],
              properties: {
                error: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['code', 'message'],
                  properties: {
                    code: { type: 'string', const: code },
                    message: { type: 'string', const: 'The API request could not be completed.' },
                  },
                },
              },
            },
          },
        },
      },
    ]),
  );
}

export function renderApiReadOpenApi(
  app: AppDef,
  schema: DatabaseSchema,
  options: { integers: 'number' | 'decimal-string' },
  /** A tenant App's catalog, from trusted composition; otherwise checked here. */
  given?: ReturnType<typeof checkApiReadCatalog>,
) {
  if (!app.api) throw new Error('The App API read document requires an explicit api declaration.');
  if (!options || !['number', 'decimal-string'].includes(options.integers)) throw new Error('Choose an explicit integer representation.');
  const catalog = given ?? checkApiReadCatalog(app.api, app, schema);
  const several = apiSeveralSources(app);
  const paths: Record<string, Json> = {},
    schemas: Record<string, Json> = {};
  for (const operation of catalog.operations) {
    if (['views', 'commands'].includes(operation.resource)) throw new Error('API resource collides with a reserved route namespace.');
    const row = createApiReadRowCodec(operation, schema, options);
    const component = `Row_${name(operation.resource)}`;
    schemas[component] = row.schema;
    const exposure = app.api.resources[operation.resource];
    const item = operation.kind === 'item';
    const projected = `ProjectedRow_${name(operation.resource)}`;
    if (!item)
      schemas[projected] = {
        ...row.schema,
        required: [...operation.primaryKey],
        'x-mistri-primary-key': [...operation.primaryKey],
        'x-mistri-default-fields': [...parseApiListParams('', operation).fields],
        'x-mistri-projection-validation': 'request-codec-requires-exact-selected-fields-plus-complete-key',
      };
    const ref = { $ref: `#/components/schemas/${item ? component : projected}` };
    const keyCodec = item ? createApiReadKeyCodec(operation, schema, options) : undefined;
    const viewId = operation.kind === 'view' ? operation.id.slice('view:'.length) : undefined;
    const view = viewId === undefined ? undefined : app.views[viewId];
    if (view && 'table' in view && (view.sorts?.length || view.totals?.length)) {
      throw new Error('The App API read document does not yet publish named sorts or totals.');
    }
    const composite = operation.primaryKey.length > 1;
    const key = composite ? 'key' : operation.primaryKey[0];
    const route = viewId === undefined ? `/${operation.resource}${item ? `/{${key}}` : ''}` : `/views/${viewId}`;
    const parameters: Json[] = item
      ? [{ name: key, in: 'path', required: true, ...keyCodec!.parameter }]
      : [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string', minLength: 1, 'x-mistri-max-utf8-bytes': 4096 },
            description:
              "Opaque: the previous page's `next`, passed back unchanged. It is bound to the token that received it, that token's scope and this server's run, and it expires; any other is refused (400).",
          },
          { name: 'count', in: 'query', schema: { type: 'boolean', default: false } },
        ];
    if (operation.standing?.tabs.length)
      parameters.push({
        name: 'segment',
        in: 'query',
        schema: { type: 'string', enum: operation.standing.tabs.map((tab) => tab.id), default: operation.standing.defaultTab },
        description: "Select one of the view's tabs by its address word; its question remains ANDed with the view and request filters.",
      });
    if (operation.segments?.length)
      parameters.push({
        name: 'segment',
        in: 'query',
        schema: { type: 'string', enum: [...operation.segments] },
        description: "Read one of the resource's segments: its conditions remain ANDed with the request filters.",
      });
    if (!item) {
      const field = `(?:${operation.fields.map((field) => field.replaceAll('.', '\\.')).join('|')})`;
      parameters.push({
        name: 'fields',
        in: 'query',
        required: false,
        schema: { type: 'string', pattern: `^${field}(?:,${field})*$(?![\\s\\S])`, default: operation.fields.join(',') },
        'x-mistri-fields': [...operation.fields],
        'x-mistri-runtime-validation': ['raw-query', 'unique-projection-fields', 'complete-primary-key-retained'],
        description:
          'Comma-separated exposed fields. Omitted means the full exposure. Complete primary keys are retained automatically. ' +
          'The generic list schema permits omitted nonkey fields; the request codec requires every selected field and forbids unselected response fields.',
      });
      if (exposure.sorts.length) {
        const field = `(?:${exposure.sorts.map((field) => field.replaceAll('.', '\\.')).join('|')})`;
        parameters.push({
          name: 'sort',
          in: 'query',
          schema: { type: 'string', pattern: `^-?${field}(?:,-?${field})*$(?![\\s\\S])` },
          description:
            'Comma-separated declared fields; a leading minus reverses a field. Each field may occur once. Primary keys complete ties.',
          'x-mistri-fields': [...exposure.sorts],
          'x-mistri-runtime-validation': ['unique-sort-fields'],
        });
      }
      for (const field of exposure.filters) {
        parameters.push(createApiFilterParameter(field, operation, schema, options));
      }
    }
    // A spec covers either count choice and every allowed page size. The
    // concrete request codec additionally enforces count presence and limit.
    const envelope = item
      ? undefined
      : createApiReadEnvelopeCodec(operation, schema, { integers: options.integers, limit: 500, countRequested: true }).schema;
    const response = envelope
      ? {
          ...envelope,
          required: ['items', 'next'],
          properties: { ...envelope.properties, items: { ...envelope.properties.items, items: ref } },
          'x-mistri-count-presence': 'required-if-and-only-if-count=true',
        }
      : ref;
    if (paths[route]) throw new Error('Duplicate API read path.');
    paths[route] = {
      get: {
        operationId: `read_${name(operation.id)}`,
        summary: `${item ? 'Read' : 'List'} ${viewId ?? operation.resource}`,
        parameters,
        'x-mistri-eligible-roles': [...operation.eligibleRoles],
        // The source this operation reads, when there is more than one to read.
        ...(several ? { 'x-mistri-source': operation.source } : {}),
        // Preserve authored predicates, not clock-evaluated dates. Labels and
        // other presentation stay out; tab IDs and default selection are API
        // addresses and therefore part of the standing operation contract.
        ...(operation.standing
          ? {
              'x-mistri-standing-contract': {
                query: operation.standing.query,
                order: operation.standing.order,
                defaultTab: operation.standing.defaultTab,
                tabs: operation.standing.tabs.map((tab) => ({ id: tab.id, query: tab.query, order: tab.order })),
              },
            }
          : {}),
        responses: {
          '200': { description: 'Projected read result', content: { 'application/json': { schema: response } } },
          ...errorResponses(),
        },
      },
    };
  }
  const document = {
    openapi: '3.1.0',
    info: { title: app.name, version: String(app.api.version), ...(app.api.description ? { description: app.api.description } : {}) },
    servers: [{ url: `/api/apps/${encodeURIComponent(app.id)}/v${app.api.version}` }],
    security: [{ bearer: [] }],
    paths,
    components: { schemas, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    // Which mistri document this is, for the narrowing and comparison that read it back.
    'x-mistri-document': 'app-api-reads',
    'x-mistri-omitted-request-features': ['totals'],
    'x-mistri-integer-representation': options.integers,
    ...(several ? { 'x-mistri-consistency': API_CONSISTENCY } : {}),
  };
  freeze(document);
  return Object.freeze({
    stage: 'private-read-spec-preview' as const,
    requestSchemas: 'pending' as const,
    cursorVerification: 'pending' as const,
    envelopeValidation: 'pending' as const,
    document,
  });
}
