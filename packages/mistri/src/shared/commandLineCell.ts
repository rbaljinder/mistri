/*
 * A command line's cell read as its column's kind (`field.lines`): the server
 * reads every line with it where the command runs, and the browser with the
 * catalog it is served once a form's grid has loaded. Its own module, so that a
 * page with no lines grid — a public form's first page — carries none of it.
 */
import { isIsoDate, isoInstant } from './command.js';
import type { CommandInputReason } from './commandInput.js';
import { columnKind, isFlagColumn, type TableMeta } from '@mistriwork/engine/shared/schema.js';

/**
 * A line's cell as its column holds it: a number for a number (an amount typed
 * as text included), yes or no for a flag, a day or a moment for a date, one of
 * a vocabulary's values, text for the rest. What a grid's box holds is text,
 * so text that reads as the kind is read as it.
 */
export function lineCell(table: TableMeta, column: string, value: string | number | boolean): { value: unknown } | CommandInputReason {
  const meta = table.columns.find((c) => c.name === column);
  if (!meta) return 'shape';
  const said = typeof value === 'string' ? value.trim() : value;
  if (isFlagColumn(meta)) {
    if (typeof said === 'boolean') return { value: said };
    if (said === 1 || said === 'true' || said === '1') return { value: true };
    if (said === 0 || said === 'false' || said === '0') return { value: false };
    return 'type';
  }
  if (meta.allowed?.length) return meta.allowed.includes(String(said)) ? { value: String(said) } : 'choice';
  const kind = columnKind(meta.type);
  if (kind === 'number') {
    const n = typeof said === 'number' ? said : typeof said === 'string' && /^-?\d+(\.\d+)?$/.test(said) ? Number(said) : NaN;
    return Number.isFinite(n) ? { value: n } : 'type';
  }
  if (typeof said !== 'string') return 'type';
  if (kind === 'date') return isIsoDate(said) || isoInstant(said) !== undefined ? { value: said } : 'type';
  return { value: said };
}
