/**
 * A keyboard-first selection queue: the rows as a listbox, and the entry's
 * bulk actions offered for exactly the selected keys.
 *
 * Selection is component-local and lives only as long as the list: the
 * exact keys of loaded records, pruned when a record leaves the list, never
 * "everything matching". A fixed-update bulk action is the same update a
 * record's own button makes, written per record through `applyBulk`, so the
 * answer is per record and one refusal neither undoes nor stops the others.
 * A bulk command — its reference declares `targets: 'many'` — is the atomic
 * other half of that contract: the command form opens once for the whole
 * selection, sends one request, and reports one outcome for the group.
 */
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { useSyncExternalStore, type ReactNode } from 'react';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppAction } from '../../shared/app.js';
import type { AppQueueList } from '@mistriwork/engine/shared/listPresentations.js';
import { primaryKey } from '@mistriwork/engine/shared/schema.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { listPresentationColumns } from '@mistriwork/engine/shared/appListColumns.js';
import { columnDisplay, columnLabel, keyOf, openRecord, state } from '@mistriwork/kit/client/core.js';
import { useChangedRows } from '@mistriwork/kit/client/liveState.js';
import { opensRecord } from '@mistriwork/kit/client/recordIntent.js';
import { keyText } from '@mistriwork/kit/client/recordTrail.js';
import { AvatarText } from '@mistriwork/kit/client/components/Dressed.js';
import { listColumn, namedCell } from '@mistriwork/kit/client/components/listColumn.js';
import type { TrailList } from '@mistriwork/kit/client/recordTrail.js';
import { bulkKey } from '@mistriwork/kit/client/bulkActions.js';
import { updateAttempts } from '@mistriwork/kit/client/updateAttempts.js';
import { CollectionSelection, type CollectionSelectionItem } from './CollectionSelection.js';
import { Value } from '@mistriwork/kit/client/components/Value.js';
import { dressFor, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import type { ModalRecord } from './RecordModal.js';
import { useBulkSelection, type BulkRecord } from '@mistriwork/kit/client/components/useBulkSelection.js';
import { useListOrder, type ListOrder } from '@mistriwork/kit/client/components/useListOrder.js';
import { useRowWindow } from '@mistriwork/kit/client/components/useRowWindow.js';
import { say } from '../copy/lists/components/QueueList.js';

interface QueueListProps {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  spec: AppQueueList;
  actions?: AppAction[];
  interactive?: boolean;
  /** Lets an otherwise read-only embedded queue open its records. */
  recordNavigation?: boolean;
  /** The entry's label: what the listbox is called to a reader. */
  label?: string;
  /** The list these rows are a page of, so a record opened here steps past the page (recordTrail.ts). */
  list?: TrailList;
  /** The view's hand order, where it keeps one (useListOrder.tsx). */
  order?: ListOrder;
  /** A reference column → the fetched path its record's name is read from (appListModel's referenceNames). */
  referenceLabels?: Record<string, string>;
  /** A split's rows: the row is the control that picks its record, marked where it is the one beside the list, with an avatar of this column. */
  pick?: { current?: Record<string, unknown>; avatar?: string };
}

/** The answer carries every column the queue reads, keys included. */
export function canShowQueue(table: TableMeta | undefined, columns: string[] | undefined, spec: AppQueueList): table is TableMeta {
  return Boolean(
    table && primaryKey(table).length && [...listPresentationColumns(spec), ...primaryKey(table)].every((name) => columns?.includes(name)),
  );
}

export function QueueList({
  table,
  rows,
  spec,
  actions = [],
  interactive = true,
  recordNavigation = false,
  label,
  list,
  order,
  referenceLabels,
  pick,
}: QueueListProps) {
  useMessageLanguage();
  useSyncExternalStore(updateAttempts.subscribe, updateAttempts.version, updateAttempts.version);
  /* A primary that is a reference is said by its record's name, as a line is:
     a lender's queue titled each application by its raw borrower key. */
  const titleOf = (row: Record<string, unknown>) => {
    const named = namedCell(table, spec.primary, row, referenceLabels);
    const plain = String(named.value ?? say('common.untitled'));
    if (named.column?.name !== spec.primary || named.value === null || named.value === undefined) return plain;
    /* The column's display rule says the title as the grid does (an enum's words, a figure's format): a queue
       titled each row by the stored key where the rule had words for it. A document, a code and a picture have
       no words to say; they stay the value. */
    const dress = dressFor(columnDisplay(table.id, spec.primary) as DisplayRule | null, named.value);
    if (!dress || dress.kind === 'json' || dress.kind === 'qr' || dress.kind === 'signature' || dress.kind === 'richText') return plain;
    return 'label' in dress ? dress.label : dress.text;
  };
  const connection = state.activeConnection ?? null;
  // A row another person just changed wears the grid's fading tint (docs/design.md, rule 11).
  const changedRows = useChangedRows(table.id, rows, (row) => keyOf(table, row) as Record<string, unknown> | null);
  const changedClass = (row: Record<string, unknown>) => (changedRows.has(row) ? ` row-changed-${changedRows.get(row)}` : '');
  const keyed: BulkRecord[] = rows.flatMap((row) => {
    const key = keyOf(table, row) as Record<string, unknown> | null;
    return key ? [{ id: bulkKey(table, key), key, label: titleOf(row), row }] : [];
  });
  const records: ModalRecord[] = keyed.map(({ key, label }) => ({ key, label }));
  const { byId, selection, change, bar, dialogs, offered } = useBulkSelection({ table, keyed, actions, interactive });
  // The row is what holds the focus in the selection grid, so a moved record's row takes it back.
  const ordering = useListOrder({
    table,
    rows,
    order,
    interactive,
    title: (row) => titleOf(row),
    focusOf: (item) => item.closest<HTMLElement>('[role="row"]'),
  });

  const items: CollectionSelectionItem[] = ordering.rows.map((row, index) => {
    const key = keyOf(table, row) as Record<string, unknown> | null;
    return key ? { key: bulkKey(table, key), label: titleOf(row) } : { key: `unkeyed:${index}`, label: titleOf(row), disabled: true };
  });
  const [detailName, metaName] = spec.lines ?? [];
  const badgeName = spec.badge;
  /* Facts reuse the cards presentation's compact, captioned vocabulary. */
  const factNames = [...new Set(spec.facts ?? [])];
  /* A queue label path is output under its full path, but dresses and formats
     as the target column (or rollup). Keep that full name so appnav resolves its display. */
  const presentationColumn = (name: string | undefined) => listColumn(table, name);
  const badge = presentationColumn(badgeName);
  const detail = presentationColumn(detailName);
  const meta = presentationColumn(metaName);
  const openLabel = spec.openLabel ?? say('open');
  const factColumns = factNames
    .map((name) => ({ name, column: presentationColumn(name) }))
    .filter((fact): fact is { name: string; column: NonNullable<ReturnType<typeof presentationColumn>> } => Boolean(fact.column));
  const caption = (name: string) => (columnLabel(table.id, name) as string | null) ?? humanName(name.split('.').pop() ?? name);
  /* A reference is said by its record's name where the list fetched one (listColumn.ts). */
  const cell = (name: string, row: Record<string, unknown>) => namedCell(table, name, row, referenceLabels);
  const renderFacts = (row: Record<string, unknown>) => {
    const shown = factColumns.flatMap(({ name }) => {
      const { column, value } = cell(name, row);
      return value != null && value !== '' ? [{ name, column, value }] : [];
    });
    if (!shown.length) return null;
    return (
      <dl className="queue-facts">
        {shown.map(({ name, column, value }) => (
          <div className="queue-fact" key={name}>
            <dt>{caption(name)}</dt>
            <dd>
              <Value tableId={table.id} col={column} value={value} compact />
            </dd>
          </div>
        ))}
      </dl>
    );
  };
  /* One row, compact: the title with its badge beside it, then one wrapping
     line of the quiet lines and the captioned facts, the action at the row's
     end — so a queue reads in half a dashboard's width without its facts
     stacking word by word. */
  const said = (column: ReturnType<typeof presentationColumn>, row: Record<string, unknown>) => {
    if (!column) return null;
    const { column: drawn, value } = cell(column.name, row);
    return value != null && value !== '' ? <Value tableId={table.id} col={drawn} value={value} compact /> : null;
  };
  const content = (row: Record<string, unknown>, title: string, extra?: ReactNode) => {
    const badgeValue = said(badge, row);
    const detailValue = said(detail, row);
    const metaValue = said(meta, row);
    const facts = renderFacts(row);
    const person = pick?.avatar ? cell(pick.avatar, row) : undefined;
    return (
      <>
        {person && person.value != null && person.value !== '' && <AvatarText text={String(person.value)} />}
        <div className="queue-content">
          <div className="queue-head">
            <span className="queue-title">{title}</span>
            {badgeValue && <span className="queue-badge">{badgeValue}</span>}
          </div>
          {(detailValue || metaValue || facts) && (
            <div className="queue-line">
              {detailValue && <span className="queue-detail">{detailValue}</span>}
              {metaValue && <span className="queue-meta">{metaValue}</span>}
              {facts}
            </div>
          )}
          {extra}
        </div>
      </>
    );
  };
  /* A long page is drawn around the viewport, in either form; the page, and
     so the selection, the pager and the record trail, is unchanged (useRowWindow.ts). */
  const plain = (!interactive && recordNavigation) || (interactive && !offered && !order);
  const plainWin = useRowWindow<HTMLUListElement>(plain ? rows.length : 0, { estimate: 64 });
  const selectWin = useRowWindow<HTMLDivElement>(plain ? 0 : rows.length, { estimate: 64 });
  /* Selection earns its place only when this reader can act on a group or
     reorder it. Ordinary task queues share the dashboard's explicit links. */
  if (plain && pick)
    return (
      <div className="queue queue-pick-list">
        <ul className="queue-list" aria-label={label ?? say('queue')} ref={plainWin.ref}>
          {plainWin.before > 0 && <li className="queue-spacer" aria-hidden="true" style={{ height: `${plainWin.before}px` }} />}
          {plainWin.indices.map((index) => {
            const row = ordering.rows[index];
            const key = keyOf(table, row) as Record<string, unknown> | null;
            const title = titleOf(row);
            const here = Boolean(key && pick.current && keyText(key) === keyText(pick.current));
            return (
              <li
                key={key ? bulkKey(table, key) : `unkeyed:${index}`}
                className={`queue-row${changedClass(row)}`}
                {...(plainWin.windowed ? { 'data-index': plainWin.lineOf(index), ref: plainWin.measure } : {})}
              >
                <button
                  type="button"
                  className="queue-pick"
                  aria-current={here ? 'true' : undefined}
                  data-opens={key ? opensRecord(table.id, key) : undefined}
                  disabled={!key}
                  onClick={() => {
                    if (key) void openRecord(table.id, key, title, 'push', { records, list });
                  }}
                >
                  {content(row, title)}
                </button>
              </li>
            );
          })}
          {plainWin.after > 0 && <li className="queue-spacer" aria-hidden="true" style={{ height: `${plainWin.after}px` }} />}
        </ul>
      </div>
    );
  if (plain)
    return (
      <div className="queue">
        <ul className="queue-list" aria-label={label ?? say('queue')} ref={plainWin.ref}>
          {plainWin.before > 0 && <li className="queue-spacer" aria-hidden="true" style={{ height: `${plainWin.before}px` }} />}
          {plainWin.indices.map((index) => {
            const row = ordering.rows[index];
            const key = keyOf(table, row) as Record<string, unknown> | null;
            const title = titleOf(row);
            return (
              <li
                key={key ? bulkKey(table, key) : `unkeyed:${index}`}
                className={`queue-row${changedClass(row)}`}
                {...(plainWin.windowed ? { 'data-index': plainWin.lineOf(index), ref: plainWin.measure } : {})}
              >
                {content(row, title)}
                {key ? (
                  <button
                    type="button"
                    className="ghost queue-open"
                    aria-label={`${openLabel} ${title}`}
                    data-opens={opensRecord(table.id, key)}
                    onClick={() => void openRecord(table.id, key, title, 'push', { records, list })}
                  >
                    {openLabel}
                  </button>
                ) : null}
              </li>
            );
          })}
          {plainWin.after > 0 && <li className="queue-spacer" aria-hidden="true" style={{ height: `${plainWin.after}px` }} />}
        </ul>
      </div>
    );
  const renderItem = (item: CollectionSelectionItem) => {
    const record = byId.get(item.key);
    const row = record?.row ?? ordering.rows[Number(item.key.slice('unkeyed:'.length))] ?? {};
    const title = record?.label ?? titleOf(row);
    const attempt = record && updateAttempts.get({ connection, table: table.id, key: record.key });
    return (
      <div className={`queue-row${changedClass(row)}`} {...ordering.item(item.key)}>
        {content(
          row,
          title,
          attempt && (
            <p className="queue-status" role={attempt.phase === 'uncertain' ? 'alert' : 'status'}>
              {attempt.phase === 'pending' ? say('common.saving') : say('common.openThisRecordToCheck', { message: attempt.message })}
            </p>
          ),
        )}
        {ordering.menu(item.key)}
        {/* Opening is not selecting: the click stays on the button, and so does
          the Enter the row would otherwise read as a toggle. */}
        <button
          type="button"
          className="ghost queue-open"
          aria-label={`${openLabel} ${title}`}
          disabled={!interactive || !record}
          data-opens={record && interactive ? opensRecord(table.id, record.key) : undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (record && interactive) void openRecord(table.id, record.key, title, 'push', { records, list });
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {openLabel}
        </button>
      </div>
    );
  };

  return (
    <div className="queue" {...ordering.zone}>
      {bar}
      <CollectionSelection
        items={items}
        selectedKeys={selection}
        ariaLabel={label ?? say('queue')}
        emptyMessage={say('noRecords')}
        onSelectionChange={change}
        renderItem={renderItem}
        onItemKey={(event, item) => ordering.keyDown(event, item.key)}
        {...(selectWin.windowed ? { window: selectWin } : {})}
      />
      {dialogs}
      {ordering.live}
    </div>
  );
}
