/**
 * A page's head: the page's name (a picker among the table's other pages
 * while authoring), pin and layout, and, once a record is chosen, the
 * record's name as the room's heading with its star, trail, actions,
 * Delete, tags and pending bar. Everything that acts on the whole record
 * sits here, above the sections.
 */
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery.js';
import { useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@mistriwork/ui/Button.js';
import { columnDisplay, columnLabel, go, labelPath, rowLabel, state } from '../core.js';
import { readRecordSource, shareRecordSource } from '../recordSource.js';
import { pathEqualityFilter } from '../resourceRequests.js';
import { canEditRow, pendingCount, sameRow, stagedVersion, subscribeStaged } from '../write.js';
import type { AppAction } from '@mistriwork/engine/schema/model.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { factWord } from '@mistriwork/engine/shared/appCards.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { shell } from '../shellMode.js';
import { isPinned, togglePinned } from '../pagemarks.js';
import { Editable, PendingBar } from './Editable.js';
import { RefJump, Value } from './Value.js';
import { headerColumns } from '@mistriwork/engine/shared/recordReads.js';
import { presentationColumns } from './columnPresentation.js';
import { useDelete } from './DeleteButton.js';
import { DropItem } from '@mistriwork/ui/DropMenu.js';
import { FavoriteStar } from './FavoriteStar.js';
import { relabelFavorite, type Favorite } from './favorites.js';
import { Dropdown } from './Dropdown.js';
import { RecordTags } from './RecordTags.js';
import { RecordTrailNav } from './RecordTrailNav.js';
import { useWalk } from './walk.js';
import { rootLabel, sourceOf, type PageDef, type PageSection } from './pageModel.js';
import { PageRenderContext, recordReadNames, spoken, usePageApi } from './pageContext.js';
import { hueOf, initialsOf } from './valueModel.js';
import { useAvatarPhotos } from './avatarPhotos.js';
import { primaryKey } from '@mistriwork/engine/shared/schema.js';
import { documentsOf } from '../documents.js';
import type { PageProps } from './Page.js';
import { useMessageLanguage } from './useMessageLanguage.js';
import { say } from '../copy/record/components/PageHead.js';
import { recordNotFound } from './RecordGone.js';
import { drawnLayout } from '@mistriwork/engine/shared/pageLayouts.js';
import { useCrumbSlots } from './crumbSlot.js';
import { onDemand } from './onDemand.js';
import { liveKeyText, useLiveActive, useRecentChange } from '../liveState.js';

/* "Updated by Ana just now", once another person's change to this record has been told (liveState.ts). */
const LiveUpdatedLine = onDemand(() => import('./LiveNotices.js'), 'LiveUpdatedLine', { quiet: true });

export function PageHead({
  entry,
  page,
  base,
  others,
  onLayout,
  actions,
  host,
  onPending,
  title,
  gone = false,
  header,
  onSectionLabel,
  onTitleEditor,
  titleOwner,
}: PageProps & {
  onPending: (opts?: { inPlace?: boolean }) => void;
  title?: () => ReactNode;
  gone?: boolean;
  /** The page's record header (useRecordHeader, below), drawn here wherever it is written. */
  header?: { section: PageSection; index: number };
  onSectionLabel?: (index: number, label: string | undefined) => void;
  onTitleEditor?: (index: number, render: (() => ReactNode) | undefined) => void;
  titleOwner?: number;
}) {
  useMessageLanguage();
  useWalk();
  const { isCurrent } = useContext(PageRenderContext);
  const authoring = !shell().inApp() && !host;
  const key = entry.key;
  const changedElsewhere = useRecentChange(base.id, key ? liveKeyText(key) : '');
  /* A draft of this record under live sync: the notice that may come over it has its row reserved from the first
     edit, so its arrival moves nothing (LiveNotices.css). */
  useSyncExternalStore(subscribeStaged, stagedVersion, stagedVersion);
  const liveDraft = useLiveActive(base.id) && Boolean(key) && sameRow(base.id, key) && pendingCount() > 0;
  const [pinned, setPinned] = useState(() => isPinned(page.id) as boolean);
  const suggested = { id: `suggested:${page.base}`, name: `${page.base} (default)`, source: 'suggested' };
  const items = [...others, ...(others.some((p) => p.id === suggested.id) ? [] : [suggested])].filter((p) => p.id !== page.id);
  const sayPage = (p: { name: string; source: string }) => (p.source === 'suggested' ? spoken(p.name) : p.name);
  /* A record that is gone has no name any more: the one the link carried is the last it was known by, and
     as the page's heading it says the record exists. The crumb trail keeps it, as where the reader came from. */
  const label = gone ? recordNotFound(spoken(base.name)) : (entry.label ?? (key ? rootLabel(key) : ''));
  const phone = useMediaQuery(PHONE_QUERY);
  /* A record page's verbs stand at the end of the crumb bar, as a list's New
     does: the bar stays at the top of the pane however long the page, so the
     record's next step is always in reach, and the name beneath it is free to
     take its line. A room drawn inside another (a split's detail, a dialog)
     and a phone keep them in the head; a phone holds them at the foot of the
     screen (page.css). */
  const { tools: crumbTools } = useCrumbSlots();
  const actionsInBar = Boolean(crumbTools && !host && !phone && shell().inApp());
  const said = useRecordHeader({
    page,
    base,
    recordKey: key,
    header: gone ? undefined : header,
    onSectionLabel,
    onTitleEditor,
    titleOwner,
    onEdit: onPending,
  });
  /* Which verbs take something away is read on every App record page, with
     or without a header: its first verb is the filled one, and a confirmed
     or bad-toned one first would fill the button that ends the record. */
  const named = header?.section.destructive;
  const destructive =
    header || shell().inApp()
      ? (() => {
          const tones = tonesOf(base.id);
          return (action: Parameters<typeof isDestructive>[0]) => isDestructive(action, named, tones);
        })()
      : undefined;
  const deleting = useDelete({
    table: base,
    recordKey: key ?? {},
    label,
    host: host
      ? {
          isCurrent: isCurrent!,
          onDeleted: host.onDeleted,
          onStateChange: host.onDeleteStateChange,
        }
      : undefined,
  });
  /* A star only where the App offers one (`favorite: true` on the resource). */
  const starred: Favorite | undefined =
    key && shell().inApp() && shell().app()?.resources[base.id]?.favorite
      ? { kind: 'record', table: base.id, key, label, pageId: page.id }
      : undefined;
  const starredId = starred ? JSON.stringify([starred.table, starred.key]) : '';
  /* Tags where the App gives the resource some (`tags`): chips under the title. */
  const tagRule = key && shell().inApp() ? shell().app()?.resources[base.id]?.tags : undefined;
  /* A record avatar is presentation of the label already loaded for this
     heading. It is deliberately limited to an explicit local display rule:
     composite labels and key fallbacks must not invent an identity mark or
     trigger another read. */
  const recordLabelPath = key && shell().inApp() ? labelPath(base) : undefined;
  /* Whether the resource gives its records an avatar is the App's to say, known before the name arrives: a head
     that stands it large beside the name (recipes.header 'hero', themeFamilies.css) keeps its room from the first paint. */
  const avatarDeclared = Boolean(
    !gone && recordLabelPath && !recordLabelPath.includes('.') && shell().app()?.resources[base.id]?.display?.[recordLabelPath]?.avatar,
  );
  const recordAvatar = avatarDeclared && Boolean(entry.label);
  /* A person whose avatar is their photo (`avatar: { from, whose }`) wears it
     here too, as in every list that names them; the initials stand in where
     there is none, or the reader may not read it. */
  const avatarRule = recordAvatar ? shell().app()?.resources[base.id]?.display?.[recordLabelPath!] : undefined;
  const ownKey = primaryKey(base);
  const photos = useAvatarPhotos(
    recordAvatar && ownKey.length === 1 ? [{ name: recordLabelPath!, display: avatarRule as never, photoOwner: ownKey[0] }] : [],
    recordAvatar && key ? [key] : [],
  );
  const photo = recordAvatar && key && ownKey.length === 1 ? photos(recordLabelPath!, key[ownKey[0]]) : undefined;
  const [brokenPhoto, setBrokenPhoto] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (starred) relabelFavorite(starred);
  }, [starredId, label]);
  /* The record put on paper — its invoice, its packing slip — is a verb on it, in More, before Delete: reading, not changing. */
  const documents = key && !gone ? documentsOf(base.id) : [];
  /* A record that is gone has nothing to be done to it: no verbs, no Delete. */
  /* The verbs, the documents and Delete stand in the App's bar (Actions.tsx), drawn through the shell's slot. */
  const { ActionBar } = shell().slots;
  const toolbar =
    ActionBar && key && !gone && (actions || deleting.available || documents.length) ? (
      <div className="page-head-actions">
        <ActionBar
          tableId={base.id}
          actions={actions?.list ?? []}
          recordKey={key}
          label={label}
          matches={actions?.matches ?? (async () => false)}
          queryScope={actions?.queryScope}
          isCurrent={isCurrent}
          compact={phone}
          destructive={destructive}
          primary={header?.section.primary}
          only={header?.section.headerActions}
          canUpdate={actions?.canUpdate}
          grantedCommands={actions?.grantedCommands}
          grantedActions={actions?.grantedActions}
          menuTail={
            documents.length || deleting.available ? (
              <>
                {documents.map((document) => (
                  <DropItem
                    key={document.id}
                    className="page-actions-item"
                    onClick={() => go({ kind: 'page', pageId: page.id, table: base.id, key, label, tab: document.id })}
                  >
                    {document.label}
                  </DropItem>
                ))}
                {deleting.available && (
                  <DropItem className="page-actions-item is-danger" disabled={deleting.blocked} onClick={deleting.ask}>
                    {say('common.delete')}
                  </DropItem>
                )}
              </>
            ) : undefined
          }
          onDone={() => {
            if (host) {
              if (isCurrent?.()) host.onActionDone();
            } else onPending({ inPlace: false });
          }}
        />
      </div>
    ) : null;
  return (
    <div
      className={`page-head${key ? ' has-record' : ''}${!host && shell().inApp() ? ' is-room' : ''}${avatarDeclared ? ' has-avatar' : ''}`}
      data-layout={drawnLayout(page)}
    >
      <div className="page-head-top">
        {authoring && items.length ? (
          <div className="page-title-pick">
            <Dropdown
              ariaLabel={say('common.page')}
              value={page.id}
              items={[
                { value: page.id, label: sayPage(page), detail: sourceOf(page) },
                ...items.map((p) => ({ value: p.id, label: sayPage(p), detail: sourceOf(p) })),
              ]}
              onChange={(id) => {
                if (id !== page.id) go({ ...entry, pageId: id }, 'replace');
              }}
              valueClassName="page-title"
            />
          </div>
        ) : key ? (
          /* Over a record's name its kind is a label for someone who works
             across tables; a public reader came for the car, not "VEHICLE". */
          shell().publicVisitor() ? null : (
            <span className="page-title">{sayPage(page)}</span>
          )
        ) : (
          <h1 className="page-title">{sayPage(page)}</h1>
        )}
        {!shell().inApp() && (
          <button
            type="button"
            className={`ghost page-pin${pinned ? ' is-pinned' : ''}`}
            aria-pressed={pinned}
            title={pinned ? say('isPinnedToTheHome', { name: page.name }) : say('pinToTheHome', { name: page.name })}
            aria-label={pinned ? say('isPinnedToTheHome', { name: page.name }) : say('pinToTheHome', { name: page.name })}
            onClick={() => setPinned(togglePinned(page) as boolean)}
          >
            {pinned ? '★' : '☆'}
          </button>
        )}
        {key && changedElsewhere && !gone && <LiveUpdatedLine table={base} recordKey={key} />}
        {authoring && (
          <Button
            size="compact"
            className="page-edit"
            title={page.source === 'saved' ? say('addRemoveAndReorder') : say('thisPageBelongsToTheFile')}
            onClick={onLayout}
          >
            {page.source === 'saved' ? say('layout') : say('copyLayout')}
          </Button>
        )}
      </div>
      {key && (
        <div className="root-bar">
          {recordAvatar &&
            (photo && photo !== brokenPhoto ? (
              <img
                className={`page-record-avatar avatar avatar-photo avatar-c${hueOf(label)}`}
                src={photo}
                alt=""
                decoding="async"
                onError={() => setBrokenPhoto(photo)}
              />
            ) : (
              <span className={`page-record-avatar avatar avatar-c${hueOf(label)}`} aria-hidden="true">
                {initialsOf(label)}
              </span>
            ))}
          {title ? (
            // Named by the record, not by the Edit button inside it.
            <div className="root-current" role="heading" aria-level={1} aria-label={label}>
              {title()}
            </div>
          ) : (
            <h1 className="root-current">
              {/* One line, cut short where it must: the whole name is the crumb's and this one's title. */}
              <span title={label}>{label}</span>
            </h1>
          )}
          {starred && <FavoriteStar favorite={starred} name={label} />}
          {said.status}
          {/* "3 of 20" and the arrows, where the record was opened from a list. */}
          <RecordTrailNav entry={entry} />
        </div>
      )}
      {/* The head's second column (page.css), unless the crumb bar holds the verbs. */}
      {toolbar && actionsInBar ? createPortal(toolbar, crumbTools!, 'record-actions') : toolbar}
      {/* A header's facts: under the name, in its column (page.css). */}
      {key && said.facts}
      {key && tagRule && <RecordTags rule={tagRule} recordKey={key} isCurrent={isCurrent} />}
      {deleting.dialog}
      {key && (
        <div className={`page-pending${liveDraft ? ' has-live-draft' : ''}`}>
          <PendingBar
            table={base}
            recordKey={key}
            placement={host?.pendingBar}
            isCurrent={isCurrent}
            onDone={(done) => onPending(host ? done : (done ?? { inPlace: true }))}
          />
        </div>
      )}
    </div>
  );
}

