/**
 * A command's contract, and the version authority.lock keeps for it.
 *
 * Nobody writes a version. A command's contract — what it acts on, what it
 * asks, what it answers, the facts it records — is digested here, and the
 * lock keeps one line per command beside the App's authority:
 *
 *   contract convertLead v1 5f0c3a91d2e4
 *
 * The version keys what outlives a deploy: a receipt, a job's attempt, an API
 * route (`/v1`). Changing a contract is only a problem where something durable
 * depends on it — the App API or MCP publishes it, a job runs or waits on it,
 * or receipts it answered are kept — and then `mistri check` says so, and
 * `mistri check --bump <name>` moves it to the next version. Anywhere else
 * the new digest is simply written down, at the same version.
 *
 * The lines are the lock's, never its authority: the server does not refuse
 * to start over a digest (authorityDiff skips them), and mistri check judges
 * them here, where it knows the dependents.
 */
import { createHash } from 'node:crypto';
import { isFormView, isPublicCommandPage, logicalResource, type AppDef } from '../../shared/app.js';
import type { AppFormCommandReference, CommandCatalog } from '../../shared/command.js';
import { canonicalCommandJson } from './commandPayload.js';
import { describeShape } from './commandShapes.js';
import { commandEventContracts } from './businessEvents.js';
import {
  commandEventSlots,
  getCommandEvents,
  registeredInitial,
  type AnyBusinessCommand,
  type BusinessCommandRegistry,
} from './businessCommands.js';

/** A lock line's word: `contract <name> v<version> <digest>`. */
export const CONTRACT_PREFIX = 'contract ';
const LINE = /^contract ([A-Za-z][A-Za-z0-9_-]*) v([1-9][0-9]{0,8}) ([0-9a-f]{12})$/;

interface LockedContract {
  version: number;
  digest: string;
}

/** The contracts a lock records, by command name. A line it cannot read is left out, and then written again. */
export function lockedContracts(lock: string | undefined): Map<string, LockedContract> {
  const contracts = new Map<string, LockedContract>();
  for (const raw of (lock ?? '').split(/\r?\n/)) {
    const match = LINE.exec(raw.trim());
    if (match) contracts.set(match[1], { version: Number(match[2]), digest: match[3] });
  }
  return contracts;
}

/**
 * What a caller relies on, digested: the table and how many records a
 * request names, the input as parsed, the output's shape, and the events it
 * records. The handler's body, its footprint and its `when` are not the
 * caller's contract: they change freely.
 */
export function contractDigest(app: Pick<AppDef, 'sources'>, command: AnyBusinessCommand): string {
  const declaredEvents = getCommandEvents(command);
  const events = declaredEvents ? commandEventContracts(declaredEvents) : [];
  const contract = {
    target: logicalResource(app, command.source, command.target),
    targets: command.targets ?? 'one',
    ...(command.public ? { public: true } : {}),
    ...(command.realm ? { realm: command.realm } : {}),
    ...(command.enabledBy ? { enabledBy: command.enabledBy } : {}),
    input: command.fields,
    ...(command.rules?.length ? { rules: command.rules } : {}),
    output: describeShape(command.output),
    events,
    slots: [...commandEventSlots(command)],
  };
  return createHash('sha256')
    .update(canonicalCommandJson(contract, 1 << 22))
    .digest('hex')
    .slice(0, 12);
}

/** The catalog an App resolves its command names from: each registration's contract, as the browser is served it. */
export function appCommandCatalog(registry: BusinessCommandRegistry, app: Pick<AppDef, 'sources' | 'connection'>): CommandCatalog {
  /* Loading resolves names before parsing normalizes a sole source's default,
     or a root `connection` into the one source named for it. */
  const sources = Object.entries(app.sources ?? {});
  const implicit =
    sources.length === 1 && sources[0][1].default !== false && sources[0][1].realm !== 'platform'
      ? sources[0][0]
      : app.sources === undefined
        ? app.connection?.trim()
        : undefined;
  return new Map(
    Object.entries(registry).map(([id, command]) => [
      id,
      Object.freeze({
        version: command.version,
        target: command.source === implicit ? command.target : logicalResource(app, command.source, command.target),
        targets: command.targets ?? 'one',
        ...(command.realm === undefined ? {} : { realm: command.realm }),
        ...(command.public ? { public: true as const } : {}),
        ...(command.enabledBy ? { enabledBy: command.enabledBy } : {}),
        ...(command.when === undefined ? {} : { when: command.when }),
        input: command.fields,
        ...(command.rules?.length ? { rules: command.rules } : {}),
        ...(formPrepares(command) ? { prepares: true as const } : {}),
      }),
    ]),
  );
}

