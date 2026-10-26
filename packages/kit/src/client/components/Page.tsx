/**
 * A page: one record, and everything around it at once.
 *
 * Sections are Queries started together that land as they arrive, each in
 * its own place: a page with a count over a large child table should not
 * hold up the record's own name. A section with a `when` is shown only
 * while the root satisfies it; a run of metrics is one strip; a run of
 * lists is a tab strip whose tabs are fetched when opened, which is the
 * whole reason six lists as tabs are cheaper than six lists down a page.
 * One bad section is named in place and does not take the page with it.
 *
 * The leaves — a value in its dress, a reference chip, an editable field,
 * the pending bar, Delete, the layout builder — are the vanilla client's
 * still, drawn into place.
 *
 * This module is the page itself: which surface it belongs to, which
 * section names the record, and the related New form a host keeps open
 * across refreshes. The head is PageHead.tsx and the sections' layout
 * PageSections.tsx; each kind draws in its own module (PageFields,
 * PageMetrics, PageTimeline, PageRelated) through one box (PageSectionBox),
 * reading the page around it from pageContext.ts.
 */
import { ErrorBoundary } from './ErrorBoundary.js';
import { ProblemScopeProvider } from './Notes.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { columnLabel, registerSurfaceMutationPendingProbe, state } from '../core.js';
import { refreshRecordInPlace } from '../recordWriteRefresh.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { PendingBarPlacement } from './Editable.js';
import type { DeleteButtonHost } from './DeleteButton.js';
import type { RecordSurfaceOwner } from './recordSurface.js';
import { openRelatedRecord } from '../insert.js';
import type { NewRecordProps } from './NewRecord.js';
import { onDemand } from './onDemand.js';
import { RecordGone } from './RecordGone.js';
import { headerOf, rootLabel, type PageDef, type PageEntry, type SectionPlan } from './pageModel.js';
import { PageRenderContext, spoken, type RecordActions, type RelatedCreator } from './pageContext.js';
import { shell } from '../shellMode.js';
import { PageHead } from './PageHead.js';
import { Sections } from './PageSections.js';
import { PageLayout } from './PageLayout.js';
import { drawnLayout, showcaseIndex } from '@mistriwork/engine/shared/pageLayouts.js';
import { humanName } from '@mistriwork/engine/shared/model.js';

/* The form and its field library load when a related New first opens. */
const NewRecordDialog = onDemand(() => import('./NewRecord.js'), 'NewRecordDialog', { quiet: true });

/** One explicitly owned, non-route editor (never a second active draft). Keep owner stable through lease
 * renewal and ordinary refresh; replace it on close/reopen or another entry.
 * The host owns navigation and must retain pending/uncertain deletion status
 * synchronously, blocking voluntary close/replacement until reconciled. */
export interface PageViewHost {
  owner: RecordSurfaceOwner;
  pendingBar: PendingBarPlacement;
  /** undefined is staging/discard, NOT acknowledgement; true is confirmed
   * Save/Undo, false requests refresh. Refresh this surface without remounting
   * its editor or replacing dirty fields. */
  onRecordChange: (opts?: { inPlace?: boolean }) => void;
  /** Includes both authored fixed actions and separately granted commands. */
  onActionDone: () => void;
  onDeleted: () => void;
  onDeleteStateChange: DeleteButtonHost['onStateChange'];
}

export interface PageProps {
  entry: PageEntry;
  page: PageDef;
  base: TableMeta;
  plans: SectionPlan[];
  /** With no record chosen, the list *is* the chooser, drawn into the body. */
  chooser?: ReactNode;
  /** The other pages this table has, for the title's picker. */
  others: Array<{ id: string; name: string; source: string }>;
  onLabel: (label: string) => void;
  onTab: (tab: string | undefined) => void;
  onLayout: () => void;
  /** Fixed edits and separately granted business commands. */
  actions?: RecordActions;
  /** Authoring preview: no write/navigation leaves, with reads pinned to the editor's connection. */
  preview?: { connection: string };
  host?: PageViewHost;
  /** No head: the sections alone, as a free-form page's block places them (RecordPageBody's `only`). */
  bare?: boolean;
}

/* ---------- the page ---------- */

