/**
 * What is on the other end of a reference, without going there.
 *
 * `sold_by 4` is a promise that an answer exists in another table. So a
 * reference answers itself on hover: a card with the referenced row's
 * identifying fields, near the chip, gone when the pointer leaves. Three
 * things make it bearable: it waits until the pointer has settled, it
 * remembers (the cache is Query's), and it gives up quietly.
 *
 * One layer for the whole page, listening on the document: a table redraws
 * its rows on every page and a virtualised one replaces them as you scroll,
 * so a listener per chip would be thousands of registrations with no one
 * place to take them off again.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, columnLabel, emptyWord, findTable, labelPath, state, viewportBox, viewportSize } from '../core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { presentationColumns } from './columnPresentation.js';
import { Value } from './Value.js';
import { say } from '../copy/record/components/Peek.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

/** How long the pointer must rest on a chip before anything is fetched. */
const SETTLE_MS = 320;
/** Fields shown before the card stops listing. */
const FIELDS = 6;

interface Target {
  chip: HTMLElement;
  table: TableMeta;
  column: string;
  value: string;
}

/** The key first, then the label column, then whatever else fits. */
function fieldsFor(table: TableMeta): string[] {
  const key = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const label = labelPath(table) as string | undefined;
  return [
    ...key,
    ...(label && !key.includes(label) ? [label] : []),
    ...table.columns.map((c) => c.name).filter((n) => !key.includes(n) && n !== label),
  ].slice(0, FIELDS);
}

export function PeekLayer() {
  const [target, setTarget] = useState<Target | null>(null);
  useEffect(() => {
    let timer = 0;
    const onEnter = (e: Event) => {
      const chip = (e.target as Element).closest?.('[data-ref-table]') as HTMLElement | null;
      if (!chip) return;
      const table = findTable(chip.dataset.refTable ?? '') as TableMeta | undefined;
      const column = chip.dataset.refColumn;
      const value = chip.dataset.refValue;
      if (!table || !column || !value) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => setTarget({ chip, table, column, value }), SETTLE_MS);
    };
    const onLeave = (e: Event) => {
      if ((e.target as Element).closest?.('[data-ref-table]')) {
        clearTimeout(timer);
        setTarget(null);
      }
    };
    const hide = () => {
      clearTimeout(timer);
      setTarget(null);
    };
    addHostListener(document, 'mouseover', onEnter);
    addHostListener(document, 'mouseout', onLeave);
    /* Focus opens it too, so the card is reachable without a pointer. */
    addHostListener(document, 'focusin', onEnter);
    addHostListener(document, 'focusout', onLeave);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    addHostListener(document, 'keydown', onKey);
    // Anything that moves the page out from under the card invalidates it.
    addHostListener(window, 'scroll', hide, true);
    addHostListener(window, 'resize', hide);
    return () => {
      clearTimeout(timer);
      removeHostListener(document, 'mouseover', onEnter);
      removeHostListener(document, 'mouseout', onLeave);
      removeHostListener(document, 'focusin', onEnter);
      removeHostListener(document, 'focusout', onLeave);
      removeHostListener(document, 'keydown', onKey);
      removeHostListener(window, 'scroll', hide, true);
      removeHostListener(window, 'resize', hide);
    };
  }, []);
  return target ? <PeekCard target={target} /> : null;
}

function PeekCard({ target }: { target: Target }) {
  const { chip, table, column, value } = target;
  const fields = fieldsFor(table);
  const columns = presentationColumns(state.schema, table, fields);
  /* The connection is part of the key: staging's employee must not show for
     production's reference. */
  const row = useQuery<Record<string, unknown> | null>({
    queryKey: ['peek', (state as { activeConnection?: string }).activeConnection ?? '', table.id, column, value, fields],
    queryFn: async () => {
      const data = await api('/api/view/run', {
        view: {
          id: `peek:${table.id}`,
          name: table.name,
          base: table.id,
          columns: fields.map((path) => ({ path })),
          filter: { groups: [[{ path: column, op: '=', value }]] },
          limit: 1,
        },
      });
      return data.rows?.[0] ?? null;
    },
    staleTime: Infinity,
    retry: false,
  });
  const card = useRef<HTMLDivElement>(null);

  /* The native tooltip has to go while the card is up: taken off the anchor
     and anything inside it, and only what was there is put back. */
  useEffect(() => {
    if (!row.data) return;
    const suppressed: Array<[Element, string]> = [];
    for (const node of [chip, ...chip.querySelectorAll('[title]')]) {
      const title = node.getAttribute('title');
      if (title === null) continue;
      suppressed.push([node, title]);
      node.removeAttribute('title');
    }
    return () => {
      for (const [node, title] of suppressed) node.setAttribute('title', title);
    };
  }, [row.data, chip]);

  /* Against the *value*, not the cell: the cell's text alignment says which
     edge the reader is looking at. Below by default; up only when there is
     no room; nudged sideways rather than allowed off the edge. */
  useLayoutEffect(() => {
    const node = card.current;
    if (!node || !chip.isConnected) return;
    const at = viewportBox(chip);
    const box = viewportBox(node);
    const view = viewportSize();
    const margin = 8;
    let top = at.bottom + 4;
    if (top + box.height > view.height - margin) {
      const above = at.top - box.height - 4;
      top = above > margin ? above : Math.max(margin, view.height - box.height - margin);
    }
    const align = getComputedStyle(chip).textAlign;
    const wanted =
      align === 'right' || align === 'end' ? at.right - box.width : align === 'center' ? at.left + at.width / 2 - box.width / 2 : at.left;
    const left = Math.min(Math.max(margin, wanted), Math.max(margin, view.width - box.width - margin));
    node.style.top = `${Math.round(top)}px`;
    node.style.left = `${Math.round(left)}px`;
  });

  if (!row.data || !chip.isConnected) return null;
  const data = row.data;
  return (
    <div className="peek" role="tooltip" ref={card}>
      <div className="peek-head">
        <span className="peek-table">{table.name}</span>
        <span className="peek-key">{value}</span>
      </div>
      <div className="peek-body">
        {fields.map((name) => (
          <div key={name} className="peek-line">
            <span className="peek-name" title={name}>
              {(columnLabel(table.id, name) as string | null) ?? name}
            </span>
            {data[name] === null || data[name] === undefined ? (
              <span className="peek-value null" title="null">
                {emptyWord()}
              </span>
            ) : (
              <div className="peek-value">
                <Value col={columns.get(name)} value={data[name]} tableId={table.id} compact />
              </div>
            )}
          </div>
        ))}
      </div>
      {/* The card is a glance; clicking the chip is the walk. */}
      <div className="peek-foot">{say('clickToOpen')}</div>
    </div>
  );
}