/* A signed-in form's command whose form prepares as it opens: over no record, only `initial` and the
   reader's `default: me` start anything, and questions defined in rows (G40) are read; a literal starts in the browser. */
const formPrepares = (command: AnyBusinessCommand): boolean =>
  command.targets === 'none' &&
  command.public !== true &&
  (registeredInitial(command) !== undefined ||
    command.fields.some(
      (field) =>
        field.type === 'defined' ||
        (field.type !== 'group' && typeof field.default === 'object' && 'auto' in field.default && field.default.auto === 'me'),
    ));

/**
 * The signed-in commands that name no record this reader is granted and no
 * signed-in form runs, as the browser is served a form's command, by id:
 * `useCommand` sends them, and draws their form, by name. A
 * public command runs only from its public form; a platform-realm one only
 * in its own realm, which `realm` names.
 */
export function unformedCommands(
  app: Pick<AppDef, 'views'>,
  registry: BusinessCommandRegistry | undefined,
  granted: (id: string, command: AnyBusinessCommand) => boolean,
  realm: 'tenant' | 'platform' = 'tenant',
): Record<string, AppFormCommandReference> {
  const formed = new Set(Object.values(app.views ?? {}).flatMap((view) => (isFormView(view) ? [view.command.id] : [])));
  const served: Record<string, AppFormCommandReference> = {};
  for (const [id, command] of Object.entries(registry ?? {})) {
    if (command.targets !== 'none' || command.public === true || (command.realm ?? 'tenant') !== realm || formed.has(id)) continue;
    if (!granted(id, command)) continue;
    served[id] = {
      id,
      version: command.version,
      ...(command.enabledBy ? { enabledBy: { flag: command.enabledBy.flag, is: command.enabledBy.is } } : {}),
      input: structuredClone(command.fields) as AppFormCommandReference['input'],
      ...(formPrepares(command) ? { prepares: true as const } : {}),
    };
  }
  return served;
}

/**
 * The public commands the public pages among `views` run (`definePage({ public: true, commands })`), as a form's
 * command is served: what a page's `useCommand` checks its input by before it sends it through the page's door.
 */
export function publicPageCommands(
  views: Readonly<Record<string, object>> | undefined,
  registry: BusinessCommandRegistry | undefined,
): Record<string, AppFormCommandReference> {
  const served: Record<string, AppFormCommandReference> = {};
  for (const view of Object.values(views ?? {})) {
    if (!isPublicCommandPage(view)) continue;
    for (const id of view.page.commands) {
      const command = registry && Object.hasOwn(registry, id) ? registry[id] : undefined;
      if (!command || command.public !== true || command.targets !== 'none' || served[id]) continue;
      served[id] = {
        id,
        version: command.version,
        input: structuredClone(command.fields) as AppFormCommandReference['input'],
        ...(command.rules?.length ? { rules: structuredClone(command.rules) as AppFormCommandReference['rules'] } : {}),
      };
    }
  }
  return served;
}

/** A command whose contract changed, and whether something durable depends on it. */
interface ContractChange {
  id: string;
  version: number;
  durable: readonly string[];
}

/**
 * The lock's contract lines for this registry: each command's recorded
 * version, and its digest now — except where the contract changed under a
 * durable dependent, whose old line stays until it is bumped, so accepting
 * the lock cannot quietly accept a breaking change. `bump` names the
 * commands `mistri check --bump` moves to their next version.
 */
export function contractLines(
  app: Pick<AppDef, 'sources'>,
  registry: BusinessCommandRegistry,
  lock: string | undefined,
  durable: (id: string) => readonly string[],
  bump: readonly string[] = [],
): { lines: string[]; changes: ContractChange[] } {
  const locked = lockedContracts(lock);
  const lines: string[] = [];
  const changes: ContractChange[] = [];
  for (const id of Object.keys(registry).sort()) {
    const digest = contractDigest(app, registry[id]);
    const before = locked.get(id);
    if (bump.includes(id)) {
      lines.push(`${CONTRACT_PREFIX}${id} v${(before?.version ?? 1) + (before ? 1 : 0)} ${digest}`);
      continue;
    }
    if (!before || before.digest === digest) {
      lines.push(`${CONTRACT_PREFIX}${id} v${before?.version ?? 1} ${digest}`);
      continue;
    }
    const on = durable(id);
    changes.push({ id, version: before.version, durable: on });
    lines.push(`${CONTRACT_PREFIX}${id} v${before.version} ${on.length ? before.digest : digest}`);
  }
  return { lines, changes };
}

/** The version the lock keeps for a command: 1 until one is bumped. */
export const lockedVersion = (lock: string | undefined) => {
  const locked = lockedContracts(lock);
  return (id: string): number | undefined => locked.get(id)?.version;
};
