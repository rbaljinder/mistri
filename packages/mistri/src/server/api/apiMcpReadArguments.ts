/** Private data conversion only. No tool registration, credential admission,
 * supplied checked plan, cursor verification or execution authority. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { resolvePath } from '@mistriwork/engine/shared/view.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';
import { createApiReadKeyCodec } from './apiReadKey.js';
import { apiDialectOf, apiIntegerRepresentation, apiValueCodec } from './apiValueCodec.js';
import { planApiItemReadRequest, planApiReadRequest, planApiViewReadRequest } from './apiReadRequest.js';

type ObjectValue = Record<string, unknown>;
const refuse = (): never => {
  throw new TypeError('App read-tool arguments are invalid or not representable.');
};
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : refuse();

/** Expand Number's shortest round-tripping spelling without arithmetic on
 * its significand. This promises the same binary64 value, not exact decimal
 * arithmetic. Finite JS numbers need at most 327 characters here. */
function decimalNumber(value: number): string {
  if (!Number.isFinite(value)) return refuse();
  const shortest = String(value);
  if (!shortest.includes('e')) return shortest;
  const match = /^(-?)([0-9])(?:\.([0-9]+))?e([+-][0-9]+)$/.exec(shortest);
  if (!match) return refuse();
  const exponent = Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 324) return refuse();
  const digits = match[2] + (match[3] ?? ''),
    point = 1 + exponent;
  const expanded =
    match[1] +
    (point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`);
  if (expanded.length > 400 || !Object.is(Number(expanded), value)) return refuse();
  return expanded;
}

/** The renderer's scalar subset only, not a general JSON Schema validator.
 * Runtime key/filter codecs below remain authoritative for scalar semantics. */
function scalarShape(value: unknown, rawSchema: unknown): void {
  const schema = object(rawSchema),
    type = schema.type;
  if (
    type === 'integer'
      ? typeof value !== 'number' || !Number.isSafeInteger(value)
      : type === 'number'
        ? typeof value !== 'number' || !Number.isFinite(value)
        : type === 'string'
          ? typeof value !== 'string'
          : type === 'boolean'
            ? typeof value !== 'boolean'
            : true
  )
    return refuse();
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return refuse();
  if (
    typeof value === 'number' &&
    ((typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))
  )
    return refuse();
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return refuse();
    if (
      (typeof schema.minLength === 'number' && [...value].length < schema.minLength) ||
      (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength)
    )
      return refuse();
  }
}

export function createApiMcpReadArguments(
  inputApp: AppDef,
  inputSchema: DatabaseSchema,
  operationId: string,
  options: { integers: 'number' | 'decimal-string' },
  /** A tenant App's catalog, from trusted composition; otherwise checked here. */
  given?: ReturnType<typeof checkApiReadCatalog>,
) {
  const app = captureTenantData(inputApp),
    schema = captureTenantData(inputSchema);
  const integers = apiIntegerRepresentation(options),
    policy = { integers } as const;
  if (!app.api || typeof operationId !== 'string') return refuse();
  const catalog = given ? captureTenantData(given) : checkApiReadCatalog(app.api, app, schema);
  const operation = catalog.operations.find((value) => value.id === operationId);
  if (!operation) return refuse();
  // Exact currently rendered parameters, not a separately maintained tool DSL.
  const document = renderApiReadOpenApi(app, schema, policy, catalog).document;
  const renderedId = `read_${Buffer.from(operationId, 'utf8').toString('hex')}`;
  const matched = Object.values(document.paths)
    .map((path) => object(object(path).get))
    .filter((value) => value.operationId === renderedId);
  if (matched.length !== 1 || !Array.isArray(matched[0].parameters)) return refuse();
  const parameters = matched[0].parameters.map(object);
  const allowed = new Map<string, ObjectValue>();
  for (const parameter of parameters) {
    if (typeof parameter.name !== 'string' || allowed.has(parameter.name)) return refuse();
    allowed.set(parameter.name, parameter);
  }
  const key = operation.kind === 'item' ? createApiReadKeyCodec(operation, schema, policy) : undefined;
  return Object.freeze({
    stage: 'read-tool-argument-codec' as const,
    authorization: 'pending' as const,
    decode(raw: unknown, now: Date) {
      const args = object(snapshot(raw, 32768).value);
      if (
        Object.keys(args).some((name) => !allowed.has(name)) ||
        parameters.some((parameter) => parameter.required === true && !Object.hasOwn(args, String(parameter.name)))
      )
        return refuse();
      if (key) {
        const parameter = parameters[0],
          value = args[String(parameter.name)];
        const complete = operation.primaryKey.length === 1 ? { [operation.primaryKey[0]]: value } : object(value);
        const properties = object(key.schema.properties);
        if (Object.keys(complete).length !== operation.primaryKey.length) return refuse();
        for (const name of operation.primaryKey) scalarShape(complete[name], properties[name]);
        const encoded = key.encode(complete);
        // The same catalog throughout: a tenant App's, given, is never re-checked
        // by the ordinary rules, which do not describe its tenant context.
        planApiItemReadRequest(app, schema, operationId, encoded, policy, catalog);
        return Object.freeze({ operationId, key: encoded, authorization: 'pending' as const });
      }
      const pairs: string[] = [];
      for (const [name, parameter] of allowed) {
        if (!Object.hasOwn(args, name)) continue;
        const value = args[name];
        let text: string;
        if (operation.filters.includes(name)) {
          const resolved = resolvePath(schema, operation.resource, name);
          const codec = apiValueCodec(resolved.column, apiDialectOf(schema, resolved.table.id), integers);
          if (Array.isArray(value)) {
            if (!value.length || value.length > 100) return refuse();
            text = value
              .map((member) => {
                scalarShape(member, codec.schema);
                const encoded = codec.encode(member);
                const lexeme = typeof encoded === 'number' ? decimalNumber(encoded) : String(encoded);
                // The shared address parser trims/splits these spellings. URI
                // encoding does not escape delimiters inside its decoded value.
                if (!lexeme || lexeme.trim() !== lexeme || lexeme.includes(',') || lexeme.includes('..') || /[\p{Cc}\p{Cs}]/u.test(lexeme))
                  return refuse();
                return lexeme;
              })
              .join(',');
          } else {
            const shape = object(parameter.schema);
            if (!Array.isArray(shape.anyOf) || typeof value !== 'string') return refuse();
            const range = shape.anyOf.find((candidate) => object(candidate).type === 'string');
            if (!range) return refuse();
            scalarShape(value, range);
            text = value;
          }
        } else {
          scalarShape(value, parameter.schema);
          text = String(value);
        }
        pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(text)}`);
      }
      const query = pairs.join('&');
      if (operation.kind === 'view') planApiViewReadRequest(app, schema, operationId, query, policy, now, catalog);
      else planApiReadRequest(app, schema, operationId, query, policy, catalog, now);
      // Cursor stays opaque: only the eventual owner can verify its signature.
      return Object.freeze({ operationId, query, authorization: 'pending' as const });
    },
  });
}
