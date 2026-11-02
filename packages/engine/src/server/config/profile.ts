/**
 * The project profile (docs/bootstrap-plan.md, Part B): the `app` block of `mistri.json`, which names the App and
 * the modules that carry its authority once, and the one rule every App command finds that file by.
 *
 * ```json
 * { "app": { "dir": ".", "commands": "commands.ts", "jobs": "jobs.ts", "policy": "policy.ts" }, "connections": [...] }
 * ```
 *
 * The order is fixed and printed: `--config`, then the App's own `<--app dir>/mistri.json`, then `./mistri.json`
 * and `./.mistri.json`, then the person's own file. No walking up. Without `--app`, the found file's `app.dir`
 * names the App. A flag beats the profile, and the profile beats the `commands.ts` convention; there is no
 * environment layer, since the environment is for secrets. A field report found `dev scratch` and
 * `check --app scratch` reading different files, and `--policy` repeated on every command of a tenant App.
 *
 * The block takes paths and nothing else: a `${NAME}` reference, a key it does not know, or a file that is not
 * there is refused by name. It is not a second App definition: it names modules and defines nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { configFileName, product } from '../product.js';

/** An entry the block may name, and the flag it stands for. */
const PROFILE_ENTRIES = { commands: '--commands', jobs: '--jobs', policy: '--policy', entry: '--app-entry' } as const;
type ProfileEntry = keyof typeof PROFILE_ENTRIES;
const PROFILE_KEYS = ['dir', ...Object.keys(PROFILE_ENTRIES)] as const;

/** Where an entry came from: a flag, the profile, the `commands.ts` beside the App, or the build that bundled it. */
type EntryFrom = 'flag' | 'profile' | 'convention' | 'build';

/** Why the config file is the one read. */
type ConfigFrom = 'flag' | 'app' | 'cwd' | 'user';

/** The `app` block, its paths resolved from the file's folder. */
interface ProjectProfile {
  readonly file: string;
  readonly dir?: string;
  readonly commands?: string;
  readonly jobs?: string;
  readonly policy?: string;
  readonly entry?: string;
}

/** What a run resolved, said before anything else and carried in `--json` as `context`. */
interface ProjectContext {
  readonly config?: { readonly path: string; readonly from: ConfigFrom };
  readonly app?: { readonly path: string; readonly from: 'flag' | 'profile' };
  readonly entries: Partial<Record<ProfileEntry, { readonly path: string; readonly from: 'flag' | 'profile' }>>;
  /** Where a flag overrode the profile: what the profile said. */
  readonly over: Partial<Record<ProfileEntry | 'dir', string>>;
}

/** A profile that cannot be used: refused before anything is read. */
export class ProfileRefusal extends Error {}

/** What an App command takes of the profile: the App, and which entries. */
export interface ProfileTakes {
  readonly entries: readonly ProfileEntry[];
  /** `dev` also takes the App as its first word. */
  readonly positional?: boolean;
  /** The command prints the context in its own output and `--json` (check, migrate); another says it on stderr. */
  readonly says?: boolean;
  /** False where the command reads no App (`migrate diff` reads schema.sql and the config's connection). */
  readonly app?: boolean;
}

const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') || isAbsolute(near) ? path : near;
};

/**
 * The config file a run reads, by the one order: `--config`, the App's own, the working directory's, the person's
 * own. Undefined when there is none (a run on a database named by `--db`).
 */
export function findConfig(
  given: { explicit?: string; app?: string },
  env: NodeJS.ProcessEnv = process.env,
): { path: string; from: ConfigFrom } | undefined {
  if (given.explicit !== undefined) return { path: resolve(given.explicit), from: 'flag' };
  const name = configFileName();
  if (given.app !== undefined && existsSync(join(resolve(given.app), name))) return { path: join(resolve(given.app), name), from: 'app' };
  for (const path of [join(process.cwd(), name), join(process.cwd(), `.${name}`)]) if (existsSync(path)) return { path, from: 'cwd' };
  const user = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), product(), 'connections.json');
  return existsSync(user) ? { path: user, from: 'user' } : undefined;
}

