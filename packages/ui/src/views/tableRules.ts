/* The rules a DataTable's rows are ordered and kept by, apart from the component so each can be held to a case. */

const missing = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === 'number' && Number.isNaN(value)) ||
  (value instanceof Date && Number.isNaN(value.getTime()));

/**
 * Orders two cells of one column, `dir` 1 ascending and -1 descending.
 *
 * A Date is ordered by its moment and a number by its size. Both used to fall through to `String(value)`, so a date
 * column sorted by weekday name ("Fri" before "Mon") and a NaN landed wherever "NaN" sorts among the digits. A cell
 * with nothing to order by (null, undefined, NaN, an invalid Date) goes last in either direction: turning the
 * sort round should not bring the blanks to the top.
 */
export function compareCells(a: unknown, b: unknown, dir: 1 | -1): number {
  const noA = missing(a);
  const noB = missing(b);
  if (noA || noB) return noA === noB ? 0 : noA ? 1 : -1;
  if (a instanceof Date && b instanceof Date) return (a.getTime() - b.getTime()) * dir;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
  if (typeof a === 'bigint' && typeof b === 'bigint') return (a < b ? -1 : a > b ? 1 : 0) * dir;
  return String(a).localeCompare(String(b), undefined, { numeric: true }) * dir;
}

/** Whether two lists hold the same rows in the same places: the same objects, or objects that say the same things. */
export function sameRows<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((row, at) => {
    const other = b[at];
    if (row === other) return true;
    if (typeof row !== 'object' || row === null || typeof other !== 'object' || other === null) return false;
    const keys = Object.keys(row);
    if (keys.length !== Object.keys(other).length) return false;
    return keys.every((key) => Object.is((row as Record<string, unknown>)[key], (other as Record<string, unknown>)[key]));
  });
}
