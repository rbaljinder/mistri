/** Private route → internal envelope mapping for App API commands. It only
 * rebuilds the envelope the browser already sends; the shared executor stays
 * the authority for command, version, input, revision and fingerprint. No
 * mounting, principal authority or execution. */
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from '../../shared/appModel.js';
import { BULK_LIMIT } from '../../shared/command.js';
import { MAX_COMMAND_BYTES, snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { checkApiCommandCatalog } from './apiCommandCatalog.js';
import { createApiReadKeyCodec } from './apiReadKey.js';
import { ApiCommandRequestError } from './apiCommandHeaders.js';
import type { ApiCommandRoute } from './apiCommandRoute.js';

const invalid = (): never => {
  throw new ApiCommandRequestError('invalid_request');
};
const absent = (): never => {
  throw new ApiCommandRequestError('not_found');
};
type Headers = Readonly<{ expectedVersion?: number; idempotencyKey?: string }>;

/** Construction checks the exposure and builds each target's key codec once;
 * a targeted command whose key the API cannot spell refuses here, loudly. */
export function createApiCommandRequestMapper(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  evidence: Parameters<typeof checkApiCommandCatalog>[4],
  options: { integers: 'decimal-string' | 'number' },
  /** A tenant App's command catalog, from trusted composition; otherwise checked here. */
  tenant?: ReturnType<typeof checkApiCommandCatalog>,
) {
  if (!app.api) throw new Error('App API command mapping needs an explicit api declaration.');
  const api = app.api;
  const catalog = tenant ?? checkApiCommandCatalog(api, app, schema, defineCommands(registry), evidence);
  const targets = new Map(
    catalog.operations
      .filter((operation) => operation.targets !== 'none')
      .map((operation) => {
        const table = schema.tables.find((table) => table.id === operation.resource);
        const key = table ? primaryKey(table) : [];
        // The read route's key rule, not a second one: a command key in a URL is
        // spelled exactly as that record's item key is.
        const codec = createApiReadKeyCodec({ resource: operation.resource, primaryKey: key, fields: key }, schema, options);
        return [operation.command, { resource: operation.resource, many: operation.targets === 'many', codec }] as const;
      }),
  );
  // A generic create names no record: its resource route takes the input alone.
  const creates = new Map(
    catalog.operations
      .filter((operation) => operation.targets === 'none')
      .map((operation) => [operation.command, operation.resource] as const),
  );
  // A body key obeys the same wire policy: normalized, then re-read as its segment.
  const bodyKey = (codec: ReturnType<typeof createApiReadKeyCodec>, raw: unknown) => {
    try {
      return Object.freeze({ ...codec.decode(codec.encode(raw)) });
    } catch {
      return invalid();
    }
  };
  const revision = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return invalid();
    return value;
  };
  return Object.freeze({
    /** A stored target key in this API's integer representation, for recovery
     * answers: a receipt recorded by any client answers in the chosen form. */
    targetKey(command: string, key: unknown) {
      const target = targets.get(command);
      if (!target) return absent();
      return bodyKey(target.codec, key);
    },
    map(route: ApiCommandRoute, headers: Headers, body: unknown) {
      if (route.appId !== app.id || route.version !== api.version) return absent();
      const identity = { command: route.command, commandVersion: route.commandVersion };
      // Scope-only recovery never invents a target, revision or input. A create
      // keeps no target to recover by: its retry under the same key replays.
      if (route.kind === 'recover') {
        if (creates.has(route.command)) return absent();
        return Object.freeze({ ...identity, idempotencyKey: route.idempotencyKey });
      }
      if (creates.has(route.command)) {
        if (route.kind !== 'many' || creates.get(route.command) !== route.resource || typeof headers.idempotencyKey !== 'string')
          return absent();
        return Object.freeze({
          ...identity,
          key: Object.freeze({}),
          expectedVersion: 0,
          idempotencyKey: headers.idempotencyKey,
          input: body,
        });
      }
      const target = targets.get(route.command);
      if (!target || target.resource !== route.resource || (route.kind === 'many' && !target.many)) return absent();
      if (route.kind === 'prepare') {
        if (body !== undefined || headers.expectedVersion !== undefined || headers.idempotencyKey !== undefined) return invalid();
        let key;
        try {
          key = Object.freeze({ ...target.codec.decode(route.rawKey) });
        } catch {
          return invalid();
        }
        return Object.freeze({ ...identity, key });
      }
      if (typeof headers.idempotencyKey !== 'string') return invalid();
      if (route.kind === 'one') {
        if (typeof headers.expectedVersion !== 'number') return invalid();
        let key;
        // The codec's null-prototype record becomes the plain key the envelope carries.
        try {
          key = Object.freeze({ ...target.codec.decode(route.rawKey) });
        } catch {
          return invalid();
        }
        return Object.freeze({
          ...identity,
          key,
          expectedVersion: revision(headers.expectedVersion),
          idempotencyKey: headers.idempotencyKey,
          input: body,
        });
      }
      let data: unknown;
      // Bounded like the executor's envelope, then re-read as plain JSON data.
      try {
        data = JSON.parse(snapshot(body, MAX_COMMAND_BYTES).json);
      } catch {
        return invalid();
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid();
      const fields = Object.keys(data),
        wrapper = data as { targets?: unknown; input?: unknown };
      if (fields.length !== 2 || !fields.includes('targets') || !fields.includes('input')) return invalid();
      const list = wrapper.targets;
      if (!Array.isArray(list) || !list.length || list.length > BULK_LIMIT) return invalid();
      const keys: unknown[] = [],
        expectedVersions: number[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid();
        const names = Object.keys(item);
        if (names.length !== 2 || !names.includes('key') || !names.includes('version')) return invalid();
        const entry = item as { key: unknown; version: unknown };
        keys.push(bodyKey(target.codec, entry.key));
        expectedVersions.push(revision(entry.version));
      }
      return Object.freeze({ ...identity, keys, expectedVersions, idempotencyKey: headers.idempotencyKey, input: wrapper.input });
    },
  });
}
