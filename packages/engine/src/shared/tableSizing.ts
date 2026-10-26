export type TableSizing = 'fit' | 'scroll';
export const TABLE_SIZINGS: readonly TableSizing[] = ['fit', 'scroll'];

/** Omission preserves the renderer's fit default without rewriting authored config. */
export function parseTableSizing(value: unknown, at: string): TableSizing | undefined {
  if (value === undefined) return undefined;
  if (value !== 'fit' && value !== 'scroll') throw new Error(`${at} has an invalid "sizing". Use "fit" or "scroll".`);
  return value;
}
