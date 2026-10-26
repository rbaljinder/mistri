/** Request-owner helpers. Kept separate from the handler's small flags type. */
import { commandFlagsReader, type CaptureCommandFlags, type CommandFlags } from './commandFlags.js';
import type { BusinessCommandActor } from './businessCommands.js';
import type { BusinessCommandBinding } from './businessCommandAccess.js';
import { CommandInputError, parseCommandEnvelope } from './commandPayload.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { BusinessCommandExecutionError, forbiddenBy } from './commandErrors.js';

/** Captures callback identity now; callers invoke only after admission. A
 * rejected capture is retained too, never retried within this request. */
export function commandFlagsOnce(capture: () => ReturnType<CaptureCommandFlags>): () => Promise<CommandFlags> {
  let pending: Promise<CommandFlags> | undefined;
  return () => (pending ??= Promise.resolve().then(capture).then(commandFlagsReader));
}

/** Convenience owners still authorize the envelope before invoking their
 * host hook. The executor repeats authorization at its ordinary boundary. */
export async function authorizedCommandFlags(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  body: unknown,
  capture: (actor: BusinessCommandActor) => Promise<CommandFlags>,
  statusOnly = false,
): Promise<CommandFlags> {
  try {
    const request = parseCommandEnvelope(body, { creating: (id) => actor.kind === 'public' || binding.creates?.(id) === true });
    return await capture(binding.authorize(request.command, actor).actor);
  } catch (error) {
    const outcome = statusOnly || binding.scoped ? 'unknown' : 'not_applied';
    if (error instanceof AppAccessDenied) throw forbiddenBy(error, outcome);
    if (error instanceof CommandInputError) throw new BusinessCommandExecutionError('invalid_input', outcome, error.field);
    throw error;
  }
}
