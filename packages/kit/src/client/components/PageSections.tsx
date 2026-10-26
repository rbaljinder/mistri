/**
 * How a page's sections are laid out: which are shown in which region, and
 * how neighbors group — a run of metrics is one strip, a run of lists is a
 * tab strip whose tabs are fetched when opened, and sections named into tabs (`tab`) are one strip of
 * panels standing where the first of them stands. Each section is a Slot:
 * gated by its `when`, then handed to the module that draws its kind.
 */
import { tabMatches } from '@mistriwork/engine/shared/addressParams.js';
import { shell } from '../shellMode.js';
import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { findTable } from '../core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { rootMatches, sectionClass, type PageDef, type PageEntry, type PageSection, type SectionPlan } from './pageModel.js';
import { PageRenderContext, inAppPage, spoken, usePageApi, type SlotProps } from './pageContext.js';
import { Loading, SectionBox } from './PageSectionBox.js';
import { FieldsSection } from './PageFields.js';
import { BreakdownSection, ChartSection, MetricSection } from './PageMetrics.js';
import { DashboardNote } from './DashboardNote.js';
import { TimelineSection } from './PageTimeline.js';
import type { HistoryApi } from './PageHistory.js';
import type { FlowsApi } from './PageFlows.js';
import { ListSection } from './PageRelated.js';
import { EmptyRun } from './PageEmptyRun.js';
import { useMessageLanguage } from './useMessageLanguage.js';
import { useTabFold } from './useTabFold.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { message } from '../messages.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { onDemand, useArrived } from './onDemand.js';
import { assertNever } from '@mistriwork/engine/shared/model.js';
import { appTargetFields } from '@mistriwork/engine/shared/appLinks.js';
import { readPageFields } from './pageFieldsRead.js';
import { pathEqualityFilter } from '../resourceRequests.js';
import { resourceOf } from './appRooms.js';

/* A record's history, fetched the first time a page holds one. */
const RecordHistory = onDemand(() => import('./PageHistory.js'), 'RecordHistory');
/* A record's flow runs, fetched the first time a page holds one. */
const RecordFlows = onDemand(() => import('./PageFlows.js'), 'RecordFlows');
/* A flow's steps drawn, fetched the first time a page holds one: no first page carries it. */
const FlowDiagram = onDemand(() => import('./PageFlowDiagram.js'), 'FlowDiagram');

/* The page's request and its section chrome, handed to the custom section: an author's component, and the page's
   side of @mistriwork/mistri/ui with it (sdk/CustomSection.tsx), drawn through the shell's slot. */
function CustomSlot(props: SlotProps) {
  const pageApi = usePageApi();
  const { preview } = useContext(PageRenderContext);
  const { CustomSection } = shell().slots;
  return CustomSection ? <CustomSection {...props} frame={{ pageApi, preview, Loading, SectionBox }} /> : null;
}

/** One section: gated by its `when`, loading until its data is here, broken in place if it cannot run. */
function Slot(props: SlotProps) {
  const { connection } = useContext(PageRenderContext);
  const { section, base, recordKey: key, plan } = props;
  const gate = useQuery({
    queryKey: ['when', base.id, key, section.when],
    queryFn: () => rootMatches(base, key, section.when!, connection),
    enabled: Boolean(section.when),
    staleTime: 0,
  });
  if (section.when && gate.data !== true) return null;
  if (plan.error && section.kind !== 'fields') return <SectionBox section={section} body={null} foldable={false} broken={plan.error} />;
  switch (section.kind) {
    case 'fields':
      return <FieldsSection {...props} />;
    case 'metric':
      return <MetricSection {...props} />;
    case 'breakdown':
      return <BreakdownSection {...props} />;
    case 'chart':
      return <ChartSection {...props} />;
    case 'note':
      return <NoteSection {...props} />;
    case 'timeline':
      return <TimelineSection {...props} />;
    case 'history':
      return <HistorySlot {...props} />;
    case 'flows':
      return <FlowsSlot {...props} />;
    case 'diagram':
      return <DiagramSlot {...props} />;
    case 'custom':
      return <CustomSlot {...props} />;
    case 'list':
      return <ListSection {...props} />;
    default:
      return assertNever(section.kind);
  }
}

/* The history section is handed the page's reads and frame, so it need not
   import them (PageHistory.tsx says why). */
