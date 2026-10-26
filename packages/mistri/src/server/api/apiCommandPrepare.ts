/** A token owner prepares through the same authorized reader as execution.
 * The revision is never reconstructed from the API's projected fields. */
import type { BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import type { BusinessCommandActor } from '../commands/businessCommands.js';
import { BusinessCommandExecutionError } from '../commands/commandErrors.js';
import { parseCommandPrepareTargets } from '../commands/commandPayload.js';
import { readPreparedRecord, withPreparedAhead } from '../commands/commandPrepare.js';
import type { CommandFlags } from '../commands/commandFlags.js';

export async function prepareApiCommand(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  body: unknown,
  signal?: AbortSignal,
  flags?: CommandFlags,
) {
  const request = parseCommandPrepareTargets(body);
  const authorized = binding.authorize(request.command, actor);
  if (request.commandVersion !== authorized.command.version) throw new BusinessCommandExecutionError('command_version_mismatch', 'unknown');
  if (request.multi || authorized.command.targets === 'none') throw new BusinessCommandExecutionError('invalid_input');
  const [key] = request.keys;
  if (authorized.keyColumns.length !== Object.keys(key).length || authorized.keyColumns.some((column) => !Object.hasOwn(key, column)))
    throw new BusinessCommandExecutionError('invalid_input');
  return withPreparedAhead(authorized.command, authorized.catalog, key, () =>
    authorized.transaction((records) =>
      readPreparedRecord(records, {
        command: authorized.command,
        commandId: request.command,
        actor: authorized.actor,
        key,
        catalog: authorized.catalog,
        ...(authorized.people ? { people: authorized.people } : {}),
        signal,
        flags,
        beforeInitial: () => authorized.assertTarget?.(records, key) ?? Promise.resolve(),
      }),
    ),
  );
}

/** Only the revision leaves preparation; no row or handler prefill is exposed. */
export function apiCommandPreparation(value: unknown) {
  const version = (value as { expectedVersion?: unknown } | null)?.expectedVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER)
    throw new BusinessCommandExecutionError('invalid_result');
  return { status: 200, headers: { etag: `"${version}"` }, value: { version } };
}
