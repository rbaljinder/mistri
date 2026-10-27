/**
 * An app's list page: the table through the app's own words.
 *
 * This is the middle of the shape an app is made of — filters → lists →
 * detail pages — and it is deliberately the *real* table view underneath:
 * the vanilla grid with the explorer chrome off, drawn into a host, not a
 * lesser grid. Sorting, the header filter menus, the pager all still work;
 * what changes is the dressing: the app's heading, its filter tabs with live
 * counts, the reader's own views after them, and a filter bar in place of
 * the hidden query bar — a search, a picker per filter and the applied
 * filters said as chips in the same row (ListFilterBar.tsx) — or, where the
 * view says `filterBar: 'rail'`, a rail of facets beside the rows
 * (FilterRail.tsx), a sheet on a phone.
 *
 * The counts and the saved views are Queries: a tab's badge is a minute's
 * cache shared by every list on the connection, and a saved view
 * (myViews.ts) is written through a fresh read of the server's list — never
 * a stale cache — so what is shown is what the server agreed to. Each view is
 * the list's question as text, so opening one is the ordinary list address.
 */
import { filterLabel } from '@mistriwork/engine/shared/listFilters.js';
import { BoardNewForm } from './boardNew.js';
import { useMessageLanguage } from './useMessageLanguage.js';
import { createPortal } from 'react-dom';
import { listControlsRef, useCrumbSlots } from './crumbSlot.js';
import { FavoriteStar } from './FavoriteStar.js';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, columnLabel, labelPath, pageSize, recordLabel, state as walk, toast } from '../core.js';
import { say } from '../copy/lists/components/AppList.js';

/* The walk's state, with the field core.js's JSDoc does not declare. */
const state = walk as typeof walk & { activeConnection?: string | null };
import { mayRunAny } from '../actionGrants.js';
import { shell } from '../shellMode.js';
import { splitConditions, splitQuery } from '../clauses.js';
import { promptFor } from '../prompt.js';
import { canonicalize, conditionTail, deriveFilterNames, mentionsColumn, ownedTails, squeeze, withCondition } from '../filterbar.js';
import { exportOffered } from '@mistriwork/engine/shared/listPresentations.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { pluralOf, recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import type { ResourceHttpSuccess } from '@mistriwork/engine/shared/resourceHttp.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { findTable } from '../core.js';
import { sameReads } from '../liveReads.js';
import {
  appListQuery,
  litTabFor,
  residueOf,
  searchColumn,
  shownTabs,
  visibleQuestion,
  wholeQuery,
  type ListEntry,
  type ListSpec,
  subtitleColumns,
  editedReferences,
  listReferenceNames,
} from './appListModel.js';
import { boxTail, boxesFor, type Box, type BoxEdit } from './FilterBoxes.js';
import { onDemand } from './onDemand.js';

const DefinedBoxes = onDemand(() => import('./DefinedFields.js'), 'DefinedBoxes', { quiet: true });

