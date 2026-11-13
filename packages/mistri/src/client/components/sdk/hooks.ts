/**
 * The hooks a custom component reads and moves with. The declared reads of a
 * `custom()` section are the first way to data — checked at load, planned,
 * narrowed by the dashboard's window — and these are the escape hatch for
 * what a component asks for itself: rows, one record or a breakdown of an App
 * resource, by the resource's own name, never a table or SQL.
 *
 * Every read is an ordinary request through the page's session, authorized
 * on the server like any other: role grants, field projection, row policy.
 * These names narrow what a component asks for; they are not the boundary.
 * Reads go through the page's one query cache, keyed by the reader, so a
 * sign-out or a switch of account never serves one reader's rows to another.
 */
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  defaultCurrency,
  formatAbsolute,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelativeDay,
  formatTimezone,
  formatWholeMoney,
} from '@mistriwork/kit/client/locale.js';
import { minorFigure } from '@mistriwork/engine/shared/money.js';
import {
  UiPageContext,
  UiSizeContext,
  type UiPageFrame,
  type UiAddress,
  useUiHost,
  type OpenMode,
  type UiOpenViewOptions,
  type UiBreakdownOptions,
  type UiChoice,
  type UiCommandHandle,
  type UiCommandOptions,
  type UiCommandOutcome,
  type UiCommandRef,
  type UiCommandReview,
  type UiFormOutcome,
  type UiFormState,
  type UiLook,
  type UiRow,
  type UiRowsOptions,
  type UiSize,
  type UiViewer,
} from './context.js';
import { say } from '../../copy/components/components/sdk/hooks.js';
import { reviewFresh, subscribeReviews } from '../../commandReviews.js';
import { messageLanguage, subscribeMessages } from '@mistriwork/kit/client/messages.js';
import type { AppFlagReader, AppFlagValue } from '../../../shared/appFlagValues.js';

/** Reads are render-local until React commits this exact render. Suspended or
 * abandoned renders share no consumption set with the committed tree. No ref or
 * memoized mutable set: concurrent work must not leak reads into another effect. */
export function useFlags<V = Readonly<Record<string, AppFlagValue>>>(): AppFlagReader<V> {
  const source = useUiHost().flags;
  const reader = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot);
  useEffect(() => {
    void source.load();
  }, [source, reader]);
  const used = new Set<string>();
  let committed = false;
  useEffect(() => {
    committed = true;
    if (used.size) source.commitUse?.(reader, [...used]);
  });
  return Object.freeze({
    get ready() {
      return reader.ready;
    },
    get(key: string) {
      const value = reader.get(key);
      if (!committed) used.add(key);
      return value;
    },
  }) as AppFlagReader<V>;
}

/** Call start from an authored interaction, never an effect or page load.
 * The server cookie is opaque; this does not sign in or grant App access. */
export function useVisitor(): { start(selection?: { readonly form?: string; readonly address?: string }): Promise<void> } {
  const source = useUiHost().flags;
  return useMemo(
    () => ({
      async start(selection?: { readonly form?: string; readonly address?: string }) {
        if (!source.establishVisitor) throw new Error(say('visitorUnavailable'));
        await source.establishVisitor(selection);
      },
    }),
    [source],
  );
}

/** Emit a custom event the App declared in `analytics.events`: `useAnalytics().emit('compare-opened', { vehicleId })`.
 * Fire-and-forget from an event handler. The server keeps only the declared name and fields, and takes who it
 * was from the session or visitor cookie, never from here. */
export function useAnalytics(): { emit(name: string, fields?: Readonly<Record<string, string | number | boolean>>): void } {
  const source = useUiHost().analytics;
  return useMemo(
    () => ({ emit: (name: string, fields?: Readonly<Record<string, string | number | boolean>>) => source.emit(name, fields) }),
    [source],
  );
}

/* A free-form page reads what it declared (definePage, `reads`): any other
   resource is a mistake said here, before the server refuses it as a denial
   for a reader who cannot read it — and it is the page's read, so the
   request says which page asks. Outside a page a component may name any
   resource. */
export function useDeclared(resource: string): string | undefined {
  const page = useContext(UiPageContext);
  if (page && !page.reads.includes(resource)) {
    throw new Error(say('thePageReadsIsNotOne', { label: page.label, map: page.reads.map((name) => `"${name}"`).join(', '), resource }));
  }
  return page?.view;
}

/**
 * A read's freshness beside its data. `isPending` is the first read, with nothing to draw yet; `isFetching` is any read
 * under way, a background refresh included. A refresh that fails keeps the last good data and says so (`isStale`,
 * `refreshError`), so a component never shows it as fresh nor swaps a finished screen for a note. Each read is
 * consistent on its own: two hooks are two reads, with no snapshot across them.
 */
