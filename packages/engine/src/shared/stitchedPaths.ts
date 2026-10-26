/**
 * Where a path crosses a stitched reference: a declared reference to a table
 * in another source, on another connection (ForeignKey.stitched), which is
 * read in a second step and never joined. Shared by the reader that stitches
 * (appStitchedReads.ts) and the load-time check of an App's own lists, so an
 * authored filter or sort through one is refused when the App starts, in the
 * words a request through one is refused with.
 */
import type { DatabaseSchema, ForeignKey } from './schema.js';
import { hopsFrom, type ViewCondition, type ViewOrder } from './viewPaths.js';

/** A stitched hop a path takes: the prefix as the path wrote it, the edge, and whether it is past the first step. */
export interface StitchedHop {
  prefix: string;
  edge: ForeignKey;
  deep: boolean;
}

/** The first stitched hop a path takes from `base`, or none. */
export function stitchedHop(schema: DatabaseSchema, base: string, path: string): StitchedHop | undefined {
  const segments = path.split('.').map((segment) => segment.trim());
  let table = base;
  for (let i = 0; i < segments.length - 1; i++) {
    const matches = hopsFrom(schema, table).filter((hop) => hop.name === segments[i] || hop.fk.name === segments[i]);
    if (matches.length !== 1) return undefined;
    const { fk } = matches[0];
    if (fk.stitched) return { prefix: segments.slice(0, i + 1).join('.'), edge: fk, deep: i > 0 };
    table = fk.to.table;
  }
  return undefined;
}

/** Why a list cannot filter or sort by a path on the far side of a stitched reference. */
export function stitchedFarProblem(hop: StitchedHop, path: string, what: string): string {
  const target = hop.edge.to.table;
  return (
    `"${path}" is on ${target}, in another source on another connection, so a list of ${hop.edge.from.table} cannot ${what} by it: ` +
    `each database filters and sorts what it holds. Show it, or ${what} on ${target}'s own list.`
  );
}

/** The first condition or sort of a list that is across a stitched reference, said as a problem. */
export function stitchedListProblem(
  schema: DatabaseSchema,
  base: string,
  parsed: { filter?: { groups: ViewCondition[][] }; orderBy?: ViewOrder[] },
): string | undefined {
  for (const condition of parsed.filter?.groups.flat() ?? []) {
    for (const path of [condition.path, ...(condition.other ? [condition.other] : [])]) {
      const hop = stitchedHop(schema, base, path);
      if (hop) return stitchedFarProblem(hop, path, 'filter');
    }
  }
  for (const order of parsed.orderBy ?? []) {
    const hop = order.alias ? undefined : stitchedHop(schema, base, order.path);
    if (hop) return stitchedFarProblem(hop, order.path, 'sort');
  }
  return undefined;
}
