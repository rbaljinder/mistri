/** Draft integration exposure parser. Not activated by the App parse front yet.
 * Exposure narrows existing authority; catalog and command-registration checks
 * are separate and must pass before any operation becomes publishable. */
import { homeSourceOf, ownSourceNames, type AppDef } from './appModel.js';
import { RESERVED_NAMES, VIEW_KEY } from '@mistriwork/engine/shared/model.js';
import { parseExposedCommandReference, type AppCommandReference, type AppFormCommandReference } from './command.js';
import { sameData } from './authoredData.js';

export interface ApiResourceExposure {
  fields: string[];
  filters: string[];
  sorts: string[];
  description?: string;
  /** Generic writes, each an explicit opt-in: a POST, PATCH or DELETE that runs
   * as the platform's own command, held to the role's editor rules. */
  create?: true;
  update?: true;
  delete?: true;
}
const API_WRITE_VERBS = ['create', 'update', 'delete'] as const;
type ApiWriteVerb = (typeof API_WRITE_VERBS)[number];
interface ApiViewExposure {
  view: string;
  label?: string;
  description?: string;
}
interface ApiCommandExposure {
  command: AppCommandReference | AppFormCommandReference;
  label?: string;
  description?: string;
}
export interface AppApiDef {
  version: number;
  roles: string[];
  publicSpec: boolean;
  /** Served beyond loopback when the operator listens there (`--host`,
   * `--allowed-host`, `--trust-proxy`); absent, the API answers loopback only.
   * Present only when true, so an App that never says it keeps its lock. */
  network?: true;
  resources: Record<string, ApiResourceExposure>;
  views: ApiViewExposure[];
  commands: ApiCommandExposure[];
  /** The command events the App's event feed carries, by name. */
  events: string[];
  description?: string;
}

/** Structured segments avoid collisions between qualified resources and paths. */
export function apiAuthorityKey(kind: string, ...names: string[]): string {
  return `api:${JSON.stringify([kind, ...names])}`;
}

/** Dormant composition seam. The general feature parser does not call this
 * until authored authority and checked-catalog activation are wired together.
 * The returned authority map merges directly into AppOrigins.authority. */
