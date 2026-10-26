import { replaceEqualDeep } from '@tanstack/react-query';

let epoch = 0;

/** Advance before Undo reconciliation so equal rows become fresh editor sources. */
export function advanceRecordSource(): void {
  epoch += 1;
}

export async function readRecordSource<T extends object>(read: () => Promise<T>): Promise<T & { recordSourceEpoch: number }> {
  // A response arriving after reconciliation still belongs to its starting epoch.
  const recordSourceEpoch = epoch;
  return { ...(await read()), recordSourceEpoch };
}

const epochOf = (value: unknown): unknown =>
  value !== null && typeof value === 'object' ? (value as { recordSourceEpoch?: unknown }).recordSourceEpoch : undefined;

export function shareRecordSource(old: unknown, next: unknown): unknown {
  return epochOf(old) !== epochOf(next) ? next : replaceEqualDeep(old, next);
}
