/** The App's event-driven surface as an AsyncAPI 3.0 document, beside its
 * OpenAPI one: the event feed's messages (`api.events`), the webhooks its
 * commands post to (`effects: { … post(…) }`) and the signed endpoints that
 * call its commands (`defineInbound`). Rendered from the same declarations
 * the server runs — nothing here is a second description to keep in step.
 *
 * Served at `…/v{n}/$asyncapi`, a token's document holds the feed events
 * it may read and nothing else: where a webhook posts and how an inbound
 * sender signs are the operator's, not a token's. `--export asyncapi`
 * renders the whole surface. */
import type { AppDef } from '../../shared/app.js';
import { getCommandEffects, getCommandEvents, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { commandEventContracts } from '../commands/businessEvents.js';
import type { ShapeDescriptor } from '../commands/commandShapes.js';
import type { CapturedInbound } from '../jobs/jobModule.js';

type Json = Record<string, unknown>;

/** A payload descriptor as JSON Schema, permissively: an opaque parser is an object the event's fields name. */
function schemaOf(shape: ShapeDescriptor, depth = 0): Json {
  if (depth > 32) return {};
  const child = (value: ShapeDescriptor) => schemaOf(value, depth + 1);
  switch (shape.kind) {
    case 'opaque':
      return {};
    case 'text':
      return {
        type: 'string',
        ...(shape.max === undefined ? {} : { maxLength: shape.max }),
        ...(shape.pattern ? { pattern: shape.pattern.source } : {}),
      };
    case 'integer':
      return { type: 'integer', minimum: shape.min, maximum: shape.max };
    case 'number':
      return {
        type: 'number',
        ...(shape.min === undefined ? {} : { minimum: shape.min }),
        ...(shape.max === undefined ? {} : { maximum: shape.max }),
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'literal':
      return { enum: [...new Set(shape.values)] };
    case 'list':
      return {
        type: 'array',
        items: child(shape.item),
        ...(shape.min === undefined ? {} : { minItems: shape.min }),
        ...(shape.max === undefined ? {} : { maxItems: shape.max }),
      };
    case 'optional':
      return child(shape.item);
    case 'nullable':
      return { anyOf: [child(shape.item), { type: 'null' }] };
    case 'anyOf':
      return { anyOf: shape.alternatives.map(child) };
    case 'object':
      return {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(Object.entries(shape.fields).map(([key, value]) => [key, child(value)])),
        required: Object.entries(shape.fields)
          .filter(([, value]) => value.kind !== 'optional')
          .map(([key]) => key),
      };
  }
}

/** An event's payload: its declared shape, or an object of its declared fields when a custom parser hides the shape. */
function payloadSchema(event: { fields: readonly string[]; payload: ShapeDescriptor }): Json {
  if (event.payload.kind !== 'opaque') return schemaOf(event.payload);
  return { type: 'object', properties: Object.fromEntries(event.fields.map((field) => [field, {}])), additionalProperties: false };
}

/** Every declared event and webhook effect of the registry, by name. */
function declared(registry: BusinessCommandRegistry) {
  const events = new Map<string, { fields: readonly string[]; payload: ShapeDescriptor; commands: string[] }>();
  const webhooks = new Map<string, { effect: string; command: string; bare: boolean }[]>();
  for (const [id, command] of Object.entries(registry)) {
    const captured = getCommandEvents(command);
    const contracts = captured
      ? (commandEventContracts(captured as never) as { name: string; fields: readonly string[]; payload: ShapeDescriptor }[])
      : [];
    for (const contract of contracts) {
      if (contract.name.startsWith('effect.')) continue;
      const known = events.get(contract.name) ?? { fields: contract.fields, payload: contract.payload, commands: [] };
      known.commands.push(id);
      events.set(contract.name, known);
    }
    for (const effect of getCommandEffects(command) ?? []) {
      const bare = contracts.some((contract) => contract.name === `effect.${effect.name}` && contract.fields.includes('bare'));
      webhooks.set(effect.destination, [...(webhooks.get(effect.destination) ?? []), { effect: effect.name, command: id, bare }]);
    }
  }
  return { events, webhooks };
}

const id = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, '_');

export function renderApiAsyncApi(
  app: AppDef,
  registry: BusinessCommandRegistry | undefined,
  options: { integers: 'decimal-string' | 'number'; scope?: 'whole' | readonly string[]; inbound?: ReadonlyMap<string, CapturedInbound> },
) {
  if (!app.api) throw new Error('AsyncAPI requires an explicit api declaration.');
  const api = app.api;
  const { events, webhooks } = declared(registry ?? {});
  const whole = options.scope === undefined || options.scope === 'whole';
  const granted = new Set(
    whole
      ? api.events
      : (options.scope as readonly string[])
          .filter((operation) => operation.startsWith('event:'))
          .map((operation) => operation.slice('event:'.length)),
  );
  const channels: Json = {},
    operations: Json = {},
    messages: Json = {},
    schemas: Json = {};
  const integer = options.integers === 'decimal-string' ? { type: 'string', pattern: '^-?(?:0|[1-9][0-9]*)$' } : { type: 'integer' };
  // The feed: one message per event this document may name.
  const feed = api.events.filter((name) => granted.has(name) && events.has(name));
  if (feed.length) {
    const references: Json = {};
    for (const name of feed) {
      const event = events.get(name)!,
        message = `event.${name}`;
      schemas[`EventPayload_${id(name)}`] = payloadSchema(event);
      messages[message] = {
        name,
        title: name,
        contentType: 'application/json',
        summary: `Emitted by ${event.commands.map((command) => `"${command}"`).join(', ')}.`,
        payload: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'occurredAt', 'resource', 'key', 'payload'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { const: name },
            occurredAt: { type: 'string', format: 'date-time' },
            resource: { type: 'string' },
            key: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, integer] } },
            payload: { $ref: `#/components/schemas/EventPayload_${id(name)}` },
          },
        },
      };
      references[id(message)] = { $ref: `#/components/messages/${message}` };
    }
    channels.events = {
      address: `/api/apps/${app.id}/v${api.version}/$events`,
      messages: references,
      description:
        "The event feed, polled oldest first: GET with a bearer token, `after` the last page's `next` and `limit` up to 200. " +
        'Each page is `{ items, next }`; an event appears only when the token holds `event:<name>` and its roles read the record.',
    };
    operations.publishEvents = {
      action: 'send',
      channel: { $ref: '#/channels/events' },
      summary: 'The App records each committed event on its feed.',
      messages: Object.keys(references).map((key) => ({ $ref: `#/channels/events/messages/${key}` })),
    };
  }
  if (whole) {
    // Webhooks: the App posts each effect after its command commits.
    for (const [destination, posts] of [...webhooks].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const references: Json = {};
      for (const post of posts) {
        const message = `effect.${post.effect}`;
        const body = { type: 'object', description: `The projection of "${post.command}"'s validated output.` };
        messages[message] ??= {
          name: message,
          title: post.effect,
          contentType: 'application/json',
          summary: `Posted after "${post.command}" commits, with an Idempotency-Key per receipt and effect.`,
          payload: post.bare
            ? body
            : {
                type: 'object',
                additionalProperties: false,
                required: ['effect', 'command', 'receipt', 'occurredAt', 'payload'],
                properties: {
                  effect: { const: post.effect },
                  command: { const: post.command },
                  receipt: { type: 'string' },
                  occurredAt: { type: 'string', format: 'date-time' },
                  payload: body,
                },
              },
        };
        references[id(message)] = { $ref: `#/components/messages/${message}` };
      }
      const channel = `webhook.${id(destination)}`;
      channels[channel] = {
        address: null,
        messages: references,
        description: `The "${destination}" webhook connection the config file names: its URL is the operator's.`,
      };
      operations[`post.${id(destination)}`] = {
        action: 'send',
        channel: { $ref: `#/channels/${channel}` },
        messages: Object.keys(references).map((key) => ({ $ref: `#/channels/${channel}/messages/${key}` })),
      };
    }
    // Inbound: a signed POST from outside runs one of the App's commands.
    for (const [name, endpoint] of [...(options.inbound ?? new Map<string, CapturedInbound>())].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const message = `inbound.${name}`,
        channel = `inbound.${id(name)}`;
      messages[message] = {
        name: message,
        title: name,
        contentType: 'application/json',
        summary: `Runs "${endpoint.command.id}" as "${endpoint.runAs}" once its signature verifies.`,
        headers: {
          type: 'object',
          required: [endpoint.verify.signatureHeader, endpoint.verify.timestampHeader],
          properties: {
            [endpoint.verify.signatureHeader]: {
              type: 'string',
              description: `HMAC-${endpoint.verify.algorithm.toUpperCase()} over the signed parts, ${endpoint.verify.encoding}${endpoint.verify.prefix ? `, after "${endpoint.verify.prefix}"` : ''}.`,
            },
            [endpoint.verify.timestampHeader]: {
              type: 'string',
              description: `The signed time, within ${Math.round(endpoint.verify.windowMs / 1000)} s.`,
            },
          },
        },
        payload: { type: 'object', description: "The sender's JSON: the declaration's key and input functions read it." },
      };
      channels[channel] = { address: `/api/inbound/${name}`, messages: { [id(message)]: { $ref: `#/components/messages/${message}` } } };
      operations[`receive.${id(name)}`] = {
        action: 'receive',
        channel: { $ref: `#/channels/${channel}` },
        messages: [{ $ref: `#/channels/${channel}/messages/${id(message)}` }],
      };
    }
  }
  const document = {
    asyncapi: '3.0.0',
    id: `urn:mistri:app:${app.id}:v${api.version}`,
    info: { title: `${app.name} events`, version: String(api.version), ...(api.description ? { description: api.description } : {}) },
    defaultContentType: 'application/json',
    channels,
    operations,
    components: { messages, schemas },
  };
  return JSON.parse(JSON.stringify(document)) as Json;
}