/* A record header (`header({ status, facts })`, presentation 'header'): the
 * head told what else to say. The status column's tone is a chip beside the
 * name; the facts are one line under it, each a value under its caption, or
 * dressed by a fact's word after or before it ("3 beds", "Born Apr 24, 2017")
 * where the author wrote one. It reads the record's row once,
 * names the record for the head as a fields section would, and hands the head
 * the editor for the name where the name may change. It lives in this module
 * rather than one of its own because it reads the page context, the editor
 * and the App, which already import the page: a module of its own joined that
 * cycle (test/repo/runtime-cycles.test.ts). Which verbs are destructive is said
 * here too: the head draws them last and quiet, never as the filled first
 * button (docs/design.md, the record head). */
type Tones = Record<string, Record<string, string> | undefined>;

/**
 * Whether a verb takes something away: named (by id) in the header's `destructive`,
 * or an update that asks to be confirmed, or one that sets a value its
 * column's display tones call bad ("Mark lost" → `lost: 'bad'`). A command
 * says nothing of what it writes, so only its name makes it one.
 */
export function isDestructive(action: AppAction, named: readonly string[] | undefined, tones: Tones): boolean {
  if (named?.includes(action.id)) return true;
  if (action.command) return false;
  if (action.confirm) return true;
  return Object.entries(action.set ?? {}).some(([column, value]) => typeof value === 'string' && tones[column]?.[value] === 'bad');
}