interface UiReadState {
  isFetching: boolean;
  isStale: boolean;
  refreshError: Error | null;
}

/* TanStack's own `isStale` is "older than its stale time", which every read here always is (no stale time is set):
   the one a component can act on is whether the data it holds failed to refresh. */
function withReadState<T>(result: UseQueryResult<T>): UseQueryResult<T> & UiReadState {
  return { ...result, isStale: result.isRefetchError, refreshError: result.isRefetchError ? result.error : null };
}

/** How far a `useRows` read has paged: the page size asked, whether the server holds more, and its count where it made one. */
interface UiRowsPaging {
  limit: number;
  hasMore: boolean;
  /** Only from a count the server made; never a page's length. */
  total?: number;
}

/* A refusal is the reader's grant, not a failure: the read answered 401 (signed out) or 403 (not this reader's). */
const refusedRead = (error: unknown) => [401, 403].includes((error as { status?: number } | null)?.status ?? 0);

/** What an `optional: true` read adds: the reader was refused it (401 or 403), which is neither an error nor an empty result. */
export interface UiRefusable {
  refused: boolean;
}

/** What `useRows` holds: the rows read so far, the read's state, and `more()` for the next page. */
export interface UiRowsQuery extends UiReadState {
  data: UiRow[] | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch(): unknown;
  page: UiRowsPaging;
  /** Reads the next `limit` rows onto the end; nothing while there are none or one is already under way. */
  more(): void;
}

const ROWS_LIMIT = 20;

/* A row remembers the resource it was read from, out of sight (not a key, never in a spread or a JSON), so a button on
   it names its row by that resource's title whether or not the page wraps the row in a List or a Scope. */
const ROW_RESOURCE = Symbol.for('mistri.row.resource');
function rowOf<R extends object>(resource: string, row: R): R {
  if (!Object.hasOwn(row, ROW_RESOURCE)) Object.defineProperty(row, ROW_RESOURCE, { value: resource });
  return row;
}
/** The resource a row was read from (`useRows`), where it was read that way. */
export const resourceOfRow = (row: object): string | undefined => (row as { [ROW_RESOURCE]?: string })[ROW_RESOURCE];

/**
 * Rows of one App resource: `useRows('pay_run', { query: 'status = review', show: ['title', 'net_total'], sort: 'pay_date desc', limit: 12 })`.
 * Each row carries its resource's key columns beside `show`. The first `limit` rows (20 unless said); `page.hasMore` says whether the server holds more, and `more()` reads them.
 */
export function useRows(resource: string, options: UiRowsOptions & { enabled?: boolean; optional: true }): UiRowsQuery & UiRefusable;
export function useRows(resource: string, options?: UiRowsOptions & { enabled?: boolean; optional?: false }): UiRowsQuery;
export function useRows(
  resource: string,
  options: UiRowsOptions & { enabled?: boolean; optional?: boolean } = {},
): UiRowsQuery & UiRefusable {
  const host = useUiHost();
  const declared = useDeclared(resource);
  const { enabled = true, optional = false, offset: _offset, ...rest } = options;
  /* A row always carries its key columns beside `show`, as a `List`'s do: whether `row.id` is there never depends on
     what `show` happened to name. The read is the reader's own, so no column is widened past what `show` could name. */
  const asked = declared ? { ...rest, keys: true, page: declared } : { ...rest, keys: true };
  const limit = rest.limit ?? ROWS_LIMIT;
  const query = useInfiniteQuery({
    queryKey: ['mistri-ui', 'rows', ...host.scope, resource, asked],
    queryFn: ({ pageParam }) => host.rows(resource, pageParam ? { ...asked, offset: pageParam } : asked),
    initialPageParam: 0,
    /* The next page starts where the rows read so far end: a refresh re-reads every page from the first. */
    getNextPageParam: (last, pages) => (last.more ? pages.reduce((sum, one) => sum + one.rows.length, 0) : undefined),
    enabled,
  });
  const pages = query.data?.pages;
  const data = useMemo(() => pages?.flatMap((one) => one.rows).map((row) => rowOf(resource, row)), [pages, resource]);
  const total = pages?.[pages.length - 1]?.total;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const more = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const failedOver = query.isRefetchError || query.isFetchNextPageError;
  /* Under `optional` a refusal is a state to draw, never a failure: no error, no rows kept from before the grant went. */
  const refused = optional && query.isError && refusedRead(query.error);
  return {
    data: refused ? undefined : data,
    refused,
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError && !refused,
    error: refused ? null : query.error,
    isStale: query.isRefetchError && !refused,
    refreshError: failedOver && !refused ? query.error : null,
    refetch: query.refetch,
    page: { limit, hasMore: hasNextPage, ...(total === undefined ? {} : { total }) },
    more,
  };
}

