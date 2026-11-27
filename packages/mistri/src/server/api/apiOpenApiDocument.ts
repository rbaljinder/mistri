/** The composed App API document: the read document, unchanged, plus the
 * command section, under one marker. The read renderer, narrowing and
 * comparator are reused as they are on the read half; the command half has its
 * own. A command path always contains `/commands/`, which no read path can
 * (`commands` is a reserved resource name), and command components have their
 * own prefixes, so a document splits back into its halves without guessing. */
import { MAX_JSON_DEPTH, snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { checkApiCommandCatalog } from './apiCommandCatalog.js';
import type { checkApiReadCatalog } from './apiReadCatalog.js';
import { renderApiCommandOpenApi } from './apiCommandOpenApi.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';
import { narrowApiReadOpenApi } from './apiNarrowedReadOpenApi.js';
import { compareApiReadSpecs } from './apiReadSpecCompare.js';
import { apiJudgment, MAX_API_DOCUMENT_BYTES, MAX_API_DOCUMENT_NODES } from './apiRefusals.js';

type Json = Record<string, any>;
/** Which mistri document this is: the composed one, or reads alone (apiReadOpenApi.ts). */
const DOCUMENT = 'app-api',
  READ_DOCUMENT = 'app-api-reads';
const COMMAND_SCHEMA = /^(?:CommandProblem|CommandInput_[0-9a-f]+|CommandBody_[0-9a-f]+|CommandResult_[0-9a-f]+)$/;
const COMMAND_OPERATION = /^(?:command|commandMany|recover|prepare)_([0-9a-f]+)$/;
const isCommandPath = (path: string) => path.includes('/commands/');
const refuse = (): never => {
  throw new TypeError('The composed API document is unavailable.');
};
const object = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : refuse());
/** The first path in the document that nests past the canonical walk's depth, or none. */
function tooDeep(value: unknown, path: readonly string[] = []): readonly string[] | undefined {
  if (path.length > MAX_JSON_DEPTH) return path;
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, child] of Object.entries(value)) {
    const found = tooDeep(child, [...path, key]);
    if (found) return found;
  }
  return undefined;
}
/** Total JSON nodes in `value`, matching the node counter in canonicalJson.ts (`snapshot`). */
function countNodes(value: unknown): number {
  if (value === null || typeof value !== 'object') return 1;
  let total = 1;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) total += countNodes(value[i]);
  } else {
    for (const child of Object.values(value)) total += countNodes(child);
  }
  return total;
}
/** The largest top-level `paths` and `components.schemas` entries in an OpenAPI document by node count. */
function largestExposures(value: unknown, top = 5): Array<readonly [label: string, nodes: number]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const doc = value as Record<string, unknown>;
  const entries: Array<readonly [string, number]> = [];
  if (doc.paths && typeof doc.paths === 'object' && !Array.isArray(doc.paths)) {
    for (const [path, entry] of Object.entries(doc.paths as Record<string, unknown>)) entries.push([path, countNodes(entry)]);
  }
  const schemas =
    doc.components && typeof doc.components === 'object' && !Array.isArray(doc.components)
      ? (doc.components as Record<string, unknown>).schemas
      : undefined;
  if (schemas && typeof schemas === 'object' && !Array.isArray(schemas)) {
    for (const [name, entry] of Object.entries(schemas as Record<string, unknown>)) entries.push([`schema:${name}`, countNodes(entry)]);
  }
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.slice(0, top);
}
/* The document is spelled by the canonical walk, with its own 100,000-node ceiling (apart from the 10,000-node
   ceiling untrusted command requests are held to) so Apps with many exposed resources, commands and `choose` picks
   render cleanly while still failing with an actionable diagnostic if a document grows past the bound. */