export function composeAppApi(
  root: unknown,
  features: readonly { id: string; api?: unknown }[],
  declaredRoles: readonly string[],
  where = 'api',
): { api?: AppApiDef; authority: Record<string, string[]> } {
  const fragments = list(features, `${where}.features`, 64).map((value, index) => {
    const entry = record(value, `${where}.features[${index}]`, ['id', 'api']);
    if (typeof entry.id !== 'string' || !VIEW_KEY.test(entry.id) || RESERVED_NAMES.has(entry.id)) fail(where, 'expected a feature id');
    return { id: entry.id as string, api: entry.api };
  });
  if (new Set(fragments.map((feature) => feature.id)).size !== fragments.length) fail(where, 'duplicate feature id');
  const authority: Record<string, string[]> = {};
  if (root === undefined) {
    if (fragments.some((feature) => feature.api !== undefined))
      fail(where, 'feature exposure requires an explicit root api block with version and roles');
    return { authority };
  }
  const rootApi = parseAppApi(root, declaredRoles, where)!;
  const all = [
    { by: 'the App', api: rootApi },
    ...fragments.flatMap((feature) => {
      if (feature.api === undefined) return [];
      const by = `features "${feature.id}"`,
        at = `${where}, ${by}`;
      const raw = record(feature.api, at);
      for (const key of Object.keys(raw)) {
        if (['version', 'roles', 'description', 'publicSpec', 'network'].includes(key))
          fail(at, `"${key}" belongs to the root App only, even when identical`);
        if (!['resources', 'views', 'commands', 'events'].includes(key)) fail(at, `unknown property "${key}"`);
      }
      return [{ by, api: parseAppApi({ version: rootApi.version, roles: rootApi.roles, ...raw }, declaredRoles, at)! }];
    }),
  ];
  const credit = (key: string, by: string) => {
    const owners = (authority[key] ??= []);
    if (!owners.includes(by)) owners.push(by);
  };
  credit(apiAuthorityKey('version'), 'the App');
  credit(apiAuthorityKey('publicSpec'), 'the App');
  if (rootApi.network) credit(apiAuthorityKey('network'), 'the App');
  rootApi.roles.forEach((role) => credit(apiAuthorityKey('role', role), 'the App'));
  const resources: Record<string, ApiResourceExposure> = {};
  const views = new Map<string, ApiViewExposure>(),
    commands = new Map<string, ApiCommandExposure>();
  const events = new Set<string>();
  const declarations = new Map<string, string>();
  const presentationOwners = new Map<string, string>();
  const mergePresentation = (
    target: { label?: string; description?: string },
    incoming: { label?: string; description?: string },
    at: string,
    by: string,
  ) => {
    for (const key of ['label', 'description'] as const) {
      const value = incoming[key];
      if (value === undefined) continue;
      const property = `${at}.${key}`;
      if (target[key] !== undefined && target[key] !== value)
        fail(where, `${property} differs between ${presentationOwners.get(property)} and ${by}`);
      target[key] = value;
      if (!presentationOwners.has(property)) presentationOwners.set(property, by);
    }
  };
  for (const { by, api } of all) {
    for (const [name, entry] of Object.entries(api.resources)) {
      const merged = (resources[name] ??= { fields: [], filters: [], sorts: [] });
      for (const [key, kind] of [
        ['fields', 'field'],
        ['filters', 'filter'],
        ['sorts', 'sort'],
      ] as const) {
        for (const field of entry[key]) {
          if (!merged[key].includes(field)) merged[key].push(field);
          credit(apiAuthorityKey(kind, name, field), by);
        }
        if (merged[key].length > MAX_FIELDS) fail(where, `merged resources "${name}" ${key} exceeds ${MAX_FIELDS} entries`);
      }
      for (const verb of API_WRITE_VERBS) {
        if (!entry[verb]) continue;
        merged[verb] = true;
        credit(apiAuthorityKey('write', name, verb), by);
      }
      mergePresentation(merged, entry, `resources "${name}"`, by);
    }
    for (const entry of api.views) {
      const merged = views.get(entry.view) ?? { view: entry.view };
      mergePresentation(merged, entry, `views "${entry.view}"`, by);
      views.set(entry.view, merged);
      credit(apiAuthorityKey('view', entry.view), by);
    }
    for (const entry of api.commands) {
      const id = entry.command.id,
        key = apiAuthorityKey('command', id);
      const previous = commands.get(id);
      if (previous && !sameData(previous.command, entry.command)) {
        fail(where, `command "${id}" references differ between ${declarations.get(key)} and ${by}; import one shared reference`);
      }
      const merged = previous ?? { command: entry.command };
      mergePresentation(merged, entry, `commands "${id}"`, by);
      commands.set(id, merged);
      if (!declarations.has(key)) declarations.set(key, by);
      credit(key, by);
    }
    for (const name of api.events) {
      events.add(name);
      credit(apiAuthorityKey('event', name), by);
    }
    if (
      Object.keys(resources).length > MAX_ENTRIES ||
      views.size > MAX_ENTRIES ||
      commands.size > MAX_ENTRIES ||
      events.size > MAX_ENTRIES
    ) {
      fail(where, `merged exposure exceeds ${MAX_ENTRIES} resources, views or commands`);
    }
  }
  return { api: { ...rootApi, resources, views: [...views.values()], commands: [...commands.values()], events: [...events] }, authority };
}

const MAX_ENTRIES = 256,
  MAX_FIELDS = 256,
  MAX_ROLES = 64;