function HistorySlot({ section, base, recordKey }: SlotProps) {
  const api = usePageApi() as unknown as HistoryApi;
  const { preview } = useContext(PageRenderContext);
  /* Until its module is here the section waits as its first read does, in its own skeleton. */
  const here = useArrived(RecordHistory);
  /* A record's history is the operator's, and its route is behind sign-in:
     asked for a public visitor, its 401 drew the sign-in screen over a page
     the visitor may read. The storefront leaves it out (docs/design.md). */
  if (shell().publicVisitor() && !preview) return null;
  if (!here) return <Loading section={section} />;
  return (
    <RecordHistory
      section={section}
      base={base}
      recordKey={recordKey}
      api={api}
      preview={preview}
      loading={<Loading section={section} />}
      frame={(body, broken) => <SectionBox section={section} body={body} foldable={false} broken={broken} />}
    />
  );
}

/* The flows section is handed the page's reads and frame as the history's is. Its route is the operator's too,
   behind sign-in, so a public visitor's page leaves it out. */
function FlowsSlot({ section, base, recordKey }: SlotProps) {
  const api = usePageApi() as unknown as FlowsApi;
  const { preview } = useContext(PageRenderContext);
  const here = useArrived(RecordFlows);
  if (shell().publicVisitor() && !preview) return null;
  if (!here) return <Loading section={section} />;
  return (
    <RecordFlows
      base={base}
      recordKey={recordKey}
      api={api}
      preview={preview}
      loading={<Loading section={section} />}
      frame={(body, broken) => <SectionBox section={section} body={body} foldable={false} broken={broken} />}
    />
  );
}

/* A flow's diagram reads its steps as the reader's rows, through the page's own reads, and is framed as the flows
   are. The steps table is the one the App's flows binding names for this page's table (shared/app.ts), as this
   reader's catalog has it: a reader who cannot read the steps is shown none. On a record's page it draws the
   record's run, whose route is the operator's, behind sign-in, so a public visitor's page leaves it out. */
function DiagramSlot({ section, base, recordKey }: SlotProps) {
  const api = usePageApi() as unknown as FlowsApi;
  const { preview } = useContext(PageRenderContext);
  const here = useArrived(FlowDiagram);
  const diagram = resourceOf(shell().app(), base.id)?.flowDiagram;
  if (diagram?.run && shell().publicVisitor() && !preview) return null;
  if (!here) return <Loading section={section} />;
  return (
    <FlowDiagram
      base={base}
      recordKey={recordKey}
      diagram={diagram}
      steps={diagram ? findTable(diagram.steps) : undefined}
      api={api}
      preview={preview}
      loading={<Loading section={section} />}
      frame={(body, broken) => <SectionBox section={section} body={body} foldable={false} broken={broken} />}
    />
  );
}

const noTargetLinks = () => null;

/* Bound navigation reads only its explicit, schema-visible source fields, through the page's ordinary reader. */
function NoteSection({ section, page, base, recordKey }: SlotProps) {
  useMessageLanguage();
  const api = usePageApi();
  const { connection, preview, isCurrent } = useContext(PageRenderContext);
  /* The suite's links are the App framework's (shellMode.ts `useTargetLinks`): none where the shell has none, and nothing read for them. */
  const scope = (shell().slots.useTargetLinks ?? noTargetLinks)();
  const columns = section.action && 'to' in section.action ? appTargetFields(section.action.to) : [];
  const keys = base.columns.filter((column) => column.primaryKey).map((column) => column.name);
  const readable =
    Boolean(scope) &&
    !preview &&
    columns.length > 0 &&
    columns.every((name) => base.columns.some((column) => column.name === name)) &&
    keys.length > 0 &&
    keys.every((name) => Object.hasOwn(recordKey, name) && recordKey[name] !== null && recordKey[name] !== undefined);
  const data = useQuery({
    queryKey: ['page-link-fields', scope?.owner.epoch, page.id, base.id, recordKey, columns],
    enabled: readable,
    queryFn: () =>
      readPageFields(
        {
          owner: connection ?? '',
          pageId: page.id,
          base,
          filter: pathEqualityFilter(Object.fromEntries(keys.map((name) => [name, recordKey[name]]))),
          columns,
        },
        (body) => api('/api/view/run', body),
      ),
    staleTime: 0,
  });
  const row = readable && (!isCurrent || isCurrent()) && data.data && 'view' in data.data ? data.data.rows[0] : undefined;
  return (
    <section className={sectionClass(section)}>
      <DashboardNote
        title={section.title}
        text={section.text ?? ''}
        icon={section.icon}
        variant={section.variant}
        action={preview && section.action && 'to' in section.action ? undefined : section.action}
        row={row}
      />
    </section>
  );
}

