/**
 * A component's run of a command that names no record, and the key a run is
 * sent under: fetched when a component holds such a command (commands.tsx),
 * never on the App's first paint.
 */
import { api, state, toast } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { queryClient } from '@mistriwork/kit/client/components/mount.js';
import type { ServedForm as RoomForm } from '@mistriwork/kit/client/components/appRooms.js';
import type { AppPayloadApp } from '../../../shared/appPayload.js';
import { commandInput, prefilledCommandValues, readyToJudge, refusedFields, type CommandValues } from '../CommandFields.js';
import type { UiCommandOptions, UiCommandOutcome } from './context.js';
import { say } from '../../copy/components/components/sdk/formCommandRun.js';

type Served = { form: RoomForm<AppPayloadApp>; appName: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The key a run is sent under: the component's own attempt, a UUID, or a fresh one. */
export function attemptKey(options: UiCommandOptions | undefined): string {
  const given = options?.attempt;
  if (given === undefined) return crypto.randomUUID();
  if (typeof given !== 'string' || !UUID.test(given)) throw new TypeError(say('attemptIsAUuid'));
  return given.toLowerCase();
}

/**
 * A form's command run as its form's submit would: checked by the form's own
 * rules once the logic they need is here (an incomplete or invalid input opens
 * the form instead, filled with it), then sent once, with no record and so
 * nothing to prepare, under one key for this run (or the component's own
 * `attempt`). A refusal is said in the server's words; an answer that never
 * said whether it ran is `unknown`, and its `check()` sends the same run
 * again under the same key — the server answers a run it already has with
 * its receipt, so it never runs twice. A command that names no record has no
 * receipt to look up by its record (`/api/commands/status` asks one).
 */
export async function runFormCommand(
  served: Served,
  input: Readonly<Record<string, unknown>> | undefined,
  options: UiCommandOptions | undefined,
  openForm: (served: Served, input: Readonly<Record<string, unknown>> | undefined) => Promise<UiCommandOutcome>,
): Promise<UiCommandOutcome> {
  const fields = served.form.command.input;
  const key = attemptKey(options);
  // Judged as the form judges it: what a `when` hides is neither asked for nor sent.
  const judging = readyToJudge(fields);
  if (judging) await judging;
  let values: Record<string, unknown>;
  try {
    values = commandInput(fields, prefilledCommandValues(fields, input ?? {}));
  } catch {
    return openForm(served, input);
  }
  // As the form's own submit sends it (FormRoom.tsx): no record, so no key and no version to expect.
  const envelope = Object.freeze({
    command: served.form.command.id,
    commandVersion: served.form.command.version,
    key: {},
    expectedVersion: 0,
    idempotencyKey: key,
    input: values,
  });
  const named = (path: string | undefined, message: string) => refusedFields(path, message, fields, values as CommandValues);
  return sendFormCommand(served.form.label, envelope, sessionIdentity(), false, named, Boolean(options?.quiet));
}

async function sendFormCommand(
  label: string,
  envelope: Readonly<Record<string, unknown>>,
  identity: ReturnType<typeof sessionIdentity>,
  checking: boolean,
  named: (path: string | undefined, message: string) => Readonly<Record<string, string>> | undefined,
  /** The caller says the outcome (`quiet`): no toast. */
  quiet = false,
): Promise<UiCommandOutcome> {
  const check = (): Promise<UiCommandOutcome> => {
    // The key is the session's: under another account the same key is another run, so it is not asked there.
    if (sessionIdentity() !== identity) {
      const message = say('checkedElsewhere', { label });
      return Promise.resolve({ status: 'unknown', message, check });
    }
    return sendFormCommand(label, envelope, identity, true, named, quiet);
  };
  try {
    const sent = (await api('/api/commands/execute', { ...envelope, ...ownedBy(state.activeConnection ?? '') })) as {
      result?: unknown;
    } | null;
    void queryClient.invalidateQueries();
    return { status: 'applied', ...(sent?.result !== undefined ? { output: sent.result } : {}) };
  } catch (error) {
    const failure = error as Error & { outcome?: unknown; field?: unknown };
    // Only an answer that says nothing ran is a refusal; a lost or uncertain one is not known (commandState.ts settleFailure).
    if (failure.outcome === 'not_applied') {
      const message = failure.message || say('isNotSomethingYouCanDo', { label });
      if (!quiet) toast(message, 'error');
      const fields = named(typeof failure.field === 'string' ? failure.field : undefined, message);
      return { status: 'refused', message, ...(fields ? { fields } : {}) };
    }
    const message = say('notKnown', { label });
    if (!checking && !quiet) toast(message, 'error');
    return { status: 'unknown', message, check };
  }
}