const MAX_NAME = 128,
  MAX_PATH = 512,
  MAX_TEXT = 2000;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROOT_KEYS = ['version', 'roles', 'publicSpec', 'network', 'description', 'resources', 'views', 'commands', 'events'];
const EXPOSURE_KEYS = ['fields', 'filters', 'sorts', 'description', 'create', 'update', 'delete'];
const WRITE_KEYS = new Set(['actions']);
// The event grammar (commandEventCapture.ts): dotted identifiers, at least two, at most 128 bytes.
const EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const fail = (where: string, message: string): never => {
  throw new Error(`${where}: ${message}.`);
};

/** Capture only own enumerable data, without invoking authored getters. */
function record(raw: unknown, where: string, keys?: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
    return fail(where, 'expected a plain data object');
  const entries = Reflect.ownKeys(raw).map((key) => {
    if (typeof key !== 'string' || RESERVED_NAMES.has(key)) return fail(where, 'unsupported property name');
    if (keys && !keys.includes(key)) {
      if (WRITE_KEYS.has(key)) return fail(where, `"${key}" exposure is not supported; an API runs an action as a command it exposes`);
      return fail(where, `unknown property "${key}"`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return fail(where, 'expected enumerable data properties');
    return [key, descriptor.value] as const;
  });
  return Object.fromEntries(entries);
}

function list(raw: unknown, where: string, max: number): unknown[] {
  if (
    !Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Array.prototype ||
    raw.length > max ||
    Reflect.ownKeys(raw).length !== raw.length + 1
  )
    return fail(where, `expected a dense list of at most ${max} entries`);
  const values: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail(where, 'expected a dense list of data entries');
    values.push(descriptor.value);
  }
  return values;
}

function identifier(raw: unknown, where: string, path = false): string {
  if (typeof raw !== 'string' || !raw || raw.length > (path ? MAX_PATH : MAX_NAME)) return fail(where, 'expected a logical name');
  const parts = raw.split('.');
  if (parts.length > (path ? 16 : 2) || parts.some((part) => !IDENTIFIER.test(part) || RESERVED_NAMES.has(part))) {
    return fail(where, 'expected a non-reserved logical name');
  }
  return raw;
}

function strings(raw: unknown, where: string, max: number, check: (value: unknown, at: string) => string): string[] {
  const values = list(raw, where, max).map((value, index) => check(value, `${where}[${index}]`));
  if (new Set(values).size !== values.length) return fail(where, 'duplicate entries are not allowed');
  return values;
}

function prose(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_TEXT)
    return fail(where, `expected nonempty text of at most ${MAX_TEXT} characters`);
  return raw.trim();
}
function presentation(raw: Record<string, unknown>, where: string): { label?: string; description?: string } {
  return {
    ...(raw.label === undefined ? {} : { label: prose(raw.label, `${where}.label`) }),
    ...(raw.description === undefined ? {} : { description: prose(raw.description, `${where}.description`) }),
  };
}

/** Shape and root authority only; physical columns, view kinds and command
 * registration are intentionally not guessed without the checked catalog. */
