/**
 * A decimal column keeps its scale, as it does on Postgres.
 *
 * SQLite stores `numeric(12,2)` 38 as the integer 38 and 19.9 as the float
 * 19.9, so the scale the column was declared with is gone by the time a row is
 * read. `pg` returns the same column as the text "38.00" and "19.90", and the
 * money display depends on that text to show cents. This reads the declared
 * type the driver reports for each result column (once per statement, not per
 * cell) and says a number the way Postgres says a numeric. A column with no
 * declared scale, an integer column and an expression (no declared type) are
 * left exactly as they were.
 */

const DECLARED_SCALE = /^\s*(?:decimal|numeric)\s*\(\s*\d+\s*,\s*(\d+)\s*\)\s*$/i;

/** The scale a declared type asks for, when it is a DECIMAL/NUMERIC with one above zero. */
export function declaredScale(type: string | null | undefined): number {
  if (!type) return 0;
  const scale = Number(DECLARED_SCALE.exec(type)?.[1] ?? 0);
  return scale > 0 ? scale : 0;
}

/** Per output position, the scale to apply, or undefined when no column needs one. */
export function scalesOf(columns: ReadonlyArray<{ type?: string | null }>): number[] | undefined {
  let scales: number[] | undefined;
  columns.forEach((column, at) => {
    const scale = declaredScale(column.type);
    if (scale > 0) (scales ??= Array.from({ length: columns.length }, () => 0))[at] = scale;
  });
  return scales;
}

/** One stored value, said with `scale` places. Text, null and bytes pass through. */
function withScale(value: unknown, scale: number): unknown {
  if (typeof value === 'bigint') return `${value}.${'0'.repeat(scale)}`;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e15) return value.toFixed(scale);
  return value;
}

/** Rows read as objects: apply the scales of the columns named by `names` (positional, as `scalesOf`). */
export function scaleRows(
  rows: Array<Record<string, unknown>>,
  names: ReadonlyArray<string | null | undefined>,
  scales: number[] | undefined,
): Array<Record<string, unknown>> {
  if (!scales) return rows;
  const apply = names.flatMap((name, at) => (name != null && scales[at] > 0 ? [[name, scales[at]] as const] : []));
  for (const row of rows) for (const [name, scale] of apply) if (row && name in row) row[name] = withScale(row[name], scale);
  return rows;
}

/** Rows read as arrays. */
export function scaleArrays(rows: unknown[][], scales: number[] | undefined): unknown[][] {
  if (!scales) return rows;
  for (const row of rows) scales.forEach((scale, at) => scale > 0 && at < row.length && (row[at] = withScale(row[at], scale)));
  return rows;
}
