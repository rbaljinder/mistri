/**
 * Which tables a read answered from (`mistri-reads`, server/live/liveReads.ts).
 *
 * The server names them on every App read it can describe; this file keeps
 * them against the answer, then against the query that holds the answer, so
 * live sync (liveInvalidate.ts) asks again only the reads a change could
 * touch. A read with no header (a tenant's, a composed answer, the first
 * paint's) has no set, and its family's own rule applies: never a missed
 * refresh, at worst an extra one.
 */
import type { Query } from '@tanstack/react-query';

const answers = new WeakMap<object, readonly string[]>();
const queries = new Map<string, readonly string[]>();

/** The ids a header names, or undefined where it names none. */
export function parseReads(header: string | null | undefined): readonly string[] | undefined {
  if (!header) return undefined;
  try {
    return header.split(',').map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

/** Keep a header's tables against the parsed answer it came with. */
export function fileReads(answer: unknown, header: string | null | undefined): void {
  const reads = parseReads(header);
  if (reads && answer && typeof answer === 'object') answers.set(answer, reads);
}

export const readsOf = (answer: unknown): readonly string[] | undefined =>
  answer && typeof answer === 'object' ? answers.get(answer) : undefined;

/** What a query made of an answer (one item of a batch, a count drawn from it) answered from the same tables:
    the batch's, a superset of the item's. Unfiled, it was asked again by every change to any table. */
export function sameReads<T>(made: T, answer: unknown): T {
  const reads = readsOf(answer);
  if (reads && made && typeof made === 'object') answers.set(made, reads);
  return made;
}

/** The query cache's hook: file the tables of what a query just got, or forget what an answer without them replaced. */
export function fileQueryReads(data: unknown, query: Pick<Query, 'queryHash'>): void {
  const reads = readsOf(data);
  if (reads) queries.set(query.queryHash, reads);
  else queries.delete(query.queryHash);
}

export const forgetQueryReads = (hash: string): void => void queries.delete(hash);
export const queryReads = (hash: string): readonly string[] | undefined => queries.get(hash);