/** The display tones of a table's columns in the App, by column. */
function tonesOf(tableId: string): Tones {
  const display =
    (shell().app() as { resources?: Record<string, { display?: Record<string, { tone?: Record<string, string> }> }> } | null)?.resources?.[
      tableId
    ]?.display ?? {};
  return Object.fromEntries(Object.entries(display).map(([column, rule]) => [column, rule?.tone]));
}

interface HeaderParts {
  status: ReactNode;
  facts: ReactNode;
}

/**
 * The header's row and what the head draws from it. Called by the head on
 * every render; with no header it reads nothing and draws nothing.
 */
function useRecordHeader({
  page,
  base,
  recordKey: key,
  header,
  onSectionLabel,
  onTitleEditor,
  titleOwner,
  onEdit,
}: {
  page: PageDef;
  base: TableMeta;
  recordKey: Record<string, unknown> | undefined;
  header: { section: PageSection; index: number } | undefined;
  onSectionLabel?: (index: number, label: string | undefined) => void;
  onTitleEditor?: (index: number, render: (() => ReactNode) | undefined) => void;
  titleOwner?: number;
  onEdit?: (opts?: { inPlace?: boolean }) => void;
}): HeaderParts {
  const api = usePageApi();
  const { preview, isCurrent, adorn, adornHeld } = useContext(PageRenderContext);
  const section = header?.section;
  const index = header?.index ?? -1;
  const facts = section?.paths ?? [];
  const status = section?.status;
  const namePath = labelPath(base) as string | undefined;
  /* Built as the server builds it for the page's compose (shared/recordReads.ts). */
  const { fetched, labels: refLabels } = headerColumns(recordReadNames(), base, section ?? { kind: 'fields' });
  const data = useQuery({
    queryKey: ['page-fields', page.id, base.id, key, fetched],
    structuralSharing: shareRecordSource,
    queryFn: () =>
      readRecordSource(() =>
        api('/api/view/run', {
          count: 'none',
          view: {
            id: `page:${page.id}:header`,
            name: base.name,
            base: base.id,
            columns: fetched.map((path) => ({ path })),
            filter: pathEqualityFilter(Object.fromEntries((primaryKey(base) as string[]).map((column) => [column, key![column]]))),
            limit: 1,
          },
        }),
      ),
    enabled: Boolean(section && key),
    staleTime: 0,
  });
  const got = data.data && 'view' in data.data ? data.data : undefined;
  const row = got?.rows[0];
  /* The header names the record for the head, first of every section. */
  useEffect(() => {
    if (row && header) onSectionLabel?.(index, rowLabel(base, row));
  }, [row, index]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (header) onSectionLabel?.(index, undefined);
    },
    [index],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const titleColumn =
    header && titleOwner === index && shell().inApp() && !preview && namePath && !namePath.includes('.')
      ? base.columns.find((c) => c.name === namePath)
      : undefined;
  const titleEditable = Boolean(
    key && titleColumn && !titleColumn.primaryKey && titleColumn.writable !== false && (canEditRow(base, key) as boolean),
  );
  useEffect(() => {
    if (!onTitleEditor || !header) return;
    if (!row || !titleEditable || !titleColumn) {
      onTitleEditor(index, undefined);
      return;
    }
    onTitleEditor(index, () => (
      <Editable
        table={base}
        row={row}
        column={titleColumn}
        recordKey={key!}
        onSaved={onEdit ?? (() => {})}
        isCurrent={isCurrent}
        app
        display={(next) => <span>{next === null || next === undefined || String(next) === '' ? rowLabel(base, row) : String(next)}</span>}
      />
    ));
  }, [row, titleEditable, index]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (header) onTitleEditor?.(index, undefined);
    },
    [index],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  /* The facts' line is held while the row is on its way: under the name it
     pushed the whole page down when it came (test/built-client-vitals.mjs). So is it while the host's adornments are
     asked about one of its empty facts: an empty fact is left out, and one the host adorns would join the line late. */
  const waitsOnHost = Boolean(row && adornHeld?.length) && facts.some((path) => adornHeld!.includes(path) && (row![path] ?? '') === '');
  if (section && ((!row && data.isPending) || waitsOnHost) && facts.length)
    return {
      status: null,
      facts: (
        <ul className="page-facts page-head-facts" aria-hidden="true" style={{ visibility: 'hidden' }}>
          <li className="page-fact">&nbsp;</li>
        </ul>
      ),
    };
  if (!section || !row) return { status: null, facts: null };

  const presented = presentationColumns(state.schema, base, [...(status ? [status] : []), ...facts]);
  const byPath = new Map((got?.resolved ?? []).map((c) => [c.path, c]));
  const columnAt = (path: string) =>
    (base.columns.find((c) => c.name === path) ?? presented.get(path) ?? byPath.get(path)) as
      | (ColumnMeta & { references?: { table: string; column: string } })
      | undefined;
  const filled = (path: string) => row[path] !== null && row[path] !== undefined && row[path] !== '';
  const captionOf = (path: string) => (columnLabel(base.id, path) as string | null) ?? humanName(path.split('.').pop() ?? path);
  const said = (path: string) => {
    const column = columnAt(path);
    const labelAt = refLabels.get(path);
    return column?.references ? (
      <RefJump
        references={column.references}
        value={row[path]}
        label={labelAt ? row[labelAt] : undefined}
        table={base}
        column={path}
        row={row}
      />
    ) : (
      <Value col={column} value={row[path]} tableId={base.id} compact />
    );
  };
  /* What the host draws at an own column: beside a filled fact's value, or as an empty fact's whole value. */
  const adornedAt = (path: string) =>
    adorn && key && !preview && !path.includes('.') && base.columns.some((c) => c.name === path)
      ? adorn({ table: base.id, column: path, key, filled: filled(path) })
      : undefined;
  const adornments = new Map(facts.map((path) => [path, adornedAt(path)] as const));
  const shown = facts.filter((path) => filled(path) || adornments.get(path));
  return {
    /* Its caption is heard, not seen: beside the name a chip is its own word. */
    status:
      status && filled(status) ? (
        <span className="page-head-status">
          <span className="visually-hidden">{captionOf(status)}: </span>
          {said(status)}
        </span>
      ) : null,
    facts: shown.length ? (
      <ul className="page-facts page-head-facts" aria-label={say('common.keyFacts')}>
        {shown.map((path) => {
          const labels = section.factLabels;
          const word =
            labels && Object.hasOwn(labels, path)
              ? factWord(labels[path], row[path], columnDisplay(base.id, path) as { format?: string; unit?: string; bar?: boolean } | null)
              : undefined;
          const before = word !== undefined && labels![path].position === 'before';
          return (
            <li key={path} className="page-fact">
              {/* A fact is a captioned value, as a field is: "Close date" over "Dec 11, 2026". An authored word
                  ("3 beds", "Asking $22,495") is its own caption. */}
              {word === undefined && (
                <span className="page-fact-caption">
                  {captionOf(path)}
                  <span className="visually-hidden">: </span>
                </span>
              )}
              {before && <span className="page-fact-word">{word} </span>}
              {filled(path) && said(path)}
              {word !== undefined && !before && <span className="page-fact-word"> {word}</span>}
              {adornments.get(path)}
            </li>
          );
        })}
      </ul>
    ) : null,
  };
}
