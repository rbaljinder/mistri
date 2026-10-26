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

async function prepare(owner: CommandOwner): Promise<number> {
  const prepared = await api('/api/commands/prepare', {
    ...ownedBy(owner.connection),
    command: owner.command,
    commandVersion: owner.commandVersion,
    key: owner.key,
  });
  if (!Number.isSafeInteger(prepared?.expectedVersion) || prepared.expectedVersion < 0)
    throw new Error(say('common.theRecordVersionIsUnavailable'));
  return prepared.expectedVersion as number;
}

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
  options: { headless: boolean; current?: () => boolean; refresh: () => void },
): Promise<CommandSent> {
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
