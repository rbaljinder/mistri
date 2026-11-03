/**
 * The page's reactions, counted: one breakdown over every entry on the page by kind, and the reader's own beside it
 * (`<by> = me`), asked in the same moment so they travel as one request (breakdownBatch.ts). On the page's own path,
 * so a timeline holds its rows until the counts are in and nothing moves when they come; the row that draws them is a
 * part of its own (TimelineReactions.tsx).
 */
import { useQuery } from '@tanstack/react-query';
import type { TimelineReactions as Reactions } from '@mistriwork/engine/shared/pageModel.js';
import { andQuery, quoteValue } from '@mistriwork/engine/shared/query.js';
import { batchedBreakdown } from '../breakdownBatch.js';

/** An entry as the reactions name it: the column of its table `whose` refers to (its key), and its value there. */
export interface ReactionEntry {
  column: string;
  value: string | number;
}

/** Every entry's counts by kind, and the kinds the reader gave, keyed by `entryKey`. */
export interface ReactionTally {
  counts: ReadonlyMap<string, number>;
  mine: ReadonlySet<string>;
}

/* The query language's word for the signed-in reader: their row of `auth.me`'s table, read where the rows are. */
const ME = 'me';

export const entryKey = (entry: string | number, kind: string) => JSON.stringify([String(entry), kind]);

/* A breakdown's rows as [entry, kind, count]: its first two columns are the keys it was asked by, the last the count. */
function tallied(answer: unknown): Array<[string, string, number]> {
  const data = answer as { columns?: string[]; rows?: Array<Record<string, unknown>>; errors?: unknown[] };
  if (data.errors?.length || !data.columns || data.columns.length < 3) throw new Error('reactions');
  const [entry, kind] = data.columns;
  const count = data.columns.at(-1)!;
  return (data.rows ?? []).map((row) => [String(row[entry!]), String(row[kind!]), Number(row[count]) || 0]);
}

/**
 * The tally for these entries, and whether it is still on its way: a reader who may not read the reactions gets none
 * (and is not kept waiting), and the entries draw no row.
 */
export function useReactionTally(
  reactions: Reactions | undefined,
  entries: ReadonlyArray<string | number>,
): { tally?: ReactionTally; waiting: boolean } {
  const asked = Boolean(reactions?.whose && reactions.by && reactions.column && entries.length);
  const tally = useQuery<ReactionTally>({
    queryKey: ['page-reactions', reactions, entries],
    enabled: asked,
    queryFn: async () => {
      const { from, whose, by, column, kinds } = reactions!;
      const these = andQuery(`${whose} in (${entries.map(quoteValue).join(', ')})`, `${column} in (${kinds.map(quoteValue).join(', ')})`);
      const most = entries.length * kinds.length;
      const ask = (narrow: string) => batchedBreakdown({ text: [from, narrow, 'count by', `${whose}, ${column}`].join(' '), limit: most });
      const [all, own] = await Promise.all([ask(these), ask(andQuery(these, `${by} = ${ME}`))]);
      return {
        counts: new Map(tallied(all).map(([entry, kind, count]) => [entryKey(entry, kind), count])),
        mine: new Set(tallied(own).flatMap(([entry, kind, count]) => (count > 0 ? [entryKey(entry, kind)] : []))),
      };
    },
    staleTime: 0,
    retry: false,
  });
  return { ...(asked && tally.isSuccess ? { tally: tally.data } : {}), waiting: asked && tally.isPending };
}
