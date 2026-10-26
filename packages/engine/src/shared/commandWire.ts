/**
 * What a command request and a date field carry, below the commands that use them: the most keys one request may
 * name, one record's key as text, a served input's fields depth first, and an ISO calendar date. The kit's selection, composed reads and date picker read
 * them as the App framework's commands do (command.ts re-exports them), so the cap and the key's spelling are one rule
 * on both sides without the kit reaching into the command rules.
 */

import type { AppCommandField } from '../../schema/model.js';

/**
 * A selection larger than one loaded page is a filter, not a selection. The
 * most records a queue selects, and the most keys one multi-target command
 * request may name: one constant, so the client cap and the server cap agree.
 */
export const BULK_LIMIT = 200;

/**
 * One record's identity: its columns sorted, each value as text. `{ id: 1 }`
 * and `{ id: "1" }` name the same row, so a target list may not carry both,
 * and the client and the server match a refusal's key to a record by it.
 */
export function commandKeyText(key: unknown): string {
  if (!key || typeof key !== 'object' || Array.isArray(key)) return '';
  const record = key as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((column) => [column, String(record[column])]),
  );
}

/** An ISO calendar date, `YYYY-MM-DD`, that exists. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Every field of a declaration, depth first, with the group path it sits under. */
export function* commandFieldsDeep(fields: readonly AppCommandField[], within = ''): Generator<{ field: AppCommandField; path: string }> {
  for (const item of fields) {
    const path = within ? `${within}.${item.name}` : item.name;
    yield { field: item, path };
    if (item.type === 'group') yield* commandFieldsDeep(item.fields, path);
  }
}
