/**
 * The sidebar's counts, read live.
 *
 * A number beside a list reads as that list's size now. The catalog's
 * `approxRows` is a snapshot from when the schema was read, never
 * refreshed after a write — this browser's or another session's — so it
 * said 48 beside a list of 49 once an applicant had submitted through a
 * public form. An app's menu asks the server instead.
 *
 * What is counted is what the view stands for, its standing condition
 * included. A whole table goes to `/api/count`; a view with a condition
 * goes to `/api/run` with the condition as text, the request the list's
 * own tab badges make (AppList.tsx): the query language is parsed on the
 * server and only there, on the server's clock, so "last 30 days" is the
 * same days beside the menu row as in the list it opens. `limit: 1` keeps the
 * rows that ride along with the total to one.
 *
 * Every request carries `countLimit`, so the server reads at most
 * NAV_COUNT_LIMIT + 1 matching rows and answers `capped` past the bound,
 * and the row says 10,000+. Unbounded, each row on screen was a full
 * COUNT(*) per user per refresh — a scan of a large Postgres table. The
 * catalog's estimate is no substitute in an app: it is the whole table's
 * size, rows a role's row policy or scope keeps from it included. The
 * bounded count goes through the same policy and filter as the list.
 *
 * The rows that ask in the same moment ask together, in one request
 * (`/api/counts`, which a list's tab badges use too), and the server counts
 * them in one statement where it can: a menu of seventeen rows was seventeen
 * requests on every page load. A row that asks alone, or a batch the server
 * refuses, asks as a single row does.
 *
 * When: once per row on screen — a row scrolled out of the list, or a
 * sidebar folded away or not drawn, asks nothing — deduplicated by what is
 * counted; again every two minutes while the page is visible (Query stops the
 * clock in a hidden tab); on return to the window; and at once after this
 * browser's own writes. Saves, bulk actions, commands and undo already
 * invalidate the `count` family these keys sit in; `countsChanged` covers
 * the two paths that did not, create and delete.
 */
import { useEffect, useState, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, findTable, state } from '../core.js';
import { sessionIdentity } from '../sessionIdentity.js';
import { firstPaintItem } from '../firstPaint.js';
import { NAV_COUNT_LIMIT } from '@mistriwork/engine/shared/reads.js';
import { queryClient } from './mount.js';
import { sameReads } from '../liveReads.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

export interface NavCountSpec {
  table: string;
  condition: string;
}
/** `capped`: the server stopped at the bound; `count` is the bound, and more match. */
export interface NavCount {
  count: number;
  exact: boolean;
  capped?: boolean;
}

/** How often a count on screen is asked again. */
const NAV_COUNT_INTERVAL = 120_000;

const activeConnection = (): string => (state as { activeConnection?: string | null }).activeConnection ?? '';

/**
 * In the `count` family, so every invalidation of a connection's counts
 * reaches these; five parts, so it never shares a cache entry with a tab
 * badge (`['count', connection, query]`, which holds a bare number).
 */
export const navCountKey = (connection: string, spec: NavCountSpec) => ['count', connection, 'nav', spec.table, spec.condition] as const;

const isNavCountKey = (key: readonly unknown[]): boolean => key[0] === 'count' && key[2] === 'nav';

/** The count, or null when the server gave none it stands behind. */
function fetchNavCount(spec: NavCountSpec): Promise<NavCount | null> {
  // A source that reports no totals (an API) is not asked for one it would refuse.
  if ((findTable(spec.table) as { countable?: false } | undefined)?.countable === false) return Promise.resolve(null);
  /* A first page's menu comes with its counts (firstPaint.ts), each by what it counts. */
  const carried = firstPaintItem('count', activeConnection(), { q: countText(spec), countLimit: NAV_COUNT_LIMIT });
  if (carried !== undefined) return Promise.resolve(counted(carried as CountResult));
  return new Promise((resolve, reject) => {
    waiting.push({ spec, resolve, reject });
    if (waiting.length === 1) setTimeout(flush, 0);
  });
}

/* The rows of one paint: a macrotask, after every row's query has mounted. */
let waiting: Array<{ spec: NavCountSpec; resolve: (count: NavCount | null) => void; reject: (error: unknown) => void }> = [];
/* The server's own ceiling on one batch (shared/reads.ts, COUNT_EACH_MAX). */
const BATCH = 64;

function flush() {
  const asked = waiting;
  waiting = [];
  for (let at = 0; at < asked.length; at += BATCH) void send(asked.slice(at, at + BATCH));
}

