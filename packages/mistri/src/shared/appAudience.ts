/**
 * Who a screen is drawn for. An App's own public (a signed-out visitor, a customer, a patient, a resident) came for
 * their own things and has no use for the office's tools: the global search, an empty bell, the look picker, a list's
 * view switch, its column chooser or a record's pager. One rule says who that is, and every part that offers one of
 * those asks it, so a portal is never the office's App with the menu taken away.
 *
 * A reader is a person where the App signs people in and they have not, or where every role they hold says
 * `portal: true`. Holding one office role beside it makes them the office: the larger set of tools is the safe one
 * for someone who works there.
 */
import type { AppAuth } from './appModel.js';

export function viewerAudience(
  auth: Pick<AppAuth, 'roles'> | undefined,
  viewer: { signedIn: boolean; roles: readonly string[] },
): 'person' | undefined {
  if (!auth) return undefined;
  if (!viewer.signedIn) return 'person';
  const held = viewer.roles.map((role) => auth.roles?.[role]);
  return held.length > 0 && held.every((grant) => grant?.portal === true) ? 'person' : undefined;
}