/** The `app` block of `file`, checked; undefined when the file has none. Throws a ProfileRefusal naming what is wrong. */
export function readProfile(file: string): ProjectProfile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* A file that does not parse is the config reader's to refuse, with its own words. */
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || !('app' in parsed)) return undefined;
  const block = (parsed as { app: unknown; apps?: unknown }).app;
  const at = shown(file);
  if ((parsed as { apps?: unknown }).apps !== undefined)
    throw new ProfileRefusal(
      `${at} has both "app" and "apps": "app" names the one App this project is, "apps" lists the Apps one server serves. Keep one.`,
    );
  if (!block || typeof block !== 'object' || Array.isArray(block))
    throw new ProfileRefusal(`${at}: "app" is an object of paths, like { "dir": ".", "jobs": "jobs.ts" }.`);
  const unknown = Object.keys(block).filter((key) => !(PROFILE_KEYS as readonly string[]).includes(key));
  if (unknown.length)
    throw new ProfileRefusal(
      `${at}: app.${unknown[0]} is not a key of the app block. It takes ${PROFILE_KEYS.slice(0, -1).join(', ')} and ${PROFILE_KEYS.at(-1)}: the App and the modules that carry its authority. Ports, mounts and looks stay as flags.`,
    );
  const folder = dirname(file);
  const profile: { -readonly [K in keyof ProjectProfile]: ProjectProfile[K] } = { file };
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value.trim()) throw new ProfileRefusal(`${at}: app.${key} is a path, relative to ${at}'s folder.`);
    if (/\$\{|\$[A-Z_]/.test(value))
      throw new ProfileRefusal(
        `${at}: app.${key} names ${JSON.stringify(value)}. The app block takes paths only: a secret or a value that differs per machine stays in the environment.`,
      );
    const path = resolve(folder, value);
    if (!existsSync(path))
      throw new ProfileRefusal(`${at}: app.${key} names ${value}, which is not there (${shown(path)}, from ${shown(folder)}).`);
    profile[key as keyof ProjectProfile] = path;
  }
  return profile;
}

let resolved: ProjectContext | undefined;
let said = false;

/**
 * Whether the context is still to be said: true once a run, so a check `migrate up --app` runs inside it does not
 * say it again after the migrate run said it first.
 */
export function claimContext(): boolean {
  if (said) return false;
  said = true;
  return true;
}

/** The context the run's profile step resolved (applyProfile), for the command to print. */
export const projectContext = (): ProjectContext | undefined => resolved;

/** Value of a flag in argv (`--flag value`), and every index it is at. */
function flagged(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  return values;
}

/**
 * The run's arguments with the profile applied under them: the App when no `--app` names one, each entry the
 * command takes that no flag names, and `--config` pinned where the file found is not the one a plain read would
 * find (the App's own `mistri.json`), so the run and any child it starts read the same file. Records the context.
 * Throws a ProfileRefusal for a block that cannot be used.
 */
export function applyProfile(argv: readonly string[], takes: ProfileTakes, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [...argv];
  if (out.includes('--no-config') || out.includes('--help') || out.includes('-h')) {
    resolved = undefined;
    return out;
  }
  /* A suite's Apps are the suite's to name (`migrate stores up --suite`): the profile's one App is not added to it. */
  const suite = out.includes('--suite');
  const apps = flagged(out, '--app');
  const positional = takes.positional && out[0] !== undefined && !out[0].startsWith('-') ? out[0] : undefined;
  const named = apps.length === 1 ? apps[0] : positional;
  const explicit = flagged(out, '--config').at(-1);
  const naming = out.includes('--db') || out.includes('-d');
  const found =
    naming && explicit === undefined
      ? undefined
      : findConfig({ ...(explicit !== undefined ? { explicit } : {}), ...(named !== undefined ? { app: named } : {}) }, env);
  /* The person's own file names connections; a project's profile is a project's, so it is never read from there. */
  const profile = found && found.from !== 'user' ? readProfile(found.path) : undefined;
  const over: Partial<Record<ProfileEntry | 'dir', string>> = {};
  let app: ProjectContext['app'];
  if (apps.length > 1) app = undefined;
  else if (named !== undefined) {
    app = { path: resolve(named), from: 'flag' };
    if (profile?.dir !== undefined && resolve(named) !== profile.dir) over.dir = profile.dir;
  } else if (profile?.dir !== undefined && !suite && takes.app !== false) {
    app = { path: profile.dir, from: 'profile' };
    out.push('--app', shown(profile.dir));
  }
  const entries: ProjectContext['entries'] = {};
  if (apps.length <= 1 && !suite && takes.app !== false)
    for (const entry of takes.entries) {
      const flag = PROFILE_ENTRIES[entry];
      const given = flagged(out, flag).at(-1);
      const said = profile?.[entry];
      if (given !== undefined) {
        entries[entry] = { path: resolve(given), from: 'flag' };
        if (said !== undefined && resolve(given) !== said) over[entry] = said;
      } else if (said !== undefined) {
        entries[entry] = { path: said, from: 'profile' };
        out.push(flag, shown(said));
      }
    }
  /* The App's own file is not one a plain read finds (engine config/locations.ts reads the working directory's):
     named, so this run and the children it starts read it. */
  if (found?.from === 'app' && explicit === undefined) out.push('--config', shown(found.path));
  resolved = { ...(found ? { config: found } : {}), ...(app ? { app } : {}), entries, over };
  said = false;
  return out;
}

