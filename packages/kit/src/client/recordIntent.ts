/**
 * What a row or a link that opens a record carries (`data-opens`), for the
 * press that begins reading the record's page before the press is over
 * (recordPress.ts). Depends on nothing, so any list can say it.
 */
export function opensRecord(tableId: string | undefined, key: unknown): string | undefined {
  if (!tableId || !key || typeof key !== 'object') return undefined;
  try {
    return JSON.stringify([tableId, key]);
  } catch {
    return undefined;
  }
}