/* A read that may be refused, as `optional: true` says it: a 401 or 403 is `refused`, never an error, and keeps no data. */
function optionally<T>(result: UseQueryResult<T> & UiReadState, optional: boolean): UseQueryResult<T> & UiReadState & UiRefusable {
  const refused = optional && result.isError && refusedRead(result.error);
  if (!refused) return { ...result, refused: false };
  return {
    ...result,
    refused,
    data: undefined,
    isError: false,
    isRefetchError: false,
    error: null,
    isStale: false,
    refreshError: null,
  } as unknown as UseQueryResult<T> & UiReadState & UiRefusable;
}

/**
 * One record of an App resource by its key: `useRecord('employee', { id: 4 }, ['name', 'title'])`. With
 * `{ optional: true }` a refusal (401, 403) is `refused: true`, not an error: `useRecord('employee', key, undefined, { optional: true })`.
 */
export function useRecord(
  resource: string,
  key: Readonly<Record<string, unknown>> | undefined,
  show: readonly string[] | undefined,
  options: { optional: true },
): UseQueryResult<UiRow | null> & UiReadState & UiRefusable;
export function useRecord(
  resource: string,
  key: Readonly<Record<string, unknown>> | undefined,
  show?: readonly string[],
  options?: { optional?: false },
): UseQueryResult<UiRow | null> & UiReadState;
export function useRecord(
  resource: string,
  key: Readonly<Record<string, unknown>> | undefined,
  show?: readonly string[],
  options: { optional?: boolean } = {},
): UseQueryResult<UiRow | null> & UiReadState & UiRefusable {
  const host = useUiHost();
  const page = useDeclared(resource);
  return optionally(
    withReadState(
      useQuery({
        queryKey: ['mistri-ui', 'record', ...host.scope, resource, key, show, page],
        queryFn: async () => (await host.record(resource, key!, show, page ? { page } : {})) ?? null,
        enabled: key !== undefined,
      }),
    ),
    options.optional === true,
  );
}

/**
 * A resource's rows grouped and measured: `useBreakdown('pay_stub', { by: 'status', measure: 'sum net' })`.
 * Each row is keyed as the server names its columns: the groups by their paths (`status`, `day(moved_at)`),
 * the measure as written (`count`, `sum(net)`, `max(on_hand_after)`).
 */
export function useBreakdown(
  resource: string,
  options: UiBreakdownOptions & { optional: true },
): UseQueryResult<UiRow[]> & UiReadState & UiRefusable;
export function useBreakdown(resource: string, options: UiBreakdownOptions & { optional?: false }): UseQueryResult<UiRow[]> & UiReadState;
export function useBreakdown(
  resource: string,
  options: UiBreakdownOptions & { optional?: boolean },
): UseQueryResult<UiRow[]> & UiReadState & UiRefusable {
  const host = useUiHost();
  const page = useDeclared(resource);
  const { optional = false, ...rest } = options;
  const asked = page ? { ...rest, page } : rest;
  return optionally(
    withReadState(
      useQuery({
        queryKey: ['mistri-ui', 'breakdown', ...host.scope, resource, asked],
        queryFn: () => host.breakdown(resource, asked),
      }),
    ),
    optional,
  );
}

/** The address parameters a page holds, as its loaders are asked them: only the ones it has a value for. */
export const pageLoadPlace = (frame: UiPageFrame): Record<string, string> =>
  Object.fromEntries(frame.params.flatMap((name) => (frame.get(name) === undefined ? [] : [[name, frame.get(name)!]])));

/* One entry per reader, page, loader and place: the page's `data` and `useLoader` of the same loader share it, and a
   command that commits reads all of them again with `['mistri-page', 'load']` (commands.tsx). */
export const pageLoadKey = (scope: readonly unknown[], view: string, loader: string, place: Readonly<Record<string, string>>) =>
  ['mistri-page', 'load', ...scope, view, loader, place] as const;

/**
 * One of a page's loaders, by its name: `page.useLoader('dueFigure')`. Each loader has its own cache entry and its own
 * state, so a slow one does not hold another back, and it is asked again as the page's place in the address changes
 * and after a command the page runs commits, as the page's `data` and its rows are. `data` is undefined while it loads.
 */
