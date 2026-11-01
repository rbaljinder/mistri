/**
 * The peek drawer: a record glanced, not visited.
 *
 * An entry that says `open: "drawer"` sends its row clicks here — a panel
 * over the right side of the list, holding the record's fields in the
 * app's own dress, dismissed by Escape or the backdrop, with the full
 * page one deliberate click away. Nothing inside navigates and nothing
 * lands in the URL: a peek is a glance, and a glance you could bookmark
 * would be a page wearing less. The presentation is the app's choice
 * through one word of config. Editable modal presentation uses RecordModal
 * and the authored PageView instead of turning this glance into another editor.
 *
 * The panel covers the list's right side, so it is a dialog like any other
 * (Modal.tsx): it takes the focus when it opens and holds Tab, which used to
 * walk on into the controls under it, and Escape hands the focus back to the
 * row it was opened from (peekpanel.js).
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, columnLabel, emptyWord, findTable, labelPath, openRecord, primaryKey, rowLabel, state } from '../core.js';
import { keyText, trailFor, type TrailList } from '../recordTrail.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { pathEqualityFilter } from '../resourceRequests.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { RefJump, Value } from './Value.js';
import { referenceProjection } from '@mistriwork/engine/shared/referenceModel.js';
import { TrailSteps, useTrailStep } from './RecordTrailNav.js';
import { say } from '../copy/record/components/PeekPanel.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

type Row = Record<string, unknown>;

interface PeekPanelProps {
  tableId: string;
  recordKey: Record<string, unknown>;
  label?: string | null;
  onClose: () => void;
  /** The list the glance was opened from: J and K, and the arrows, step through it. */
  records?: Array<{ key: Record<string, unknown>; label?: string | null }>;
  /** That list's question and page, so a step past the page reads the next one (recordTrail.ts). */
  list?: TrailList;
}

const typingIn = (element: Element | null) =>
  Boolean(element) && (/^(input|textarea|select)$/i.test(element!.tagName) || (element as HTMLElement).isContentEditable);

/**
 * The row is fetched fresh — a peek that showed the grid's projection
 * would show five columns and call it the record. References speak names,
 * unconditionally: "who is 8?" without a hover is the whole point of a
 * glance. Each label is one more joined column in the same query, the
 * page-fields pattern; the id stays in the chip's tooltip.
 */
function useGlance(table: TableMeta, recordKey: Record<string, unknown>) {
  const { fetched: paths, labels: refLabelAt } = referenceProjection(
    state.schema,
    table,
    [...new Set([...table.columns.map((col) => col.name), ...(labelPath(table) ? [labelPath(table)!] : [])])],
    true,
    labelPath,
  );
  const keyValues = (primaryKey(table) as string[]).map((c) => recordKey[c]);
  const row = useQuery<Row | null>({
    queryKey: ['peekpanel', (state as { activeConnection?: string }).activeConnection ?? '', table.id, keyValues],
    queryFn: async () => {
      const data = await api('/api/view/run', {
        view: {
          id: `peek:${table.id}`,
          name: table.name,
          base: table.id,
          columns: paths.map((path) => ({ path })),
          filter: pathEqualityFilter(Object.fromEntries((primaryKey(table) as string[]).map((column) => [column, recordKey[column]]))),
          limit: 1,
        },
      });
      return data.rows?.[0] ?? null;
    },
    retry: false,
  });
  return { row, refLabelAt };
}

