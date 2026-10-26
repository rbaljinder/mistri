/**
 * A test's App with its commands resolved the way loading an App resolves
 * them. A deployment's App names each command and its commands module
 * registers it (appCommandCatalog, from `defineCommands`); a test's App
 * literal keeps each command's contract inline instead — `command: { id,
 * target, targets, realm, input }` — so this lifts those contracts into the
 * catalog and leaves the names behind, and parseAppConfig resolves them as it
 * would from the module. A contract without a target is a form's command.
 */
import { parseAppConfig, type AppDef } from '../../packages/mistri/src/shared/app.js';
import { parseAppApi } from '../../packages/mistri/src/shared/appApi.js';
import { withCommandCatalog, type CommandCatalog, type CommandCatalogEntry } from '../../packages/mistri/src/shared/command.js';
import { parseCommandInput } from '../../packages/mistri/src/shared/commandInputParse.js';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function contract(raw: Raw, publicForm: boolean): CommandCatalogEntry {
  const target = raw.target as string | undefined;
  return Object.freeze({
    version: typeof raw.version === 'number' ? raw.version : 1,
    target: target ?? '',
    targets: target === undefined ? 'none' : ((raw.targets as 'one' | 'many' | undefined) ?? 'one'),
    ...(raw.realm === undefined ? {} : { realm: raw.realm as 'tenant' | 'platform' }),
    ...(publicForm ? { public: true as const } : {}),
    ...(typeof raw.when === 'string' ? { when: raw.when } : {}),
    input: parseCommandInput(raw.input ?? {}, `command "${String(raw.id)}"`, { publicForm }),
  });
}

/** The literal with each inline command contract replaced by its name, and the catalog they make. */
export function namedCommands<T>(raw: T): { app: T; commands: Map<string, CommandCatalogEntry> } {
  const commands = new Map<string, CommandCatalogEntry>();
  const name = (value: unknown, publicForm: boolean): unknown => {
    if (!isRecord(value) || typeof value.id !== 'string') return value;
    if (!commands.has(value.id)) commands.set(value.id, contract(value, publicForm));
    return value.id;
  };
  const walk = (node: unknown, publicForm: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, publicForm));
    if (!isRecord(node)) return node;
    const form = node.kind === 'form' ? node.public === true : publicForm;
    const out: Raw = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
      // An accessor is the parser's to refuse, never ours to invoke.
      if (!('value' in descriptor) || !descriptor.enumerable) {
        Object.defineProperty(out, key, descriptor);
        continue;
      }
      const value = descriptor.value;
      if (key === 'command') out[key] = name(value, form);
      /* An API exposure lists a contract bare, or `{ command, label }`. */
      else if (key === 'commands' && Array.isArray(value) && value.some((item) => isRecord(item) && typeof item.id === 'string')) {
        out[key] = value.map((item) => (isRecord(item) && typeof item.id === 'string' ? name(item, false) : walk(item, form)));
      } else out[key] = walk(value, form);
    }
    return out;
  };
  return { app: walk(raw, false) as T, commands };
}

/** parseAppConfig over a test's literal, its inline command contracts — and any `contracts` beside it, for an App that
    names its commands — resolved as a commands module resolves names. */
export function parseTestApp(raw: unknown, where: string, contracts: Record<string, Raw> = {}): AppDef {
  const { app, commands } = namedCommands(raw);
  const lifted = commands.size > 0;
  for (const [id, entry] of catalogOf(contracts)) commands.set(id, entry);
  // A literal with nothing inline is parsed as written: its getters, symbols and hidden keys are the parser's to refuse.
  return parseAppConfig(lifted ? app : raw, where, commands.size ? { commands } : {});
}

/** parseAppApi over a test's api block, its inline command contracts resolved as parseTestApp resolves an App's. */
export function parseTestApi(raw: unknown, roles: readonly string[], where?: string): ReturnType<typeof parseAppApi> {
  const { app, commands } = namedCommands(raw);
  // Names alone resolve from the catalog the caller set (withCommandCatalog), as an App's do.
  return commands.size ? withCommandCatalog(commands, () => parseAppApi(app, roles, where)) : parseAppApi(raw, roles, where);
}

/** A catalog from contracts written as a test's command objects: `{ refresh: {}, qualify: { target: 'lead' } }`. */
export function catalogOf(contracts: Record<string, Raw>): CommandCatalog {
  return new Map(Object.entries(contracts).map(([id, raw]) => [id, contract({ id, ...raw }, raw.public === true)]));
}
