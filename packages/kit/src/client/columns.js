/**
 * How a column should be drawn.
 *
 * Decided per column, once per result set, from the declared type *and* the
 * values actually on the page. Type alone is not enough: SQLite has no
 * boolean, so a flag column arrives as INTEGER and would otherwise render as
 * a column of 1s and 0s. Values alone are not enough either — a page where
 * every quantity happens to be 0 or 1 is not a column of checkboxes.
 *
 * The rule throughout: formatting may never hide the stored value. Anything
 * reformatted carries the raw value in its title, because in a database tool
 * the difference between `5000` and `5,000` is sometimes the whole question.
 */

/* From the shared schema, not through core.js: the value rules (valueModel.ts)
   are also the public kit's (components/sdk), which draws a value in a custom
   component's tests, where the walk and its globals do not exist. */
import { columnKind } from '@mistriwork/engine/shared/schema.js';

/** Columns whose name says "flag" loudly enough to trust 0/1 as a boolean. */
const FLAG_NAME =
  /^(is|has|can|should|was)_|_(flag|enabled|disabled)$|^(active|enabled|disabled|deleted|archived|verified|published|visible|locked|hidden|default|primary|required|readonly)$/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/;

/**
 * Below this many rows, sorting any column is cheap enough to offer freely.
 *
 * `ESTIMATE_ABOVE` from shared/reads.ts, which is where this codebase
 * already draws the line between "counting is free" and "counting is a scan
 * worth avoiding". A sort is the same kind of work as a count, so it belongs
 * on the same side of the same line rather than getting a second threshold to
 * disagree with the first.
 */
export const SORT_SCAN_BELOW = 50_000;

/**
 * May the header offer to sort this column?
 *
 * A header click is a one-click action with no visible cost, and on an
 * unindexed column of a large table it is a full scan and a sort of
 * everything to show twenty rows. So the offer is made when an index leads on
 * the column — or when the table is small enough that the scan costs nothing
 * anybody would notice.
 *
 * That second clause is the whole point. The rule used to be the first alone,
 * which is right on a table of millions and far too careful on one of a
 * hundred and seventy: `employee.last_name` had no index, so there was no way
 * to sort by it from the interface at all.
 *
 * `approxRows` unknown is not treated as small. A table nobody could count is
 * not one to assume is cheap.
 *
 * Pure, and exported, so the rule can be tested directly rather than through a
 * browser — no fixture in this repo has fifty thousand rows in it, so the
 * large-table half is otherwise a branch nothing ever exercises.
 */
export function sortableFromHeader(table) {
  if (!table) return false;
  return table.approxRows != null && table.approxRows < SORT_SCAN_BELOW;
}

/* What a value is compared character by character: a key, a reference, a code, a serial. A name, a status or a
   city is read, so an App sets it in the reading face; only these keep the data face unasked. */
const ID_NAME = /(^|_)(id|uuid|code|sku|vin|ref|key|token|serial|number|no|hash|slug)$/i;
/**
 * @param {{ primaryKey?: boolean, references?: unknown, identifier?: boolean, sourceName?: string } | undefined} meta
 * @param {string} name
 */
export function identifierLike(meta, name) {
  return Boolean(meta?.primaryKey || meta?.references || meta?.identifier || ID_NAME.test(meta?.sourceName ?? name));
}

export function planColumn(meta, name, rows) {
  const values = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined);
  const declared = columnKind(meta?.type);
  const plan = { align: 'left', kind: declared, mono: false };

  const allNumeric = values.length > 0 && values.every((v) => typeof v === 'number');

  // Boolean: declared as one, an integer a CHECK pins to 0 and 1, or an integer flag column whose name says so.
  if (
    declared === 'boolean' ||
    meta?.flag === true ||
    (allNumeric && FLAG_NAME.test(meta?.sourceName ?? name) && values.every((v) => v === 0 || v === 1))
  ) {
    return { ...plan, kind: 'boolean', align: 'center' };
  }

  if (declared === 'number' || allNumeric) {
    /* Keys and references are identifiers that happen to be numeric. Grouping
       them turns invoice 1001 into "1,001", which reads as a quantity and is
       not what the value means. */
    const identifier = Boolean(meta?.primaryKey || meta?.references || meta?.identifier);
    const decimals = identifier ? 0 : Math.max(0, ...values.map(countDecimals));
    const group = !identifier && values.some((v) => Math.abs(Number(v)) >= 10000);
    return { ...plan, kind: 'number', align: 'right', decimals, group, identifier };
  }

  if (declared === 'date' || (values.length && values.every((v) => typeof v === 'string' && ISO_DATE.test(v)))) {
    // A column of timestamps all at midnight is a date column wearing a
    // timestamp's clothes; showing ` 00:00:00` on every row is pure noise.
    const anyTime = values.some((v) => /[ T]\d{2}:\d{2}/.test(String(v)) && !/[ T]00:00:00(\.0+)?$/.test(String(v)));
    return { ...plan, kind: 'date', mono: true, showTime: anyTime };
  }

  /* Short, uniform text — codes, statuses, currencies — reads better in a
     narrow monospace column than stretched across a wide proportional one. */
  const longest = Math.max(0, ...values.map((v) => String(v).length));
  return { ...plan, kind: 'text', mono: longest <= 12 && values.length > 0, idLike: identifierLike(meta, name) };
}

function countDecimals(value) {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(6, text.length - dot - 1);
}
