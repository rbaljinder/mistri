/**
 * A custom section's aggregate reads, as its component receives them.
 *
 * A total is a breakdown, answered by the server under the reader's grants like every other (a dashboard's
 * metrics and breakdowns, a page's figures), so the figure counts every row the reader may see. The answer is
 * read by position, not by the names the server gave the columns (`count`, `sum(net)`, `key_1`, `value`): the
 * groups come first, then the measure, then the name of the record a reference key points at, if any. One figure
 * with no groups is the first column of its one row; with a `by`, each group is its key, its figure and its name.
 * An id or a sum past 2^53 stays a string: nothing here runs a value through Number().
 */

/** What a measure says: a count is always a number; a sum, average, minimum or maximum may be text (a wide decimal) or null (no rows). */
export type TotalValue = number | string | null;

/** One group of a total that has a `by`. */
export interface TotalGroup {
  /** The group's value (`'open'`, a reference's key, a period's start). */
  key: unknown;
  value: TotalValue;
  /** The record a reference key points at, said by its name, where the server named it. */
  label?: string;
}

type Row = Readonly<Record<string, unknown>>;

const figure = (value: unknown): TotalValue =>
  value === null || value === undefined ? null : typeof value === 'number' || typeof value === 'string' ? value : null;

/** One figure: the first column of the first row, or null where the server answered no row. */
export function totalFigure(rows: readonly Row[] | undefined): TotalValue {
  const row = rows?.[0];
  return row ? figure(row[Object.keys(row)[0]]) : null;
}

/** Each group of a grouped total, in the order the server gave. */
export function totalGroups(rows: readonly Row[] | undefined): TotalGroup[] {
  return (rows ?? []).map((row) => {
    const columns = Object.keys(row);
    const label = row.label;
    return { key: row[columns[0]], value: figure(row[columns[1]]), ...(typeof label === 'string' && label ? { label } : {}) };
  });
}