const canonical = (value: unknown) => {
  const deep = tooDeep(value);
  if (deep) {
    const where = deep.join(' › ');
    const command = /^\/(?:[^/]+\/)*commands\/([^/]+)\/v\d+$/.exec(deep[0] === 'paths' ? deep[1] : '')?.[1];
    throw new Error(
      `The App's API document nests deeper than the ${MAX_JSON_DEPTH} levels a document is held to, at ${where} [api-document-depth]. ` +
        (command && deep.includes('targets')
          ? `Command "${command}" takes many records, and its body's keys nest past the limit: take \`targets: 'many'\` off its entry in \`api.commands\` (its one-record route stays), or leave it out of \`api.commands\`.`
          : `Flatten what nests there, or leave it out of \`api\`.`),
    );
  }
  const nodes = countNodes(value);
  if (nodes > MAX_API_DOCUMENT_NODES) {
    const largest = largestExposures(value);
    const named = largest.length
      ? ` Largest entries: ${largest.map(([label, count]) => `${label} (${count.toLocaleString('en-US')})`).join(', ')}.`
      : '';
    throw new Error(
      `The App's API document has ${nodes.toLocaleString('en-US')} nodes, past the ${MAX_API_DOCUMENT_NODES.toLocaleString('en-US')}-node limit a document is held to [api-document-size].${named} ` +
        `Trim the exposed fields or remove entries from \`api\`.`,
    );
  }
  return snapshot(value, MAX_API_DOCUMENT_BYTES, { maxNodes: MAX_API_DOCUMENT_NODES }).json;
};
const freeze = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
};

export function renderApiOpenApi(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  evidence: Parameters<typeof checkApiCommandCatalog>[4],
  options: { integers: 'decimal-string' | 'number' },
  /** A tenant App's two catalogs, from trusted composition; otherwise checked here. */
  tenant?: Readonly<{ reads: ReturnType<typeof checkApiReadCatalog>; commands: ReturnType<typeof checkApiCommandCatalog> }>,
) {
  if (!app.api) throw new Error('The App API document requires an explicit api declaration.');
  // The read catalog refuses command exposures so a read-only surface cannot
  // silently ignore them. Here the command half renders them explicitly, so
  // the read half is rendered from the same App with its commands projected out.
  // The reads and the commands judged apart, so one run says the refusals of both (apiRefusals.ts).
  const judged = apiJudgment();
  const read = judged.run(
    () => renderApiReadOpenApi({ ...app, api: { ...app.api!, commands: [] } }, schema, options, tenant?.reads).document as Json,
  )!;
  const commands = judged.run(() => renderApiCommandOpenApi(app, schema, registry, evidence, options, tenant?.commands))!;
  judged.done();
  for (const path of Object.keys(commands.paths)) if (Object.hasOwn(read.paths, path) || !isCommandPath(path)) refuse();
  for (const name of Object.keys(commands.schemas))
    if (Object.hasOwn(read.components.schemas, name) || !COMMAND_SCHEMA.test(name)) refuse();
  const document = JSON.parse(
    canonical({
      ...read,
      'x-mistri-document': DOCUMENT,
      paths: { ...read.paths, ...commands.paths },
      components: { ...read.components, schemas: { ...read.components.schemas, ...commands.schemas } },
    }),
  );
  freeze(document);
  return Object.freeze({ stage: DOCUMENT, document });
}

/** The read half exactly as the read renderer shapes it, and the command half.
 * A read-only document is accepted as a document with no commands. */
export function splitApiOpenApi(input: unknown) {
  const doc = object(snapshot(input, MAX_API_DOCUMENT_BYTES, { maxNodes: MAX_API_DOCUMENT_NODES }).value);
  if (doc['x-mistri-document'] !== DOCUMENT && doc['x-mistri-document'] !== READ_DOCUMENT) return refuse();
  const components = object(doc.components),
    readPaths: Json = {},
    commandPaths: Json = {},
    readSchemas: Json = {},
    commandSchemas: Json = {};
  for (const [path, entry] of Object.entries(object(doc.paths))) (isCommandPath(path) ? commandPaths : readPaths)[path] = entry;
  for (const [name, value] of Object.entries(object(components.schemas)))
    (COMMAND_SCHEMA.test(name) ? commandSchemas : readSchemas)[name] = value;
  if (doc['x-mistri-document'] === READ_DOCUMENT && (Object.keys(commandPaths).length || Object.keys(commandSchemas).length))
    return refuse();
  return {
    read: { ...doc, 'x-mistri-document': READ_DOCUMENT, paths: readPaths, components: { ...components, schemas: readSchemas } },
    commands: { paths: commandPaths, schemas: commandSchemas },
  };
}

