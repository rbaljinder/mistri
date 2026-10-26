/** Conservative comparison of two App API read documents, not general OpenAPI diff. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';

type Data = Record<string, any>;
const fail = (): never => {
  throw new TypeError('Unsupported App API read document.');
};
const object = (value: unknown): Data => (value && typeof value === 'object' && !Array.isArray(value) ? value : fail());
const keys = (value: Data, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
};
const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') && new Set(value).size === value.length ? value : fail();
const canonical = (value: unknown): string => snapshot(value, 1_048_576).json;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
// Only these known response/parameter objects have prose removed. Never walk
// arbitrary maps: description/title/summary can be real field names.
const withoutDescription = (value: Data) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description'));
const responses = (value: Data) =>
  Object.fromEntries(Object.entries(value).map(([status, response]) => [status, withoutDescription(response)]));

function read(input: unknown) {
  const doc = object(snapshot(input, 1_048_576).value);
  keys(doc, [
    'openapi',
    'info',
    'servers',
    'security',
    'paths',
    'components',
    'x-mistri-document',
    'x-mistri-omitted-request-features',
    'x-mistri-integer-representation',
    'x-mistri-consistency',
  ]);
  if (
    doc.openapi !== '3.1.0' ||
    doc['x-mistri-document'] !== 'app-api-reads' ||
    !['number', 'decimal-string'].includes(doc['x-mistri-integer-representation'])
  )
    fail();
  const info = object(doc.info);
  keys(info, ['title', 'version', 'description']);
  if (typeof info.version !== 'string' || !/^[1-9][0-9]*(?![\s\S])/.test(info.version) || !Number.isSafeInteger(Number(info.version)))
    fail();
  if (!same(doc.security, [{ bearer: [] }]) || !Array.isArray(doc.servers) || doc.servers.length !== 1) fail();
  keys(object(doc.servers[0]), ['url']);
  const server = doc.servers[0].url;
  if (typeof server !== 'string' || !server.startsWith('/api/apps/') || !server.endsWith(`/v${info.version}`)) fail();
  strings(doc['x-mistri-omitted-request-features']);
  if (Object.hasOwn(doc, 'x-mistri-consistency') && doc['x-mistri-consistency'] !== 'single-source-per-request') fail();
  const components = object(doc.components);
  keys(components, ['schemas', 'securitySchemes']);
  if (!same(components.securitySchemes, { bearer: { type: 'http', scheme: 'bearer' } })) fail();
  const schemas = object(components.schemas);
  const schema = (raw: unknown): void => {
    const node = object(raw);
    keys(node, [
      '$ref',
      'type',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'anyOf',
      'not',
      'enum',
      'const',
      'format',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'pattern',
      'default',
      'x-mistri-max-utf8-bytes',
      'x-mistri-unicode-scalar-values',
      'x-mistri-control-characters',
      'x-mistri-exact-uncapped-count',
      'x-mistri-count-presence',
      'x-mistri-primary-key',
      'x-mistri-default-fields',
      'x-mistri-projection-validation',
    ]);
    if ('$ref' in node) {
      if (
        Object.keys(node).length !== 1 ||
        typeof node.$ref !== 'string' ||
        !node.$ref.startsWith('#/components/schemas/') ||
        !Object.hasOwn(schemas, node.$ref.slice(21))
      )
        fail();
      return;
    }
    if (!node.type && !node.anyOf && !node.enum && !node.properties && !Object.hasOwn(node, 'const')) fail();
    if (node.type && !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(node.type)) fail();
    const scalar = (item: unknown) => item === null || ['string', 'number', 'boolean'].includes(typeof item);
    if ('enum' in node && (!Array.isArray(node.enum) || !node.enum.length || node.enum.some((item: unknown) => !scalar(item)))) fail();
    if (('const' in node && !scalar(node.const)) || ('default' in node && !scalar(node.default))) fail();
    if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') fail();
    for (const key of ['minimum', 'maximum']) if (key in node && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) fail();
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'x-mistri-max-utf8-bytes'])
      if (key in node && (!Number.isSafeInteger(node[key]) || node[key] < 0)) fail();
    if ('format' in node && !['date', 'decimal', 'date-time'].includes(node.format)) fail();
    if ('pattern' in node) {
      if (typeof node.pattern !== 'string') fail();
      try {
        new RegExp(node.pattern, 'u');
      } catch {
        fail();
      }
    }
    if ('not' in node) {
      if (!same(node.not, { enum: ['.', '..'] })) fail();
    }
    if ('properties' in node) Object.values(object(node.properties)).forEach(schema);
    if ('required' in node) strings(node.required);
    if ('items' in node) schema(node.items);
    if ('anyOf' in node) {
      if (!Array.isArray(node.anyOf) || !node.anyOf.length) fail();
      node.anyOf.forEach(schema);
    }
  };
  for (const [name, row] of Object.entries(schemas)) {
    schema(row);
    if (row.type !== 'object' || row.additionalProperties !== false || !row.properties) fail();
    const required = strings(row.required),
      fields = Object.keys(row.properties);
    if (name.startsWith('ProjectedRow_')) {
      const key = strings(row['x-mistri-primary-key']),
        defaults = strings(row['x-mistri-default-fields']);
      if (
        !key.length ||
        !same(required, key) ||
        key.some((field) => !fields.includes(field)) ||
        !same([...defaults].sort(), [...fields].sort()) ||
        row['x-mistri-projection-validation'] !== 'request-codec-requires-exact-selected-fields-plus-complete-key'
      )
        fail();
      const full = schemas[name.replace(/^ProjectedRow_/, 'Row_')];
      if (!full || !same(full.properties, row.properties)) fail();
    } else if (
      !same([...required].sort(), fields.sort()) ||
      ['x-mistri-primary-key', 'x-mistri-default-fields', 'x-mistri-projection-validation'].some((key) => key in row)
    )
      fail();
  }
  const paths = object(doc.paths),
    ids = new Set<string>();
  for (const [path, entry] of Object.entries(paths)) {
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) fail();
    keys(object(entry), ['get']);
    const get = object(entry.get);
    keys(get, [
      'operationId',
      'summary',
      'parameters',
      'x-mistri-eligible-roles',
      'x-mistri-source',
      'x-mistri-standing-contract',
      'responses',
    ]);
    if (Object.hasOwn(get, 'x-mistri-source') && typeof get['x-mistri-source'] !== 'string') fail();
    if (typeof get.operationId !== 'string' || ids.has(get.operationId)) fail();
    ids.add(get.operationId);
    strings(get['x-mistri-eligible-roles']);
    if (Object.hasOwn(get, 'x-mistri-standing-contract')) {
      const standing = object(get['x-mistri-standing-contract']);
      keys(standing, ['query', 'order', 'defaultTab', 'tabs']);
      const question = (value: Data) => {
        if (typeof value.query !== 'string' || !Array.isArray(value.order)) fail();
        const paths = new Set<string>();
        for (const entry of value.order) {
          keys(object(entry), ['path', 'direction']);
          if (typeof entry.path !== 'string' || !entry.path.length || paths.has(entry.path) || !['asc', 'desc'].includes(entry.direction))
            fail();
          paths.add(entry.path);
        }
      };
      question(standing);
      if (!Array.isArray(standing.tabs)) fail();
      const ids = new Set<string>();
      for (const tab of standing.tabs) {
        keys(object(tab), ['id', 'query', 'order']);
        question(tab);
        if (typeof tab.id !== 'string' || !/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*(?![\s\S])/.test(tab.id) || ids.has(tab.id)) fail();
        ids.add(tab.id);
      }
      if (standing.defaultTab !== (standing.tabs[0]?.id ?? null)) fail();
    }
    if (!Array.isArray(get.parameters)) fail();
    const names = new Set<string>();
    for (const parameter of get.parameters) {
      keys(object(parameter), [
        'name',
        'in',
        'required',
        'style',
        'explode',
        'schema',
        'description',
        'x-mistri-fields',
        'x-mistri-runtime-validation',
        'x-mistri-range-endpoint-schema',
        'x-mistri-key-columns',
        'x-mistri-decoded-key-schema',
        'x-mistri-max-encoded-segment-utf8-bytes',
        'x-mistri-max-canonical-key-json-utf8-bytes',
      ]);
      if (typeof parameter.name !== 'string' || !['path', 'query'].includes(parameter.in) || names.has(parameter.name)) fail();
      if (
        (parameter.required !== undefined && typeof parameter.required !== 'boolean') ||
        (parameter.in === 'path' && (parameter.required !== true || !path.includes(`{${parameter.name}}`)))
      )
        fail();
      names.add(parameter.name);
      schema(parameter.schema);
      if (parameter.name === 'fields' && parameter.in === 'query') {
        const fields = strings(parameter['x-mistri-fields']);
        if (!fields.length || fields.some((field) => !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?![\s\S])/.test(field))) fail();
        const field = `(?:${fields.map((field) => field.replaceAll('.', '\\.')).join('|')})`;
        if (!same(parameter.schema, { type: 'string', pattern: `^${field}(?:,${field})*$(?![\\s\\S])`, default: fields.join(',') })) fail();
      }
      if (parameter['x-mistri-range-endpoint-schema']) schema(parameter['x-mistri-range-endpoint-schema']);
      if (parameter['x-mistri-decoded-key-schema']) schema(parameter['x-mistri-decoded-key-schema']);
    }
    const codes: Record<string, string> = {
      400: 'invalid_request',
      401: 'unauthenticated',
      403: 'forbidden',
      404: 'not_found',
      405: 'method_not_allowed',
      429: 'rate_limited',
      503: 'temporarily_unavailable',
    };
    keys(object(get.responses), ['200', ...Object.keys(codes)]);
    object(get.responses['200']);
    for (const [status, rawResponse] of Object.entries(get.responses)) {
      const response = object(rawResponse);
      keys(response, ['description', 'content']);
      keys(object(response.content), ['application/json']);
      keys(object(response.content['application/json']), ['schema']);
      const body = response.content['application/json'].schema;
      schema(body);
      if (
        status !== '200' &&
        !same(body, {
          type: 'object',
          additionalProperties: false,
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', const: codes[status] },
                message: { type: 'string', const: 'The API request could not be completed.' },
              },
            },
          },
        })
      )
        fail();
    }
  }
  return { doc, paths, schemas, version: Number(info.version), server: server.slice(0, -String(info.version).length) };
}

export function compareApiReadSpecs(previous: unknown, current: unknown) {
  const before = read(previous),
    after = read(current);
  const findings: Array<Readonly<{ path: string; change: string; classification: 'additive' | 'review-required' }>> = [];
  const add = (path: string, change: string, classification: 'additive' | 'review-required' = 'review-required') =>
    findings.push(Object.freeze({ path, change, classification }));
  if (before.server !== after.server) add('$', 'application-identity-changed');
  for (const key of ['x-mistri-integer-representation', 'x-mistri-omitted-request-features'])
    if (!same(before.doc[key], after.doc[key])) add('$', key);
  // A second source changes what a request may assume of the data it reads together. Both strings, or absent.
  if (before.doc['x-mistri-consistency'] !== after.doc['x-mistri-consistency']) add('$', 'x-mistri-consistency');
  for (const [name, oldRow] of Object.entries(before.schemas)) {
    const row = after.schemas[name];
    if (!row) {
      add(name, 'response-schema-removed');
      continue;
    }
    const constraints = (value: Data) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !['properties', 'required', 'x-mistri-default-fields'].includes(key)));
    if (!same(constraints(oldRow), constraints(row))) add(name, 'row-contract-changed');
    for (const field of Object.keys(oldRow.properties)) {
      if (!Object.hasOwn(row.properties, field)) add(name, `field-removed:${field}`);
      else if (!same(oldRow.properties[field], row.properties[field])) add(name, `field-contract-changed:${field}`);
      if (Object.hasOwn(row.properties, field) && oldRow.required.includes(field) !== row.required.includes(field))
        add(name, `required-field-changed:${field}`);
    }
    if (
      oldRow['x-mistri-default-fields'] &&
      row['x-mistri-default-fields'] &&
      !same(
        oldRow['x-mistri-default-fields'],
        row['x-mistri-default-fields'].filter((field: string) => Object.hasOwn(oldRow.properties, field)),
      )
    )
      add(name, 'default-projection-changed');
    for (const field of Object.keys(row.properties))
      if (!Object.hasOwn(oldRow.properties, field)) add(name, `field-added:${field}`, 'additive');
  }
  for (const [path, oldEntry] of Object.entries(before.paths)) {
    const entry = after.paths[path];
    if (!entry) {
      add(path, 'operation-removed');
      continue;
    }
    const old = oldEntry.get,
      next = entry.get;
    for (const key of ['operationId', 'x-mistri-eligible-roles']) if (!same(old[key], next[key])) add(path, `${key}-changed`);
    if (old['x-mistri-source'] !== next['x-mistri-source']) add(path, 'x-mistri-source-changed');
    const standing = 'x-mistri-standing-contract';
    if (
      Object.hasOwn(old, standing) !== Object.hasOwn(next, standing) ||
      (Object.hasOwn(old, standing) && !same(old[standing], next[standing]))
    )
      add(path, 'standing-contract-changed');
    if (!same(responses(old.responses), responses(next.responses))) add(path, 'responses-changed');
    const named = new Map(next.parameters.map((p: Data) => [`${p.in}:${p.name}`, p]));
    for (const parameter of old.parameters) {
      const id = `${parameter.in}:${parameter.name}`,
        updated = named.get(id);
      if (!updated) add(path, `parameter-removed:${id}`);
      else if (parameter.name === 'fields' && parameter.in === 'query' && (updated as Data).name === 'fields') {
        const nextParameter = updated as Data;
        const oldFields = strings(parameter['x-mistri-fields']),
          nextFields = strings(nextParameter['x-mistri-fields']);
        const fieldContract = (p: Data) =>
          Object.fromEntries(Object.entries(withoutDescription(p)).filter(([key]) => !['schema', 'x-mistri-fields'].includes(key)));
        if (
          oldFields.some((field) => !nextFields.includes(field)) ||
          !same(
            oldFields,
            nextFields.filter((field) => oldFields.includes(field)),
          ) ||
          !same(fieldContract(parameter), fieldContract(nextParameter))
        )
          add(path, `parameter-contract-changed:${id}`);
      } else if (!same(withoutDescription(parameter), withoutDescription(updated as Data))) add(path, `parameter-contract-changed:${id}`);
      named.delete(id);
    }
    for (const [id, parameter] of named)
      add(
        path,
        `parameter-added:${id}`,
        (parameter as Data).required || (parameter as Data).in === 'path' ? 'review-required' : 'additive',
      );
  }
  for (const path of Object.keys(after.paths)) if (!Object.hasOwn(before.paths, path)) add(path, 'operation-added', 'additive');
  const requiresVersionBump = findings.some((finding) => finding.classification === 'review-required');
  const versionStatus = after.version > before.version ? 'increased' : after.version < before.version ? 'decreased' : 'unchanged';
  return Object.freeze({
    stage: 'private-read-spec-comparison' as const,
    compatibilityProof: 'not-established' as const,
    requiresVersionBump,
    versionStatus,
    versionRequirementMet: versionStatus !== 'decreased' && (!requiresVersionBump || versionStatus === 'increased'),
    findings: Object.freeze(findings.sort((a, b) => `${a.path}:${a.change}`.localeCompare(`${b.path}:${b.change}`))),
  });
}
