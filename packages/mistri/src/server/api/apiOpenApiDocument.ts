/** The composed App API document: the read document, unchanged, plus the
 * command section, under one marker. The read renderer, narrowing and
 * comparator are reused as they are on the read half; the command half has its
 * own. A command path always contains `/commands/`, which no read path can
 * (`commands` is a reserved resource name), and command components have their
 * own prefixes, so a document splits back into its halves without guessing. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { checkApiCommandCatalog } from './apiCommandCatalog.js';
import type { checkApiReadCatalog } from './apiReadCatalog.js';
import { renderApiCommandOpenApi } from './apiCommandOpenApi.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';
import { narrowApiReadOpenApi } from './apiNarrowedReadOpenApi.js';
import { compareApiReadSpecs } from './apiReadSpecCompare.js';

type Json = Record<string, any>;
/** Which mistri document this is: the composed one, or reads alone (apiReadOpenApi.ts). */
const DOCUMENT = 'app-api',
  READ_DOCUMENT = 'app-api-reads';
const COMMAND_SCHEMA = /^(?:CommandProblem|CommandInput_[0-9a-f]+|CommandResult_[0-9a-f]+)$/;
const COMMAND_OPERATION = /^(?:command|commandMany|recover|prepare)_([0-9a-f]+)$/;
const isCommandPath = (path: string) => path.includes('/commands/');
const refuse = (): never => {
  throw new TypeError('The composed API document is unavailable.');
};
const object = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : refuse());
const canonical = (value: unknown) => snapshot(value, 2_097_152).json;
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
  const read = renderApiReadOpenApi({ ...app, api: { ...app.api, commands: [] } }, schema, options, tenant?.reads).document as Json;
  const commands = renderApiCommandOpenApi(app, schema, registry, evidence, options, tenant?.commands);
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
  const doc = object(snapshot(input, 2_097_152).value);
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