/** What a row counts, as a batch item says it. */
const countText = (spec: NavCountSpec): string => (spec.condition ? `${spec.table} ${spec.condition}` : spec.table);

type CountResult = { total?: unknown; exactTotal?: unknown; cappedTotal?: unknown; errors?: unknown[] } | undefined;
/** One item of a batch's answer, as the row says it. */
const counted = (said: CountResult): NavCount | null =>
  said && !said.errors?.length && typeof said.total === 'number'
    ? { count: said.total, exact: said.exactTotal !== false, ...(said.cappedTotal === true ? { capped: true } : {}) }
    : null;

async function send(batch: typeof waiting) {
  if (batch.length === 1) return fetchOne(batch[0].spec).then(batch[0].resolve, batch[0].reject);
  let results: CountResult[];
  let data: { results?: typeof results };
  try {
    data = (await api('/api/counts', { items: batch.map(({ spec }) => countText(spec)), countLimit: NAV_COUNT_LIMIT })) as {
      results?: typeof results;
    };
    if (!Array.isArray(data?.results) || data.results.length !== batch.length) throw new Error();
    results = data.results;
  } catch {
    // Whatever refused the batch, each row is owed its own answer.
    for (const { spec, resolve, reject } of batch) fetchOne(spec).then(resolve, reject);
    return;
  }
  batch.forEach(({ resolve }, index) => resolve(sameReads(counted(results[index]), data)));
}

/** One row's count, asked alone. */
async function fetchOne(spec: NavCountSpec): Promise<NavCount | null> {
  if (!spec.condition) {
    const data = await api('/api/count', { table: spec.table, countLimit: NAV_COUNT_LIMIT });
    return typeof data?.count === 'number'
      ? sameReads({ count: data.count, exact: data.exact !== false, ...(data.capped === true ? { capped: true } : {}) }, data)
      : null;
  }
  const data = await api('/api/run', { q: `${spec.table} ${spec.condition}`, limit: 1, countLimit: NAV_COUNT_LIMIT });
  return 'total' in data && !data.errors?.length && typeof data.total === 'number'
    ? sameReads(
        {
          count: data.total,
          exact: !('exactTotal' in data && data.exactTotal === false),
          ...('cappedTotal' in data && data.cappedTotal === true ? { capped: true } : {}),
        },
        data,
      )
    : null;
}

/**
 * A row's live count. A refused or failed read is absent — not zero, and
 * not the last number either, which may be one this role can no longer
 * see. The server's refusal is the whole answer; the sidebar says nothing.
 */
export function useNavCount(spec: NavCountSpec, visible: boolean): NavCount | null {
  const query = useQuery({
    queryKey: navCountKey(activeConnection(), spec),
    queryFn: () => fetchNavCount(spec),
    enabled: visible,
    refetchInterval: NAV_COUNT_INTERVAL,
  });
  return query.isError ? null : (query.data ?? null);
}

/**
 * Whether a row is on screen. One observer per row rather than a shared
 * one: a menu is tens of rows, and an observer that belongs to its row
 * goes when the row does. Without IntersectionObserver every row counts as
 * seen — the alternative is a menu with no numbers at all.
 */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setSeen(last.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return seen;
}

/**
 * Coming back to the window asks again. Query's own focus refetch listens
 * for the tab turning visible, which a second window beside this one never
 * changes; the window's `focus` event does. Rows on screen only, counts
 * past the client's stale time only, and a refetch already on its way is
 * joined rather than restarted. A tenant session is left to lease renewal,
 * the way the client's defaults leave every other query (mount.tsx).
 */
export function useCountsOnFocus(): void {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      if (sessionIdentity().tenantRequired) return;
      void client.refetchQueries(
        { predicate: (query) => isNavCountKey(query.queryKey), type: 'active', stale: true },
        { cancelRefetch: false },
      );
    };
    addHostListener(window, 'focus', refresh);
    return () => removeHostListener(window, 'focus', refresh);
  }, [client]);
}

/**
 * After this browser's own create or delete: every count on the connection
 * — the menu's and the list tabs' — at once, joining a refetch the same
 * write already started elsewhere rather than asking twice.
 */
export function countsChanged(connection: string | null | undefined = activeConnection()): void {
  try {
    void queryClient.invalidateQueries({ queryKey: ['count', connection ?? ''] }, { cancelRefetch: false });
  } catch {
    /* A disposed cache has no counts to refresh. */
  }
}
