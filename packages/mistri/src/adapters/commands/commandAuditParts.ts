/**
 * A target's changes are one JSON array of entries, up to AUDIT_TARGET_ENTRIES of them. The receipt row keeps the first
 * AUDIT_PART_ENTRIES as text, as it always did, so every reader of a receipt and every receipt written before the
 * audit-part table keeps working; the rest are continuation pieces of AUDIT_PART_ENTRIES each, in the audit-part table.
 * Split on the way in, stitched on the way out: this is the one place that knows how.
 */
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { AUDIT_PART_ENTRIES, COMMAND_TARGET_BOUNDS, CommandJournalUnavailable } from './commandJournalSchema.js';

/** One target's audit as the journal takes it: the text of its first pieces and the continuation texts, in order. */
type SplitAudit = Readonly<{ changesJson: string; changesParts?: readonly string[] }>;

/**
 * `changes` as the journal keeps them. Each piece is serialized on its own, never the whole: the canonical walk is
 * bounded in nodes as well as bytes, and a list of thousands of entries would be refused by the first where each piece
 * is not. `frame` wraps what the receipt row keeps (a visitor's audit names the visitor beside its changes); the
 * continuation pieces are plain arrays of entries either way.
 */
export function splitAudit(changes: readonly unknown[], frame: (head: readonly unknown[]) => unknown = (head) => head): SplitAudit {
  const text = (piece: readonly unknown[]) => canonicalCommandJson(piece, COMMAND_TARGET_BOUNDS.changes);
  const changesJson = canonicalCommandJson(frame(changes.slice(0, AUDIT_PART_ENTRIES)), COMMAND_TARGET_BOUNDS.changes);
  const parts: string[] = [];
  for (let from = AUDIT_PART_ENTRIES; from < changes.length; from += AUDIT_PART_ENTRIES)
    parts.push(text(changes.slice(from, from + AUDIT_PART_ENTRIES)));
  return parts.length ? Object.freeze({ changesJson, changesParts: Object.freeze(parts) }) : Object.freeze({ changesJson });
}

/**
 * One target's whole audit as text: its first pieces, as the receipt row holds them, then each continuation in order.
 * Without continuations it is `changesJson` itself, byte for byte. A reader that shows what a target changed reads
 * the continuations of its target (the audit-part table, `groupAuditParts`) and asks this; one that only looks at what
 * the first pieces frame (a visitor, a field name) needs nothing more.
 */
export function stitchAudit(changesJson: string, parts: readonly string[] = []): string {
  if (!parts.length) return changesJson;
  const first: unknown = JSON.parse(changesJson);
  const rest = parts.flatMap((part) => {
    const piece: unknown = JSON.parse(part);
    if (!Array.isArray(piece)) throw new CommandJournalUnavailable();
    return piece as unknown[];
  });
  if (Array.isArray(first)) return JSON.stringify([...first, ...rest]);
  const framed = first as { changes?: unknown } | null;
  if (framed && typeof framed === 'object' && Array.isArray(framed.changes))
    return JSON.stringify({ ...framed, changes: [...framed.changes, ...rest] });
  throw new CommandJournalUnavailable();
}

/** A receipt's continuation rows (`target_index`, `part`, `changes_json`), in any order, as each target's texts in piece order. */
export function groupAuditParts(rows: readonly Readonly<Record<string, unknown>>[]): ReadonlyMap<number, readonly string[]> {
  const byTarget = new Map<number, Array<[number, string]>>();
  for (const row of rows) {
    const target = Number(row.target_index);
    if (typeof row.changes_json !== 'string' || !Number.isInteger(target) || !Number.isInteger(Number(row.part)))
      throw new CommandJournalUnavailable();
    const held = byTarget.get(target) ?? [];
    held.push([Number(row.part), row.changes_json]);
    byTarget.set(target, held);
  }
  const grouped = new Map<number, readonly string[]>();
  for (const [target, held] of byTarget) {
    held.sort((a, b) => a[0] - b[0]);
    // Numbered from 1 without a gap, or the audit is not whole.
    if (held.some(([part], at) => part !== at + 1)) throw new CommandJournalUnavailable();
    grouped.set(
      target,
      held.map(([, text]) => text),
    );
  }
  return grouped;
}
