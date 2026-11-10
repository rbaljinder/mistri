/**
 * A record's command sent without its form, as the form's submit would send it: prepared for the record's revision,
 * started, and sent once. The prepare may already have been asked (`readyCommand`), when the pointer or focus came to
 * the button, so a click sends only the execute. Two callers, one path: a component's `run` (components/sdk/commands.tsx) and an action
 * whose command asks nothing, which runs on one click (components/Actions.tsx). What happens after —
 * a notice, the form opened over an answer that never arrived — is the caller's.
 */
import type { AppCommandAction } from '../shared/app.js';
import { api } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { commandOperations, type CommandOperation, type CommandOwner } from './commandState.js';
import { message as say } from '@mistriwork/kit/client/messages.js';

type CommandSent = { operation: CommandOperation } | { refused: string };

/* A revision asked ahead of the click is used for a short while. One the record has moved past is refused by the
   execute as `stale_record`, before any handler runs, and the click then prepares and sends once more, as it would
   have from the start; so a stale one costs a round trip, never a wrong write. */
const READY_MS = 10_000;
const ready = new Map<string, { at: number; version: Promise<number> }>();
const readyKey = (owner: CommandOwner) => JSON.stringify([owner.connection, owner.command, owner.commandVersion, owner.key]);

/**
 * The record's revision for this command, and the values its form would start from: what a page shows a person to
 * review (`useCommand(...).prepare`), and what every send is judged against.
 */
export async function prepareCommand(owner: CommandOwner): Promise<{ expectedVersion: number; initial?: Record<string, unknown> }> {
  const prepared = await api('/api/commands/prepare', {
    ...ownedBy(owner.connection),
    command: owner.command,
    commandVersion: owner.commandVersion,
    key: owner.key,
  });
  if (!Number.isSafeInteger(prepared?.expectedVersion) || prepared.expectedVersion < 0)
    throw new Error(say('common.theRecordVersionIsUnavailable'));
  const initial = prepared.initial && typeof prepared.initial === 'object' ? (prepared.initial as Record<string, unknown>) : undefined;
  return { expectedVersion: prepared.expectedVersion as number, ...(initial ? { initial } : {}) };
}

const prepare = async (owner: CommandOwner): Promise<number> => (await prepareCommand(owner)).expectedVersion;

/**
 * Ask the record's revision for a command that runs on one click, before the click: the pointer coming to its button,
 * or focus. Asked once while it is fresh; the click's `sendCommand` takes it, or the request still on its way.
 */
export function readyCommand(owner: CommandOwner): void {
  const key = readyKey(owner);
  const kept = ready.get(key);
  if (kept && Date.now() - kept.at < READY_MS) return;
  const version = prepare(owner);
  version.catch(() => {
    if (ready.get(key)?.version === version) ready.delete(key);
  });
  ready.set(key, { at: Date.now(), version });
}

export async function sendCommand(
  action: AppCommandAction,
  owner: CommandOwner,
  input: Record<string, unknown>,
  options: { headless: boolean; current?: () => boolean; refresh: () => void; pinned?: number },
): Promise<CommandSent> {
  /* A revision a person reviewed is sent as it is, once: a record that moved since is refused `stale_record`, and
     preparing again here would run the command over a revision nobody saw. */
  if (options.pinned !== undefined) {
    const sent = await execute(action, owner, input, options.pinned, options);
    if ('operation' in sent && sent.operation.phase === 'success') ready.clear();
    return sent;
  }
  const key = readyKey(owner);
  const kept = ready.get(key);
  ready.delete(key);
  const early = kept && Date.now() - kept.at < READY_MS ? kept.version : undefined;
  let expectedVersion: number;
  try {
    // One asked ahead that failed is asked again here, so its refusal is this click's own.
    expectedVersion = early ? await early.catch(() => prepare(owner)) : await prepare(owner);
  } catch (error) {
    return { refused: (error as Error).message };
  }
  const sent = await execute(action, owner, input, expectedVersion, options);
  if (early && 'operation' in sent && sent.operation.phase === 'error' && sent.operation.code === 'stale_record') {
    commandOperations.forget(owner);
    return sendCommand(action, owner, input, options);
  }
  // A command that ran moved its record, so no revision asked ahead still holds.
  if ('operation' in sent && sent.operation.phase === 'success') ready.clear();
  return sent;
}

async function execute(
  action: AppCommandAction,
  owner: CommandOwner,
  input: Record<string, unknown>,
  expectedVersion: number,
  { headless, current = () => true, refresh }: { headless: boolean; current?: () => boolean; refresh: () => void },
): Promise<CommandSent> {
  let operation: CommandOperation;
  try {
    operation = commandOperations.start(owner, expectedVersion, input, action, headless);
  } catch (error) {
    return { refused: (error as Error).message };
  }
  await commandOperations.send(
    operation,
    'execute',
    (path, envelope) => {
      if (path !== '/api/commands/execute' && path !== '/api/commands/status') throw new Error(say('common.invalidCommandPath'));
      if (!current()) throw Object.assign(new Error(say('common.thisCommandFormIsNoLonger')), { outcome: 'not_applied' });
      return api(path, { ...envelope, ...ownedBy(owner.connection) });
    },
    refresh,
  );
  return { operation };
}

/**
 * A sent command whose answer did not arrive, asked again by its receipt: the same frozen envelope, so the same
 * idempotency key, which the server answers from its journal and never runs a second time (businessCommandExecution.ts).
 */
export async function checkCommand(operation: CommandOperation, owner: CommandOwner, refresh: () => void): Promise<void> {
  await commandOperations.send(
    operation,
    'status',
    (path, envelope) => {
      if (path !== '/api/commands/execute' && path !== '/api/commands/status') throw new Error(say('common.invalidCommandPath'));
      return api(path, { ...envelope, ...ownedBy(owner.connection) });
    },
    refresh,
  );
}