export function parseAppApi(raw: unknown, declaredRoles: readonly string[], where = 'api'): AppApiDef | undefined {
  if (raw === undefined) return undefined;
  const input = record(raw, where, ROOT_KEYS);
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 1) return fail(where, 'version must be a positive safe integer');
  if (!declaredRoles.length) return fail(where, 'api needs auth.roles declared by the App');
  const roles = strings(input.roles, `${where}.roles`, MAX_ROLES, (role, at) => {
    if (typeof role !== 'string' || !declaredRoles.includes(role)) return fail(at, 'role is not declared by the App');
    return role;
  });
  if (!roles.length) return fail(where, 'roles must not be empty');
  if (input.publicSpec !== undefined && typeof input.publicSpec !== 'boolean') return fail(where, 'publicSpec must be true or false');
  if (input.network !== undefined && typeof input.network !== 'boolean') return fail(where, 'network must be true or false');
  const resources: Record<string, ApiResourceExposure> = {};
  if (input.resources !== undefined) {
    const entries = Object.entries(record(input.resources, `${where}.resources`));
    if (entries.length > MAX_ENTRIES) return fail(where, `resources exceeds ${MAX_ENTRIES} entries`);
    for (const [name, value] of entries) {
      identifier(name, `${where}.resources`);
      const at = `${where}.resources.${name}`,
        exposure = record(value, at, EXPOSURE_KEYS);
      const fields = strings(exposure.fields, `${at}.fields`, MAX_FIELDS, (field, spot) => identifier(field, spot, true));
      if (!fields.length) return fail(at, 'fields must not be empty');
      const subset = (key: 'filters' | 'sorts') => {
        const names =
          exposure[key] === undefined
            ? []
            : strings(exposure[key], `${at}.${key}`, MAX_FIELDS, (field, spot) => identifier(field, spot, true));
        if (names.some((field) => !fields.includes(field))) return fail(at, `${key} must name exposed fields only`);
        return names;
      };
      const writes: Partial<Record<(typeof API_WRITE_VERBS)[number], true>> = {};
      for (const verb of API_WRITE_VERBS) {
        if (exposure[verb] === undefined) continue;
        if (exposure[verb] !== true)
          return fail(`${at}.${verb}`, 'a generic write is opted into with true; leave it out to keep the resource read-only');
        writes[verb] = true;
      }
      resources[name] = { fields, filters: subset('filters'), sorts: subset('sorts'), ...writes, ...presentation(exposure, at) };
    }
  }
  const views = (input.views === undefined ? [] : list(input.views, `${where}.views`, MAX_ENTRIES)).map((value, index) => {
    const at = `${where}.views[${index}]`,
      entry = typeof value === 'string' ? { view: value } : record(value, at, ['view', 'label', 'description']);
    if (typeof entry.view !== 'string' || !VIEW_KEY.test(entry.view) || RESERVED_NAMES.has(entry.view))
      return fail(at, 'expected a view key');
    return { view: entry.view, ...presentation(entry, at) };
  });
  const commands = (input.commands === undefined ? [] : list(input.commands, `${where}.commands`, MAX_ENTRIES)).map((value, index) => {
    const at = `${where}.commands[${index}]`;
    // A name, or `{ command: name, label, description }`.
    const entry = typeof value === 'string' ? { command: value } : record(value, at, ['command', 'label', 'description']);
    const command = parseExposedCommandReference(entry.command, `${at}.command`);
    return { command, ...presentation(entry, at) };
  });
  const events =
    input.events === undefined
      ? []
      : strings(input.events, `${where}.events`, MAX_ENTRIES, (name, at) => {
          if (typeof name !== 'string' || name.length > MAX_NAME || !EVENT_NAME.test(name))
            return fail(at, 'expected an event name, such as "order.shipped"');
          if (name.startsWith('effect.'))
            return fail(at, '"effect." events are the platform\'s record of a webhook post; the feed carries the App\'s own events');
          return name;
        });
  if (new Set(views.map((view) => view.view)).size !== views.length) return fail(where, 'duplicate view exposure');
  if (new Set(commands.map((entry) => entry.command.id)).size !== commands.length) return fail(where, 'duplicate command exposure');
  return {
    version: input.version as number,
    roles,
    publicSpec: input.publicSpec === true,
    ...(input.network === true ? { network: true as const } : {}),
    resources,
    views,
    commands,
    events,
    ...(input.description === undefined ? {} : { description: prose(input.description, `${where}.description`) }),
  };
}

/* ---------- generic writes, by name (the server defines them: apiGenericWrites.ts) ---------- */

export type ApiWrite = Readonly<{ id: string; verb: ApiWriteVerb; resource: string; fields: readonly string[] }>;