export function useLoader(name: string): UseQueryResult<unknown> & UiReadState {
  const host = useUiHost();
  const frame = useContext(UiPageContext);
  if (!frame) throw new Error(say('useloaderOutsideAPage'));
  const named = frame.loaders ?? [];
  if (!named.includes(name)) {
    throw new Error(
      say('thePageLoadsIsNotOne', {
        label: frame.label,
        map: named.length ? named.map((each) => `"${each}"`).join(', ') : say('noLoaders'),
        loader: name,
      }),
    );
  }
  const place = pageLoadPlace(frame);
  return withReadState(
    useQuery({
      queryKey: pageLoadKey(host.scope, frame.view, name, place),
      queryFn: async () => (await host.load(frame.view, place, name)) ?? null,
      placeholderData: keepPreviousData,
    }),
  );
}

/** What `page.useForm` holds: the declared form's draft as it stands, how its last opening ended, and the form itself. */
interface UiForm extends UiReadState {
  label: string;
  /** Whether this reader is served the form; one that is not (or a public form) opens as `openForm` does. */
  granted: boolean;
  steps: UiFormState['steps'];
  /** The open draft, as the form's own layout resumes it; null without one. */
  resume: UiFormState['draft'];
  /** Where the form opens: the step its draft reopens, or the first not saved; null at the review, or without a draft. */
  step: string | null;
  saved: readonly string[];
  /** The draft holds saved steps not yet submitted: leaving loses nothing, but they are not sent. */
  dirty: boolean;
  expiresAt: string | null;
  /** A submit sent and not yet known to have landed: `startOver()` refuses until it is. */
  pending: boolean;
  /** How the form ended the last time this page opened it; null before. */
  outcome: UiFormOutcome | null;
  isPending: boolean;
  error: Error | null;
  /** The form over the page, filled with what was given (`at` a step its draft has reached); resolves as it closes, and
      the draft is read again. */
  open(input?: Readonly<Record<string, unknown>>, options?: { at?: string }): Promise<UiFormOutcome>;
  /** The form opened at a step its draft has reached (never past the first not saved). */
  goTo(step: string): Promise<UiFormOutcome>;
  /** The draft discarded, as the form's Start over does: false while a submit is pending, or without a draft. */
  startOver(): Promise<boolean>;
}

/**
 * One of the form views a page declares (`forms: ['apply']`): `const apply = page.useForm('apply')`. Its draft is the
 * one the form's own layout resumes, read through the same server and keys, so the page's "Continue your application"
 * and the form never disagree. Every submit is still the server's to grant.
 */
export function useForm(view: string): UiForm {
  const host = useUiHost();
  const handle = useMemo(() => host.form(view), [host, view]);
  const [outcome, setOutcome] = useState<UiFormOutcome | null>(null);
  const read = withReadState(useQuery({ queryKey: ['mistri-ui', 'form', ...host.scope, view], queryFn: () => handle.state() }));
  const { refetch } = read;
  const opened = useCallback(
    async (input?: Readonly<Record<string, unknown>>, at?: string) => {
      const ended = await handle.open(input, at === undefined ? {} : { at });
      setOutcome(ended);
      void refetch();
      return ended;
    },
    [handle, refetch],
  );
  const state = read.data;
  return {
    label: state?.label ?? view,
    granted: state?.granted ?? false,
    steps: state?.steps ?? [],
    resume: state?.draft ?? null,
    step: state?.draft?.step ?? null,
    saved: state?.draft?.saved ?? [],
    dirty: (state?.draft?.saved.length ?? 0) > 0,
    expiresAt: state?.draft?.expiresAt ?? null,
    pending: state?.pending ?? false,
    outcome,
    isPending: read.isPending,
    error: read.error,
    isFetching: read.isFetching,
    isStale: read.isStale,
    refreshError: read.refreshError,
    open: (input, options) => opened(input, options?.at),
    goTo: (step) => opened(undefined, step),
    startOver: async () => {
      const gone = await handle.startOver();
      void refetch();
      return gone;
    },
  };
}

/** Where a component may send the reader: a record (as a page, a peek or a dialog), one of the App's views, or one of its forms in a dialog. */
export function useNavigate(): {
  openRecord(resource: string, key: Readonly<Record<string, unknown>>, options?: { mode?: OpenMode; label?: string }): void;
  openView(view: string, options?: UiOpenViewOptions): void;
  openForm(view: string, prefill?: Readonly<Record<string, string | number>>): void;
  openPage(name: string, params?: Readonly<Record<string, string>>): void;
  pageHref(name: string, params?: Readonly<Record<string, string>>): string;
  publicLink(view: string): string | undefined;
} {
  const host = useUiHost();
  /* One answer for both: the page's canonical address through the App's own rules, or a mistake said in words. */
  const pageHref = (name: string, params?: Readonly<Record<string, string>>): string => {
    const address = host.href({ kind: 'page', path: name, ...(params ? { params } : {}) });
    if (address === undefined) throw new Error(say('noAddressFor', { what: say('addressPage', { path: name }) }));
    return address;
  };
  return {
    openPage: (name, params) => host.follow(pageHref(name, params)),
    pageHref,
    openRecord: (resource, key, options) => host.openRecord(resource, key, options),
    openView: (view, options) => host.openView(view, options),
    openForm: (view, prefill) => host.openForm(view, prefill),
    publicLink: (view) => host.publicLink(view),
  };
}

