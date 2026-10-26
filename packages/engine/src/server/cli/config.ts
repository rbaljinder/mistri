/**
 * The config file at startup: its connections and services into the
 * registry, and the sections beside them — views, saved SQL, pages, record
 * layouts and app directories — read once, as the connections are. A config
 * that exists but is wrong stops the start; a missing one is fine.
 */
import { startupReport } from '../../shared/refusal.js';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, type Registry } from '../connections.js';
import { configLocations } from '../config/locations.js';
import type { ConfigSections } from '../configSections.js';
import { parsePagesConfig, type PageDef } from '../../shared/page.js';
import { parseLayoutsConfig, type ConfigLayout } from '../../shared/recordview.js';
import { parseViewsConfig, type ViewDef } from '../../shared/view.js';
import { parseQueriesConfig, type SavedQuery } from '../../shared/sqlsaved.js';
import type { Options } from './args.js';
import { product } from '../product.js';

/**
 * A variable an App's definition may read, as an "apps" entry's `env` names it. The file is read here, for every
 * product; the App framework's own word for it (shared/appAuthority.ts `AppEnvName`) is this shape, read from here.
 */
interface ConfigEnvName {
  name: string;
  secret?: true;
}

/* A name that reads like a credential. What a definition reads of the
   environment can end up in what every browser is sent — a title, a link, a
   query — so a password is refused unless the operator says, in so many
   words, that the definition needs it. */
const SECRET_LOOKING = /PASS|SECRET|TOKEN|KEY|CREDENTIAL|DATABASE_URL|^PG/i;

/** One "apps" entry's `env`: names, or `{ "name": …, "secret": true }` for one that reads like a credential. */
export function parseAppEnv(raw: unknown, where: string): ConfigEnvName[] {
  if (!Array.isArray(raw)) throw new Error(`${where} "env" must be a list of environment variable names.`);
  const seen = new Set<string>();
  return raw.map((entry): ConfigEnvName => {
    const named =
      typeof entry === 'string' ? { name: entry } : entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const name = typeof named.name === 'string' ? named.name.trim() : '';
    const extra = Object.keys(named).filter((key) => key !== 'name' && key !== 'secret');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || extra.length || (named.secret !== undefined && named.secret !== true)) {
      throw new Error(`${where} "env" takes names ("REGION") or { "name": "API_KEY", "secret": true }, not ${JSON.stringify(entry)}.`);
    }
    if (seen.has(name)) throw new Error(`${where} "env" names ${name} twice.`);
    seen.add(name);
    if (SECRET_LOOKING.test(name) && named.secret !== true) {
      throw new Error(
        `${where} "env" names ${name}, which reads like a credential. Whatever the App's definition does with it can reach ` +
          `the browser; if the definition truly needs it, write { "name": "${name}", "secret": true }. See \`mistri docs secrets\`.`,
      );
    }
    return named.secret === true ? { name, secret: true } : { name };
  });
}

/** What a session keeps from its config file. */
export interface StartupConfig {
  /** The file this session's connections were read from, and written back to. */
  configPath?: string;
  /** The file as parsed and as text, so a tenant start can see it change under it. */
  loadedConfigSignature?: string;
  loadedConfigText?: string;
  /** Views predefined in the config file. Read once, at startup, like connections. */
  views: ViewDef[];
  /** SQL statements predefined in the config file, read from the same place. */
  queries: SavedQuery[];
  pages: PageDef[];
  layouts: ConfigLayout[];
  /** The "apps" directories, resolved against the config file's own location. */
  apps: string[];
  /** Said when DATABASE_URL was set and the config's own connections were used instead of it. */
  environmentTargetNote?: string;
  /** What each of those directories' definitions may read of the environment, by resolved directory. */
  appEnv: Record<string, ConfigEnvName[]>;
  /** `"mount": { "<app>": "/" | "/<segment>" }`, as written: where each App is served (shared/mount.ts). A `--mount` for the same App wins. */
  mount?: Record<string, string>;
  /** `"basePath": "/tools"`, as written; `--base-path` wins. */
  basePath?: string;
}