interface Shown {
  section: PageSection;
  index: number;
}
interface Tab {
  key: string | number;
  token: string;
  label: ReactNode;
}

/** Names across the top, one panel under them, each panel drawn the first time it is opened (or at once, where `eager`). */
export function TabStrip({
  tabs,
  name,
  entry,
  onTab,
  draw,
  scoped,
  eager = [],
  className = '',
}: {
  tabs: Tab[];
  name: string;
  entry: PageEntry;
  onTab: (tab: string | undefined) => void;
  draw: (i: number) => ReactNode;
  scoped: boolean;
  eager?: number[];
  className?: string;
}) {
  const id = useId();
  // An address says a tab as its word (appAddress.ts): matched by the token or by it.
  const asked = tabs.findIndex((tab) => tabMatches(tab.token, entry.tab));
  const [active, setActive] = useState(asked === -1 ? 0 : asked);
  const [drawn, setDrawn] = useState<Set<number>>(() => new Set([asked === -1 ? 0 : asked, ...eager]));
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  /* The tabs that do not fit go under More (useTabFold.ts); the chosen one is never among them. */
  const { strip, folded } = useTabFold(tabs.length, active);
  /* A tab reached by the keyboard may have been under More: it is focused once the fold has made room for it. */
  const focusing = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focusing.current === undefined || folded.has(focusing.current)) return;
    buttons.current[focusing.current]?.focus();
    focusing.current = undefined;
  });
  const show = (i: number) => {
    setActive(i);
    setDrawn((s) => new Set(s).add(i));
    /* Written into the address bar without re-rendering: what you are looking
       at is what a link should carry. The first tab writes nothing. */
    onTab(!scoped && i === 0 ? undefined : tabs[i].token);
  };
  return (
    <div className={`page-tabs${className}`}>
      {/* The strip is the row that is measured; the tabs are its tablist, and More stands beside them, not among them. */}
      <div className="page-tabstrip folds" ref={strip}>
        <div className="page-tablist" role="tablist" aria-label={name}>
          {tabs.map((tab, i) => (
            <button
              key={tab.key}
              type="button"
              className="page-tab"
              data-fold={i}
              data-folded={folded.has(i) ? '' : undefined}
              aria-hidden={folded.has(i) || undefined}
              role="tab"
              id={`${id}-tab-${i}`}
              aria-controls={`${id}-tabpanel-${i}`}
              aria-selected={i === active}
              tabIndex={i === active ? 0 : -1}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              onClick={() => show(i)}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                const to = step ? (i + step + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
                if (to < 0) return;
                e.preventDefault();
                show(to);
                if (folded.has(to)) focusing.current = to;
                else buttons.current[to]?.focus();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="page-tab-more" data-fold-more="" data-folded={folded.size ? undefined : ''} aria-hidden={!folded.size || undefined}>
          <DropMenu
            className="page-tab-more-menu"
            triggerClassName="page-tab"
            label={message('common.more')}
            popupClassName="page-actions-popup"
            align="end"
          >
            {tabs.map((tab, i) =>
              folded.has(i) ? (
                <DropItem key={tab.key} className="page-actions-item" onClick={() => show(i)}>
                  {tab.label}
                </DropItem>
              ) : null,
            )}
          </DropMenu>
        </div>
      </div>
      <div className="page-tabpanels">
        {tabs.map((tab, i) => (
          <div
            key={tab.key}
            className="page-tabpanel"
            role="tabpanel"
            id={`${id}-tabpanel-${i}`}
            aria-labelledby={`${id}-tab-${i}`}
            tabIndex={i === active ? 0 : -1}
            hidden={i !== active}
            inert={i !== active}
            aria-hidden={i !== active}
          >
            {drawn.has(i) ? draw(i) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A run of lists as tabs: the names across the top, one table under them, fetched when opened. */
function ListTabs({
  items,
  entry,
  onTab,
  draw,
  scoped,
}: {
  items: Shown[];
  entry: PageEntry;
  onTab: (tab: string | undefined) => void;
  draw: (item: Shown) => ReactNode;
  scoped: boolean;
}) {
  useMessageLanguage();
  /* The token is the source's words (apps.ts keepAddresses), so an address names one tab in every language. */
  const named = (item: Shown) =>
    item.section.addressWords?.title ??
    item.section.title ??
    (findTable(item.section.from ?? '') as TableMeta | undefined)?.name ??
    item.section.from ??
    '';
  // Read as the strip renders: the run is still being gathered when the strip is created.
  const tabs = items.map((item) => ({
    key: item.index,
    token: scoped ? `section:${item.index}` : named(item),
    label: item.section.title ?? spoken((findTable(item.section.from ?? '') as TableMeta | undefined)?.name ?? item.section.from ?? ''),
  }));
  return <TabStrip tabs={tabs} name="Related lists" entry={entry} onTab={onTab} draw={(i) => draw(items[i])} scoped={scoped} />;
}

/** The record's sections as tabs: a panel is sections again, laid out as the page lays them out. */
function SectionTabs({
  groups,
  entry,
  onTab,
  lay,
  scoped,
}: {
  groups: Array<{ name: string; items: Shown[] }>;
  entry: PageEntry;
  onTab: (tab: string | undefined) => void;
  lay: (items: Shown[]) => ReactNode[];
  scoped: boolean;
}) {
  useMessageLanguage();
  /* Tokened by the tab's source words (apps.ts keepAddresses): an address names one tab in every language. */
  const tabs = groups.map((group) => ({
    key: group.name,
    token: `tab:${group.items.find(({ section }) => section.addressWords?.tab)?.section.addressWords?.tab ?? group.name}`,
    label: group.name,
  }));
  /* A panel holding the record's own fields is drawn at once, hidden: those
     fields are what name the record in its head, and one row costs nothing.
     A panel of lists still costs nothing until it is opened. */
  const eager = groups.flatMap((group, i) => (group.items.some(({ section }) => section.kind === 'fields') ? [i] : []));
  return (
    <TabStrip
      tabs={tabs}
      name="Record sections"
      entry={entry}
      onTab={onTab}
      scoped={scoped}
      eager={eager}
      className=" page-tabs-sections"
      draw={(i) => <div className="page-tab-sections">{lay(groups[i].items)}</div>}
    />
  );
}

export function Sections({
  page,
  base,
  recordKey: key,
  plans,
  entry,
  onLabel,
  onEdit,
  onTab,
  region,
  onSectionLabel,
  titleOwner,
  onTitleEditor,
  only,
}: {
  page: PageDef;
  base: TableMeta;
  recordKey: Record<string, unknown>;
  plans: SectionPlan[];
  entry: PageEntry;
  onLabel: (label: string) => void;
  onEdit: (opts?: { inPlace?: boolean }) => void;
  onTab: (tab: string | undefined) => void;
  region?: 'main' | 'aside';
  onSectionLabel: (index: number, label: string | undefined) => void;
  titleOwner?: number;
  onTitleEditor?: (index: number, render: (() => ReactNode) | undefined) => void;
  /** A part of the region, by section index: a listing draws its photos and its body as two bands (PageLayout.tsx). */
  only?: (index: number) => boolean;
}) {
  /* Hidden sections are dropped here: hiding is a layout decision, and the
     original index travels with each one, because that is what the plan is
     keyed by. */
  const shown: Shown[] = page.sections
    .map((section, index) => ({ section, index }))
    /* A record header is drawn in the head (PageHead.tsx), not where it is written. */
    .filter(
      ({ section, index }) =>
        !section.hidden &&
        (!only || only(index)) &&
        !(section.kind === 'fields' && section.presentation === 'header') &&
        (!region || (section.region ?? 'main') === region),
    );
  const firstFields = shown.find(({ section }) => section.kind === 'fields')?.index;
  /* Only the aside's strips are scoped: the main column is the page, with or
     without an aside beside it, so its tabs keep their words in the address
     (/accounts/26/opportunities), never an index. */
  const scoped = region === 'aside';
  /* Each section stands behind its own boundary: one that throws while
     drawing says so under its heading, and the rest of the page stays. */
  const draw = (item: Shown, collapsed?: boolean) => (
    <ErrorBoundary
      key={`${item.index}${collapsed ? '-add' : ''}`}
      fallback={(note) => <SectionBox section={item.section} body={null} foldable={false} crashed={note} />}
    >
      <Slot
        page={page}
        section={item.section}
        index={item.index}
        plan={plans.find((p) => p.index === item.index) ?? { index: item.index }}
        base={base}
        recordKey={key}
        foldable={item.section.kind === 'fields' && item.index !== firstFields && !shell().publicVisitor()}
        entry={entry}
        onLabel={region ? undefined : onLabel}
        onSectionLabel={region ? onSectionLabel : undefined}
        onEdit={onEdit}
        titleOwner={titleOwner}
        onTitleEditor={onTitleEditor}
        collapsed={collapsed}
      />
    </ErrorBoundary>
  );
  /* A sequence of sections as the page draws them. `listTabs` is off inside
     a section's tab: a strip of lists inside a strip of sections is tabs in
     tabs, so there a panel's lists stack. */
  /* An App's page is laid out as its author wrote it: lists side by side
     become a tab strip only where the page says `listTabs: true` (or names
     tabs). A strip made on its own put two half-width lists in one
     full-width box. The Workbench's pages, built from the schema or by
     drag, keep the strip unless they say `listTabs: false`. */
  const autoTabs = inAppPage() ? page.listTabs === true : page.listTabs !== false;
  const lay = (items: Shown[], listTabs: boolean, grouped = false): ReactNode[] => {
    /* How long the run of lists containing each section is, so a run of one
       stays a plain section: one tab is a heading with a border around it. */
    const listRuns = new Map<number, number>();
    /* A gallery is a picture, not a table: it stands on its own, never a tab.
       Nor does a list an App's author gave a width: `width: 'half'` is a
       place on the page, and a tab strip spans it whole. The Workbench's
       builder gives every list it adds a width, so there a width is not a
       placement anyone chose, and its lists keep the strip. */
    /* A list that says what it does while empty (`empty: 'hide' | 'collapse'`) is a tab like any other: inside a strip
       an empty list is neither hidden nor collapsed, its tab shows it and the strip already folds it. */
    const tabbed = (section: PageSection) =>
      section.kind === 'list' && section.presentation !== 'gallery' && (section.width === undefined || !inAppPage());
    /* Outside a strip, such a list is left out or said in one line with its neighbours (PageEmptyRun.tsx). */
    const emptyable = (section: PageSection) => section.kind === 'list' && Boolean(section.emptyMode) && section.presentation !== 'card';
    /* Where a tab holds nothing but such lists, it never ends up with nothing. */
    const onlyEmptyable = items.length > 0 && items.every(({ section }) => emptyable(section));
    for (let i = 0; i < items.length; i += 1) {
      if (!tabbed(items[i].section)) continue;
      let end = i;
      while (end + 1 < items.length && tabbed(items[end + 1].section)) end += 1;
      for (let at = i; at <= end; at += 1) listRuns.set(at, end - i + 1);
      i = end;
    }
    const laid: ReactNode[] = [];
    let run: Shown[] | null = null;
    let strip: Shown[] | null = null;
    let leave: Shown[] | null = null;
    items.forEach((item, i) => {
      if (item.section.kind === 'metric') {
        strip = null;
        leave = null;
        if (!run) {
          run = [];
          laid.push(<MetricRun key={`run-${i}`} items={run} draw={draw} />);
        }
        run.push(item);
        return;
      }
      run = null;
      if (listTabs && autoTabs && listRuns.has(i) && (listRuns.get(i) ?? 0) > 1) {
        if (!strip) {
          strip = [];
          laid.push(<ListTabs key={`tabs-${i}`} items={strip} entry={entry} onTab={onTab} draw={draw} scoped={scoped} />);
        }
        strip.push(item);
        leave = null;
        return;
      }
      strip = null;
      if (emptyable(item.section)) {
        if (!leave) {
          leave = [];
          laid.push(
            <EmptyRun
              key={`empty-${i}`}
              items={leave}
              plans={plans}
              base={base}
              recordKey={key}
              draw={draw}
              rescue={grouped && onlyEmptyable}
            />,
          );
        }
        leave.push(item);
        return;
      }
      leave = null;
      laid.push(draw(item));
    });
    return laid;
  };
  /* Sections named into tabs: one strip per region, standing where the first
     of them stands, its tabs in the order their names first appear. The
     sections without a tab keep their order around it. One name alone is no
     strip — the parser refuses it, and a hidden section can still leave one —
     so its sections are drawn as they are. */
  const groups: Array<{ name: string; items: Shown[] }> = [];
  for (const item of shown) {
    const name = item.section.tab;
    if (!name) continue;
    const group = groups.find((g) => g.name === name);
    if (group) group.items.push(item);
    else groups.push({ name, items: [item] });
  }
  if (groups.length < 2) return <>{lay(shown, true)}</>;
  const first = shown.findIndex((item) => item.section.tab);
  return (
    <>
      {lay(shown.slice(0, first), true)}
      <SectionTabs groups={groups} entry={entry} onTab={onTab} scoped={scoped} lay={(items) => lay(items, false, true)} />
      {lay(
        shown.slice(first).filter((item) => !item.section.tab),
        true,
      )}
    </>
  );
}

/** A run of metrics is one item, not several: a strip with a line of its own. */
function MetricRun({ items, draw }: { items: Shown[]; draw: (item: Shown) => ReactNode }) {
  return <div className="page-metric-row">{items.map(draw)}</div>;
}
