/**
 * The order a chart and a breakdown draw their groups in, where the key declares one (Dashboard.tsx, ChartFigure.tsx).
 * It lives apart from dashboardModel.ts because only those on-demand parts read it: the shell's first paint carries
 * none of it, and a record page's own figures keep dashboardModel's orderGroups.
 */

/**
 * Groups in the order their key declares: the values its vocabulary names first, in that order, and anything else
 * biggest first after them. A `scale` — an age in days, a priority 1 to 5, a month — runs in its own order instead: a
 * histogram sorted by its counts read 0, 1, 6, 3, 2.
 */
export function orderDeclared<T extends Record<string, unknown>>(
  rows: readonly T[],
  key: string,
  value: string,
  vocabulary?: readonly string[],
  scale?: boolean,
): T[] {
  const rank = new Map((vocabulary ?? []).map((word, at) => [word, at]));
  const place = (row: T) => (row[key] == null ? undefined : rank.get(String(row[key]))) ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => {
    const first = place(a),
      second = place(b);
    if (first !== second) return first - second;
    if (scale) {
      const order = scaleOrder(a[key], b[key]);
      if (order) return order;
    }
    return (Number(b[value]) || 0) - (Number(a[value]) || 0);
  });
}

/** Two steps of a scale in its order, the empty one last: numbers by their size, anything else (a period) as text. Only
    compared, never said, so a key past 2^53 losing its last digits here moves nothing a reader can see. */
function scaleOrder(a: unknown, b: unknown): number {
  if (a == null || a === '') return b == null || b === '' ? 0 : 1;
  if (b == null || b === '') return -1;
  const x = Number(a),
    y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Whether a group key is a scale — its values steps in an order of their own
 * rather than categories: a bucket of time (`month opened_on`, `hour at`), or
 * a number that is neither a key nor a reference (an age in days, a priority
 * 1 to 5, a score). An id is a number too, but 17 is not "after" 16. Such a
 * key keeps its order in a breakdown and a chart, and its series are drawn
 * as steps of one hue (Chart.tsx, a donut's `ordered`).
 */
export function isScale(
  column: { type?: string; references?: unknown; primaryKey?: boolean } | undefined,
  by: string | undefined,
): boolean {
  if (by && /^(day|month|quarter|year|weekday|hour)\s/i.test(by.trim())) return true;
  return Boolean(
    column && !column.references && !column.primaryKey && /int|serial|numeric|decimal|real|double|float|number/i.test(column.type ?? ''),
  );
}

/**
 * The order a group key declares, where it declares one: the values the
 * schema allows (a CHECK list, an enum, a machine's states), else the values
 * its display rule names, in the order the rule names them — a priority
 * stored as 1 to 5 and said Urgent to Planning reads in that order, not by
 * its counts — and whether it is a scale (isScale). Plain text declares
 * neither, and is read biggest first.
 */
export function declaredOrder(
  column: { type?: string; references?: unknown; primaryKey?: boolean; allowed?: readonly string[] } | undefined,
  rule: { values?: Record<string, string> } | null | undefined,
  by: string | undefined,
): { vocabulary?: string[]; scale: boolean } {
  const named = rule?.values && !column?.references ? Object.keys(rule.values) : [];
  const vocabulary = column?.allowed?.length ? [...column.allowed] : named.length ? named : undefined;
  return { ...(vocabulary ? { vocabulary } : {}), scale: isScale(column, by) };
}
