/**
 * A row's children, opened in place — the vanilla client's view of it.
 *
 * The expander and the detail row are components (components/Nested.tsx) and
 * their answers live in the Query cache; what stays here is what the rest
 * of the client asks: whether a table has children at all, and the reset a
 * new result calls for.
 */
import { refsTo } from './core.js';
import { queryClient } from './components/mount.js';

/** A new result means new rows; answers cached against the old ones are
    answers to a question nobody is asking any more. A row still open on
    screen is still asking — a sort or a page re-asks the table in place and
    keeps it open — so its answer is refreshed where it stands rather than
    pulled from under it. */
export function resetNested() {
  const cache = queryClient.getQueryCache();
  for (const query of cache.findAll({ queryKey: ['nested'] })) {
    if (query.getObserversCount() > 0) void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
    else cache.remove(query);
  }
}

/** Whether expanding would show anything at all. */
export const hasChildren = (table) => Boolean(table) && refsTo(table.id).length > 0;