/** An address on this origin written as a path (`/leads/4?tab=open`): never an absolute or protocol-relative one, which a
    sign-in's `then` must not be a way to follow (headlessLanding.js reads it, and sends a signed-in person there). */
// A browser drops tabs and newlines from an address, so `/\t/evil` would be read as `//evil`: refuse control characters too.
const inAppPath = (path: string): boolean =>
  path.startsWith('/') && !path.startsWith('//') && ![...path].some((c) => c === '\\' || c <= '\u001f' || c === '\u007f');

/**
 * The App's own addresses, as strings for an `<a href>` (and for an embedding app's navigator): `useHref().record('leads', { id: 4 })`.
 * Each is the one canonical address the router reads back (appAddress.ts). A view, page or record the App has no
 * address for is a mistake said here, not a link that goes nowhere.
 */
export function useHref(): {
  signIn(options?: { then?: string }): string;
  view(view: string, params?: Readonly<Record<string, string>>): string;
  record(view: string, key: Readonly<Record<string, unknown>>, options?: { tab?: string }): string;
  page(path: string, params?: Readonly<Record<string, string>>): string;
} {
  const host = useUiHost();
  return useMemo(() => {
    const said = (to: UiAddress, what: string) => {
      const address = host.href(to);
      if (address === undefined) throw new Error(say('noAddressFor', { what }));
      return address;
    };
    return {
      signIn: (options) => {
        const address = said({ kind: 'signIn' }, 'the sign-in');
        const then = options?.then;
        return then !== undefined && inAppPath(then) ? `${address}?then=${encodeURIComponent(then)}` : address;
      },
      view: (view, params) => said({ kind: 'view', view, ...(params ? { params } : {}) }, say('addressView', { view })),
      record: (view, key, options) =>
        said({ kind: 'record', view, key, ...(options?.tab ? { tab: options.tab } : {}) }, say('addressRecord', { view })),
      page: (path, params) => said({ kind: 'page', path, ...(params ? { params } : {}) }, say('addressPage', { path })),
    };
  }, [host]);
}

/** The page's timeline composer, from a custom section beside it: `fill` puts a template's words in the box (and
    chooses Reply or Internal note, where the page offers it) for the reader to edit and send — it never sends. It
    answers false when the page draws no composer. */
export function useComposer(): { fill(text: string, options?: { mode?: 'reply' | 'note' }): boolean } {
  const host = useUiHost();
  return { fill: (text, options = {}) => host.fillComposer(text, options.mode) };
}

/**
 * Where a file resource's row is served, for an `<img>`: `useFile('member_avatar')({ id: 4 }, { thumbnail: true })`.
 * In a tenant App the file is read on the reader's lease first, so the address is undefined until it lands, and the
 * component draws again then.
 */
export function useFile(
  resource: string,
): (key: Readonly<Record<string, unknown>>, options?: { thumbnail?: boolean }) => string | undefined {
  const host = useUiHost();
  useDeclared(resource);
  /* A new function once a file lands, so a component that keeps what it drew by this one draws again too. */
  const [landed, drawn] = useReducer((count: number) => count + 1, 0);
  return useCallback((key, options) => host.fileAddress(resource, key, options, drawn), [host, resource, landed]);
}

/** Who is reading: signed in or not, the signed-in account's id and the roles they hold here. Redraws when that changes. */
export function useViewer(): UiViewer {
  const host = useUiHost();
  const said = useSyncExternalStore(
    host.subscribeViewer,
    () => JSON.stringify(host.viewer()),
    () => '',
  );
  /* Parsed once for each reading, so `roles` (and the viewer) is the same array until who is reading, or what they hold,
     changes: an effect that depends on it runs when the reading changes, not on every draw. */
  return useMemo(() => (said ? (JSON.parse(said) as UiViewer) : host.viewer()), [said, host]);
}

const keyText = (key: Readonly<Record<string, unknown>>) =>
  JSON.stringify(
    Object.keys(key)
      .sort()
      .map((column) => [column, String(key[column])]),
  );

/** Why a command cannot be run on a record, before any click (`useCommand(...).reason(record)`). */
export type CommandUnavailable = 'signed-out' | 'not-granted' | 'unavailable';

