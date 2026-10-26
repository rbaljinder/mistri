/**
 * Which of a record's verbs is the one filled button, and the order of the
 * rest (docs/design.md, the record head): the verb the record most needs
 * next first and filled — the header's `primary` where it names one that is
 * shown now, else the first that takes nothing away — the others after it
 * in the author's order, and the destructive ones last and quiet. A record
 * whose only verbs are destructive has no filled button: the one it would
 * fill would end it.
 */
import type { AppAction } from '../../shared/appModel.js';

type ActionIntent = 'primary' | 'secondary' | 'quiet';

/** The verbs in the order they are drawn, each with how it is drawn. */
export function orderActions<A extends Pick<AppAction, 'id'>>(
  actions: readonly A[],
  destructive?: (action: A) => boolean,
  primary?: string,
): Array<{ action: A; intent: ActionIntent }> {
  const ends = (action: A) => Boolean(destructive?.(action));
  const lead =
    actions.find((action) => !ends(action) && primary !== undefined && action.id === primary) ?? actions.find((action) => !ends(action));
  const rest = actions.filter((action) => action !== lead);
  return [
    ...(lead ? [{ action: lead, intent: 'primary' as const }] : []),
    ...rest.filter((action) => !ends(action)).map((action) => ({ action, intent: 'secondary' as const })),
    ...rest.filter(ends).map((action) => ({ action, intent: 'quiet' as const })),
  ];
}