/** Freshly observed operation IDs only: read IDs narrow the read half with the
 * existing function; `command:<id>` keeps that command's routes and the
 * components they reference. Unknown IDs refuse rather than disappear. */
export function narrowApiOpenApi(document: unknown, operationIds: readonly string[]) {
  const { read, commands } = splitApiOpenApi(document);
  const ids = snapshot(operationIds, 262144).value;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) return refuse();
  const readIds = (ids as string[]).filter((id) => /^(?:item|list|view):/.test(id));
  const commandIds = (ids as string[]).filter((id) => id.startsWith('command:'));
  // The event feed's operations are the AsyncAPI document's (apiAsyncApi.ts), not this one's.
  const eventIds = (ids as string[]).filter((id) => id.startsWith('event:'));
  if (readIds.length + commandIds.length + eventIds.length !== ids.length) return refuse();
  const narrowedRead = narrowApiReadOpenApi(read as never, readIds) as unknown as Json;
  const granted = new Set(commandIds.map((id) => Buffer.from(id.slice('command:'.length), 'utf8').toString('hex')));
  const found = new Set<string>(),
    paths: Json = {},
    schemas: Json = {};
  const reference = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(reference);
      return;
    }
    const node = value as Json;
    if (typeof node.$ref === 'string') {
      const name = node.$ref.startsWith('#/components/schemas/') ? node.$ref.slice('#/components/schemas/'.length) : refuse();
      if (!Object.hasOwn(commands.schemas, name)) refuse();
      if (!Object.hasOwn(schemas, name)) {
        schemas[name] = commands.schemas[name];
        reference(schemas[name]);
      }
    }
    Object.values(node).forEach(reference);
  };
  for (const [path, entry] of Object.entries(commands.paths)) {
    const methods = Object.entries(object(entry));
    if (methods.length !== 1) refuse();
    const [method, operation] = methods[0],
      match = COMMAND_OPERATION.exec(object(operation).operationId);
    if (!match) refuse();
    if (!granted.has(match![1])) continue;
    found.add(match![1]);
    const { 'x-mistri-eligible-roles': _roles, ...selected } = operation as Json;
    paths[path] = { [method]: selected };
  }
  if (found.size !== granted.size) return refuse();
  reference(paths);
  const result = {
    ...narrowedRead,
    'x-mistri-document': DOCUMENT,
    paths: { ...narrowedRead.paths, ...paths },
    components: { ...narrowedRead.components, schemas: { ...narrowedRead.components.schemas, ...schemas } },
  };
  const copy = JSON.parse(canonical(result));
  freeze(copy);
  return copy;
}

/** The read half through the existing conservative comparison; the command
 * half is compared whole: any removal or change needs review, additions do not. */
export function compareApiOpenApiDocuments(previous: unknown, current: unknown) {
  const before = splitApiOpenApi(previous),
    after = splitApiOpenApi(current);
  const read = compareApiReadSpecs(before.read, after.read);
  const findings: Array<Readonly<{ path: string; change: string; classification: 'additive' | 'review-required' }>> = [...read.findings];
  const add = (path: string, change: string, classification: 'additive' | 'review-required') =>
    findings.push(Object.freeze({ path, change, classification }));
  for (const [kind, old, next] of [
    ['operation', before.commands.paths, after.commands.paths],
    ['command-schema', before.commands.schemas, after.commands.schemas],
  ] as const) {
    for (const [name, value] of Object.entries(old)) {
      if (!Object.hasOwn(next, name)) add(name, `${kind}-removed`, 'review-required');
      else if (canonical(value) !== canonical(next[name])) add(name, `${kind}-changed`, 'review-required');
    }
    for (const name of Object.keys(next)) if (!Object.hasOwn(old, name)) add(name, `${kind}-added`, 'additive');
  }
  const requiresVersionBump = findings.some((finding) => finding.classification === 'review-required');
  return Object.freeze({
    stage: 'private-api-spec-comparison' as const,
    compatibilityProof: 'not-established' as const,
    requiresVersionBump,
    versionStatus: read.versionStatus,
    versionRequirementMet: read.versionStatus !== 'decreased' && (!requiresVersionBump || read.versionStatus === 'increased'),
    findings: Object.freeze(findings.sort((a, b) => `${a.path}:${a.change}`.localeCompare(`${b.path}:${b.change}`))),
  });
}
