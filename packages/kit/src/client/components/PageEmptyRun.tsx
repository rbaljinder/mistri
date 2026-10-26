/**
 * Related lists that may be left out while they have no rows (`empty: 'hide' | 'collapse'`, or the page's), decided
 * where a run of them stands, because only the page sees the lists beside each one. Each list is asked the question
 * it asks itself (the same query, so the answer is shared), and then:
 *
 * - a list with rows is drawn as ever;
 * - an empty one that hides is left out, unless the reader may add to it: a door is never taken away, so it collapses;
 * - empty ones that collapse, side by side, are one quiet line where the first stood — "No charges, payments or notes
 *   yet" — each with its Add, instead of one "No … yet" sentence under each of several headings;
 * - a tab keeps at least one list: where a tab holds nothing but lists and they are all empty, they are said in a
 *   line rather than leaving the tab blank.
 *
 * Inside a `listTabs` strip an empty list is neither hidden nor collapsed: its tab shows it (PageSections.tsx).
 */
import { shellRoot } from '../shellHost.js';
import { useContext, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { PageSection, SectionPlan } from './pageModel.js';
import { rootMatches } from './pageModel.js';
import { PageRenderContext, usePageApi } from './pageContext.js';
import { listRead, listThings, relatedDoor } from './PageRelated.js';
import { groupsBody } from '@mistriwork/engine/shared/recordReads.js';
import { Empty } from './Notes.js';
import { say } from '../copy/record/components/PageEmptyRun.js';
import { useMessageLanguage } from './useMessageLanguage.js';

interface RunItem {
  section: PageSection;
  index: number;
}

/** What a list is, for deciding: waiting to know, with rows (or broken, which it says itself), or empty. */
type Standing = 'wait' | 'rows' | 'empty' | 'gone';

/** The names said as a sentence's list: "charges, payments or notes". */
function said(names: string[]): string {
  try {
    return new Intl.ListFormat(shellRoot().lang || undefined, { type: 'disjunction', style: 'long' }).format(names);
  } catch {
    return names.join(', ');
  }
}

export function EmptyRun({
  items,
  plans,
  base,
  recordKey,
  draw,
  rescue,
}: {
  items: RunItem[];
  plans: SectionPlan[];
  base: TableMeta;
  recordKey: Record<string, unknown>;
  /** One list as the page draws it; `collapsed` draws only its Add. */
  draw: (item: RunItem, collapsed?: boolean) => ReactNode;
  /** The run is all a tab holds: it never leaves the tab with nothing. */
  rescue: boolean;
}) {
  useMessageLanguage();
  const api = usePageApi();
  const context = useContext(PageRenderContext);
  const planOf = (item: RunItem): SectionPlan => plans.find((p) => p.index === item.index) ?? { index: item.index };
  const reads = items.map((item) => listRead(item.section, planOf(item)).view);
  const asked = useQueries({
    queries: items.map((item, i) => {
      const plan = planOf(item);
      const view = reads[i];
      /* A grouped list is empty when it has no groups: it asks the groups it asks itself (PageRelated.tsx). */
      if (item.section.group && plan.groups) {
        const groups = plan.groups;
        return {
          queryKey: ['page-list', 'groups', groups, 0],
          queryFn: () => api('/api/breakdown', groupsBody(groups, 0)),
          enabled: !plan.empty && !plan.error,
          staleTime: 0,
        };
      }
      return {
        queryKey: ['page-list', view, 0],
        queryFn: () => api('/api/view/run', { view: view!, offset: 0 }),
        enabled: !plan.empty && !plan.error && Boolean(view),
        staleTime: 0,
      };
    }),
  });
  const gates = useQueries({
    queries: items.map((item) => ({
      queryKey: ['when', base.id, recordKey, item.section.when ?? `none-${item.index}`],
      queryFn: () => rootMatches(base, recordKey, item.section.when!, context.connection),
      enabled: Boolean(item.section.when),
      staleTime: 0,
    })),
  });
  const standing = (i: number): Standing => {
    const { section } = items[i];
    const plan = planOf(items[i]);
    if (section.when && gates[i].data !== true) return gates[i].isPending ? 'wait' : 'gone';
    if (plan.error) return 'rows';
    if (plan.empty) return 'empty';
    const grouped = Boolean(section.group && plan.groups);
    if (!reads[i] && !grouped) return 'rows';
    const got = asked[i].data;
    if (asked[i].isPending) return 'wait';
    if (grouped) return got && !('errors' in got) && got.rows.length === 0 ? 'empty' : 'rows';
    return got && 'view' in got && got.rows.length === 0 ? 'empty' : 'rows';
  };
  const states = items.map((_, i) => standing(i));
  /* Nothing here is drawn as a list: the run is all that stands in its tab, so it may not vanish. */
  const nothingElse = rescue && states.every((state) => state === 'empty' || state === 'gone') && states.includes('empty');
  const door = (item: RunItem) => relatedDoor(item.section, base, recordKey, { preview: context.preview, actions: context.actions }).door;

  const laid: ReactNode[] = [];
  let line: RunItem[] = [];
  const flush = () => {
    if (!line.length) return;
    const group = line;
    line = [];
    const adds = group.map((item) => draw(item, true));
    laid.push(
      <Empty
        key={`empty-${group[0].index}`}
        className="page-empty-run"
        text={say('noThingsYet', { things: said(group.map((item) => listThings(item.section))) })}
        action={adds.some(Boolean) ? <>{adds}</> : undefined}
      />,
    );
  };
  items.forEach((item, i) => {
    const state = states[i];
    if (state === 'gone') return;
    if (state !== 'empty') {
      flush();
      laid.push(draw(item));
      return;
    }
    if (item.section.emptyMode === 'collapse' || nothingElse || door(item)) line.push(item);
  });
  flush();
  return <>{laid}</>;
}
