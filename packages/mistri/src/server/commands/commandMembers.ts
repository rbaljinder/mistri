/**
 * A member of the team as a command's input names one (`field.member()`, a text of format `member`): an account id
 * the form picked from the team's names (/api/team, tenantTeamRoute.ts). The shape is the shared reader's; whether
 * the account is an active member of the command's tenant is judged here, on the server, for every door alike — a
 * form, a page's `run`, the test kit, the App API and MCP all reach the executor — so an id the form never offered
 * (another tenant's member, one removed since, one typed into a crafted request) is refused at its field.
 *
 * Who is a member is the binding's to say (`AuthorizedBusinessCommand.members`): a tenant App's signed-in binding reads
 * each id's membership of the request's own tenant (tenantRequestRuntime.ts). A binding that cannot say — an ordinary
 * App, which `check` refuses the field in, a public door, a platform command — refuses every id: never admitted for
 * want of a reader.
 */
import type { AppCommandField } from '../../shared/command.js';
import type { AnyBusinessCommand } from './businessCommands.js';

/** The sentence a refused id is said with, at its field. */
const NOT_A_MEMBER = 'This is not a member of the team.';

/** Who of these accounts is an active member of the command's tenant. */
export type CommandMembers = (accountIds: readonly string[]) => Promise<ReadonlySet<string>>;

/** The command's inputs that name a member of the team: at the input's top level (shared/command.ts keeps them there). */
const memberInputs = (fields: readonly AppCommandField[]): AppCommandField[] =>
  fields.filter((field) => field.type === 'text' && field.format === 'member');

/**
 * The first input whose account is not an active member, by its path and the sentence it is refused with; undefined
 * when every one given is. Asked where the command's other picks are judged, after its receipt is looked for, so a
 * replay answers as it did; the membership is the tenant store's, read beside the transaction, not a row it holds.
 */
export async function memberBreak(
  command: AnyBusinessCommand,
  input: unknown,
  members: CommandMembers | undefined,
): Promise<{ path: string; reason: string } | undefined> {
  const named = memberInputs(command.fields);
  if (!named.length) return undefined;
  const given = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const asked = named.flatMap((field) => {
    const value = given[field.name];
    return typeof value === 'string' && value !== '' ? [{ path: field.name, id: value }] : [];
  });
  if (!asked.length) return undefined;
  let found: ReadonlySet<string>;
  try {
    found = members ? await members([...new Set(asked.map((each) => each.id))]) : new Set();
  } catch {
    // A membership that could not be read admits nobody.
    found = new Set();
  }
  const refused = asked.find((each) => !found.has(each.id));
  return refused ? { path: refused.path, reason: NOT_A_MEMBER } : undefined;
}
