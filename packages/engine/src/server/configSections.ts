/**
 * The sections of tablewalk.json beside `connections`.
 *
 * The engine reads `connections`, `hidden`, `pool` and the cache (connections.ts, cacheService.ts). Every other
 * entry a config file lists beside the databases — an email service, an identity provider, a webhook, a search
 * engine — and every other top-level key — `analytics` — belongs to the App framework. Its parsers are a table
 * (serviceConnections.ts) that a main hands to `loadConfig`: the sections a binary owns are the ones it passes, and
 * an entry of a kind it does not pass is refused there. The file stays one file; the engine neither knows those
 * sections' shapes nor imports their parsers.
 *
 * A kind's config type is added to `ServiceKinds` by declaration merging from the module that registers it, so
 * `ServiceConfig` is the union of the kinds the program has, and a reader of `Registry.serviceConfigs()` sees all of
 * them without the engine naming one.
 */

/** Kind → the shape of its entry once checked. A registering module adds its own kinds with `declare module`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ServiceKinds {}
export type ServiceKind = keyof ServiceKinds & string;
export type ServiceConfig = ServiceKinds[keyof ServiceKinds];

/** How one kind of service entry is read, checked and written back. */
interface ServiceKindSpec {
  /** Found by its issuer or by this server itself, so its entry may leave out "url". */
  urlless?: boolean;
  /** What a deployment has one of, in a sentence ("email service"): a second entry of the kind is refused. */
  singleton?: string;
  /** The entry, checked. Throws naming the field: a config someone wrote is refused rather than half-read. */
  parse(entry: Record<string, unknown>, path: string): ServiceConfig;
  /** The entry as written, for saving: the references stay references. */
  entry(service: never): Record<string, unknown>;
}

/** The sections of a config file a binary owns: its service kinds, the checks across them, its top-level keys. */
export interface ConfigSections {
  kinds: Readonly<Record<string, ServiceKindSpec>>;
  /** A check across every service the file names, run once they are all read (a scim directory names its providers). */
  checks: ReadonlyArray<(services: readonly ServiceConfig[], path: string) => void>;
  /** Top-level keys of the file other than `connections`; each parser gets the value and the file's path. */
  top: Readonly<Record<string, (value: unknown, path: string) => unknown>>;
  /**
   * What becomes of an entry of a kind these sections do not name. Absent, it is refused. `'keep'` is the
   * database browser's (cli/browserCommands.ts): the one file is shared with the App framework, whose services
   * the browser neither reads nor serves, so their entries are kept as written, unread, and a save writes them
   * back where they were.
   */
  others?: 'keep';
}

/** Sections side by side; the kinds and keys of a later part win, its checks follow. */
export function mergeSections(...parts: ConfigSections[]): ConfigSections {
  return {
    kinds: Object.assign({}, ...parts.map((p) => p.kinds)),
    checks: parts.flatMap((p) => p.checks),
    top: Object.assign({}, ...parts.map((p) => p.top)),
  };
}

/** Whether `sections` keep this entry unread: a kind they do not name, which another reader of the file does. */
export const keptUnread = (sections: ConfigSections, kind: unknown): boolean =>
  sections.others === 'keep' && typeof kind === 'string' && kind !== 'http' && !Object.hasOwn(sections.kinds, kind);

export const isServiceKind = (sections: ConfigSections, kind: unknown): kind is ServiceKind =>
  typeof kind === 'string' && Object.hasOwn(sections.kinds, kind);

/** Whether an entry of this kind is found by something other than a url. */
export const isUrlless = (sections: ConfigSections, kind: unknown): boolean =>
  typeof kind === 'string' && sections.kinds[kind]?.urlless === true;

/** How a refusal names an entry: the file and the connection. */
export const serviceWhere = (entry: Record<string, unknown>, path: string): string => `${path}: connection "${String(entry.name)}"`;

export function serviceConnectionOf(sections: ConfigSections, entry: Record<string, unknown>, path: string): ServiceConfig {
  return sections.kinds[entry.kind as string]!.parse(entry, path);
}

export function serviceEntry(sections: ConfigSections, service: ServiceConfig): Record<string, unknown> {
  return sections.kinds[service.kind]!.entry(service as never);
}

/** At most one of a singleton kind, then each check. */
export function checkServices(sections: ConfigSections, services: readonly ServiceConfig[], path: string): void {
  for (const [kind, spec] of Object.entries(sections.kinds)) {
    if (!spec.singleton) continue;
    const named = services.filter((service) => service.kind === kind);
    if (named.length > 1) {
      throw new Error(
        `${path} names ${named.length} ${kind} connections (${named.map((c) => `"${c.name}"`).join(', ')}); a deployment has one ${spec.singleton}.`,
      );
    }
  }
  for (const check of sections.checks) check(services, path);
}

/** The top-level keys the file has, parsed. */
export function parseConfigSections(sections: ConfigSections, parsed: unknown, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(sections.top)) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = parse(value, path);
  }
  return out;
}

/* ---- what a plain url-and-auth service (a cache, a search engine) shares ---- */

export const SHARED_SERVICE_KEYS = ['name', 'kind', 'url', 'auth', 'insecure', 'allowLinkLocal'];

/** Refuse a key the kind does not take, and a flag that is not a boolean. */
export function checkServiceKeys(entry: Record<string, unknown>, kind: string, keys: readonly string[], where: string): void {
  const stray = Object.keys(entry).find((key) => !keys.includes(key));
  if (stray) {
    throw new Error(`${where} is a ${kind} connection, which takes no "${stray}". It takes: ${keys.join(', ')}.`);
  }
  for (const flag of ['insecure', 'allowLinkLocal'] as const) {
    if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
      throw new Error(`${where} has "${flag}": ${JSON.stringify(entry[flag])}. It must be true or false, without quotes.`);
    }
  }
}
