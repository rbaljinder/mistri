/**
 * The records a command's reference input may pick, for a component that draws its own picker (`useOptions`). They are
 * read where the platform's own picker reads them — the reader's door, the input's filter — so a custom picker offers
 * exactly what the native one does, and the server judges the pick again when the command runs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCommandHandle, useViewer } from './hooks.js';
import { useUiHost, type UiCommandRef, type UiOption, type UiReferenceInput } from './context.js';
import { say } from '../../copy/components/components/sdk/options.js';

const LIMIT = 20;
/* Long enough that a typed word is one read, short enough that a pause shows its matches. */
const SETTLE_MS = 150;

/** The record a picker holds, named: `available` is false when the reader cannot see it, which is never "not found". */
type UiResolvedOption = UiOption & { available: boolean };

/** A reference input's choices, searched and paged, and the one picked (`useOptions`). */
export interface UiOptions {
  /** The text searched for, as typed. */
  query: string;
  setQuery(text: string): void;
  /** The matches read so far, a page each; the latest query's, never an earlier one's. */
  pages: UiOption[][];
  hasMore: boolean;
  /** Reads the next page onto the end; nothing while there is none or one is already under way. */
  more(): void;
  /** The picked record's key. */
  selected: string | number | undefined;
  select(key: string | number | undefined): void;
  /** The picked record named, read by its key when it is not among the matches; undefined while there is none or it is being read. */
  resolved: UiResolvedOption | undefined;
  /** True while what is typed has not been searched yet. */
  isPending: boolean;
  error: Error | null;
}

/**
 * The records one reference input of a command offers: `useOptions('assignVisit', 'nurse')`. Typing searches (the
 * latest text wins: an earlier answer arriving late is never shown), `more()` reads the next page, and `select(key)`
 * holds a pick whose name is read by its key when it is not on a page, so a key from the address or a draft is named
 * too. A reader who has lost access to the resource is told the pick is not available, never that it does not exist.
 * A reader not granted the command is offered nothing. Draw the list with `Typeahead` from `@mistriwork/ui`, which
 * keeps the keyboard.
 */
export function useOptions(command: UiCommandRef, name: string): UiOptions {
  const host = useUiHost();
  const viewer = useViewer();
  const handle = useCommandHandle(command, viewer);
  const declared = handle.input?.(name);
  if (handle.granted && declared?.type !== 'reference') throw new Error(say('notAReference', { command, name }));
  const reference = handle.granted && declared?.type === 'reference' ? (declared as UiReferenceInput) : undefined;
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [selected, setSelected] = useState<string | number | undefined>(undefined);
  useEffect(() => {
    const text = query.trim();
    if (text === asked) return;
    const settle = setTimeout(() => setAsked(text), SETTLE_MS);
    return () => clearTimeout(settle);
  }, [query, asked]);
  const read = useInfiniteQuery({
    /* The text is in the key, so each query has its own answer and only the latest one's is drawn. */
    queryKey: ['mistri-ui', 'options', ...host.scope, command, name, asked],
    queryFn: ({ pageParam }) => host.choices(reference!, asked, { offset: pageParam, limit: LIMIT }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.more ? pages.length * LIMIT : undefined),
    enabled: Boolean(reference),
    retry: false,
  });
  const pages = useMemo(() => read.data?.pages.map((one) => one.options) ?? [], [read.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = read;
  const more = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const onPage = useMemo(() => pages.flat().find((option) => option.key === selected), [pages, selected]);
  const named = useQuery({
    queryKey: ['mistri-ui', 'option', ...host.scope, command, name, selected],
    /* A key the reader cannot read is answered as unavailable, as an access loss is: the picker never says it is gone. */
    queryFn: async (): Promise<UiResolvedOption> => {
      const found = await host.choiceName(reference!, selected!).catch(() => null);
      return found ? { ...found, available: true } : { key: selected!, label: say('notAvailable'), available: false };
    },
    enabled: Boolean(reference) && selected !== undefined && !onPage,
    retry: false,
  });
  const resolved = selected === undefined ? undefined : onPage ? { ...onPage, available: true } : named.data;
  return {
    query,
    setQuery,
    pages,
    hasMore: Boolean(hasNextPage),
    more,
    selected,
    select: setSelected,
    resolved,
    isPending: Boolean(reference) && (read.isPending || query.trim() !== asked),
    error: read.error,
  };
}