/** A command as a component holds it (`useCommand`). */
interface UiCommand {
  label: string;
  granted: boolean;
  /** The resource whose records it runs on, where it has one (not public: `CommandButton` names its row from it). */
  resource?: string;
  /** Whether it is available on this record now; undefined until the server has said. */
  available(record: Readonly<Record<string, unknown>>): boolean | undefined;
  /**
   * Why it cannot be run on this record, said before any click: `'signed-out'`, `'not-granted'` (the
   * reader's role is not granted it), or `'unavailable'` (the server said its `when` does not hold for
   * this record and reader now); undefined while it can be, and until the server has said. Nothing the
   * page did not already know: a precondition only the command's handler checks is the App's to say.
   */
  reason(record: Readonly<Record<string, unknown>>): CommandUnavailable | undefined;
  /** Whether a run on this record is on its way. */
  pending(record: Readonly<Record<string, unknown>>): boolean;
  run(
    record: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
    options?: UiCommandOptions,
  ): Promise<UiCommandOutcome>;
  open(
    record: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
    options?: UiCommandOptions,
  ): Promise<UiCommandOutcome>;
  /** What a review shows before the person confirms, and the token `run(record, input, { review })` pins it with. */
  prepare(
    record?: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
  ): Promise<UiCommandReview | Extract<UiCommandOutcome, { status: 'refused' }>>;
  /** Whether the last review `prepare` gave still stands; true before any. */
  reviewFresh: boolean;
  /**
   * The choices one of its inputs offers, as they were served with the command: a choice's declared options, or a
   * table's rows (`field.choice({ from })`) where they come with it — on a public page, read as the public reads them
   * and kept until a row changes, so the page draws its own select with no read of its own. Undefined for an input
   * that offers none, or whose rows its own form reads.
   */
  choices(field: string): readonly UiChoice[] | undefined;
}

/**
 * One of the App's commands, as its actions offer it, by name: `useCommand('reactToPost')`.
 * A command no action offers and a signed-in form does names no record: it
 * is sent as its form sends it, and the record handed in is not read.
 *
 * `run(record, input)` sends it when the input is complete and valid, and
 * opens the platform's own form, filled with what was given, when it is not;
 * `open` always opens the form. Either way it is the one command pipeline —
 * prepared for the record's revision, sent once under a request key,
 * refused in the server's words, the page's reads refreshed after it — and
 * nothing a component sends is a write of its own. `available(record)` asks
 * the server whether the command's `when` holds for this record and this
 * reader, once per record, and answers undefined until it has; `reason(record)`
 * says why not in a word. A signed-out reader is granted no command. An applied
 * run resolves with what the command returned (`output`), so a component acts on
 * what it made without looking it up.
 */
export function useCommand(ref: UiCommandRef): UiCommand {
  const viewer = useViewer();
  return useHandle(useCommandHandle(ref, viewer), viewer);
}

