/** Non-callable App discovery preview. Never register these descriptors as a
 * live tools/list response: supplied scope is filtering data, not admission.
 * The one exception is a read owner (`purpose: 'owner'`), which passes its own
 * fresh native observation as the scope; nothing else may. */
import { createHash } from 'node:crypto';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { AppDef } from '../../shared/appModel.js';
import { apiSeveralSources } from '../../shared/appApi.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';

type Json = Record<string, unknown>;
const fail = (): never => {
  throw new TypeError('App read-tool preview is unavailable.');
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

export function previewApiMcpReadTools(
  app: AppDef,
  schema: DatabaseSchema,
  options: { integers: 'number' | 'decimal-string' },
  rawScope: unknown,
  purpose: 'preview' | 'owner' = 'preview',
  /** A tenant App's catalog, from trusted composition; otherwise checked here. */
  given?: ReturnType<typeof checkApiReadCatalog>,
) {
  const scope = object(snapshot(rawScope, 262144).value);
  if (Object.keys(scope).length !== 2 || !Object.hasOwn(scope, 'operations') || !Object.hasOwn(scope, 'roles')) return fail();
  const permitted = new Set(names(scope.operations)),
    roles = new Set(names(scope.roles));
  if (!app.api) return fail();
  const catalog = given ?? checkApiReadCatalog(app.api, app, schema);
  const document = renderApiReadOpenApi(app, schema, options, catalog).document;
  const components = document.components.schemas;
  let nodes = 0;
  const resolve = (raw: unknown, depth = 0, active = new Set<string>()): Json => {
    if (++nodes > 100000 || depth > 32) return fail();
    const value = object(raw);
    if (Object.hasOwn(value, '$ref')) {
      const ref = value.$ref;
      if (
        Object.keys(value).length !== 1 ||
        typeof ref !== 'string' ||
        !/^#\/components\/schemas\/(?:Projected)?Row_[0-9a-f]+$/.test(ref) ||
        active.has(ref)
      )
        return fail();
      const key = ref.slice('#/components/schemas/'.length);
      if (!Object.hasOwn(components, key)) return fail();
      return resolve(components[key], depth + 1, new Set([...active, ref]));
    }
    const result: Json = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        ![
          'type',
          'properties',
          'required',
          'additionalProperties',
          'items',
          'not',
          'anyOf',
          'oneOf',
          'allOf',
          'enum',
          'const',
          'minimum',
          'maximum',
          'exclusiveMinimum',
          'exclusiveMaximum',
          'multipleOf',
          'minLength',
          'maxLength',
          'pattern',
          'format',
          'minItems',
          'maxItems',
          'uniqueItems',
          'default',
          'description',
          'title',
        ].includes(key) &&
        !key.startsWith('x-mistri-')
      )
        return fail();
      if (key === 'additionalProperties' && typeof child !== 'boolean') return fail();
      // Traverse schema positions only: a property literally named title or
      // description remains data, not a recursively stripped annotation.
      if (key === 'properties')
        result[key] = Object.fromEntries(
          Object.entries(object(child)).map(([name, property]) => [name, resolve(property, depth + 1, active)]),
        );
      else if (key === 'items' || key === 'not') result[key] = resolve(child, depth + 1, active);
      else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
        if (!Array.isArray(child)) return fail();
        result[key] = child.map((schema) => resolve(schema, depth + 1, active));
      } else result[key] = child;
    }
    return result;
  };
  const byId = new Map<string, Json>();
  for (const path of Object.values(document.paths)) {
    if (Object.keys(path).length !== 1 || !Object.hasOwn(path, 'get')) return fail();
    const operation = object(path.get);
    if (typeof operation.operationId !== 'string' || byId.has(operation.operationId)) return fail();
    byId.set(operation.operationId, operation);
  }
  if (byId.size !== catalog.operations.length) return fail();
  const tools: Json[] = [],
    bindings: Array<{ name: string; operationId: string }> = [];
  const used = new Set<string>();
  for (const operation of catalog.operations) {
    const spec = byId.get(`read_${Buffer.from(operation.id, 'utf8').toString('hex')}`);
    if (!spec) return fail();
    if (!permitted.has(operation.id) || !operation.eligibleRoles.some((role) => roles.has(role))) continue;
    const authored = operation.kind === 'view' ? operation.id.slice(5) : operation.resource;
    const kind = operation.kind === 'item' ? 'get' : operation.kind;
    const slug = authored.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 30);
    const suffix = createHash('sha256')
      .update(JSON.stringify([app.id, operation.id]))
      .digest('hex')
      .slice(0, 24);
    const name = `${kind}_${slug}_${suffix}`;
    if (name.length > 64 || used.has(name)) return fail();
    used.add(name);
    const properties: Json = {},
      required: string[] = [];
    if (!Array.isArray(spec.parameters)) return fail();
    for (const raw of spec.parameters) {
      const parameter = object(raw),
        key = parameter.name;
      if (
        typeof key !== 'string' ||
        Object.hasOwn(properties, key) ||
        !['query', 'path'].includes(String(parameter.in)) ||
        parameter.content !== undefined ||
        (parameter.style !== undefined && !['form', 'simple'].includes(String(parameter.style)))
      )
        return fail();
      if (parameter.in === 'path' && parameter.required !== true) return fail();
      properties[key] = resolve(parameter.schema);
      if (parameter.required === true) required.push(key);
    }
    const response = object(object(object(object(spec.responses)['200']).content)['application/json']).schema;
    const exposedView = app.api.views.find((view) => view.view === authored);
    const label = operation.kind === 'view' ? (exposedView?.label ?? app.views[authored]?.label ?? authored) : authored;
    tools.push({
      name,
      title: `${app.name}: ${kind} ${label}`.slice(0, 256),
      description:
        purpose === 'owner'
          ? (
              `Reads ${label} from ${app.name} through its App API, as this token allows; checked again on every call.` +
              // With several sources, what one call may assume of another's data.
              (apiSeveralSources(app) ? ` Each call reads source "${operation.source}" alone; nothing is promised across calls.` : '')
            ).slice(0, 1024)
          : 'Private non-callable read preview. Authentication, execution and cursor verification are not implemented.',
      inputSchema: { type: 'object', additionalProperties: false, properties, required },
      outputSchema: resolve(response),
    });
    bindings.push({ name, operationId: operation.id });
  }
  // Bounded deep immutable capture also rejects unsupported JSON data. Bindings
  // are private dispatch metadata, not fields to disclose in a tool listing.
  return snapshot(
    { stage: 'private-read-tool-preview', authorization: 'pending', execution: 'pending', cursorVerification: 'pending', tools, bindings },
    4194304,
  ).value as Readonly<{
    stage: 'private-read-tool-preview';
    authorization: 'pending';
    execution: 'pending';
    cursorVerification: 'pending';
    tools: readonly Readonly<Json>[];
    bindings: readonly Readonly<{ name: string; operationId: string }>[];
  }>;
}