/** Whether the profile, or the App's own mistri.json, decided any of the run's context: then the run says it. */
export function fromProfile(context: ProjectContext | undefined): boolean {
  return (
    context !== undefined &&
    (context.config?.from === 'app' ||
      context.app?.from === 'profile' ||
      Object.values(context.entries).some((entry) => entry.from === 'profile') ||
      Object.keys(context.over).length > 0)
  );
}

/**
 * The entries the App itself says, where neither a flag nor the profile named one: the `commands.ts` beside its
 * manifest (convention), or a build's own bundles (build).
 */
export function appEntries(
  app: {
    readonly build?: { readonly entries: Partial<Record<'commands' | 'jobs' | 'policy', string>> };
    readonly commands?: { readonly file: string };
  },
  given: Partial<Record<'commands' | 'jobs' | 'policy', string | undefined>>,
): Partial<Record<ProfileEntry, { path: string; from: EntryFrom }>> {
  const more: Partial<Record<ProfileEntry, { path: string; from: EntryFrom }>> = {};
  if (app.build) {
    for (const kind of ['commands', 'jobs', 'policy'] as const) {
      const own = app.build.entries[kind];
      if (own && given[kind] === undefined) more[kind] = { path: own, from: 'build' };
    }
    return more;
  }
  if (given.commands === undefined && app.commands) more.commands = { path: app.commands.file, from: 'convention' };
  return more;
}

/**
 * The context as the run prints it, one line an entry: where it came from, and a flag that overrode the profile.
 * `convention` and `build` are the App's to say (the loaded App's commands.ts beside it, a build's own bundles).
 */
export function contextLines(
  context: ProjectContext | undefined,
  more: Partial<Record<ProfileEntry, { path: string; from: EntryFrom }>> = {},
): string[] {
  if (!context) return [];
  const where = context.config
    ? `${shown(context.config.path)} (${{ flag: '--config', app: 'beside the App', cwd: 'the working directory', user: "the person's own" }[context.config.from]})`
    : 'no config file';
  const lines = [`Context: ${where}`];
  const row = (key: string, path: string | undefined, from: string) => lines.push(`  ${key.padEnd(9)} ${(path ?? '—').padEnd(13)} ${from}`);
  if (context.app) row('app', shown(context.app.path), context.app.from === 'profile' ? 'mistri.json' : over(context, 'dir', 'flag'));
  for (const entry of ['commands', 'jobs', 'policy', 'entry'] as const) {
    const own = context.entries[entry] ?? more[entry];
    if (!own) {
      /* Not named by a flag or the profile: the App may still say it (its commands.ts), where the run reads that. */
      if (entry !== 'entry') row(entry, undefined, 'not named');
      continue;
    }
    row(entry, shown(own.path), own.from === 'profile' ? 'mistri.json' : own.from === 'flag' ? over(context, entry, 'flag') : own.from);
  }
  return lines;
}

function over(context: ProjectContext, key: ProfileEntry | 'dir', from: string): string {
  const said = context.over[key];
  return said !== undefined ? `${from}, over mistri.json's ${shown(said)}` : from;
}

/** The context as `--json` carries it: `{ config, app, entries: { commands|jobs|policy|entry: { path, from } | null } }`. */
export function contextJson(
  context: ProjectContext | undefined,
  more: Partial<Record<ProfileEntry, { path: string; from: EntryFrom }>> = {},
): {
  config: { path: string; from: ConfigFrom } | null;
  app: { path: string; from: string } | null;
  entries: Record<ProfileEntry, { path: string; from: EntryFrom; over?: string } | null>;
} {
  const entry = (key: ProfileEntry) => {
    const own = context?.entries[key] ?? more[key];
    if (!own) return null;
    const said = context?.over[key];
    return { path: own.path, from: own.from, ...(said !== undefined ? { over: said } : {}) };
  };
  return {
    config: context?.config ?? null,
    app: context?.app ?? null,
    entries: { commands: entry('commands'), jobs: entry('jobs'), policy: entry('policy'), entry: entry('entry') },
  };
}