/** The host's handle on a command, as this reader is served it: what `useCommand` holds, and `useField` reads its input from. */
export function useCommandHandle(ref: UiCommandRef, viewer: UiViewer): UiCommandHandle {
  const host = useUiHost();
  /* A free-form page runs what it declared (definePage, `commands`), as it reads what it declared. */
  const page = useContext(UiPageContext);
  if (page && !page.commands.includes(ref)) {
    throw new Error(
      say('thePageRunsIsNotOne', {
        label: page.label,
        map: page.commands.length ? page.commands.map((name) => `"${name}"`).join(', ') : say('noCommands'),
        command: ref,
      }),
    );
  }
  return useMemo(() => host.command(ref, page?.view), [host, ref, page?.view, viewer.signedIn, viewer.account]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Whether this reader may run one of the App's commands, without running it: `useGranted('raiseInvoice')`. It reads
 * what `useCommand(…).granted` reads (signed in, granted the command, and served the action or form that offers it),
 * but a free-form page need not declare the command in `commands` to ask, since asking writes nothing: a page that
 * shows an entry only to a role that may use it lists the commands it runs, not the ones it only asks about.
 */
export function useGranted(ref: UiCommandRef): boolean {
  const host = useUiHost();
  const viewer = useViewer();
  const page = useContext(UiPageContext);
  return useMemo(() => host.command(ref, page?.view).granted, [host, ref, page?.view, viewer.signedIn, viewer.account]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * One of the App's fixed actions, a machine's verb or `action(label, { set })`, by its id: `useAction('startVisit')`. It
 * is held as a command is (`granted`, `available`, `reason`, `pending`, `run`, `open`, and the same outcome), but it is
 * the record page's own button: `run(record)` writes the action's `set` to that record by its key through the update
 * route, asking first when the action says `confirm`, and the server judges it again, as it judges the record page's —
 * a record in a state the action leaves, or one this reader may not move, is refused in its words, never skipped. It
 * takes no input, but for the reason an action asks (`run(record, { reason })`). On a free-form page it is one of the
 * page's `actions`, which name fixed actions of the resources it reads.
 */
export function useAction(ref: UiCommandRef): UiCommand {
  const host = useUiHost();
  const page = useContext(UiPageContext);
  if (page && !(page.actions ?? []).includes(ref)) {
    throw new Error(
      say('thePageRunsActionIsNotOne', {
        label: page.label,
        map: page.actions?.length ? page.actions.map((name) => `"${name}"`).join(', ') : say('noActions'),
        action: ref,
      }),
    );
  }
  const viewer = useViewer();
  const handle = useMemo(() => host.action(ref, page?.reads), [host, ref, page?.reads, viewer.signedIn, viewer.account]); // eslint-disable-line react-hooks/exhaustive-deps
  return useHandle(handle, viewer);
}

/** What `useCommand` and `useAction` share: a handle held as a component holds it, its availability asked of the server once per record. */
function useHandle(handle: UiCommandHandle, viewer: UiViewer): UiCommand {
  const [answers, setAnswers] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef(new Map<string, Readonly<Record<string, unknown>>>());
  const wanted = useRef(new Map<string, Readonly<Record<string, unknown>>>());
  const [round, setRound] = useState(0);
  /* The handle whose answers are wanted: one for another reader or command asks everything again. */
  const current = useRef(handle);
  useEffect(() => {
    if (current.current === handle) return;
    current.current = handle;
    asked.current.clear();
    setAnswers(new Map());
  }, [handle]);
  useEffect(
    () => () => {
      current.current = undefined as unknown as typeof handle;
    },
    [],
  );
  /* The records a draw asked about, asked of the server after it (one batch, commandAvailability.ts). */
  useEffect(() => {
    const ask = [...wanted.current].filter(([text]) => !asked.current.has(text));
    wanted.current.clear();
    if (!ask.length) return;
    for (const [text, key] of ask) asked.current.set(text, key);
    const by = handle;
    void Promise.all(ask.map(async ([text, key]) => [text, by.granted ? await by.available(key).catch(() => false) : false] as const)).then(
      (results) => {
        if (current.current === by) setAnswers((before) => new Map([...before, ...results]));
      },
    );
  });
  /* Asked again after a run, keeping the last answers until the new ones arrive: a chip does not blink. */
  const again = () => {
    asked.current.clear();
    setRound((n) => n + 1);
  };
  const track = (text: string, work: Promise<UiCommandOutcome>) => {
    setRunning((before) => new Set(before).add(text));
    return work.finally(() => {
      setRunning((before) => {
        const next = new Set(before);
        next.delete(text);
        return next;
      });
      /* What a command changed may change what is available: asked again after it settles. */
      again();
    });
  };
  void round;
  /* The last review this component prepared, read from the tab's reviews so a live change to its record draws again. */
  const [review, setReview] = useState<string | undefined>(undefined);
  const fresh = useSyncExternalStore(
    subscribeReviews,
    () => review === undefined || reviewFresh(review),
    () => true,
  );
  const available = (record: Readonly<Record<string, unknown>>) => {
    const text = keyText(record);
    if (!asked.current.has(text)) wanted.current.set(text, record);
    return answers.get(text);
  };
  return {
    label: handle.label,
    granted: handle.granted,
    resource: handle.resource,
    available,
    reason(record) {
      // A public page's public command is everyone's: granted, signed in or not (publicPageCommand.ts).
      if (!viewer.signedIn && !handle.granted) return 'signed-out';
      if (!handle.granted) return 'not-granted';
      return available(record) === false ? 'unavailable' : undefined;
    },
    pending: (record) => running.has(keyText(record)),
    run: (record, input, options) => track(keyText(record), handle.run(record, input, options)),
    open: (record, input, options) => track(keyText(record), handle.open(record, input, options)),
    prepare: async (record = {}, input) => {
      if (!handle.prepare) return { status: 'refused', message: say('reviewNotOffered', { label: handle.label }) };
      const prepared = await handle.prepare(record, input);
      if (!('status' in prepared) && current.current === handle) setReview(prepared.token);
      return prepared;
    },
    reviewFresh: fresh,
    choices: (field) => handle.choices?.(field),
  };
}

/**
 * A free-form page's place, kept in its address: `const [list, setList] = useAddressState('list')` reads and writes
 * `/{app}/pick-walk?list=12`, so a page reached by a link, a reload or Back opens where the reader was.
 * The name is one of the page's declared `params` (a page's `useParam` is this hook). A change refines the place the
 * reader is on, in the address as they go; `{ push: true }` makes it a step Back returns from.
 */
export function useAddressState(
  name: string,
): [string | undefined, (value: string | number | undefined, options?: { push?: boolean }) => void] {
  const page = useContext(UiPageContext);
  if (!page) throw new Error(say('useaddressstateKeepsAPages'));
  if (!page.params.includes(name)) {
    throw new Error(
      say('thePageKeepsInItsAddress', {
        label: page.label,
        params: page.params.length ? page.params.map((param) => `"${param}"`).join(', ') : say('noParameters'),
        name,
      }),
    );
  }
  const set = useCallback(
    (value: string | number | undefined, options?: { push?: boolean }) =>
      page.set(name, value === undefined || value === '' ? undefined : String(value), options),
    [page, name],
  );
  return [page.get(name), set];
}

/**
 * One of the App's messages (`messages/<locale>.ts`) in the reader's
 * language, its `{name}`s filled from `args`: `useMessage('help.title')`,
 * `useMessage('help.results', { count: 3 })`. Redraws when the reader picks
 * another language. A key the catalog lacks is said as itself.
 */
export function useMessage(key: string, args?: Readonly<Record<string, string | number | boolean | Date | null | undefined>>): string {
  const host = useUiHost();
  useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  return host.message(key, args);
}

/** How `useFormat().money` says a figure: as a column's display rule says one (`format: 'money'`). */
interface UiMoneyFormat {
  /** An ISO 4217 code; the App's `ui.currency` when not given. */
  currency?: string;
  /** The value is kept in minor units: 1999 is said as 19.99, exactly. */
  minor?: boolean;
  /** Without the minor digits where they are all zero: "$24,495", and "$24,495.50" still. */
  whole?: boolean;
  /** Compact from a thousand ("$27.9K"), for a figure meant to be glanced at; put the exact one in its title. */
  compact?: boolean;
}

/* Where a compact figure starts, as a metric card's (dashboardModel.ts CARD_COMPACT). */
const COMPACT_FROM = 1000;

/**
 * Money said as the display rules say it: exact to the currency's minor digits, a decimal string past 2^53 digit for
 * digit (never through Number()), minor units read exactly. A currency code alone is `{ currency }`.
 */
function sayMoney(value: number | string, options: string | UiMoneyFormat = {}): string {
  const { currency, minor, whole, compact } = typeof options === 'string' ? { currency: options } : options;
  const code = currency || defaultCurrency();
  const major = minor ? minorFigure(value, code) : value;
  if (major === undefined) return String(value);
  if (compact && Math.abs(Number(major)) >= COMPACT_FROM)
    return formatMoney(Number(major), code, { notation: 'compact', maximumFractionDigits: 1 });
  return whole ? formatWholeMoney(major, code) : formatMoney(major, code);
}

/** Figures in the App's locale, currency and timezone (`ui.locale`, `ui.currency`, `ui.timezone`), as every built-in section says them. */
export function useFormat() {
  return {
    /** The App's day (`ui.timezone`): the zone a page reckons "today" in, as the built-in calendar does. Undefined where the App names none, so `Intl` uses the reader's own. */
    timezone: formatTimezone(),
    number: (value: number | string, options?: Intl.NumberFormatOptions) => formatNumber(value, options),
    money: (value: number | string, options?: string | UiMoneyFormat) => sayMoney(value, options),
    percent: (value: number) => formatPercent(value),
    date: (value: string) => formatDate(value),
    /**
     * A moment as the App's clock says it; with `timezone`, the instant said in that zone with its name ("2:30 PM
     * PDT"). `style: 'short'` says it in the fewest characters ("3/5/26, 2:30 PM"), for a cell or a card's line.
     */
    dateTime: (value: string, options?: { timezone?: string; style?: 'short' }) => {
      const short = options?.style === 'short';
      return options?.timezone
        ? formatAbsolute(value, { time: true, zone: options.timezone, short })
        : formatDateTime(value, short ? 'short' : undefined);
    },
    /** "in 3 days", "yesterday"; undefined for a value that is not a date. */
    relative: (value: string) => formatRelativeDay(value) ?? undefined,
  };
}

/** The look the App wears for this reader, light or dark, and the density. */
export function useLook(): UiLook {
  const host = useUiHost();
  const said = useSyncExternalStore(
    host.subscribeLook,
    () => JSON.stringify(host.look()),
    () => '',
  );
  return said ? (JSON.parse(said) as UiLook) : host.look();
}

/** One design token's value as the look resolves it — `useToken('--accent')` — for a canvas or an SVG attribute. CSS can say `var(--accent)` itself. */
export function useToken(name: `--${string}`): string {
  const host = useUiHost();
  return useSyncExternalStore(
    host.subscribeLook,
    () => host.token(name),
    () => '',
  );
}

/** The section's measured width, and whether it is phone-narrow: a component lays itself out for the room it has. */
export function useSectionSize(): UiSize {
  return useContext(UiSizeContext);
}
