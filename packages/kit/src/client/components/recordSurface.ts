/** Shared page reads. A host owns presentation; this module never moves the walk,
 * changes a draft, settles a mutation or records a visit. */
import { ownedBy } from '../requestIdentity.js';
import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, findTable, labelPath, primaryKey, state, writeAllowed } from '../core.js';
import { shell } from '../shellMode.js';
import { grantedActionIds } from '../actionGrants.js';
import { connectionGeneration } from '../connectionTransition.js';
import { sessionIdentity, subscribeSessionIdentity } from '../sessionIdentity.js';
import { pageById, pagesFor } from '../page.js';
import { pathEqualityFilter, recordKey } from '../resourceRequests.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import type { PageProps } from './Page.js';
import { resourceOf } from './appRooms.js';
import { rootMatches, type PageEntry, type SectionPlan } from './pageModel.js';
import { useWalk } from './walk.js';
import { composeRecordPage } from '../recordCompose.js';
import { FOCUS_ALWAYS } from './mount.js';
import { say } from '../copy/record/components/recordSurface.js';

export type RecordSurfacePage = PageDef & { id: string; name: string; base: string; source: 'saved' | 'config' | 'suggested' };
export interface RecordSurfaceAlternative {
  id: string;
  name: string;
  source: string;
}
export type RecordSurfaceEntry = PageEntry & { table: string; key: Record<string, unknown> };

/** Capture once per host lifetime, not on every render. The host predicate must
 * fence close/reopen and replacement generations, including the same record.
 * It supplements the captured data authority; it cannot replace those checks. */
const capturedOwner = Symbol('record surface owner');
export interface RecordSurfaceOwner {
  readonly [capturedOwner]: true;
  readonly connection: string;
  readonly queryScope: number;
  readonly isCurrent: () => boolean;
}

let nextScope = 0;
export function captureRecordSurfaceOwner(hostIsCurrent: () => boolean): RecordSurfaceOwner {
  const identity = sessionIdentity(),
    schema = state.schema;
  const connection = state.activeConnection ?? '',
    generation = connectionGeneration();
  const app = shell().app(),
    appMode = shell().inApp();
  return Object.freeze({
    [capturedOwner]: true as const,
    connection,
    queryScope: ++nextScope,
    isCurrent: () => {
      try {
        return (
          identity === sessionIdentity() &&
          identity.mode !== 'locked' &&
          identity.mode !== 'unknown' &&
          schema === state.schema &&
          connection === (state.activeConnection ?? '') &&
          generation === connectionGeneration() &&
          app === shell().app() &&
          appMode === shell().inApp() &&
          hostIsCurrent() === true
        );
      } catch {
        return false;
      }
    },
  });
}

class RetiredSurface extends Error {
  constructor() {
    super(say('thisRecordSurfaceIsNoLonger'));
  }
}

/** Data for the existing PageView, including authored fixed actions and business
 * commands. Rendering a modal still requires host-aware PageView mutation and
 * dock integration: its current internal go() callbacks are route-specific. */
type RecordSurfaceContent = Pick<PageProps, 'entry' | 'page' | 'base' | 'plans' | 'others' | 'actions'>;