export function PageView(props: PageProps) {
  const { entry, page, base, plans, chooser, host } = props;
  const queries = useQueryClient();
  const keyText = JSON.stringify(entry.key);
  const surface = useMemo(
    () => (host ? { owner: host.owner, pageId: entry.pageId, table: base.id, keyText } : undefined),
    [host?.owner, entry.pageId, base.id, keyText],
  );
  const activeSurface = useRef(surface);
  activeSurface.current = surface;
  const activeEntry = useRef(entry);
  activeEntry.current = entry;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = useCallback(
    () =>
      !surface ||
      (mounted.current &&
        activeSurface.current === surface &&
        surface.owner.isCurrent() &&
        activeEntry.current.pageId === surface.pageId &&
        JSON.stringify(activeEntry.current.key) === surface.keyText),
    [surface],
  );
  // Keep the child above section loading/error branches: a related refresh must
  // not unmount a pending form or the parent field editor. The actual Dialog is
  // still a descendant of the record Modal in React's focus-ownership tree.
  type RelatedForm = { surface: typeof surface; props?: NewRecordProps; unresolved: boolean; changed: (value: boolean) => void };
  const [related, setRelated] = useState<RelatedForm | null>(null);
  const activeRelated = useRef<RelatedForm | null>(null);
  const relatedAnchor = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!surface) return;
    return registerSurfaceMutationPendingProbe(
      () => isCurrent() && activeRelated.current?.surface === surface && activeRelated.current.unresolved,
    );
  }, [surface, isCurrent]);
  const openRelated: RelatedCreator = (table, form, onAdded) => {
    if (!surface || !isCurrent() || !relatedAnchor.current || activeRelated.current?.surface === surface) return;
    const child: RelatedForm = {
      surface,
      unresolved: false,
      changed: (value) => {
        if (isCurrent() && activeRelated.current === child) child.unresolved = value;
      },
    };
    activeRelated.current = child;
    const current = () => isCurrent() && activeRelated.current === child;
    openRelatedRecord(table, form, onAdded, {
      host: relatedAnchor.current,
      isCurrent: current,
      close: () => {
        if (current()) {
          activeRelated.current = null;
          setRelated(null);
        }
      },
      render: (props) => {
        if (current()) {
          child.props = props;
          setRelated(child);
        }
      },
    });
    if (!child.props && activeRelated.current === child) activeRelated.current = null;
  };
  const onLabel = (label: string) => {
    if (isCurrent()) props.onLabel(label);
  };
  const onTab = (tab: string | undefined) => {
    if (isCurrent()) props.onTab(tab);
  };
  const hasAside = page.sections.some((section) => section.region === 'aside' && !section.hidden);
  const [labelOwner, setLabelOwner] = useState<number | undefined>(undefined);
  const [titleEditor, setTitleEditor] = useState<{ index: number; render: () => ReactNode } | null>(null);
  const onTitleEditor = useCallback((index: number, render: (() => ReactNode) | undefined) => {
    setTitleEditor((current) => (render ? { index, render } : current?.index === index ? null : current));
  }, []);
  /* A record header names the record first: it is the head. */
  const header = useMemo(() => headerOf(page), [page]);
  /* A verb a related list draws in its own head (`actions`) is that list's, not the record's head's — unless the
     record's header names it too. */
  const headActions = useMemo(() => {
    const placed = new Set(page.sections.flatMap((section) => section.listActions ?? []));
    for (const id of header?.section.headerActions ?? []) placed.delete(id);
    const all = props.actions;
    return all && placed.size ? { ...all, list: all.list.filter((action) => !placed.has(action.id)) } : all;
  }, [page, header, props.actions]);
  const labelOrder = useMemo(() => {
    const fields = page.sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section.kind === 'fields' && !section.hidden);
    const heads = fields.filter(({ section }) => section.presentation === 'header');
    const rest = fields.filter(({ section }) => section.presentation !== 'header');
    return [
      ...heads,
      ...rest.filter(({ section }) => section.region !== 'aside'),
      ...rest.filter(({ section }) => section.region === 'aside'),
    ];
  }, [page]);
  const titleOwner = hasAside ? labelOwner : labelOrder[0]?.index;
  // Keyed on what identifies the record and its page, not on object identity:
  // a host that rebuilds its props per render must not restart label ownership.
  const labels = useMemo(() => ({ values: new Map<number, string>(), published: undefined as string | undefined }), [page.id, keyText]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeLabels = useRef(labels);
  activeLabels.current = labels;
  const publishLabel = useRef(onLabel);
  publishLabel.current = onLabel;
  const onSectionLabel = useCallback(
    (index: number, label: string | undefined) => {
      // Cleanup from an old page must not publish into its replacement.
      if (activeLabels.current !== labels || !isCurrent()) return;
      if (label === undefined) labels.values.delete(index);
      else labels.values.set(index, label);
      // A gated or slow main section must not prevent an already-loaded section
      // from naming the record; an aside can never supersede a loaded main label.
      const owner = labelOrder.find((item) => labels.values.has(item.index));
      setLabelOwner(owner?.index);
      const chosen = owner && labels.values.get(owner.index);
      if (chosen !== undefined && chosen !== labels.published) {
        labels.published = chosen;
        publishLabel.current(chosen);
      }
    },
    [labels, labelOrder, isCurrent],
  );
  /* A write that landed in place needs no repaint — the bar reads the
     store and the fields confirm themselves; one that asked for it gets one. */
  const refreshInPlace = () => {
    if (!entry.key) return;
    refreshRecordInPlace(
      queries,
      { connection: state.activeConnection ?? '', table: base.id, key: entry.key, queryScope: props.actions?.queryScope },
      true,
    );
  };
  /* What the shell draws at the record's own fields (a suggestion waiting on one): asked by every record page, routed
     or in a dialog, never by a preview. The slot is the shell's for its whole life, so the hook's place is fixed. A
     suggestion that landed wrote to the record, so it is read again as any write asks. */
  const landed = useRef<() => void>(() => {});
  const adornment = shell().slots.useFieldAdornment?.(
    host?.owner.connection ?? state.activeConnection ?? '',
    base.id,
    props.preview ? undefined : entry.key,
    () => landed.current(),
  );
  const onPending = (opts?: { inPlace?: boolean }) => {
    if (host) {
      if (isCurrent()) host.onRecordChange(opts);
      return;
    }
    /* Re-read in place, never by replacing the walk entry: that started the
       room over and blanked the record until every read had answered again
       (recordWriteRefresh.ts, refreshRecordInPlace). */
    if (opts && opts.inPlace === false) refreshInPlace();
    else if (opts?.inPlace && page.sections.some((section) => section.workflow))
      void queries.invalidateQueries({ queryKey: ['page-fields', page.id, base.id, entry.key] });
  };
  /* A record that is gone — deleted under an open page, or a link to one
     that never was — fails every section at once. It is said once, in the
     words the room uses for a missing record (PageRoom.tsx), and the head
     offers no verbs for it: each section repeating a 404 beside Start work
     and Mark done was a page still open for business. */
  landed.current = () => onPending({ inPlace: false });
  const [goneKey, setGone] = useState<string | null>(null);
  const gone = goneKey === keyText;
  const onGone = useCallback(() => setGone(keyText), [keyText]);
  if (host && !isCurrent()) return null;
  /* The archetype (shared/pageLayouts.ts) is on the page the payload carries, so its columns are drawn on the first
     render, before any section has answered. */
  const layout = drawnLayout(page);
  const showcase = showcaseIndex(page);
  const sectionsOf = (region: 'main' | 'aside' | undefined, only?: (index: number) => boolean) =>
    entry.key ? (
      <Sections
        page={page}
        base={base}
        recordKey={entry.key}
        plans={plans}
        entry={entry}
        onLabel={onLabel}
        onEdit={onPending}
        onTab={onTab}
        region={region}
        onSectionLabel={onSectionLabel}
        titleOwner={titleOwner}
        onTitleEditor={onTitleEditor}
        only={only}
      />
    ) : null;
  /* A showcase's panel is named by what it offers, "Home: Asking rent", where a record's aside is its context. */
  const offer =
    layout === 'showcase' ? page.sections.find((section) => section.region === 'aside' && section.presentation === 'headline') : undefined;
  const figure = offer?.paths?.[0];
  const panel =
    layout === 'showcase'
      ? {
          noun: page.name,
          figure: figure ? ((columnLabel(base.id, figure) as string | null) ?? humanName(figure.split('.').pop() ?? figure)) : undefined,
        }
      : undefined;
  return (
    <PageRenderContext.Provider
      value={{
        ...(adornment?.adorn && !props.preview ? { adorn: adornment.adorn } : {}),
        ...(adornment?.held.length && !props.preview ? { adornHeld: adornment.held } : {}),
        preview: Boolean(props.preview),
        connection: props.preview?.connection ?? host?.owner.connection,
        isCurrent: host ? isCurrent : undefined,
        openRelated: host ? openRelated : undefined,
        actions: props.preview || gone ? undefined : props.actions,
        onGone,
        recordName: entry.label,
        ...(host ? { onActionDone: host.onActionDone } : {}),
      }}
    >
      <ProblemScopeProvider>
        {props.preview ? (
          <div className="page-head">
            <h2 className="page-title">{page.name}</h2>
            <div className="root-bar">
              <h1 className="root-current">{entry.label ?? (entry.key ? rootLabel(entry.key) : '')}</h1>
            </div>
          </div>
        ) : props.bare ? null : (
          <ErrorBoundary>
            <PageHead
              {...props}
              actions={gone ? undefined : headActions}
              gone={gone}
              onPending={onPending}
              title={titleEditor && titleEditor.index === titleOwner ? titleEditor.render : undefined}
              header={header}
              onSectionLabel={onSectionLabel}
              onTitleEditor={onTitleEditor}
              titleOwner={titleOwner}
            />
          </ErrorBoundary>
        )}
        {gone && entry.key ? (
          <PageLayout>
            <RecordGone base={base} spoken={spoken(base.name)} className="page-gone" />
          </PageLayout>
        ) : entry.key ? (
          showcase !== undefined ? (
            <PageLayout
              layout={layout}
              panel={panel}
              aside={hasAside ? sectionsOf('aside') : undefined}
              below={sectionsOf(hasAside ? 'main' : undefined, (index) => index !== showcase)}
            >
              {sectionsOf(hasAside ? 'main' : undefined, (index) => index === showcase)}
            </PageLayout>
          ) : (
            <PageLayout layout={layout} aside={hasAside ? sectionsOf('aside') : undefined}>
              {sectionsOf(hasAside ? 'main' : undefined)}
            </PageLayout>
          )
        ) : (
          <PageLayout>{chooser}</PageLayout>
        )}
        {host && <span hidden ref={relatedAnchor} />}
        {related?.props && related.surface === surface && (
          <NewRecordDialog {...related.props} retainUncertain onUnresolvedChange={related.changed} />
        )}
      </ProblemScopeProvider>
    </PageRenderContext.Provider>
  );
}
