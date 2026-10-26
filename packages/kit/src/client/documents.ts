/**
 * Which documents a record has, and which one an address asks for
 * (shared/appDocuments.ts). A document is the last segment of its record's
 * address, where a record page's tab is said, so the walk carries it as the
 * entry's `tab`: the room that draws the record yields to the sheet when the
 * word names one of its table's documents. Small, and on every App page: the
 * sheet itself is a part loaded on demand.
 */
import { shell } from './shellMode.js';
import { tabWord } from '@mistriwork/engine/shared/addressParams.js';
import type { AppPayloadDocument } from '@mistriwork/engine/shared/servedApp.js';

/** The documents of a table this reader is served, in the App's order. */
export function documentsOf(tableId: string | undefined): AppPayloadDocument[] {
  if (!tableId || !shell().inApp()) return [];
  return (shell().app()?.documents ?? []).filter((document) => document.base === tableId);
}

/** The document a record entry is on: its tab names one of its table's documents, by key or as an address says it. */
export function documentAt(entry: { table?: string; key?: unknown; tab?: string }): AppPayloadDocument | undefined {
  if (!entry.key || !entry.tab) return undefined;
  const asked = entry.tab;
  return documentsOf(entry.table).find((document) => document.id === asked || tabWord(document.id) === asked);
}
