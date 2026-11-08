import { api } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';

/**
 * A step of a command's form checked by the server (`/api/commands/check`): the same reader, `when`s and rules the run
 * uses, over the fields asked so far, nothing run. A check that cannot be asked — a host with none, the budget spent,
 * offline — is no word: the step goes on and the submission is judged whole.
 */
export async function checkCommandStep(
  connection: string | null,
  command: { readonly id: string; readonly version: number },
  names: readonly string[],
  input: unknown,
): Promise<Record<string, string> | undefined> {
  try {
    const result = (await api(COMMAND_ROUTES.check, {
      ...ownedBy(connection),
      command: command.id,
      commandVersion: command.version,
      fields: [...names],
      input,
    })) as { problems?: unknown } | undefined;
    const problems = result?.problems && typeof result.problems === 'object' ? (result.problems as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(problems).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return undefined;
  }
}
