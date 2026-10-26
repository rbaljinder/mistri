/**
 * A page's related list: the rows that point at the root, a page at a time,
 * drawn as the section asks — a grid, cards, a gallery of photos, or
 * attachments when the rows are files — with the create, upload and pager
 * a list offers. Adding refreshes every list, timeline and count on the page.
 */
import { PresentationSwitch } from './PresentationSwitch.js';
import { useContext, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ownedBy } from '../requestIdentity.js';
import type { ResourceClientReply } from '@mistriwork/engine/shared/resourceHttp.js';
import { columnLabel, recordLabel, api as coreApi, findTable, openRecord, rowLabel, state, writeAllowed } from '../core.js';
import { relatedRows } from '../prefs.js';
import { formatBytes, formatNumber, formatRelativeDay } from '../locale.js';
import { columnKind, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { recordViewKey, recordViewLabel, withoutParent, withoutParentName } from '@mistriwork/engine/shared/referenceModel.js';
import { groupsBody, listView } from '@mistriwork/engine/shared/recordReads.js';
import { GROUP_ROWS_DEFAULT, GROUPS_DEFAULT } from '@mistriwork/engine/shared/pageModel.js';
import { groupFactPaths, groupTable } from '@mistriwork/engine/shared/pagePaths.js';
import { andQuery, quoteValue } from '@mistriwork/engine/shared/query.js';
import { Grid } from './Grid.js';
import { RowActions } from './RowActions.js';
import { RowTrailHosts, rowKeyString } from './RowHost.js';
import type { GroupMoves } from './groupMoves.js';
import { wholeColumn } from './placeOrder.js';
import { mayRunAny } from '../actionGrants.js';
import { offeredBy } from './appRooms.js';
import { Icon } from './Icon.js';
import { relatedCreatePlan } from '@mistriwork/engine/shared/relatedCreate.js';
import { inlineFileAddress } from './cardsModel.js';
import { filesOnLease, saveFileOnLease } from '../fileSource.js';
import { FILE_MAX_BYTES_DEFAULT } from '@mistriwork/engine/shared/fileBounds.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { pluralOf, recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import type { ServedResource } from '@mistriwork/engine/shared/servedApp.js';
import { canInsert, openRelatedRecord } from '../insert.js';
import type { FormCuration } from './newRecordModel.js';
import { formShownFields } from '@mistriwork/engine/shared/form.js';
import { pinnedBy, sectionClass } from './pageModel.js';
import { CurrentCard } from './PageCurrent.js';
import { PageRenderContext, recordReadNames, usePageApi, type RecordActions, type SlotProps } from './pageContext.js';
import { Loading, SectionBox } from './PageSectionBox.js';
import { ListEmpty } from './ListEmpty.js';
import { Empty } from './Notes.js';
import { RecordSummaries } from './RecordSummaries.js';
import { canDelete } from '../delete.js';
import { updateAttempts } from '../updateAttempts.js';
import { shell } from '../shellMode.js';
import { recordKey as checkedKey } from '../resourceRequests.js';
import { countsChanged } from './navCounts.js';
import { onDemand, useArrived } from './onDemand.js';
import { say } from '../copy/record/components/PageRelated.js';
import { served } from '../addressMount.js';

/* A list of files draws as attachments, fetched the first time a page holds one. */
const AttachmentList = onDemand(() => import('./AttachmentList.js'), 'AttachmentList');
const CardsList = onDemand(() => import('./CardsList.js'), 'CardsList');
/* A grouped list is one the page's author asked for; the rest of the record page never draws it. */
const GroupedBody = onDemand(() => import('./PageGroups.js'), 'GroupedBody');
const Gallery = onDemand(() => import('./Gallery.js'), 'Gallery');

/** The App resource over this table, if there is one. */
function resourceOf(table: TableMeta | undefined): ServedResource | undefined {
  if (!table) return undefined;
  const resources = (shell().app() as { resources?: Record<string, ServedResource> } | null)?.resources ?? {};
  return resources[table.id] ?? resources[table.name];
}

/** The `file` block of the App resource over this table, when its rows are files. */
function fileOf(table: TableMeta | undefined): ServedResource['file'] {
  return resourceOf(table)?.file;
}

/** Rows related to the root: the real list. */
export function ListSection(props: SlotProps) {
  return <RelatedList {...props} />;
}

/** Its first page as the server asks it for the page's compose (shared/recordReads.ts): the names and keys a row needs added. */
export function listRead(section: SlotProps['section'], plan: SlotProps['plan']) {
  return listView(recordReadNames(), section, plan, section.limit ?? (section.group ? GROUP_ROWS_DEFAULT : (relatedRows() as number)));
}

/** What a list's rows are called in a sentence: the section's title, or the table's name as the reader says it. */
export function listThings(section: SlotProps['section']): string {
  const table = findTable(section.from ?? '') as TableMeta | undefined;
  return (
    section.title ??
    (shell().inApp()
      ? (resourceOf(table)?.noun?.many ?? pluralOf(recordNoun(undefined, table?.name ?? section.from ?? '')))
      : (table?.name ?? section.from ?? ''))
  ).toLocaleLowerCase();
}

/**
 * The doors a related list offers this reader: the Add of its own, as a list view offers New, and the record's verbs
 * that add to it (`actions`). An empty list that offers one is never taken away, so this is asked by the list when it
 * draws its head and by the page when it decides whether to leave the list out (PageEmptyRun.tsx).
 */
export function relatedDoor(
  section: SlotProps['section'],
  base: TableMeta,
  recordKey: Record<string, unknown>,
  context: { preview?: boolean; actions?: RecordActions },
) {
  const table = findTable(section.from ?? '') as TableMeta | undefined;
  const app = shell().inApp();
  /* A list of files uploads where the reader may add them, whether or not it names a create: the
     file's own columns are the upload's to fill, so there is nothing for a create to say but its label. Any other
     list of the record's children offers its Add as a list view offers New — where this reader may add a row,
     through the child's own New form, bound to the record — unless it says `create: false`, or adds
     through the record's own verbs (`actions`) instead. */
  const noun = (
    app ? (resourceOf(table)?.noun?.one ?? recordNoun(undefined, table?.name ?? section.from ?? '')) : (table?.name ?? '')
  ).toLocaleLowerCase();
  const create = section.noCreate
    ? undefined
    : (section.create ??
      (app && fileOf(table)
        ? { label: say('attachFiles') }
        : app && !section.listActions && !section.similar && noun
          ? { label: say('addThing', { thing: noun }) }
          : undefined));
  /* `actions`: the record's own verbs that add to this list, in its head and not the record's (Page.tsx), each
     offered as the head would offer it — granted, and while its condition holds. */
  const placed =
    section.listActions && app && !context.preview && context.actions
      ? context.actions.list.filter((action) => section.listActions!.includes(action.id))
      : [];
  const creation =
    create && table && state.schema
      ? relatedCreatePlan(state.schema, base.id, table.id, section.path ?? '', create, {
          filter: section.filter,
        })
      : undefined;
  const defaults = creation?.bindings && Object.fromEntries(creation.bindings.map((b) => [b.column, recordKey[b.parent]]));
  /* An Add the list offers on its own stands back where the child needs another record this one cannot name (a work
     order's bike, from its mechanic's page): the author's `create` still offers it, asking for that record. */
  const offeredAlone = section.create === undefined && !(app && fileOf(table));
  const canCreate = Boolean(
    !context.preview &&
    app &&
    table &&
    !(offeredAlone && creation?.otherParents?.length) &&
    canInsert(table) &&
    defaults &&
    Object.values(defaults).every((v) => typeof v === 'string' || typeof v === 'number'),
  );
  return { noun, create, placed, creation, defaults, canCreate, door: canCreate || placed.length > 0 };
}

/** Rows related to the root, a page at a time — the real list, not a sample of one. */
function RelatedList({ section, plan, base, recordKey, onEdit, collapsed }: SlotProps) {
  const api = usePageApi();
  const { preview, isCurrent, openRelated, connection, recordName, onActionDone, actions: recordActions } = useContext(PageRenderContext);
  const queries = useQueryClient();
  const [added, setAdded] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const table = findTable(section.from ?? '') as TableMeta | undefined;
  const columnsOf = () =>
    Array.isArray(section.columns) && section.columns.length ? section.columns : (table?.columns ?? []).map((c) => c.name);
  /* A grouped list's `limit` is the rows to a group, and its pages are of groups (PageGroups.tsx). */
  const grouped = Boolean(section.group && plan.groups);
  const limit = section.limit ?? (grouped ? GROUP_ROWS_DEFAULT : (relatedRows() as number));
  const app = shell().inApp();
  const presentation = useMemo(() => listRead(section, plan), [plan.view, section.limit, limit, table, app]); // eslint-disable-line react-hooks/exhaustive-deps
  const { view, labelColumns, keyColumns, labelColumn } = presentation;
  /* A list of the record's own children holds the column that points back
     at it to one value, the record the page is on: like a tab's
     `status = new` in a summary (docs/design.md), it says nothing, so it is
     left out while anything else is shown. A similar list is not held. */
  const hidden = useMemo(() => {
    const back = app && !section.similar && section.path && !section.path.includes('.') ? section.path : undefined;
    const held = presentation.hidden as string[];
    const shown = columnsOf().filter((name) => !held.includes(name));
    return back && shown.includes(back) && shown.length > 1 ? [...held, back] : held;
  }, [presentation, app, section.similar, section.path, section.columns, table]); // eslint-disable-line react-hooks/exhaustive-deps
  const [offset, setOffset] = useState(0);
  const [layout, setLayout] = useState('records');
  /* A list of files waits for its drawing as it waits for its rows, in the section's own skeleton. */
  const attachmentsHere = useArrived(AttachmentList, Boolean(app && fileOf(table)));
  /* Cards and a gallery likewise: each is a part of its own, asked for beside the rows. */
  const asCards = typeof section.presentation === 'object' && section.presentation.kind === 'cards';
  const cardsHere = useArrived(CardsList, asCards);
  const galleryHere = useArrived(Gallery, section.presentation === 'gallery');
  const data = useQuery<ResourceClientReply<'/api/view/run'>>({
    queryKey: ['page-list', view, offset],
    queryFn: () => {
      if (!view) throw new Error(say('thisListHasNoView'));
      return api('/api/view/run', { view, offset });
    },
    enabled: !plan.empty && Boolean(view) && !grouped,
    staleTime: 0,
  });
  /* A grouped list asks its groups first, a page of them at a time; each group's rows follow (PageGroups.tsx). */
  const groupsAsked = useQuery<ResourceClientReply<'/api/breakdown'>>({
    queryKey: ['page-list', 'groups', plan.groups, offset],
    queryFn: () => api('/api/breakdown', groupsBody(plan.groups!, offset)),
    enabled: !plan.empty && grouped,
    staleTime: 0,
    /* A page of groups turned keeps the one standing until the next is in, so the box holds its height. */
    placeholderData: keepPreviousData,
  });
  /* The footer's sums: one row measured over every related row, planned on
     the server beside the list, so it counts past the page on screen. */
  const sums = useQuery<ResourceClientReply<'/api/breakdown'>>({
    queryKey: ['page-list', 'totals', plan.totals],
    queryFn: () => api('/api/breakdown', { def: plan.totals! }),
    enabled: !plan.empty && Boolean(plan.totals),
    staleTime: 0,
  });
  /* A similar list is empty when the record has no value to match on — no
     body type — and reads then as one that matched nothing: it has no
     reference to be missing. */
  /* Left out, or said in one line with its neighbours, while it has no rows, is the page's to decide: it alone sees
     the lists beside this one (PageEmptyRun.tsx). The line asks this list for its Add alone, below. */
  if (collapsed && plan.empty) return null;
  /* What the rows are called in a sentence: the section's title, or the table's name as the reader says it. */
  const things = listThings(section);
  const nothingYet = things ? say('common.noYet', { things }) : say('nothingHereYet');
  if (plan.empty && section.similar) {
    return (
      <SectionBox
        section={section}
        foldable={false}
        body={section.empty ? <ListEmpty spec={section.empty} /> : <Empty className="page-group-empty" text={nothingYet} />}
      />
    );
  }
  /* The record names no parent to list through. Said as the reader would
     say it — which reference is unset, and so what cannot be shown — with no
     header row over nothing: "This record has no account_id to list
     through" named a column, and the empty grid under it looked broken. */
  if (plan.empty) {
    const reference = section.of
      ? app
        ? ((columnLabel(base.id, section.of) as string | null) ?? humanName(section.of)).replace(/[\s_]+id$/i, '').toLocaleLowerCase()
        : section.of
      : 'reference';
    return (
      <SectionBox
        section={section}
        foldable={false}
        body={<Empty text={say('noIsSetSoThere', { reference, things: things || say('recordsNoun') })} />}
      />
    );
  }
  if (!view) return <SectionBox section={section} body={null} foldable={false} broken={say('thisListHasNoView')} />;
  if (
    (grouped ? groupsAsked.isPending : data.isPending) ||
    (!attachmentsHere && app && fileOf(table)) ||
    (asCards && !cardsHere) ||
    (section.presentation === 'gallery' && !galleryHere)
  )
    return <Loading section={section} />;
  const asking = grouped ? groupsAsked : data;
  if (asking.isError) return <SectionBox section={section} body={null} foldable={false} broken={(asking.error as Error).message} />;
  const groupsGot = grouped && groupsAsked.data && !('errors' in groupsAsked.data) ? groupsAsked.data : undefined;
  /* A grouped list draws its rows group by group (PageGroups.tsx): the flat read below stands as an empty page. */
  const got = grouped ? ((groupsGot ? { view: view, columns: [], rows: [] } : undefined) as typeof data.data) : data.data;
  if (!got || !('view' in got))
    return <SectionBox section={section} body={null} foldable={false} broken={got?.errors[0]?.message ?? say('thisListCouldNotBeRead')} />;
  /* Its children's names say the word that tells them apart, not the page's title again. */
  const rows = app && !section.similar ? withoutParentName(got.rows, Object.values(labelColumns), recordName) : got.rows;
  const summed = sums.data && 'rows' in sums.data ? ((sums.data.rows?.[0] ?? {}) as Record<string, unknown>) : undefined;
  const totals =
    section.totals?.length && plan.totals
      ? Object.fromEntries(section.totals.map((column, i) => [column, summed ? (summed[`total_${i}`] ?? 0) : undefined]))
      : undefined;
  const noRows = grouped ? (groupsGot?.rows.length ?? 0) === 0 : rows.length === 0;
  const authoredEmpty = offset === 0 && noRows && section.empty ? <ListEmpty spec={section.empty} /> : undefined;
  /* In an App an empty list is the empty sentence, not a header row over nothing. */
  const plainEmpty = app && offset === 0 && noRows ? <Empty text={section.title ? nothingYet : say('noRelatedRecordsYet')} /> : undefined;
  /* A footer that sums more rows than the page shows says so: "Total" under
     two rows that add up to less read as arithmetic gone wrong. */
  const totalsLabel =
    totals && (got.more || offset > 0 || (got.total !== undefined && got.total > rows.length))
      ? got.total === undefined
        ? say('totalAllThings', { things: things || say('recordsNoun') })
        : say('totalAllCountThings', { count: formatNumber(got.total), things: things || say('recordsNoun') })
      : undefined;
  const pinned = pinnedBy(view);
  const recordForRow = (row: Record<string, unknown>, outputs: readonly string[] = got.columns) => {
    const key = recordViewKey(keyColumns, outputs, row);
    // Inferred names live in the authored row. Explicit names must use only
    // the private projection, so a colliding output cannot impersonate them.
    const naming = table && recordLabel(table) === undefined ? row : {};
    return {
      key,
      label: table ? (rowLabel(table, { ...naming, ...pinned, ...key, ...recordViewLabel(labelColumn, outputs, row) }) as string) : '',
    };
  };
  /* The card's name as said on this page: without the page record's name
     before it, and none where it is that name — a review file named by its
     application's reference repeated the heading ("AL-1006" twice). The
     foot's "View …" still opens it. */
  const cardTitle = (label: string, page: string | undefined): string | null =>
    page?.trim() && label.trim() === page.trim() ? null : String(withoutParent(label, page));
  /* The one current row as a card, or the card saying there is none. */
  if (section.presentation === 'card' && table) {
    const noun = (app ? (resourceOf(table)?.noun?.one ?? recordNoun(undefined, table.name)) : table.name).toLocaleLowerCase();
    const shown = (got.columns ?? []).filter((name) => !(hidden as string[]).includes(name));
    const record = rows[0] ? recordForRow(rows[0]) : undefined;
    return (
      <section className={`${sectionClass(section)} page-card-section`}>
        <CurrentCard
          table={table}
          caption={section.title}
          row={rows[0]}
          columns={shown}
          show={Array.isArray(section.columns) ? section.columns : undefined}
          referenceLabels={labelColumns}
          labels={(section as { labels?: Record<string, string> }).labels}
          record={record}
          title={record && app ? cardTitle(record.label, recordName) : undefined}
          noun={noun}
          /* Said with the record's noun, never the title: a title is a heading, not a noun ("In the shop now" said
             "No in the shop now right now."). */
          empty={authoredEmpty ?? <Empty text={say('noRightNow', { thing: noun })} />}
        />
      </section>
    );
  }
  const summaries = app && table && keyColumns.length > 0 && rows.length > 0;
  /* `rowActions`: each row's own verbs from a ⋯ at its end — the same menu a list view's row has. A verb on a
     child moves the record too (a payment voided marks the order), so the page is read again after it. */
  const offered = section.rowActions && app && !preview && table ? offeredBy(resourceOf(table)).actions : undefined;
  const rowVerbs = offered?.some((action) => action.header !== false) && mayRunAny(shell().app(), table!.id, offered) ? offered : undefined;
  /* The list reads its key under its own output names (recordViewKey); a row's menu, like a list view's, names
     its record by the table's own columns, so they ride on each row, kept out of sight. */
  const keyNames = rowVerbs ? keyColumns.map(({ column }) => column).filter((column) => !(got.columns ?? []).includes(column)) : [];
  const gridRows = rowVerbs ? rows.map((row) => ({ ...row, ...(recordViewKey(keyColumns, got.columns, row) ?? {}) })) : rows;
  const hiddenColumns = new Set<string>(hidden);
  /* Related rows as cards: each row carries its key under its own column
     names, which is what a card opens its record with. */
  const drawn = typeof section.presentation === 'object' ? section.presentation : undefined;
  const cards = drawn?.kind === 'cards' ? drawn : undefined;
  /* An embedded custom list: its component draws the rows, each with its key under its own column names. */
  const custom = drawn?.kind === 'custom' ? drawn : undefined;
  const cardRows = drawn ? rows.map((row) => ({ ...row, ...(recordViewKey(keyColumns, got.columns, row) ?? {}) })) : [];
  /* An embedded board or calendar is drawn by the App's own component, as the view draws it, held to this record: a
     board reads each lane by its own query, so the record's condition is said in the query language. A list reached
     through `of` names its rows by another record's key, so it keeps the rows read here. */
  const lanes = section.lanes;
  const heldKey = Object.values(recordKey);
  const presented =
    lanes && table && app && shell().present && keyColumns.length
      ? shell().present!({
          presentation: lanes,
          table,
          data: { ...got, rows, table: table.id, ms: 0 } as never,
          entry: {
            kind: 'table',
            table: table.id,
            query:
              section.of || section.similar || heldKey.length !== 1
                ? ''
                : andQuery(section.filter, `${section.path} = ${quoteValue(heldKey[0])}`),
          },
          actions: undefined,
          listLabel: section.title ?? table.name,
          referenceLabels: labelColumns,
          interactive: !preview,
          recordNavigation: true,
          list: undefined,
          current: undefined,
          order: undefined,
          at: { page: 0, size: limit },
        })
      : null;
  const paged = !grouped && !presented && (got.more || offset > 0);
  const { create, placed, creation, defaults, canCreate } = relatedDoor(section, base, recordKey, { preview, actions: recordActions });
  /* The New form a row of this list is added through: the child resource's own
     (its captions, help, groups and narrowed pickers), asking what the create
     shows, starting from the create's defaults, the list's equalities and the
     record's own values it fills — and bound to the record, which it never asks. */
  const createForm = async (): Promise<FormCuration> => {
    const own = resourceOf(table)?.form as FormCuration | undefined;
    const bound = new Set(creation!.bindings!.map((b) => b.column));
    const shown = [...(create!.show ?? formShownFields(own) ?? creation!.show!)].filter((name) => !bound.has(name));
    const fill = Object.entries(creation!.fill ?? {});
    let filled: Record<string, unknown> = {};
    if (fill.length) {
      /* The record's values, read as this reader reads them: a column they cannot read fills nothing. */
      try {
        const data = await coreApi('/api/query', {
          ...ownedBy(connection ?? state.activeConnection),
          table: base.id,
          columns: [...new Set(fill.map(([, parent]) => parent))],
          filter: {
            groups: [Object.entries(recordKey).map(([column, value]) => ({ column, op: '=' as const, value: value as string | number }))],
          },
          limit: 1,
          offset: 0,
        });
        const row = (data.rows as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
        filled = Object.fromEntries(
          fill.flatMap(([child, parent]) => (row[parent] === null || row[parent] === undefined ? [] : [[child, row[parent]]])),
        );
      } catch {
        filled = {};
      }
    }
    return {
      // A row added beside its record stays beside it: the drawer, whatever the resource's own New form opens as.
      ...(own ?? {}),
      show: shown,
      open: 'drawer',
      // Steps carve the resource's own form; a create asks its own fields, on one page.
      steps: create!.show
        ? undefined
        : own?.steps
            ?.map((step) => ({ ...step, fields: step.fields.filter((name) => shown.includes(name)) }))
            .filter((step) => step.fields.length),
      defaults: { ...(creation!.defaults ?? {}), ...filled, ...defaults },
    };
  };
  const refreshLists = () =>
    void queries.invalidateQueries({
      predicate: (query) => ['page-list', 'page-timeline', 'page-metric', 'page-breakdown'].includes(String(query.queryKey[0])),
    });
  /* A resource whose rows are files draws as attachments: each a download,
     and, where the list may add, an upload bound to this record the way a
     related New form is. The file's own columns are the upload's to fill. */
  const file = app ? fileOf(table) : undefined;
  const owner = connection ?? state.activeConnection;
  /* Rename and Remove are offered where the server would accept them — the
     catalog's own answer for this reader, as the record's Delete asks it —
     and never in a preview, which writes nothing. */
  const nameColumn = file && table ? table.columns.find((column) => column.name === file.name) : undefined;
  const connectionWritable = Boolean(state.connections?.some((c: { id: string; writable?: boolean }) => c.id === owner && c.writable));
  const renamable = Boolean(
    !preview &&
    file &&
    table &&
    nameColumn &&
    !nameColumn.primaryKey &&
    nameColumn.writable !== false &&
    !table.isView &&
    writeAllowed(table.id) &&
    connectionWritable,
  );
  /* A grouped list's rows move between groups, and to their place in a ranked one (groupMoves.tsx), on the board's
     two paths: an ordinary update of the grouped column where this reader may write it, else the one command of the
     row's own that takes the group (`moveToSprint` with `{ sprint }`), asked nothing more. A ranked list is one read
     in a single number column, ascending, that the reader may write, as a list view's hand order is. */
  const groupMoves = ((): GroupMoves | undefined => {
    const by = section.group?.by;
    if (!grouped || !app || preview || !table || !by || by.includes('.') || !keyColumns.length || table.isView) return undefined;
    const may = (name: string) => {
      const column = table.columns.find((c) => c.name === name);
      return Boolean(
        column &&
        !column.primaryKey &&
        column.writable !== false &&
        column.changesBy !== 'actions' &&
        writeAllowed(table.id) &&
        connectionWritable,
      );
    };
    const parent = state.schema
      ? (groupTable(state.schema as DatabaseSchema, { from: table.id, group: section.group }) as TableMeta | undefined)
      : undefined;
    type Said = Record<string, string | number | boolean | null>;
    const write = async (key: Record<string, unknown>, values: Said, expected: Said) => {
      if (isCurrent && !isCurrent()) return { message: say('thisPageHasMoved'), refused: false };
      const outcome = await updateAttempts.run({ connection: owner ?? null, table: table.id, key }, values, () =>
        coreApi('/api/update', { ...ownedBy(owner), table: table.id, key: checkedKey(key), values, expected }),
      );
      return outcome.kind === 'applied'
        ? null
        : { message: outcome.message ?? '', refused: outcome.kind === 'rejected' || outcome.kind === 'blocked' };
    };
    const verb = may(by)
      ? undefined
      : (offeredBy(resourceOf(table))?.actions ?? [])
          .flatMap((action) => {
            if (action.command === undefined) return [];
            const takes = action.command.input.filter(
              (field) => field.name === by || (field.type === 'reference' && parent !== undefined && field.from === parent.id),
            );
            const rest = action.command.input.filter((field) => !takes.includes(field) && 'required' in field && field.required);
            const run =
              takes.length === 1 && !rest.length ? shell().slots.recordCommand?.(action.command, String(action.label)) : undefined;
            return run ? [{ run, input: takes[0].name, required: Boolean((takes[0] as { required?: boolean }).required) }] : [];
          })
          .at(0);
    if (!may(by) && !verb) return undefined;
    const order = (view?.orderBy ?? []) as Array<{ path: string; direction?: string }>;
    const sort = order.length === 1 ? order[0] : undefined;
    const rankColumn = sort && sort.direction !== 'desc' ? table.columns.find((c) => c.name === sort.path) : undefined;
    const ranked =
      rankColumn && may(rankColumn.name) && /int|real|num|dec|double|float|serial/i.test(rankColumn.type ?? '') ? rankColumn : undefined;
    return {
      keyOf: (row, columns) => {
        const key = recordViewKey(keyColumns, columns, row);
        const id = key ? rowKeyString(table, key) : null;
        return key && id ? { key, id } : null;
      },
      labelOf: (row, columns) => recordForRow(row, [...columns]).label,
      enters: (key) => (key === null || key === undefined ? may(by) || (verb !== undefined && !verb.required) : true),
      regroup: async (key, _label, from, to) => {
        if (verb) {
          const outcome = await verb.run(key as Record<string, string | number>, { [verb.input]: to ?? null });
          // A refusal is said where it was refused (the command's own pipeline).
          return outcome.status === 'applied' || outcome.status === 'done' ? null : '';
        }
        const failed = await write(key, { [by]: (to ?? null) as Said[string] }, { [by]: (from ?? null) as Said[string] });
        return failed ? failed.message : null;
      },
      ...(ranked
        ? {
            rank: {
              column: ranked.name,
              whole: wholeColumn(ranked.type),
              write: (key: Record<string, unknown>, _label: string, value: number, expected: unknown) =>
                write(key, { [ranked.name]: value }, { [ranked.name]: (expected ?? null) as Said[string] }),
            },
          }
        : {}),
      done: async () => {
        await queries.invalidateQueries({
          predicate: (query) => ['page-list', 'page-timeline', 'page-metric', 'page-breakdown'].includes(String(query.queryKey[0])),
        });
        void shell().undo.refresh();
        countsChanged();
      },
    };
  })();
  const removable = Boolean(!preview && file && table && canDelete(table));
  const renameFile = async (rowKey: Record<string, unknown>, next: string, original: string | null): Promise<string | null> => {
    if (!table || !file || (isCurrent && !isCurrent())) return say('thisPageHasMoved');
    const values = { [file.name]: next };
    const outcome = await updateAttempts.run({ connection: owner ?? null, table: table.id, key: rowKey }, values, () =>
      coreApi('/api/update', { ...ownedBy(owner), table: table.id, key: checkedKey(rowKey), values, expected: { [file.name]: original } }),
    );
    if (outcome.kind !== 'applied') return outcome.message;
    void shell().undo.refresh();
    refreshLists();
    return null;
  };
  const removeFile = async (rowKey: Record<string, unknown>): Promise<string | null> => {
    if (!table || (isCurrent && !isCurrent())) return say('thisPageHasMovedOn');
    try {
      const result = (await coreApi('/api/delete', { ...ownedBy(owner), table: table.id, key: checkedKey(rowKey), confirm: true })) as {
        deleted?: boolean | null;
        errors?: Array<{ message: string }>;
      };
      if (result?.deleted !== true || result.errors?.length) return result?.errors?.[0]?.message ?? say('theFileWasNotRemoved');
      refreshLists();
      countsChanged();
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
  const lease = filesOnLease();
  const attachments =
    file && table
      ? rows.flatMap((row) => {
          const rowKey = recordViewKey(keyColumns, got.columns, row);
          if (!rowKey) return [];
          const name =
            String(row[file.name] ?? '') || rowLabel(table, { ...pinned, ...rowKey, ...recordViewLabel(labelColumn, got.columns, row) });
          const meta = (got.columns ?? [])
            .filter(
              (column) =>
                ![file.name, file.content, file.type, file.thumbnail].includes(column) &&
                !(keyColumns as ReadonlyArray<{ column: string }>).some((key) => key.column === column) &&
                !(hidden as string[]).includes(column) &&
                row[column] != null &&
                row[column] !== '',
            )
            .map((column) =>
              column === file.size ? formatBytes(Number(row[column])) : (formatRelativeDay(String(row[column])) ?? String(row[column])),
            );
          const href = served(`/api/file?${new URLSearchParams({ ...ownedBy(owner), table: table.id, key: JSON.stringify(rowKey) })}`);
          const type = file.type && typeof row[file.type] === 'string' ? (row[file.type] as string) : undefined;
          return [
            {
              id: JSON.stringify(rowKey),
              name,
              href,
              meta,
              ...(type ? { type } : {}),
              inline: inlineFileAddress(table.id, rowKey, owner),
              ...(lease ? { save: () => saveFileOnLease(table.id, rowKey) } : {}),
              onOpen: () => void openRecord(table.id, rowKey, name),
              ...(renamable
                ? { rename: (next: string) => renameFile(rowKey, next, row[file.name] == null ? null : String(row[file.name])) }
                : {}),
              ...(removable ? { remove: () => removeFile(rowKey) } : {}),
            },
          ];
        })
      : [];
  /* A caption is words: a reference (the building the photo hangs from) or a number (its place in the order) says
     nothing under a picture, and read as "· 1 · 1". */
  const captions = (column: string) => {
    const meta = table?.columns.find((candidate) => candidate.name === column);
    return Boolean(meta && !meta.references && columnKind(meta.type) === 'text');
  };
  /* A gallery is the same rows as photos, drawn in place through the file
     route's inline mode; the shown columns that are not the file's own are
     each photo's caption. A resource whose rows are not files keeps its grid. */
  const gallery =
    /* On a tenant lease a photo has no address to draw in place (fileSource.ts): the files are listed instead. */
    section.presentation === 'gallery' && file && table && !lease
      ? rows.flatMap((row) => {
          const rowKey = recordViewKey(keyColumns, got.columns, row);
          if (!rowKey) return [];
          const words = (got.columns ?? [])
            .filter(
              (column) =>
                ![file.name, file.content, file.type, file.size, file.thumbnail].includes(column) &&
                !(keyColumns as ReadonlyArray<{ column: string }>).some((key) => key.column === column) &&
                !(hidden as string[]).includes(column) &&
                row[column] != null &&
                row[column] !== '' &&
                captions(column),
            )
            .map((column) => String(row[column]));
          const alt = words[0] ?? String(row[file.name] ?? '');
          return [
            {
              id: JSON.stringify(rowKey),
              src: inlineFileAddress(table.id, rowKey, owner),
              ...(file.thumbnail ? { thumb: inlineFileAddress(table.id, rowKey, owner, 'thumb') } : {}),
              alt,
              ...(words.length ? { caption: words.join(' · ') } : {}),
            },
          ];
        })
      : undefined;
  const send = async (picked: File): Promise<string | null> => {
    if (!table || (isCurrent && !isCurrent())) return say('thisPageHasMovedOnNothing');
    try {
      /* The encoder is the attachment list's, here since its Attach button was. */
      const { fileToBase64 } = await import('./AttachmentList.js');
      /* The file's row starts as a New from this list would: the create's
         defaults and the list's equalities, then the binding to this record. */
      const data = (await coreApi('/api/file/upload', {
        table: table.id,
        values: { ...creation!.defaults, ...defaults },
        ...ownedBy(connection),
        file: { name: picked.name, type: picked.type, data: await fileToBase64(picked) },
      })) as { errors?: Array<{ message: string }> };
      if (data?.errors?.length) return data.errors[0].message;
      setOffset(0);
      refreshLists();
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
  /* The list's verbs stand in its heading's row, after the heading, and go under it where the column is narrow,
     from the same edge: an aside's related list kept them on a row of their own, pushed to the far side. */
  /* A placed verb is the App's (Actions.tsx), and an embedded list's own component with the page's side of
     @mistriwork/mistri/ui (sdk/CustomList.tsx): each drawn through the shell's slot. */
  const { ActionBar, CustomList } = shell().slots;
  const tools =
    (canCreate && !file) || placed.length > 0 ? (
      <div className="page-related-create">
        {added && <span role="status">{say('recordAdded')}</span>}
        {placed.length > 0 && ActionBar && (
          <ActionBar
            tableId={base.id}
            actions={placed}
            recordKey={recordKey}
            label={recordName ?? ''}
            matches={recordActions!.matches}
            queryScope={recordActions!.queryScope}
            isCurrent={isCurrent}
            only={section.listActions}
            quiet
            canUpdate={recordActions!.canUpdate}
            grantedCommands={recordActions!.grantedCommands}
            grantedActions={recordActions!.grantedActions}
            onDone={() => {
              refreshLists();
              /* The record moved too (its counts, its stage): read again as the head's own verbs read it. */
              if (onActionDone) onActionDone();
              else onEdit({ inPlace: false });
            }}
          />
        )}
        {canCreate && !file && (
          <button
            type="button"
            className="ghost"
            ref={createButton}
            onClick={() => {
              if (isCurrent && !isCurrent()) return;
              setAdded(false);
              void createForm().then((form) =>
                isCurrent && !isCurrent()
                  ? undefined
                  : (openRelated ?? openRelatedRecord)(table!, form, () => {
                      if (isCurrent && !isCurrent()) return;
                      setAdded(true);
                      setOffset(0);
                      void queries.invalidateQueries({
                        predicate: (query) =>
                          ['page-list', 'page-timeline', 'page-metric', 'page-breakdown'].includes(String(query.queryKey[0])),
                      });
                      createButton.current?.focus();
                    }),
              );
            }}
          >
            + {create!.label}
          </button>
        )}
      </div>
    ) : undefined;
  /* An empty list said in one line: only its Add stands there, an upload for a list of files. */
  if (collapsed)
    return file && canCreate ? (
      <AttachmentList
        items={[]}
        empty={false}
        emptyText=""
        upload={{ label: create!.label, maxBytes: file.maxBytes ?? FILE_MAX_BYTES_DEFAULT, send }}
      />
    ) : (
      (tools ?? null)
    );
  return (
    <SectionBox
      section={section}
      foldable={false}
      tools={tools}
      body={
        <div className="page-list-body">
          {(file ? undefined : authoredEmpty) ??
            (grouped && groupsGot && view ? (
              <GroupedBody
                section={section}
                groups={groupsGot}
                offset={offset}
                perPage={section.group?.limit ?? GROUPS_DEFAULT}
                onOffset={setOffset}
                view={view}
                labelColumns={labelColumns}
                rowsPerGroup={limit}
                {...(groupMoves ? { moves: groupMoves } : {})}
                overall={
                  summed && totals
                    ? { label: say('totalAllThings', { things: things || say('recordsNoun') }), sums: totals as Record<string, unknown> }
                    : undefined
                }
                grid={(data, subtotals, subtotalsLabel) => {
                  /* Each group's table draws the same ⋯ an ungrouped list does: its own rows carry their keys, and
                     the host/menu pair belongs to this table alone, so one group's menu never reaches another's. */
                  const keyed = rowVerbs || groupMoves;
                  const groupKeys = keyed
                    ? keyColumns.map(({ column }) => column).filter((column) => !(data.columns ?? []).includes(column))
                    : [];
                  const groupRows = keyed
                    ? ((data.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
                        ...row,
                        ...(recordViewKey(keyColumns, data.columns ?? [], row) ?? {}),
                      }))
                    : data.rows;
                  const table_ = (
                    <Grid
                      table={table}
                      sizing={section.sizing}
                      data={keyed ? { ...data, rows: groupRows, columns: [...(data.columns ?? []), ...groupKeys] } : data}
                      hide={[...hidden, ...groupFactPaths(section), ...groupKeys, '__rank']}
                      referenceLabels={labelColumns}
                      totals={subtotals}
                      totalsLabel={subtotalsLabel}
                      interactive={false}
                      virtual={false}
                      dropColumns
                      emptyText={say('noRelatedRecordsYet')}
                      onRowClick={
                        table && keyColumns.length
                          ? (row) => {
                              const record = recordForRow(row, data.columns ?? []);
                              if (record.key) void openRecord(table.id, record.key, record.label);
                            }
                          : undefined
                      }
                    />
                  );
                  return rowVerbs ? (
                    <RowTrailHosts>
                      <RowActions
                        table={table!}
                        rows={groupRows as Array<Record<string, unknown>>}
                        actions={rowVerbs}
                        onDone={() => {
                          refreshLists();
                          onActionDone?.();
                        }}
                      />
                      {table_}
                    </RowTrailHosts>
                  ) : (
                    table_
                  );
                }}
              />
            ) : presented ? (
              presented.element
            ) : custom && table && CustomList ? (
              cardRows.length ? (
                <CustomList
                  table={table}
                  rows={cardRows}
                  spec={custom}
                  interactive={!preview}
                  label={section.title ?? table.name}
                  page={{ index: Math.floor(offset / Math.max(1, limit)), size: limit }}
                />
              ) : (
                <Empty className="page-group-empty" text={nothingYet} />
              )
            ) : cards && table ? (
              cardRows.length ? (
                <CardsList table={table} rows={cardRows} spec={cards} label={section.title ?? table.name} />
              ) : (
                <Empty className="page-group-empty" text={nothingYet} />
              )
            ) : gallery ? (
              <>
                {/* A gallery's New is an upload, for a reader who may add the files; everyone else sees the photos. */}
                {canCreate && (
                  <AttachmentList
                    items={[]}
                    empty={false}
                    emptyText=""
                    upload={{ label: create!.label, maxBytes: file!.maxBytes ?? FILE_MAX_BYTES_DEFAULT, send }}
                  />
                )}
                <Gallery
                  items={gallery}
                  label={section.title ?? say('photos')}
                  emptyText={section.title ? say('common.noYet', { things: section.title.toLocaleLowerCase() }) : say('noPhotosYet')}
                />
              </>
            ) : file ? (
              <AttachmentList
                items={attachments}
                empty={authoredEmpty}
                emptyText={section.title ? say('common.noYet', { things: section.title.toLocaleLowerCase() }) : say('noFilesYet')}
                upload={canCreate ? { label: create!.label, maxBytes: file.maxBytes ?? FILE_MAX_BYTES_DEFAULT, send } : undefined}
              />
            ) : (
              (plainEmpty ?? (
                <div className={summaries ? `responsive-results page-related-results show-${layout}` : undefined}>
                  {summaries && (
                    <>
                      <PresentationSwitch
                        layout={layout}
                        onChange={setLayout}
                        label={say('common.listPresentation')}
                        records={say('common.records')}
                        table={say('common.table')}
                      />
                      {/* A summary's title is the row's name, which on its parent's page says the word alone too. */}
                      <RecordSummaries
                        table={table}
                        data={{ ...got, rows }}
                        columns={got.columns.filter((name) => !hiddenColumns.has(name))}
                        referenceLabels={labelColumns}
                        parent={!section.similar && section.path && !section.path.includes('.') ? section.path : undefined}
                        recordForRow={
                          section.similar
                            ? recordForRow
                            : (row) => {
                                const record = recordForRow(row);
                                return { ...record, label: withoutParent(record.label, recordName) };
                              }
                        }
                      />
                    </>
                  )}
                  <div className="result-table">
                    {((grid) =>
                      rowVerbs ? (
                        <RowTrailHosts>
                          <RowActions
                            table={table!}
                            rows={gridRows}
                            actions={rowVerbs}
                            onDone={() => {
                              refreshLists();
                              onActionDone?.();
                            }}
                          />
                          {grid}
                        </RowTrailHosts>
                      ) : (
                        grid
                      ))(
                      <Grid
                        table={table}
                        sizing={section.sizing}
                        data={{ ...got, rows: gridRows, columns: [...(got.columns ?? columnsOf()), ...keyNames] }}
                        hide={keyNames.length ? [...hidden, ...keyNames] : hidden}
                        referenceLabels={labelColumns}
                        totals={totals}
                        totalsLabel={totalsLabel}
                        interactive={false}
                        virtual={false}
                        /* Beside an aside the main column is narrow: columns past the room are left out, the name and status kept, rather than cut at the edge. */
                        dropColumns
                        emptyText={
                          app
                            ? section.title
                              ? say('common.noYet', { things: section.title.toLocaleLowerCase() })
                              : say('noRelatedRecordsYet')
                            : say('noForThisRecord', { name: table?.name ?? section.from ?? '' })
                        }
                        onRowClick={
                          table && keyColumns.length
                            ? (row) => {
                                const record = recordForRow(row);
                                if (record.key) void openRecord(table.id, record.key, record.label);
                              }
                            : undefined
                        }
                      />,
                    )}
                  </div>
                </div>
              ))
            ))}
          {paged && (
            <div className="page-pager">
              <span className="step-control">
                <button
                  type="button"
                  className="step-button"
                  aria-label={say('previousRows')}
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                >
                  <Icon name="caret-left" size={16} />
                </button>
                <span className="page-range step-position">
                  {`${formatNumber(offset + 1)}–${formatNumber(offset + rows.length)}${got.total === undefined ? '' : say('common.ofTotal', { total: formatNumber(got.total) })}`}
                </span>
                <button
                  type="button"
                  className="step-button"
                  aria-label={say('moreRows')}
                  disabled={!got.more}
                  onClick={() => setOffset(offset + limit)}
                >
                  <Icon name="caret-right" size={16} />
                </button>
              </span>
            </div>
          )}
        </div>
      }
    />
  );
}
