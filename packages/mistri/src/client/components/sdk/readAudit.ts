/**
 * `useReadAudit(filters)`: who opened or listed which of an audited resource's rows in this organization, newest first,
 * a page at a time: the Settings Reads room's own log, over its own route (/api/reads), for a page that shows it beside
 * a record. The same gate as the room: the tenant's admins, the tenant from the lease, never on a support visit. A
 * reader outside it hears the route's refusal as `error` and is given no lines. Outside a tenant App it is empty.
 */
import { useCallback, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useUiHost } from './context.js';
import type { ReadAuditFilters, ReadAuditLine } from '../../readAuditTypes.js';

interface UiReadAudit {
  /** The lines read so far, newest first: the first page, and each one `more()` read below it. */
  reads: readonly ReadAuditLine[];
  /** The id the page below starts under; absent when the last line has been read. */
  next: number | undefined;
  /** Reads the next page onto the end; nothing while there is none or one is already under way. */
  more(): void;
  isPending: boolean;
  error: Error | null;
}

export function useReadAudit(filters: ReadAuditFilters = {}): UiReadAudit {
  const host = useUiHost();
  const { actor, resource, record, since, until, before } = filters;
  const asked = useMemo(() => ({ actor, resource, record, since, until }), [actor, resource, record, since, until]);
  const query = useInfiniteQuery({
    /* The filters are in the key, so each set has its own pages and only the latest one's are drawn. */
    queryKey: ['mistri-ui', 'reads', ...host.scope, asked, before ?? null],
    queryFn: ({ pageParam }) => host.reads.read({ ...asked, ...(pageParam === undefined ? {} : { before: pageParam }) }),
    initialPageParam: before,
    getNextPageParam: (last) => last.next,
    /* A refusal is the answer (a reader outside the gate), not a failure to try again. */
    retry: false,
  });
  const reads = useMemo(() => (query.error ? [] : (query.data?.pages.flatMap((page) => page.reads) ?? [])), [query.data, query.error]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const more = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return {
    reads,
    next: query.error ? undefined : query.data?.pages.at(-1)?.next,
    more,
    isPending: query.isPending,
    error: query.error,
  };
}