/**
 * Whether the config file a start would read names Apps: read raw, before anything is said of it, so the database
 * browser's main can hand a start that serves Apps to the App framework's without both reading the file aloud. The
 * file is the one `loadConfig` would read; one it cannot parse is left for that to refuse.
 */
export async function configNamesApps(opts: Pick<Options, 'config' | 'noConfig'>): Promise<boolean> {
  if (opts.noConfig) return false;
  for (const path of configLocations(opts.config)) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    try {
      return (JSON.parse(text) as { apps?: unknown } | null)?.apps !== undefined;
    } catch {
      return false;
    }
  }
  return false;
}

/** `sections` may be a promise's maker, so a start that reads no config file (`--no-config`) never loads them. */
export async function readStartupConfig(
  opts: Options,
  registry: Registry,
  given: ConfigSections | (() => Promise<ConfigSections>),
): Promise<StartupConfig> {
  const read: StartupConfig = { views: [], queries: [], pages: [], layouts: [], apps: [], appEnv: {} };
  if (opts.noConfig) return read;
  const sections = typeof given === 'function' ? await given() : given;
  try {
    const config = await loadConfig(opts.config, sections);
    if (config) {
      // Remembered so "Save" writes back to the file this session was
      // started from, rather than to whichever path happens to sort first.
      read.configPath = config.path;
      read.loadedConfigSignature = JSON.stringify(config);
      read.loadedConfigText = await readFile(config.path, 'utf8');
      for (const c of config.connections) {
        registry.add({
          name: c.name,
          // Located against the file already (loadConfig); the spelling is kept for a save.
          url: c.url,
          ...(c.writtenUrl !== undefined ? { writtenUrl: c.writtenUrl } : {}),
          schemas: c.schemas,
          // Opt in, per connection. Absent means read-only, which is the
          // right default for a file someone may have copied from a
          // colleague without reading every line of.
          writable: c.writable === true,
          /* Opt *out*, per connection: the default is a normal connection,
             and `"rows": false` is someone deciding this database's rows
             must not leave the process. */
          rows: c.rows === false ? false : undefined,
          // Columns never served over it, checked by loadConfig.
          ...(c.hidden ? { hidden: c.hidden } : {}),
          // A PostgreSQL reader count, checked by loadConfig.
          pool: c.pool,
          // Read replicas' URLs, checked by loadConfig.
          ...(c.replicas ? { replicas: c.replicas } : {}),
          // A direct URL for LISTEN behind a pooler, checked by loadConfig.
          ...(c.listen ? { listen: c.listen } : {}),
          // An API's base URL, description and auth, checked by loadConfig.
          http: c.http,
          // Where its migrations are (tablewalk migrate), checked by loadConfig.
          ...(c.migrations ? { migrations: c.migrations } : {}),
          source: 'config',
        });
      }
      // A cache and a search engine: services, not databases, opened when first used.
      registry.sections = sections;
      for (const service of config.services) registry.addService(service);
      for (const entry of config.kept ?? []) registry.keep(entry);
      const services = config.services.length ? `, plus ${config.services.map((s) => `${s.kind} "${s.name}"`).join(' and ')}` : '';
      console.log(`${product()}: ${config.connections.length} connection(s)${services} from ${config.path}`);
      /* DATABASE_URL is the default database of a start that names none. A
         config that lists connections names them — usually "${DATABASE_URL}"
         among them — and adding the variable as well opened the same database
         a second time under a second name. The config wins; said when the
         variable is not one of its connections, so nobody wonders which. */
      if (opts.targetFromEnvironment && config.connections.length) {
        opts.target = '';
        opts.targetFromEnvironment = false;
        if (!config.connections.some((c) => typeof c.url === 'string' && /\$(?:\{DATABASE_URL\}|DATABASE_URL(?!\w))/.test(c.url))) {
          read.environmentTargetNote =
            `DATABASE_URL is set, and ${config.path} names the connections, so it is not used; ` +
            'write "${DATABASE_URL}" as a connection\'s url to use it.';
          console.log(`${product()}: ${read.environmentTargetNote}`);
        }
      }
      /* Re-read rather than widening `loadConfig`'s return: connections are
         the file's reason to exist and views are a second, independent
         section of it. One extra read of a small file at startup buys the
         connection loader staying exactly as it was. */
      read.views = parseViewsConfig(JSON.parse(await readFile(config.path, 'utf8')) as unknown, config.path);
      if (read.views.length) {
        console.log(`${product()}: ${read.views.length} view(s) from ${config.path}`);
      }
      read.queries = parseQueriesConfig(JSON.parse(await readFile(config.path, 'utf8')) as unknown, config.path);
      if (read.queries.length) {
        console.log(`${product()}: ${read.queries.length} saved SQL statement(s) from ${config.path}`);
      }
      read.pages = parsePagesConfig(JSON.parse(await readFile(config.path, 'utf8')) as unknown, config.path);
      if (read.pages.length) {
        console.log(`${product()}: ${read.pages.length} page(s) from ${config.path}`);
      }
      read.layouts = parseLayoutsConfig(JSON.parse(await readFile(config.path, 'utf8')) as unknown, config.path);
      if (read.layouts.length) {
        console.log(`${product()}: ${read.layouts.length} record layout(s) from ${config.path}`);
      }
      /* "apps": [dir | { "dir": dir, "env": [name, …] }, …] — directories,
         resolved against the config file's own location: the file travels,
         and a path written next to it should keep pointing at the thing
         next to it. `env` is what that App's definition may read of the
         environment; nothing else reaches it (apps.ts, importFresh). */
      const rawApps = (JSON.parse(await readFile(config.path, 'utf8')) as { apps?: unknown }).apps;
      if (rawApps !== undefined) {
        const entries = Array.isArray(rawApps) ? rawApps : [undefined];
        read.apps = entries.map((entry, i) => {
          const dir =
            typeof entry === 'string'
              ? entry
              : entry && typeof entry === 'object' && !Array.isArray(entry)
                ? (entry as { dir?: unknown }).dir
                : undefined;
          const extra = entry && typeof entry === 'object' ? Object.keys(entry).filter((key) => key !== 'dir' && key !== 'env') : [];
          if (typeof dir !== 'string' || !dir.trim() || extra.length) {
            throw new Error(`${config.path}: "apps" must be a list of app directory paths, or { "dir": …, "env": [names] }.`);
          }
          const resolved = resolve(dirname(config.path), dir.trim());
          const env = (entry as { env?: unknown }).env;
          if (typeof entry === 'object' && env !== undefined) read.appEnv[resolved] = parseAppEnv(env, `${config.path}: apps[${i}]`);
          return resolved;
        });
      }
      /* Where the Apps are served, beside which Apps: a deployment's fact,
         checked with the flags' own rule once the Apps are loaded (main). */
      const { mount, basePath } = JSON.parse(await readFile(config.path, 'utf8')) as { mount?: unknown; basePath?: unknown };
      if (mount !== undefined) {
        if (!mount || typeof mount !== 'object' || Array.isArray(mount) || Object.values(mount).some((at) => typeof at !== 'string')) {
          throw new Error(`${config.path}: "mount" must name each App's place by its id, like { "main": "/", "billing": "/billing" }.`);
        }
        read.mount = mount as Record<string, string>;
      }
      if (basePath !== undefined) {
        if (typeof basePath !== 'string') throw new Error(`${config.path}: "basePath" must be a path, like "/tools".`);
        read.basePath = basePath;
      }
    }
  } catch (err) {
    // A config that exists but is wrong is reported, never skipped:
    // silently ignoring a file someone wrote is worse than refusing.
    console.error(`Config error: ${startupReport(err)}`);
    if (opts.embedded) throw err;
    process.exit(1);
  }
  return read;
}
