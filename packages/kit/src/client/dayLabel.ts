/* How a stored day or moment is named when a row is called by it: the one reading the walk (core.js) and the
   React half share, kept outside components/ so the walk never reaches into it. */
import { formatDate, formatDateTime } from './locale.js';

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * A day or moment used as a row's name (a crumb, a pill, a title), said as the grid says a date: the reader's locale,
 * never the stored ISO text. Absolute even in an App — a name that read "tomorrow" would not be the name it was
 * yesterday. Undefined for anything that is no day, so a name or an id (a big-int one stays its string) is untouched.
 * Lives outside components/ because the walk (core.js) names rows with it and may not reach into the React half.
 */
export function sayDayLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!ISO_DAY.test(text)) return undefined;
  return /[ T]00:00(:00(\.0+)?)?$/.test(text) ? formatDate(text) : formatDateTime(text);
}