export function PeekPanel({ tableId, recordKey, label, onClose, records, list }: PeekPanelProps) {
  const table = findTable(tableId) as TableMeta | undefined;
  /* The focus lands on the title, not the first button: the Space that opened
     the glance is still held, and its release would press whatever button
     took the focus. J, K and Tab all start from there. */
  const title = useRef<HTMLHeadingElement>(null);
  /* The glance steps through the list it was opened from, when it was given
     one — past its page too; the record it was opened on is the starting place. */
  const [trail, setTrail] = useState(() =>
    trailFor(
      tableId,
      recordKey,
      records?.map((record) => ({ key: record.key, ...(record.label == null ? {} : { label: record.label }) })),
      list,
    ),
  );
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const { step, reading } = useTrailStep(trail, setTrail, () => open.current);
  const stepRef = useRef(step);
  stepRef.current = step;
  const current = trail ? trail.records[trail.index] : { key: recordKey, label };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        /* A modal takes the key it handles — same manners as the palette. */
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      /* J and K, as on a record page: the glance is over the list, so the
         keys are its own while it is open — unless something is being typed. */
      if ((e.key === 'j' || e.key === 'k') && !e.metaKey && !e.ctrlKey && !e.altKey && !typingIn(document.activeElement)) {
        e.preventDefault();
        e.stopPropagation();
        void stepRef.current(e.key === 'j' ? 1 : -1);
      }
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onClose]);
  if (!table) return null;
  const steps = trail && <TrailSteps trail={trail} reading={reading} onStep={(by) => void step(by)} />;
  /* Plain: the panel places itself over the page's right side, and its scrim
     is named after its first class (features.css). */
  return (
    <Modal
      className="peekpanel-glance peekpanel"
      plain
      onClose={onClose}
      initialFocus={title}
      ariaLabel={current.label ? say('aGlance', { label: current.label }) : say('aGlanceAtTheRecord')}
    >
      <Glance table={table} recordKey={current.key} label={current.label} onClose={onClose} steps={steps} title={title} />
    </Modal>
  );
}

function Glance({
  table,
  recordKey,
  label,
  onClose,
  steps,
  title,
}: {
  table: TableMeta;
  recordKey: Record<string, unknown>;
  label?: string | null;
  onClose: () => void;
  steps?: ReactNode;
  title: RefObject<HTMLHeadingElement | null>;
}) {
  const { row, refLabelAt } = useGlance(table, recordKey);
  const said = row.data ? (rowLabel(table, row.data) as string | null) : null;
  const naming = labelPath(table) as string | undefined;
  return (
    <>
      {/* The head stays as J and K step, so the focus on its title or on a
          step is not dropped with the record being left; only the body, keyed
          by the record, is drawn anew (and starts at its top). */}
      <div className="peekpanel-head">
        <h2 className="peekpanel-title" ref={title} tabIndex={-1}>
          {said ?? label ?? '…'}
        </h2>
        {steps}
        <button
          type="button"
          className="ghost peekpanel-open"
          title={say('theFullPageWithItsSections')}
          onClick={() => {
            onClose();
            void openRecord(table.id, recordKey, label, 'push', { direct: true });
          }}
        >
          {say('common.details')}
        </button>
        <button type="button" className="peekpanel-close" aria-label={say('common.close')} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="peekpanel-body" key={keyText(recordKey)}>
        {row.isPending ? (
          <p className="note">{say('common.reading')}</p>
        ) : row.isError ? (
          <p className="note">{(row.error as Error).message}</p>
        ) : !row.data ? (
          <p className="note">{say('common.thatRecordIsNoLonger')}</p>
        ) : (
          <div className="peekpanel-fields">
            {/* The name is the title; repeating it as the first field says
                      nothing twice. Everything else shows, nulls included — a
                      glance answers "what do we know", and "nothing" is an answer. */}
            {table.columns
              .filter((col) => col.name !== naming)
              .map((col) => {
                const value = row.data![col.name];
                return (
                  <div key={col.name} className="field">
                    <dt title={col.name}>{(columnLabel(table.id, col.name) as string | null) ?? col.name}</dt>
                    {value === null || value === undefined ? (
                      <dd className="null" title="null">
                        {emptyWord()}
                      </dd>
                    ) : col.references && String(value) !== '' ? (
                      <dd>
                        <RefJump
                          references={col.references}
                          value={value}
                          label={refLabelAt.has(col.name) ? row.data![refLabelAt.get(col.name)!] : undefined}
                          table={table}
                          column={col.name}
                          row={row.data!}
                        />
                      </dd>
                    ) : (
                      <dd>
                        <Value col={col} value={value} tableId={table.id} />
                      </dd>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </>
  );
}