/** The command id a generic write runs as: `create-invoice`, `update-invoice`, `delete-invoice`. */
const apiWriteCommandId = (verb: ApiWriteVerb, resource: string): string => `${verb}-${resource}`;

/** The generic writes an API opts into, in a stable order. */
export function apiWrites(api: AppApiDef | undefined): ApiWrite[] {
  if (!api) return [];
  return Object.entries(api.resources)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([resource, exposure]) =>
      API_WRITE_VERBS.filter((verb) => exposure[verb]).map((verb) =>
        Object.freeze({ id: apiWriteCommandId(verb, resource), verb, resource, fields: Object.freeze([...exposure.fields]) }),
      ),
    );
}

/** Whether the API serves the command routes: exposed commands, or generic writes. */
export function apiExposesCommands(api: AppApiDef | undefined): boolean {
  return !!api && (api.commands.length > 0 || apiWrites(api).length > 0);
}

type ApiSourcesView = Pick<AppDef, 'sources' | 'resources' | 'views'> & { api?: AppApiDef };

/** The App's own sources its API reaches, in declaration order: each exposed
 * resource's, each exposed view's table's and each exposed command's
 * target's. Only these connections are judged for serving (their engine,
 * their store); a source the API never touches is not. Empty for an App
 * without `sources`, whose one connection is the App's. */
export function apiExposedSources(app: ApiSourcesView): string[] {
  if (!app.sources || !app.api) return [];
  const home = homeSourceOf(app);
  const resources = new Set(Object.keys(app.api.resources));
  for (const { view } of app.api.views) {
    const table = (app.views?.[view] as { table?: string } | undefined)?.table;
    if (table) resources.add(table);
  }
  for (const { command } of app.api.commands) if ('target' in command && command.target) resources.add(command.target);
  const reached = new Set([...resources].map((resource) => app.resources?.[resource]?.source ?? home));
  return Object.keys(app.sources).filter((source) => reached.has(source));
}

/** The consistency an App API of several sources promises, in its documents:
 * each request reads one source group, and nothing holds across requests. */
export const API_CONSISTENCY = 'single-source-per-request';

/** Whether an App's API documents say which source each operation reads: only
 * an App with more than one of its own. A one-source App's documents are as
 * they were before several sources could be served. */
export function apiSeveralSources(app: Pick<AppDef, 'sources'>): boolean {
  return ownSourceNames(app).length > 1;
}

/** What parsing can see of an exposure that would read two connections in
 * one request [api-multi-source]: a field, filter or sort that starts on a
 * declared reference to a source on another connection. An approximation —
 * a key the database declares, or a hop past the first, is not visible here —
 * so the checked catalog judges every path again against the opened
 * connections (apiReadCatalog.ts), and that is the rule. */
export function apiCrossConnectionProblems(app: ApiSourcesView, where = 'api'): string[] {
  if (!app.sources || !app.api) return [];
  const home = homeSourceOf(app);
  const connectionOf = (resource: string) => {
    const source = app.resources?.[resource]?.source ?? home;
    return source === undefined ? undefined : app.sources![source]?.connection;
  };
  const problems: string[] = [];
  for (const [resource, exposure] of Object.entries(app.api.resources)) {
    const from = connectionOf(resource);
    for (const path of new Set([...exposure.fields, ...exposure.filters, ...exposure.sorts])) {
      const dot = path.indexOf('.');
      if (dot < 1) continue;
      const reference = app.resources?.[resource]?.references?.[path.slice(0, dot)];
      if (!reference) continue;
      const to = connectionOf(reference.to);
      if (from === undefined || to === undefined || to === from) continue;
      problems.push(
        `${where}.resources.${resource}: "${path}" reaches "${reference.to}", on another connection; one App API request reads one connection [api-multi-source]. ` +
          `Expose "${reference.to}" as a resource of its own, or drop the path.`,
      );
    }
  }
  return problems;
}
