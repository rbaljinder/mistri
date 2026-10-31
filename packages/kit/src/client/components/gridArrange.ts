/**
 * A grid's own arrangement: the order its reader put its columns in, and
 * the widths they dragged them to. Both live only in the grid that drew
 * them — a reader's arrangement, never the query's, so a refetch, a sort
 * or a page never moves a column the reader placed, and another reader
 * never sees it. The query's columns stay the source of truth: an order
 * that names a column no longer drawn is dropped, and a column the order
 * never named stands after the arranged ones, in the query's order.
 *
 * Widths are layout pixels, the units a column's `width` style speaks
 * (Grid.tsx divides the pointer's screen pixels by the zoom-aware ruler
 * before they arrive here). A column narrower than this does not take a
 * head: its label would be a sliver and its sort a guess.
 */
export const MIN_COLUMN_WIDTH = 48;

/** One arrow-key step on a column's resizer, and the step with Shift held. */
const RESIZE_STEP = 16;
const RESIZE_SHIFT_STEP = 64;

/** The step an arrow key moves a resizer, larger with Shift held. */
export function columnResizeStep(shiftKey: boolean): number {
  return shiftKey ? RESIZE_SHIFT_STEP : RESIZE_STEP;
}

/** A width a column may actually be given: whole pixels, never below its floor. */
export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_COLUMN_WIDTH;
  return Math.max(MIN_COLUMN_WIDTH, Math.round(width));
}

/**
 * The columns as drawn, in the reader's order: the order's names first,
 * in the order's order, then every drawn column the order never named,
 * in the order they were drawn. With no order, the drawn order stands.
 */
export function applyColumnOrder(drawn: readonly string[], order: readonly string[] | null): string[] {
  if (!order) return [...drawn];
  const kept = order.filter((name) => drawn.includes(name));
  const placed = new Set(kept);
  return [...kept, ...drawn.filter((name) => !placed.has(name))];
}

/**
 * The order with one column stepped one place left or right, as the
 * header's move buttons and Alt+arrows ask. At either edge, or naming a
 * column the order does not hold, the order stands unchanged.
 */
export function moveColumn(order: readonly string[], name: string, direction: 'left' | 'right'): string[] {
  const at = order.indexOf(name);
  const to = direction === 'left' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  const [moved] = next.splice(at, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** The fitted widths, with every width the reader dragged standing in place of its fitted one. */
export function applyColumnWidths(
  fitted: readonly number[],
  columns: readonly string[],
  overrides: Readonly<Record<string, number>>,
): number[] {
  return columns.map((name, index) => {
    const override = overrides[name];
    return override === undefined ? (fitted[index] ?? 0) : clampColumnWidth(override);
  });
}