/* A list's single `per` value (`category_id = 3`), which picks the fields a row-defined column's boxes are. */
function oneValue(tail: string): string | undefined {
  const match = /^=\s*(?:"([^"]*)"|'([^']*)'|(\S+))$/.exec(tail.trim());
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}
import { useConditionWords } from './useConditionWords.js';
import { message } from '../messages.js';
import { useTabFold } from './useTabFold.js';
import { DropGroup, DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { FilterRail, FilterSheet, type FacetUnit } from './FilterRail.js';
import { clearFacets, facetActive } from './filterRailModel.js';
import { FilterPicker, ListFilterBar } from './ListFilterBar.js';
import { AppColumnMenuContext, returnFocusTo, type AppColumnMenuHost } from './AppColumnMenu.js';
import { resourceOf } from './appRooms.js';
import { renamedView, useSavedViews, withView, withoutView, writeSavedViews, type SavedView } from './myViews.js';
import { PHONE_QUERY, RAIL_QUERY, useMediaQuery } from './useMediaQuery.js';
import { TableRoom } from './TableRoom.js';
import { RowOpensContext } from './rowOpens.js';
import { ListEmpty } from './ListEmpty.js';
import { Empty } from './Notes.js';
import { Button } from '@mistriwork/ui/Button.js';
import { SortMenu } from './SortMenu.js';
import { QuickAdd } from './QuickAddOnDemand.js';
import { defaultCurrency, formatLocale, formatNumber } from '../locale.js';

interface AppListProps {
  entry: ListEntry;
  spec: ListSpec;
  /** Where a new question goes: the walk, or an embedding page's own redraw. */
  navigate: (query: string) => void;
  /** Embedded in a page's chooser, the grid's own navigation is off. */
  embedded?: boolean;
  /** The app's New button, when the page offers one. */
  newButton?: ReactNode;
  /** In a dashboard's section that opted in (`interactive`): the list works — its search, its filters,
      its selection and the bulk actions its room offers — under the section's own heading, with no
      heading, saved views, quick add or rail of its own. */
  inDashboard?: boolean;
  /** Rows the list matched, once known, for a heading drawn outside the list (a dashboard section's count). */
  onTotal?: (total: number | undefined) => void;
}

/* What the next paint should hand focus back to. The redraw replaces the
   control the person just used and focus fell to <body> — twenty Tab stops
   from where they were — so the box or tab that spoke is remembered, and
   the next list puts focus back on its twin. */
let refocus: { column?: string; value?: string; tab?: string } | null = null;

interface Counted {
  total: number;
  capped: boolean;
}

/**
 * Every tab's badge, asked in one request (`/api/counts`) and counted in one
 * statement where the server can: a list with six tabs was six requests, each
 * running the whole list's read — joins, sort, a page of rows — to use its
 * count. Each is bounded as a list's total is ("10,000+"). A minute's cache,
 * shared by every list on the connection that shows the same tabs. A server
 * that refuses the batch is asked tab by tab, as before.
 */
function useTabCounts(questions: string[]): Map<string, Counted | null> | undefined {
  const items = [...new Set(questions)].sort();
  const client = useQueryClient();
  return useQuery<Map<string, Counted | null>>({
    queryKey: ['count', state.activeConnection ?? '', 'tabs', items],
    /* While a new batch is on the way each badge says what it last said — a batch's answer, or the grid's total
       when its tab was on screen (gridCount) — so swapping tabs never empties the badges and shifts the row. */
    placeholderData: () => knownCounts(client),
    queryFn: async () => {
      const said = (data: { total?: unknown; cappedTotal?: unknown; errors?: unknown[] } | undefined): Counted | null =>
        data && !data.errors?.length && typeof data.total === 'number' ? { total: data.total, capped: data.cappedTotal === true } : null;
      try {
        const data = (await api('/api/counts', { items })) as {
          results?: Array<{
            total?: number;
            cappedTotal?: boolean;
            errors?: unknown[];
          }>;
        };
        if (!Array.isArray(data.results) || data.results.length !== items.length) throw new Error(say('theCountsCameBack'));
        return sameReads(new Map(items.map((q, i) => [q, said(data.results![i])])), data);
      } catch {
        return new Map(
          await Promise.all(
            items.map(async (q): Promise<[string, Counted | null]> => {
              try {
                return [
                  q,
                  said(
                    (await api('/api/run', { q, limit: 1 })) as {
                      total?: number;
                      cappedTotal?: boolean;
                      errors?: unknown[];
                    },
                  ),
                ];
              } catch {
                return [q, null];
              }
            }),
          ),
        );
      }
    },
    enabled: items.length > 0,
    staleTime: 60_000,
  }).data;
}

/* The last placeholder handed out, handed out again while it says the same. Query asks for a placeholder on
   every render of a batch not yet answered — and of one never asked, a list with no tabs — and a fresh Map each
   time is a new result: the list rendered again, which asked again, every frame for as long as it stood. Each
   render woke the navigation hold, which then held every list to its 1.5 s cap (navigationHold.ts). */
let lastKnown: Map<string, Counted | null> | undefined;
const sameCount = (a: Counted | null | undefined, b: Counted | null | undefined) =>
  a === b || (a != null && b != null && a.total === b.total && a.capped === b.capped);

/** Every count this connection's badges have been told, newest last: the placeholder for a batch on the way. */
function knownCounts(client: ReturnType<typeof useQueryClient>): Map<string, Counted | null> | undefined {
  const known = new Map<string, Counted | null>();
  for (const [, data] of client.getQueriesData<Map<string, Counted | null>>({ queryKey: ['count', state.activeConnection ?? ''] }))
    if (data instanceof Map) for (const [question, counted] of data) known.set(question, counted);
  if (!known.size) return undefined;
  const last = lastKnown;
  if (
    last &&
    last.size === known.size &&
    [...known].every(([question, counted]) => last.has(question) && sameCount(last.get(question), counted))
  )
    return last;
  lastKnown = known;
  return known;
}

/** A tab's badge: its count from the batch, or the grid's own total when the tab is the one on screen. */
function TabCount({ counted }: { counted?: Counted | null }) {
  // null is a current result with no count, not permission to show an older one.
  const said = counted == null ? '' : `${formatNumber(counted.total)}${counted.capped ? '+' : ''}`;
  /* The number in a box of its own, over the room a tab keeps for it (features.css). */
  return <span className="tab-count">{said && <span>{said}</span>}</span>;
}

export function AppList({ entry, spec, navigate, embedded = false, newButton, inDashboard = false, onTotal }: AppListProps) {
  useMessageLanguage();
  const caption = spec.label;
  const client = useQueryClient();
  const table = findTable(entry.table) as TableMeta | undefined;
  const tabs = shownTabs(spec);
  const refinement = visibleQuestion(spec, entry.query);
  // The name column's box, where one can be drawn (appListModel.ts).
  const naming = searchColumn(table);
  const declared = [...new Set([...(naming ? [naming] : []), ...(spec.filters ?? (table ? deriveFilterNames(table) : []))])];
  /* A row-defined column among the filters is its fields' boxes, once its definitions are read (DefinedFields.tsx). */
  const bound = table ? resourceOf(shell().app(), table.id)?.defined : undefined;
  const boundNames = bound ? declared.filter((name) => Object.hasOwn(bound, name)) : [];
  const [definedBoxes, setDefinedBoxes] = useState<Record<string, Box[]>>({});
  const onDefinedBoxes = useCallback((column: string, next: Box[]) => setDefinedBoxes((previous) => ({ ...previous, [column]: next })), []);
  const names = declared.flatMap((name) => (boundNames.includes(name) ? (definedBoxes[name] ?? []).map((box) => box.column) : [name]));
  /* The resource's caption, through the label source every surface reads (appLabels.ts). */
  const captionOf = (name: string) => columnLabel(spec.table, name) ?? humanName(name);
  const near = [...declared, ...(table?.columns.map((column) => column.name) ?? [])];
  const labelOf = (name: string) => filterLabel(name, captionOf, near);
  const form = useRef<HTMLFormElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const crumbs = useCrumbSlots();
  const inCrumbs = !embedded && !inDashboard && Boolean(crumbs.note && crumbs.tools);
  const [gridResult, setGridResult] = useState<{
    query: string;
    connection: string | null | undefined;
    total: number | null;
    capped: boolean;
  }>();
  const connection = state.activeConnection;
  const gridCurrent = gridResult?.query === entry.query && gridResult.connection === connection ? gridResult : undefined;
  const gridTotal = gridCurrent?.total;
  const gridCapped = gridCurrent?.capped === true;
  const [advancedOpen, setAdvanced] = useState(false);
  const rail = useRef<HTMLElement>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  /* The rail needs more room than a phone query describes: see RAIL_QUERY. */
  const railNarrow = useMediaQuery(RAIL_QUERY);
  /* An embedded list is a page's chooser, too narrow for a rail: it keeps the bar. */
  const railed = spec.filterBar === 'rail' && !embedded && !inDashboard;
  const [sheet, setSheet] = useState(false);

  /* What the person set by hand, box by box, since this question was
     drawn. Only a touched box speaks on submit — in the bar, that is the
     search box; every picker applies itself. */
  const boxes = useMemo(
    () =>
      table
        ? declared
            .flatMap((name) => (boundNames.includes(name) ? (definedBoxes[name] ?? []) : boxesFor(table, [name], labelOf)))
            .map((box) => (box.kind === 'text' && spec.suggest?.[box.column] ? { ...box, suggest: spec.suggest[box.column] } : box))
        : [],
    [table, names.join(','), spec, definedBoxes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [edits, setEdits] = useState<Record<string, BoxEdit>>({});
  const editsNow = useRef(edits);
  editsNow.current = edits;
  const touched = (column: string) => column in editsNow.current;
  const tailOf = (box: (typeof boxes)[number]) =>
    boxTail(box, editsNow.current[box.column], conditionTail(refinement, box.column) as string);
  const litTab = litTabFor(tabs, refinement, names);
  /* The name column's box is the bar's search; every other box is a picker. */
  const searchBox = boxes.find((box) => box.column === naming && box.kind === 'text');

  /* The saved views of this list, by the view's key: two views over one
     table are two lists with their own working sets. The server says whose
     they are — the App's shared list, or the signed-in account's own — or
     that this reader cannot save (a row policy, a tenant, signed out). */
  const viewKey = spec.id ?? `table:${entry.table}`;
  const saved = useSavedViews(viewKey);
  // A dashboard's list keeps the dashboard's question: views are the list room's to save.
  const yours = inDashboard ? [] : saved.views;
  const store = saved.store;
  const savable = !inDashboard && (store === 'shared' || store === 'account');
  const yourLit = yours.findIndex((f) => canonicalize(f.query) === canonicalize(refinement));
  /* The strip fits its row (useTabFold.ts): the list's tabs by their place, then the saved views' heading, then each
     saved view; what does not fit is under More, and the lit one never is. */
  const savedAt = tabs.length + 1;
  const { strip: tabStrip, folded } = useTabFold(
    tabs.length + (yours.length ? yours.length + 1 : 0),
    yourLit === -1 ? litTab : savedAt + yourLit,
  );
  const foldMark = (at: number) => ({
    'data-fold': at,
    'data-folded': folded.has(at) ? '' : undefined,
    'aria-hidden': folded.has(at) || undefined,
  });
  const writeViews = useMutation({
    mutationFn: (change: (views: SavedView[]) => SavedView[]) => writeSavedViews(client, viewKey, change),
    onError: (err: Error) => toast(err.message, 'error'),
  });

  /* Every control funnels here: one composition, one navigation. A control
     that knows where the focus belongs next — a picker in a popover, a chip's
     way out — says which column's control takes it. */
  const apply = (typed: string, focus?: string) => {
    const active = document.activeElement as HTMLElement | null;
    const boxHome = active?.closest?.('[data-column]') as HTMLElement | null;
    refocus = focus
      ? { column: focus }
      : boxHome
        ? { column: boxHome.dataset.column, value: active?.dataset?.value }
        : active?.getAttribute?.('role') === 'tab'
          ? { tab: active.textContent ?? '' }
          : null;
    state.page = 0;
    navigate(wholeQuery(spec, typed));
  };

  const currentText = () => filter.current?.value ?? refinement;

  /* Everything applied, as chips — each condition with its own way out, and
     the leftover clauses (a sort, a hand-written group) as one chip
     when no tab explains them. The bar says them in its own row
     (ListFilterBar.tsx); a list without one says them here. */
  const residue = litTab === -1 ? residueOf(refinement, names) : '';
  /* Said in the App's words — the column's label, the rule's word for a
     value — never the language the controls wrote (conditionWords.ts). */
  const { speaker, andWords, sayCondition, sayFilter, sayQuestion, sayTails } = useConditionWords(table, [
    refinement,
    ...yours.map((view) => view.query),
  ]);
  const residueChip = residue
    ? {
        text: andWords(sayQuestion(speaker, residue)),
        remove: () => {
          let text = '';
          for (const box of boxes) text = withCondition(text, box.column, tailOf(box));
          apply(text);
        },
      }
    : undefined;
  const chips: Array<{ text: string; remove: () => void }> = [];
  for (const box of boxes) {
    const tails = ownedTails(refinement, box.column);
    if (!tails.length) continue;
    // The lit tab already says its own conditions; a chip would repeat it.
    if (litTab >= 0 && mentionsColumn(tabs[litTab].query ?? '', box.column)) continue;
    chips.push({
      text: sayTails(speaker, box.column, tails),
      remove: () => apply(withCondition(currentText(), box.column, '')),
    });
  }
  if (residueChip) chips.push(residueChip);

  const chipList = chips.map((c) => (
    <span key={c.text} className="applist-chip">
      <span className="applist-chip-text">{c.text}</span>
      <button type="button" className="applist-chip-x" aria-label={say('common.remove2', { text: c.text })} onClick={c.remove}>
        ×
      </button>
    </span>
  ));

  const isDefault = canonicalize(entry.query) === canonicalize(appListQuery(spec, 0));
  const exactTab = litTab >= 0 && canonicalize(refinement) === canonicalize(tabs[litTab].query ?? '');
  const offerSave = savable && !(isDefault || exactTab || yourLit >= 0 || !refinement);
  const gridTab = tabs.findIndex((_, i) => squeeze(appListQuery(spec, i)) === squeeze(entry.query));
  /* The badges not already on screen: the grid's own total answers the tab
     it shows, so that one is never asked twice (and a list whose grid is
     still loading does not ask again once it lands). */
  const tabCounts = useTabCounts(
    tabs.length > 1 || yours.length > 0
      ? [
          ...tabs.flatMap((_, i) => (i === gridTab ? [] : [appListQuery(spec, i)])),
          ...yours.map((f) => squeeze(`${entry.table} ${f.query}`)),
        ]
      : [],
  );

  /* The grid's own total is a count its tab's badge said: kept with the batches, for the placeholder. */
  useEffect(() => {
    if (typeof gridTotal !== 'number' || gridTab < 0) return;
    const question = appListQuery(spec, gridTab);
    client.setQueryData(['count', connection ?? '', 'grid', question], new Map([[question, { total: gridTotal, capped: gridCapped }]]));
  }, [gridTotal, gridCapped, gridTab, connection]); // eslint-disable-line react-hooks/exhaustive-deps

  /* A tab's count: the grid's own total for the tab it shows, else the counts read for the strip. While the grid of
     the tab just chosen is on its way, its badge says what it last said, as every other badge does while its batch
     is: the strip's batch leaves that tab out, and once it was answered the badge stood empty until the rows came.
     An emptied badge is a narrower tab, and a strip at the edge of its fold took its last tab out of More for those
     few frames and put it back, on every visit to the list and every switch to a tab (a service-desk App's Inbox
     flickered at a desk); where nothing folds, the search box beside the strip jumped instead. */
  const countOf = (i: number) => {
    const question = appListQuery(spec, i);
    if (i !== gridTab) return tabCounts?.get(question);
    if (typeof gridTotal === 'number') return { total: gridTotal, capped: gridCapped };
    if (gridCurrent) return null;
    return tabCounts?.has(question) ? tabCounts.get(question) : knownCounts(client)?.get(question);
  };
  const pickTab = (i: number) => {
    if (i === litTab) return;
    state.page = 0;
    /* Swapping tabs swaps the tab's clause and keeps the boxes: the reader
       who narrowed to one customer and flips from Open to Done is asking
       about the same customer. Only what the person set by hand travels;
       and the tab wins over a box for its own columns. */
    let text = tabs[i].query ?? '';
    for (const box of boxes) {
      if (!touched(box.column)) continue;
      if (mentionsColumn(text, box.column)) continue;
      text = withCondition(text, box.column, tailOf(box));
    }
    apply(text);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    /* Touched boxes fold into the text on the way out; untouched ones stay
       silent — the text already says what they would. */
    let text = currentText();
    for (const box of boxes) {
      if (touched(box.column)) text = withCondition(text, box.column, tailOf(box));
    }
    apply(text);
  };

  /* A view is the question on screen — tab, filters and sort — as text. */
  /* A view's name starts as what it asks, in the reader's words: "Status is Open and Owner is me". */
  const viewWords = (query: string) => {
    const conditions = sayFilter(speaker, splitQuery(`rows ${query}`).filter);
    return andWords(conditions.length ? conditions : sayQuestion(speaker, query));
  };
  const save = async () => {
    const name = await promptFor({
      title: say('saveThisView'),
      label: say('common.name'),
      value: viewWords(refinement),
      placeholder: say('mineDueThisWeek'),
    });
    if (!name || !String(name).trim()) return;
    writeViews.mutate((views) => withView(views, String(name), refinement));
  };
  const rename = async (view: SavedView) => {
    const name = await promptFor({
      title: say('renameThisView'),
      label: say('common.name'),
      value: view.name,
      hint: viewWords(view.query),
      confirmLabel: say('common.rename'),
    });
    if (!name || !String(name).trim()) return;
    writeViews.mutate((views) => renamedView(views, view.name, String(name)));
  };

  /* The paint that replaced the one this person was using: put focus back
     on the twin of the control they used — in a rail, the very value. */
  useEffect(() => {
    if (!refocus) return;
    const root = form.current?.parentElement;
    if (refocus.column) {
      const at = `[data-column="${CSS.escape(refocus.column)}"]`;
      const exact = refocus.value ? `${at} input[data-value="${CSS.escape(refocus.value)}"]` : '';
      for (const home of [rail.current, root]) {
        const twin = (exact && home?.querySelector(exact)) || home?.querySelector(`${at} input, ${at} button`);
        if (twin) {
          (twin as HTMLElement).focus();
          break;
        }
      }
    } else if (refocus.tab && root) {
      for (const t of root.querySelectorAll('[role="tab"]')) {
        if ((t.textContent ?? '') === refocus.tab) {
          (t as HTMLElement).focus();
          break;
        }
      }
    }
    refocus = null;
  }, []);

  /* The grid: rows only — an entry can carry a workbench tab (diagram,
     definition) across the mode flip, and the diagram under the app's
     filter boxes was a surface those controls cannot filter. The keys the
     app did not choose to show ride along hidden. */
  const chosen = new Set(spec.show ?? []);
  /* A reference is drawn by its record's name, read beside it (appListModel's referenceNames). */
  const referenceLabels = useMemo(() => listReferenceNames(spec), [spec]);
  const named = Object.values(referenceLabels).filter((name) => !chosen.has(name));
  const hide =
    chosen.size && table
      ? [
          ...new Set([
            ...primaryKey(table),
            ...(recordLabel(table) && labelPath(table) ? [labelPath(table)!] : []),
            ...(spec.order ? [spec.order] : []),
            ...subtitleColumns(entry.table, [...chosen]),
            ...editedReferences(spec),
            ...(spec.opens ? [spec.opens] : []),
            ...named,
          ]),
        ].filter((name) => !chosen.has(name))
      : named;
  /* A join table's list opens what each row is about, by its name where the list shows it. */
  const rowOpens = useMemo(
    () =>
      spec.opens
        ? {
            column: spec.opens,
            label:
              referenceLabels[spec.opens] ??
              spec.show?.find((name) => name.startsWith(`${spec.opens}.`) && !name.slice(spec.opens!.length + 1).includes('.')),
          }
        : null,
    [spec.opens, spec.show, referenceLabels],
  );
  const gridEntry = useMemo(() => ({ kind: 'table' as const, table: entry.table, query: entry.query }), [entry.table, entry.query]);
  /* Totals are over everything the conditions match, not the page: one
     measure per column, asked in the list's own query family so a write
     that refreshes the rows refreshes the sums too. */
  // The conditions alone: a sort, a column list or a limit is the page's, not the sum's.
  const totalText = (column: string) => [entry.table, splitQuery(entry.query).filter, `sum ${column}`].filter(Boolean).join(' ');
  const totalAnswers = useQueries({
    queries: (spec.presentation ? [] : (spec.totals ?? [])).map((column) => ({
      queryKey: ['run', connection ?? '', 'total', totalText(column)],
      queryFn: async () => {
        const data = (await api('/api/breakdown', {
          text: totalText(column),
          limit: 1,
        })) as { rows?: Array<Record<string, unknown>> };
        const row = data.rows?.[0];
        return row ? row[Object.keys(row)[0]] : null;
      },
    })),
  });
  const totals =
    spec.totals?.length && !spec.presentation
      ? Object.fromEntries(spec.totals.map((column, i) => [column, totalAnswers[i]?.data]))
      : undefined;
  const onGrid = (result: ResourceHttpSuccess<'/api/run'>) => {
    setGridResult({
      query: entry.query,
      connection,
      total: typeof result.total === 'number' ? result.total : null,
      capped: 'cappedTotal' in result && result.cappedTotal === true,
    });
    onTotal?.(typeof result.total === 'number' ? result.total : undefined);
    /* "Fix the query above" must not point at a control the redraw hid. */
    if (result.errors?.length) setAdvanced(true);
  };

  // A failed query can still expose its recovery editor; ordinary browsing is opt-in.
  const showAdvanced = advancedOpen || (spec.advancedFilters === true && !boxes.length);
  const tabQuery = litTab >= 0 ? (tabs[litTab].query ?? '') : '';
  /* A range's figures in the App's own dress: the resource's currency before them (the App's
     `ui.currency` when the rule names none, as every other money figure), its unit after. */
  const display =
    (
      resourceOf(shell().app(), entry.table) as
        | {
            display?: Record<string, { format?: string; currency?: string; unit?: string }>;
          }
        | undefined
    )?.display ?? {};
  const unitOf = (column: string): FacetUnit | undefined => {
    const rule = display[column];
    if (rule?.format === 'money')
      return {
        currency: rule.currency ?? defaultCurrency(),
        ...(rule.unit ? { unit: rule.unit } : {}),
      };
    return rule?.unit ? { unit: rule.unit } : undefined;
  };
  /* The view's own `query` is its standing condition: hidden from the reader's question, but every facet count stands on it. */
  const railProps = table ? { table, boxes, refinement, tabQuery, standing: spec.query ?? '', unitOf } : undefined;
  /* Beside the rows, the chips head the results — where the eye is on the
     rows, with the Sort and one Clear all — not under the heading, a column
     away from the facets that set them. The phone's sheet keeps them above. */
  const beside = railed && !railNarrow && Boolean(railProps);
  /* The bar says what is applied in its own row, where it was set. */
  const chipsInBar = spec.filterBar !== 'none' && !railed && Boolean(table);
  const narrowed = boxes.filter((box) => facetActive(refinement, box.column, tabQuery)).length;
  /* What the grid's column menus write through (AppColumnMenu.tsx): read when
     a menu is used, so the grid is not redrawn each time it changes. */
  const menuHost = useRef<AppColumnMenuHost | null>(null);
  menuHost.current = table
    ? {
        table,
        query: entry.query,
        refinement,
        tabQuery,
        standing: spec.query ?? '',
        listKey: viewKey,
        unitOf,
        Picker: FilterPicker,
        boxFor: (column) =>
          boxes.find((box) => box.column === column && box.meta) ?? boxesFor(table, [column], labelOf).find((box) => box.meta),
        apply: (text, column) => {
          refocus = null;
          returnFocusTo(column);
          state.page = 0;
          navigate(wholeQuery(spec, text));
        },
        navigate: (query, column) => {
          refocus = null;
          returnFocusTo(column);
          state.page = 0;
          navigate(query);
        },
        /* Beside the rows the rail already shows the column's control: the menu goes there rather than drawing a second one. */
        railFacet: (column) =>
          beside ? (rail.current?.querySelector<HTMLElement>(`.facet[data-column="${CSS.escape(column)}"]`) ?? null) : null,
      }
    : null;
  const matched =
    typeof gridTotal === 'number'
      ? say('match', {
          gridTotal: new Intl.NumberFormat(formatLocale()).format(gridTotal),
        })
      : undefined;

  /* Narrowed past the tab — a search, a filter — to nothing: said as that,
     with the way back beside it. "No rows match." alone left the reader to
     find each chip's × (or the rail's Clear all) to see the list again.
     Clear keeps the tab and the order and drops the rest. */
  const refinedFilter = splitQuery(`rows ${refinement}`) as {
    filter: string;
    sort?: string;
  };
  /* The tab the conditions stand under, read without the order: a sort from
     the Sort menu lights no tab, and Clear must not drop the tab with it. */
  /* Each tab read without its order too: a tab carries its sort (`on_notice sort available_on`), and held against a
     filter with the order taken out it lit no tab, so a tab with no rows was said as a search that matched nothing,
     its own condition named as what narrowed it, with a Clear that left the tab. */
  const tabFilters = tabs.map((tab) => ({ ...tab, query: splitQuery(`rows ${tab.query ?? ''}`).filter }));
  const filterTab = litTabFor(tabFilters, refinedFilter.filter, names);
  const filterTabQuery = filterTab >= 0 ? (tabFilters[filterTab].query ?? '') : '';
  const narrowedPast =
    Boolean(refinedFilter.filter.trim()) &&
    canonicalize(refinedFilter.filter) !== canonicalize(splitQuery(`rows ${filterTabQuery}`).filter);
  const clearTo = [filterTabQuery, refinedFilter.sort].filter(Boolean).join(' ');
  const applyNow = useRef(apply);
  applyNow.current = apply;
  /* Kept while its words and target are unchanged, so the rows below (kept by
     `grid`) are not redrawn for a keystroke. */
  /* What narrowed it, said as the chips say it: the conditions past the tab's own. */
  const tabConditions = new Set(splitConditions(splitQuery(`rows ${filterTabQuery}`).filter).map((c: string) => canonicalize(c)));
  const pastTab = splitConditions(refinedFilter.filter).filter((c: string) => !tabConditions.has(canonicalize(c)));
  /* Said by the records' own noun where the resource names one ("No homes match"), not the list's caption, which may
     name a ledger ("No rent roll match"). */
  const listNoun = table ? resourceOf(shell().app(), entry.table)?.noun : undefined;
  const things = listNoun?.many ?? caption.toLowerCase();
  const narrowedBy = pastTab.length ? andWords(pastTab.map((c: string) => sayCondition(speaker, c))) : '';
  const noMatchText = narrowedBy
    ? message('filter.noMatches', { things, conditions: narrowedBy })
    : message('filter.noMatchesPlain', { things });
  const noMatches = useMemo(
    () => (
      <Empty
        className="list-empty list-no-matches"
        text={<span className="empty-note-title">{say('noMatches')}</span>}
        detail={noMatchText}
        action={
          <Button size="compact" onClick={() => applyNow.current(clearTo)}>
            {say('common.clear')}
          </Button>
        }
      />
    ),
    [noMatchText, clearTo],
  );

  /* The page's own list names itself in the crumb bar — title, count, star —
     with New at the bar's end, instead of a heading band of its own. An
     embedded list, or an App without breadcrumbs, keeps the heading row. */
  /* The rows, kept as one element for as long as what they are drawn from is
     unchanged. The search box is this room's state, so each character typed
     redrew the room and, with it, the whole grid under the box; now a
     keystroke redraws the box and the chips, and the rows are left alone. */
  const hideKey = hide.join('\n');
  const keptHide = useMemo(() => hide, [hideKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalsKey = totals ? JSON.stringify(totals) : '';
  const keptTotals = useMemo(() => totals, [totalsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const onGridNow = useRef(onGrid);
  onGridNow.current = onGrid;
  const keptOnGrid = useCallback((result: ResourceHttpSuccess<'/api/run'>) => onGridNow.current(result), []);
  const unrefined = !splitQuery(`rows ${refinement}`).filter.trim();
  const listEmpty = Boolean(!embedded && spec.empty && unrefined);
  /* A list that says nothing of its own empty state says what belongs in it, by its noun, and offers New where the
     room does: "No work orders yet. Use New to add the first work order." A narrowed list keeps its own words. */
  const noun = resourceOf(shell().app(), entry.table)?.noun;
  const nothingYet =
    !embedded && !spec.empty && unrefined && table ? (
      <ListEmpty
        spec={{
          title: message('common.noYet', { things: noun?.many ?? pluralOf(recordNoun(noun, table.name)) }),
          ...(newButton && !inDashboard ? { description: say('addTheFirst', { thing: recordNoun(noun, table.name) }) } : {}),
        }}
      />
    ) : undefined;
  /* A tab with nothing under it is not a search that missed: it says the tab is empty, by the records' noun and the
     tab's own word, with nothing to clear. Left to the grid, it said nothing at all. */
  const tabEmpty =
    !embedded && !unrefined && !narrowedPast && filterTab >= 0 && table ? (
      <Empty
        className="list-empty"
        text={say('noneInTab', { things: noun?.many ?? pluralOf(recordNoun(noun, table.name)), tab: tabs[filterTab].label ?? '' })}
      />
    ) : undefined;
  const exportOff = !exportOffered(shell().app(), entry.table);
  /* A board's lanes offer New where the room does (BoardList): a boolean, so the room's fresh button each render does
     not redraw the rows. */
  const offersNew = Boolean(newButton) && !embedded && !inDashboard;
  const gridPage = state.page,
    gridSize = pageSize();
  const grid = useMemo(
    () => (
      <div className={`applist-grid${embedded ? '' : ' applist-room'}`}>
        {spec.quickAdd && table && !embedded && !inDashboard && (
          <div className="grid-inset">
            <QuickAdd
              table={table}
              form={spec.form}
              onAdded={() => {
                void client.invalidateQueries({
                  queryKey: ['run', connection ?? ''],
                });
                void client.invalidateQueries({
                  queryKey: ['count', connection ?? ''],
                });
              }}
            />
          </div>
        )}
        <BoardNewForm.Provider value={offersNew ? (spec.form ?? {}) : null}>
          <RowOpensContext.Provider value={rowOpens}>
            <TableRoom
              entry={gridEntry}
              sizing={spec.sizing}
              chrome={false}
              summaries
              inset={!inDashboard}
              embedded={inDashboard}
              hide={keptHide}
              referenceLabels={referenceLabels}
              totals={keptTotals}
              density={spec.density}
              /* A ⋯ with nothing a reader may run is a dead control and a reserved column; the App payload already says what they may run. */
              rowActions={Boolean(
                spec.rowActions && !spec.presentation && !embedded && mayRunAny(shell().app(), entry.table, spec.actions ?? []),
              )}
              editable={spec.presentation || embedded ? undefined : spec.editable}
              inCrumbs={inCrumbs}
              onResult={keptOnGrid}
              presentation={embedded ? undefined : spec.presentation}
              present={shell().present ?? undefined}
              empty={
                embedded ? undefined : narrowedPast ? (
                  noMatches
                ) : listEmpty && spec.empty ? (
                  <ListEmpty spec={spec.empty} />
                ) : (
                  (nothingYet ?? tabEmpty)
                )
              }
              actions={embedded ? undefined : spec.actions}
              listLabel={caption}
              order={embedded ? undefined : spec.order}
              export={exportOff ? false : undefined}
              interactive={embedded ? false : undefined}
            />
          </RowOpensContext.Provider>
        </BoardNewForm.Provider>
      </div>
    ),
    [
      gridPage,
      gridSize,
      embedded,
      inDashboard,
      spec,
      table,
      client,
      connection,
      gridEntry,
      keptHide,
      referenceLabels,
      keptTotals,
      inCrumbs,
      keptOnGrid,
      listEmpty,
      narrowedPast,
      noMatches,
      filterTab,
      caption,
      exportOff,
      offersNew,
      rowOpens,
    ],
  );
  /* A signed-out visitor reads the storefront, not the tool (docs/design.md,
     public pages): a match count chip and a favourites star are an
     operator's furniture there. */
  const visitor = shell().publicVisitor();
  const title = (
    <>
      <h1 className={`applist-title${spec.heading === false ? ' visually-hidden' : ''}`}>{caption}</h1>
      {typeof gridTotal === 'number' && !visitor && spec.heading !== false && (
        <span className="applist-count" title={say('rowsTheTabAndFilters')}>
          {formatNumber(gridTotal)}
          {gridCapped ? '+' : ''}
        </span>
      )}
      {spec.favorite && spec.id && !visitor && <FavoriteStar favorite={{ kind: 'view', view: spec.id, label: caption }} name={caption} />}
    </>
  );
  return (
    <>
      {boundNames.map((name) => (
        <DefinedBoxes
          key={name}
          column={name}
          binding={bound![name]}
          per={bound![name].per ? oneValue(conditionTail(refinement, bound![name].per!) as string) : undefined}
          onBoxes={onDefinedBoxes}
        />
      ))}
      {inCrumbs && createPortal(title, crumbs.note!)}
      {inCrumbs && !spec.quickAdd && newButton && createPortal(newButton, crumbs.tools!)}
      <div className={`applist-head${inCrumbs ? ' in-crumbs' : ''}`}>
        {!inCrumbs && !inDashboard && (
          <div className="applist-head-row" ref={head}>
            {title}
            {!spec.quickAdd && newButton}
          </div>
        )}
        {/* In the layout under a heading, chips or none: a row that appears with the
            first filter shoves everything down a line under a reader's eyes.
            Beside a title in the crumb bar the empty row folds away (features.css). */}
        {!beside && !chipsInBar && <div className="applist-chips">{chipList}</div>}
      </div>
      <div className="applist-controls" role="group" aria-label={say('listControls', { caption })}>
        {(tabs.length > 1 || yours.length > 0) && (
          <div className="tabs folds" ref={tabStrip}>
            <div className="tabs-row" role="tablist">
              {tabs.map((tab, i) => (
                <button
                  key={tab.label}
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={i === litTab && yourLit === -1}
                  onClick={() => pickTab(i)}
                  {...foldMark(i)}
                >
                  <span>{tab.label}</span>
                  <TabCount counted={countOf(i)} />
                </button>
              ))}
              {yours.length > 0 && (
                <span className="tab-group" {...foldMark(tabs.length)} aria-hidden="true">
                  {tabs.length > 1 && <span className="tab-divider" />}
                  <span className="tab-group-label">{store === 'account' ? say('myViews') : say('savedViews')}</span>
                </span>
              )}
              {/* The × is a real button *beside* the tab, not a span inside it:
              interactive-inside-interactive is invalid ARIA. */}
              {yours.map((f, i) => (
                <span key={f.name} className="tab-wrap" role="presentation" {...foldMark(savedAt + i)}>
                  <button
                    type="button"
                    role="tab"
                    className="tab tab-yours"
                    aria-selected={i === yourLit}
                    title={`${viewWords(f.query) || say('everything')} — ${store === 'account' ? say('yourView') : say('aSavedView')}`}
                    onClick={() => {
                      if (i !== yourLit) {
                        state.page = 0;
                        apply(f.query);
                      }
                    }}
                  >
                    <span>{f.name}</span>
                    <TabCount counted={tabCounts?.get(squeeze(`${entry.table} ${f.query}`))} />
                  </button>
                  {savable && (
                    <button
                      type="button"
                      className="tab-x"
                      title={say('common.removeName', { name: f.name })}
                      aria-label={say('removeTheView', { name: f.name })}
                      onClick={() => writeViews.mutate((views) => withoutView(views, f.name))}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            <div className="tab-more" data-fold-more="" data-folded={folded.size ? undefined : ''} aria-hidden={!folded.size || undefined}>
              <DropMenu
                className="tab-more-menu"
                triggerClassName="tab"
                label={message('common.more')}
                popupClassName="page-actions-popup"
                align="end"
              >
                {tabs.map((tab, i) =>
                  folded.has(i) ? (
                    <DropItem key={tab.label} className="page-actions-item" onClick={() => pickTab(i)}>
                      <span>{tab.label}</span>
                      <TabCount counted={countOf(i)} />
                    </DropItem>
                  ) : null,
                )}
                {yours.some((_, i) => folded.has(savedAt + i)) && (
                  <DropGroup labelClassName="more-group-label" label={store === 'account' ? say('myViews') : say('savedViews')}>
                    {yours.map((f, i) =>
                      folded.has(savedAt + i) ? (
                        <DropItem
                          key={f.name}
                          className="page-actions-item"
                          onClick={() => {
                            state.page = 0;
                            apply(f.query);
                          }}
                        >
                          {f.name}
                        </DropItem>
                      ) : null,
                    )}
                  </DropGroup>
                )}
              </DropMenu>
            </div>
          </div>
        )}
        {spec.filterBar !== 'none' && (
          <form className="applist-filterbar" ref={form} onSubmit={submit}>
            <div className="applist-fields">
              {chipsInBar && table && (
                <ListFilterBar
                  table={table}
                  boxes={boxes}
                  search={searchBox}
                  refinement={refinement}
                  tabQuery={tabQuery}
                  standing={spec.query ?? ''}
                  unitOf={unitOf}
                  typed={searchBox ? edits[searchBox.column]?.raw : undefined}
                  onType={(raw) => {
                    if (!searchBox) return;
                    /* Now, not on the next paint: the search field's own × asks in the same event. */
                    editsNow.current = {
                      ...editsNow.current,
                      [searchBox.column]: { raw },
                    };
                    setEdits(editsNow.current);
                  }}
                  onSearch={() => form.current?.requestSubmit()}
                  apply={apply}
                  current={currentText}
                  residue={residueChip}
                  listLabel={caption}
                  phone={phone}
                  onSheet={() => setSheet(true)}
                />
              )}
              {/* Beside a rail the Sort heads the results with the chips instead. */}
              {spec.sorts?.length && !beside ? (
                <SortMenu
                  sorts={spec.sorts}
                  sort={spec.sort}
                  query={entry.query}
                  onPick={(query) => {
                    walk.page = 0;
                    navigate(query);
                  }}
                />
              ) : null}
              {/* The view's own verbs — how to ask, keep and forget the question —
              together at the bar's end, not strewn between the filters. */}
              <div className="applist-actions">
                {railed && railNarrow && railProps && boxes.length > 0 && (
                  <button type="button" className="applist-toggle" aria-haspopup="dialog" onClick={() => setSheet(true)}>
                    {narrowed ? say('common.filters', { narrowed }) : say('common.filtersButton')}
                  </button>
                )}
                {spec.advancedFilters === true && boxes.length > 0 && (
                  <button
                    type="button"
                    className="applist-toggle"
                    aria-expanded={showAdvanced}
                    onClick={() => {
                      setAdvanced(!showAdvanced);
                      // Opening an inline editor must not scroll its toggle beneath
                      // the sticky trail, leaving the same control impossible to close.
                      if (!showAdvanced) setTimeout(() => filter.current?.focus({ preventScroll: true }), 0);
                    }}
                  >
                    {say('advanced')}
                  </button>
                )}
                {/* Saving and renaming never both apply: a question already kept is not offered again. */}
                {offerSave && (
                  <button
                    type="button"
                    className="applist-toggle"
                    title={store === 'account' ? say('keepThisTabIts') : say('keepThisTabItsFilters')}
                    onClick={() => void save()}
                  >
                    {say('saveView')}
                  </button>
                )}
                {savable && yourLit >= 0 && (
                  <button type="button" className="applist-toggle" onClick={() => void rename(yours[yourLit])}>
                    {say('renameView')}
                  </button>
                )}
              </div>
            </div>
            <div className="applist-advanced" hidden={!showAdvanced}>
              <input
                ref={filter}
                type="text"
                className="applist-filter"
                defaultValue={refinement}
                placeholder={naming ? say('contains', { naming }) : say('filterRecords')}
                aria-label={say('filter', { caption })}
                /* The form has no submit button and, beside the search box, two
               fields, so Enter submits by hand rather than by implicit submission. */
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    form.current?.requestSubmit();
                  }
                }}
              />
            </div>
          </form>
        )}
        {/* A phone's Records/Table switch, drawn here by the list (TableView): its own row over the rows cost a
            line of every list's first screen. */}
        {inCrumbs && <span className="applist-presentation" ref={listControlsRef} />}
      </div>
      {beside && railProps ? (
        <div className="applist-body has-rail">
          <aside className="filter-rail" ref={rail} aria-label={say('captionFilters', { caption })}>
            <FilterRail {...railProps} clearAll={false} onChange={apply} status={matched} />
          </aside>
          <div className="applist-results">
            <div className="applist-results-head">
              <div className="applist-chips" role="group" aria-label={say('filtersApplied', { caption })}>
                {chipList}
                {narrowed > 0 && (
                  <button
                    type="button"
                    className="applist-chips-clear"
                    onClick={() =>
                      apply(
                        clearFacets(
                          refinement,
                          boxes.map((box) => box.column),
                          tabQuery,
                        ),
                      )
                    }
                  >
                    {say('list.clearAll')}
                  </button>
                )}
              </div>
              {spec.sorts?.length ? (
                <SortMenu
                  sorts={spec.sorts}
                  sort={spec.sort}
                  query={entry.query}
                  onPick={(query) => {
                    walk.page = 0;
                    navigate(query);
                  }}
                />
              ) : null}
            </div>
            <AppColumnMenuContext.Provider value={menuHost}>{grid}</AppColumnMenuContext.Provider>
          </div>
        </div>
      ) : (
        <AppColumnMenuContext.Provider value={menuHost}>{grid}</AppColumnMenuContext.Provider>
      )}
      {/* The phone's pickers: the rail's sheet — for a bar, every filter but the search it keeps in view. */}
      {sheet && railProps && (
        <FilterSheet
          {...railProps}
          boxes={railed ? boxes : boxes.filter((box) => box !== searchBox)}
          onClose={() => setSheet(false)}
          onApply={(text) => {
            setSheet(false);
            apply(text);
          }}
        />
      )}
    </>
  );
}