type RecordSurfaceState =
  | { status: 'retired' | 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing'; page: RecordSurfacePage; base: TableMeta }
  | { status: 'ready'; content: RecordSurfaceContent; refreshFailed: boolean };

export const RECORD_REFRESH_FAILED = say('couldNotRefreshThisRecord');

/** Explicit non-route entry point. Never parses a URL, resolves a cold root or
 * falls back to the current route's entry. The host supplies label/tab changes
 * and consumes content only while this surface remains current. */
export function useRecordSurface({ owner, entry }: { owner: RecordSurfaceOwner; entry: RecordSurfaceEntry }) {
  const surface = usePageSurface(owner, entry, { explicitRoot: true });
  let result: RecordSurfaceState;
  if (!surface.isCurrent()) result = { status: 'retired' };
  else if (surface.definition.isError && !surface.page) result = { status: 'error', message: surface.definition.error.message };
  else if (!surface.page) result = { status: 'loading' };
  else if (surface.page.error) result = { status: 'error', message: surface.page.error };
  else if (!surface.base) result = { status: 'error', message: say('common.isNotATable', { base: surface.page.base }) };
  else if (surface.rootError) result = { status: 'error', message: surface.rootError };
  else if (surface.gone) result = { status: 'missing', page: surface.page, base: surface.base };
  else if (surface.plan.isError && !surface.content) result = { status: 'error', message: surface.plan.error.message };
  // Same-owner background errors cannot retire an editor or its unresolved
  // nested mutations. Cached data never crosses the ownership checks above.
  else if (surface.content) result = { status: 'ready', content: surface.content, refreshFailed: surface.refreshFailed };
  else result = { status: 'loading' };
  return { result, rootRow: surface.rootRow, isCurrent: surface.isCurrent };
}

/** Shared pipeline also used by PageRoom before its routed wrapper has resolved
 * a cold URL or chosen a root. Only that wrapper may mutate the routed entry. */
export function usePageSurface(owner: RecordSurfaceOwner, entry: PageEntry, options: { explicitRoot?: boolean } = {}) {
  useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  useWalk();
  const keyText = JSON.stringify(entry.key);
  const target = useMemo(() => {
    const pageId = entry.pageId,
      table = entry.table,
      rootBody = entry.rootBody;
    const key = entry.key ? Object.freeze({ ...entry.key }) : undefined;
    const isCurrent = () =>
      owner[capturedOwner] === true &&
      owner.isCurrent() &&
      entry.pageId === pageId &&
      entry.table === table &&
      entry.rootBody === rootBody &&
      JSON.stringify(entry.key) === keyText;
    // Check after rejection as well as fulfillment: stale failures cannot become
    // a missing-record state or start another request under a replacement owner.
    const read = async <T>(request: () => Promise<T>): Promise<T> => {
      if (!isCurrent()) throw new RetiredSurface();
      try {
        const reply = await request();
        if (!isCurrent()) throw new RetiredSurface();
        return reply;
      } catch (error) {
        if (!isCurrent()) throw new RetiredSurface();
        throw error;
      }
    };
    return { pageId, table, key, read, isCurrent };
  }, [owner, entry, entry.pageId, entry.table, entry.rootBody, keyText]);
  const current = target.isCurrent();
  const definition = useQuery<RecordSurfacePage>({
    queryKey: ['page-def', owner.connection, target.pageId, target.table, owner.queryScope],
    queryFn: () => target.read(() => pageById(target.pageId, target.table) as Promise<RecordSurfacePage>),
    enabled: current,
    staleTime: 0,
    gcTime: 0,
  });
  const page = current ? definition.data : undefined;
  const base = page && !page.error ? (findTable(page.base) as TableMeta | undefined) : undefined;
  /* A suggested page is its table's own: the base and the id are in its name,
     so its root and its plan are asked beside its definition, not after it —
     one round trip off every record a page was never configured for. The
     content still waits for the definition. */
  const suggested =
    !page && target.pageId?.startsWith('suggested:')
      ? (findTable(target.pageId.slice('suggested:'.length)) as TableMeta | undefined)
      : undefined;
  const readBase = base ?? suggested;
  const readPageId = page?.id ?? (suggested ? target.pageId : undefined);
  const needsResolution = Boolean(readBase && (entry.table !== readBase.id || (!entry.key && entry.rootBody !== undefined)));
  let rootError: string | undefined;
  if (options.explicitRoot && readBase) {
    try {
      const checked = recordKey(target.key),
        pk = primaryKey(readBase) as string[];
      if (
        entry.table !== readBase.id ||
        pk.length !== Object.keys(checked).length ||
        pk.some((column) => !Object.hasOwn(checked, column))
      ) {
        throw new Error(say('incompleteSurfaceRoot'));
      }
    } catch {
      rootError = say('thisSurfaceNeedsAComplete');
    }
  }
  const others = useQuery<RecordSurfaceAlternative[]>({
    queryKey: ['pages-of', owner.connection, readBase?.id, owner.queryScope],
    queryFn: () =>
      target.read(async () => {
        try {
          return ((await pagesFor(readBase!.id)) as Array<RecordSurfaceAlternative & { error?: string }>).filter((p) => !p.error);
        } catch {
          return [];
        } // Alternatives failing never removes the known layout.
      }),
    enabled: current && Boolean(readBase) && !needsResolution && !rootError,
    staleTime: 0,
    gcTime: 0,
  });
  const plan = useQuery<{ page?: PageDef; plans?: SectionPlan[] }>({
    queryKey: ['page-plan', owner.connection, readPageId, keyText, page?.source === 'saved' ? JSON.stringify(page) : '', owner.queryScope],
    /* The plan and every read the page's sections will ask, in one request
       (shared/recordReads.ts), or the one a press on the row already began.
       Asked before the probe, which then waits for the row the compose reads. */
    queryFn: () =>
      target.read(() => composeRecordPage(owner.connection, page?.source === 'saved' ? page : readPageId!, target.key!, entry.tab)),
    /* Planning independently attests the root on the scoped server adapter.
       Start it beside the probe: the probe still decides whether this surface
       may render, but no longer puts a round trip ahead of every section. */
    enabled: current && !needsResolution && !rootError && Boolean(readBase && readPageId && target.key),
    staleTime: 0,
    gcTime: 0,
    // The record on screen: a tab coming back re-reads it, however recent.
    meta: FOCUS_ALWAYS,
  });
  const probe = useQuery<{ row: Record<string, unknown> | null; unreachable?: boolean }>({
    queryKey: ['page-root', owner.connection, readPageId, keyText, owner.queryScope],
    queryFn: () =>
      target.read(async () => {
        try {
          const namePath = labelPath(readBase!) as string | undefined;
          const pk = primaryKey(readBase!) as string[];
          const reply = await api('/api/view/run', {
            ...ownedBy(owner.connection),
            count: 'none',
            view: {
              id: `page:${readPageId!}:root`,
              name: readBase!.name,
              base: readBase!.id,
              columns: [...pk, ...(namePath ? [namePath] : [])].map((path) => ({ path })),
              filter: pathEqualityFilter(Object.fromEntries(pk.map((column) => [column, target.key![column]]))),
              limit: 1,
            },
          });
          return { row: reply.rows?.[0] ?? null };
        } catch {
          // Preserve the routed behavior: an unreachable probe lets the planner
          // explain the failure, rather than asserting that the record is gone.
          return { row: null, unreachable: true };
        }
      }),
    // The root probe needs the resolved page/base/key only. Alternatives feed
    // the chooser in the eventual plan, so making this read wait for them
    // serializes two independent requests and delays the missing-root fence.
    enabled: current && !needsResolution && !rootError && Boolean(readBase && readPageId && target.key),
    staleTime: 0,
    gcTime: 0,
  });
  const gone = Boolean(current && probe.data && !probe.data.row && !probe.data.unreachable);
  /* One page object per plan: PageView keys its label ownership on the page
     it was given, and a modal host re-renders on every label it publishes,
     so a fresh spread here would republish forever once an aside is in play. */
  const presented = useMemo(
    () => (page && plan.data ? { ...(plan.data.page ?? page), source: plan.data.page?.source ?? page.source } : undefined),
    [page, plan.data],
  );
  let content: RecordSurfaceContent | undefined;
  if (
    current &&
    !needsResolution &&
    !rootError &&
    base &&
    page &&
    others.data &&
    target.key &&
    probe.data &&
    !gone &&
    plan.data &&
    presented
  ) {
    /* A record page offers every one of its resource's actions, whichever list it was opened from. */
    const declared = shell().inApp() ? resourceOf(shell().app(), base.id)?.actions : undefined;
    const actions: PageProps['actions'] = declared?.length
      ? {
          list: declared,
          queryScope: owner.queryScope,
          matches: async (when) => {
            if (!target.isCurrent()) return false;
            const matches = await rootMatches(base, target.key!, when, owner.connection);
            return target.isCurrent() && matches;
          },
          canUpdate: writeAllowed(base.id),
          grantedCommands: shell().app()?.grantedCommands ?? [],
          grantedActions: grantedActionIds(shell().app(), base.id),
        }
      : undefined;
    content = { entry, page: presented, base, plans: plan.data.plans ?? [], others: others.data, actions };
  }
  return {
    definition,
    page,
    base,
    needsResolution,
    rootError,
    others,
    probe,
    plan,
    gone,
    content,
    refreshFailed: definition.isError || plan.isError,
    rootRow: current ? probe.data?.row : undefined,
    isCurrent: target.isCurrent,
  };
}
