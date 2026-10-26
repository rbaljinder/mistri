/** Private projection of a trusted read preview by freshly observed operation
 * IDs. This helper verifies no credential or principal and enables no route. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { renderApiReadOpenApi } from './apiReadOpenApi.js';

type Document = ReturnType<typeof renderApiReadOpenApi>['document'];
type JsonObject = Record<string, unknown>;
const refuse = (): never => {
  throw new TypeError('The scoped read preview is unavailable.');
};
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : refuse();
const freeze = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
};

/** Caller supplies the server-owned full preview and native observation's
 * operations, never request parameters or a claim that IDs prove authority.
 * Empty scope is valid. Unknown IDs refuse instead of silently disappearing.
 * The full renderer must succeed first: this does not bypass unsupported
 * declaration validation, or claim all preview features execute over HTTP.
 * Authored global metadata (including App description) is retained. This is
 * NOT a sanitizer for arbitrary documents/extensions outside our renderer. */
export function narrowApiReadOpenApi(document: Document, operationIds: readonly string[]) {
  const source = object(snapshot(document, 1_048_576).value);
  const ids = snapshot(operationIds, 262144).value;
  if (
    !Array.isArray(ids) ||
    ids.length > 1024 ||
    ids.some((id) => typeof id !== 'string' || !/^(?:item|list|view):.+$/u.test(id)) ||
    new Set(ids).size !== ids.length
  )
    return refuse();
  if (source.openapi !== '3.1.0' || source['x-mistri-document'] !== 'app-api-reads') return refuse();
  const expected = new Set(ids.map((id) => `read_${Buffer.from(id as string, 'utf8').toString('hex')}`));
  const found = new Set<string>(),
    paths: JsonObject = {};
  for (const [path, value] of Object.entries(object(source.paths))) {
    const entry = object(value),
      get = object(entry.get);
    if (typeof get.operationId !== 'string') return refuse();
    if (!expected.has(get.operationId)) continue;
    if (found.has(get.operationId) || Object.keys(entry).some((key) => key !== 'get')) return refuse();
    found.add(get.operationId);
    const selected = { ...get };
    delete selected['x-mistri-eligible-roles'];
    delete selected['x-mistri-standing-contract'];
    paths[path] = { get: selected };
  }
  if (found.size !== expected.size) return refuse();

  const components = object(source.components),
    allSchemas = object(components.schemas);
  const schemas: JsonObject = {},
    queued: string[] = [];
  const references = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(references);
      return;
    }
    const node = object(value);
    if (Object.hasOwn(node, '$ref')) {
      if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#/components/schemas/')) return refuse();
      const name = node.$ref.slice('#/components/schemas/'.length);
      if (!Object.hasOwn(allSchemas, name)) return refuse();
      if (!Object.hasOwn(schemas, name)) {
        schemas[name] = object(allSchemas[name]);
        queued.push(name);
      }
    }
    Object.values(node).forEach(references);
  };
  references(paths);
  for (let index = 0; index < queued.length; index++) references(schemas[queued[index]]);
  // Retain only the renderer's bearer security declaration and referenced
  // schemas; no hidden component map survives through a generic spread.
  const result = {
    ...source,
    paths,
    components: {
      schemas,
      securitySchemes: components.securitySchemes,
    },
  };
  freeze(result);
  // The input is the trusted renderer's document; only these captured maps
  // are narrowed. This assertion does not certify arbitrary OpenAPI inputs.
  return result as unknown as Document;
}
