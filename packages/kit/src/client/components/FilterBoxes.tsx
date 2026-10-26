/**
 * Named filter boxes over a table — one grammar, two modes.
 *
 * The workbench mounts the boxes above the plain table view; an app mounts
 * the same boxes inside its own filter section, with tabs and Advanced
 * around them. Both write the same language into the same place — the
 * entry's query text — so a box's state is a condition *tail*: `= open`,
 * `= last 30 days`, `is empty`, or '' for none.
 *
 * The parent holds what the person has set by hand, box by box. Only a
 * touched box speaks on submit: an untouched one used to read the query
 * back through its own narrow eyes and rewrite it, and a tab whose column
 * held two conditions came back holding one. The text already holds
 * whatever the boxes have not touched.
 */
import { useMessageLanguage } from './useMessageLanguage.js';
import { ownedBy } from '../requestIdentity.js';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, columnLabel, findTable, labelPath, primaryKey, quote, state } from '../core.js';
import { columnKind, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { DATE_OPTIONS, boxKind, conditionTail, equalsTail, squeeze, unquote, withCondition } from '../filterbar.js';
import { Dropdown } from './Dropdown.js';
import { tagsTail } from './filterRailModel.js';
import { presentationColumns } from './columnPresentation.js';
import { hasFilterOf } from '@mistriwork/engine/shared/listFilters.js';
import { tryResolvePath } from '@mistriwork/engine/shared/view.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import { say } from '../copy/filters/components/FilterBoxes.js';

type BoxKind = 'text' | 'ref' | 'flag' | 'enum' | 'date' | 'tags';

/** What a person set in a box: the text they typed and, for a reference, the row they picked; or a chosen tail. */
export interface BoxEdit {
  raw?: string;
  id?: string | null;
  tail?: string;
}

/** `exact`: the source matches whole values only (an API), so typed text is asked as `=`, never `contains`. */
export interface Box {
  column: string;
  label: string;
  kind: BoxKind;
  meta: ColumnMeta | undefined;
  exact?: boolean;
  /** The columns whose values the box suggests as the reader types: the list view's `suggest` (SuggestBox.tsx). */
  suggest?: readonly string[];
  /**
   * The rows that point at the record, where the box asks about them (shared/listFilters.ts): their table, and
   * the column or path of theirs it asks — `meta` is that column — or, `segment`, one of their segments, whose
   * box is a yes with no value.
   */
  has?: { child: string; asks: string; segment: boolean };
}

/* A column a path ends on, dressed as the box kind reads it: its own name, on the table that holds it, so a
   reference across a hop is a typeahead of its records as one on the list's own table is. */
function kindAt(table: TableMeta | undefined, path: string, meta: ColumnMeta | undefined): BoxKind {
  if (!meta || !table || !state.schema || !path.includes('.')) return boxKind(meta, table?.id) as BoxKind;
  const { resolved } = tryResolvePath(state.schema, table.id, path);
  return boxKind(resolved ? { ...meta, name: resolved.column.name } : meta, resolved?.table.id) as BoxKind;
}

/** The boxes a table gets, for a set of column names. */
export function boxesFor(table: TableMeta | undefined, names: string[], labelOf: (name: string) => string): Box[] {
  const columns = presentationColumns(
    state.schema,
    table,
    names.filter((name) => !hasFilterOf(name)),
  );
  return names.map((name) => {
    const has = hasFilterOf(name);
    if (has) {
      const child = (findTable(has.child) ?? state.schema?.tables.find((t: TableMeta) => t.name === has.child)) as TableMeta | undefined;
      const segment = Boolean(child?.segments && Object.hasOwn(child.segments, has.asks));
      const meta = segment ? undefined : (presentationColumns(state.schema, child, [has.asks]).get(has.asks) as ColumnMeta | undefined);
      return {
        column: name,
        label: labelOf(name),
        kind: segment ? 'flag' : kindAt(child, has.asks, meta),
        meta,
        has: { child: child?.id ?? has.child, asks: has.asks, segment },
      };
    }
    const meta = columns.get(name) as (ColumnMeta & { allowed?: string[] }) | undefined;
    return {
      column: name,
      label: labelOf(name),
      kind: kindAt(table, name, meta),
      meta,
      ...(table?.filterable ? { exact: true } : {}),
    };
  });
}

/** The tail a box stands for: what was set by hand, else what the text already says. */
/** A text box over a number column holding words: not sent, since the
    database refuses words compared with a number (PostgreSQL's 22P02), and
    the box says what it takes instead. */
export function wrongForNumber(box: Box, raw: string | undefined): boolean {
  const text = (raw ?? '').trim().replace(/^=\s*/, '');
  return (
    Boolean(text) &&
    box.meta !== undefined &&
    columnKind(box.meta.type) === 'number' &&
    !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text)
  );
}

export function boxTail(box: Box, edit: BoxEdit | undefined, current: string): string {
  if (!edit) return current;
  if (box.kind === 'text') {
    const raw = (edit.raw ?? '').trim();
    if (!raw) return '';
    if (wrongForNumber(box, raw)) return current;
    const fuzzy = !box.exact && box.meta ? columnKind(box.meta.type) === 'text' : false;
    if (!fuzzy) return equalsTail(raw);
    if (raw.startsWith('=')) return equalsTail(raw.slice(1).trim());
    return `contains ${quote(raw)}`;
  }
  if (box.kind === 'ref') {
    const raw = (edit.raw ?? '').trim();
    if (!raw) return '';
    if (edit.id != null) return `= ${quote(edit.id)}`;
    return equalsTail(raw);
  }
  return edit.tail ?? '';
}

/** What a text box shows for a tail: the words it searches for, `=` and the
    value for an exact match on text, the value for a number; '' for a
    condition a box cannot say. The bar's box and an App list's search read it. */
export function boxText(box: Box, tail: string): string {
  const fuzzy = box.meta ? columnKind(box.meta.type) === 'text' : false;
  if (tail.startsWith('contains ')) return unquote(tail.slice('contains '.length));
  if (tail.startsWith('= ')) return fuzzy ? `=${unquote(tail.slice(2))}` : unquote(tail.slice(2));
  return '';
}

interface FilterBoxesProps {
  boxes: Box[];
  /** The visible question, for what each box reads when untouched. */
  refinement: string;
  edits: Record<string, BoxEdit>;
  onEdit: (column: string, edit: BoxEdit) => void;
  /** A pick is a decision: enums, dates, flags and reference picks submit themselves. */
  onSubmit: () => void;
}

function FilterBoxes({ boxes, refinement, edits, onEdit, onSubmit }: FilterBoxesProps) {
  useMessageLanguage();
  return (
    <>
      {boxes.map((box) => (
        <label key={box.column} className="applist-field" data-column={box.column}>
          <span className="applist-field-label">{box.label}</span>
          <BoxControl
            box={box}
            tail={conditionTail(refinement, box.column) as string}
            edit={edits[box.column]}
            onEdit={(e) => onEdit(box.column, e)}
            onSubmit={onSubmit}
          />
        </label>
      ))}
    </>
  );
}

function BoxControl({
  box,
  tail,
  edit,
  onEdit,
  onSubmit,
}: {
  box: Box;
  tail: string;
  edit: BoxEdit | undefined;
  onEdit: (e: BoxEdit) => void;
  onSubmit: () => void;
}) {
  const { kind, meta, label, column } = box;
  if (kind === 'text') {
    /* A search box on a text column searches: `contains`, any case, and an
       exact match is one `=` prefix away. A number is named, so it keeps
       plain equality. */
    const fuzzy = meta ? columnKind(meta.type) === 'text' : false;
    const shown = edit?.raw !== undefined ? edit.raw : boxText(box, tail);
    return (
      <input
        type="text"
        className="applist-quick applist-quick-text"
        value={shown}
        aria-label={say('common.filter2', { label })}
        title={fuzzy ? say('common.matchesAnywhereInTheValue') : meta?.references ? say('filtersByTheId', { column }) : undefined}
        onChange={(e) => onEdit({ raw: e.target.value })}
      />
    );
  }
  if (kind === 'ref') {
    return <RefBox box={box} tail={tail} edit={edit} onEdit={onEdit} onSubmit={onSubmit} />;
  }
  if (kind === 'flag') {
    /* A checkbox, not a dropdown: the question a flag box answers is "only
       the urgent ones?", and that is one gesture. An untouched checkbox
       leaves a `= false` it cannot draw exactly as it found it. */
    const checked = edit ? edit.tail === '= true' : tail === '= true';
    return (
      <span className="applist-check">
        <input
          type="checkbox"
          className="applist-checkbox"
          aria-label={say('common.only', { label })}
          checked={checked}
          onChange={(e) => {
            onEdit({ tail: e.target.checked ? '= true' : '' });
            queueMicrotask(onSubmit);
          }}
        />
      </span>
    );
  }
  const options: Array<[string, string]> =
    kind === 'date'
      ? (DATE_OPTIONS as Array<[string, string]>)
      : // A list of choices (a row-defined `choices` field) is asked whether it has the value, not whether it is it.
        ((meta as (ColumnMeta & { allowed?: string[] }) | undefined)?.allowed ?? []).map(
          (v) => [v, kind === 'tags' ? tagsTail([v]) : equalsTail(v)] as [string, string],
        );
  /* A condition the menu has no word for — `= last month` typed in
     Advanced — is preserved until the person actually picks something. */
  const chosen = edit ? (edit.tail ?? '') : (options.find(([, value]) => squeeze(value) === tail)?.[1] ?? '');
  return (
    <Dropdown
      items={[{ value: '', label: 'any' }, ...options.map(([l, value]) => ({ value, label: l }))]}
      value={chosen}
      ariaLabel={say('common.filter2', { label })}
      onChange={(value) => {
        onEdit({ tail: value });
        queueMicrotask(onSubmit);
      }}
    />
  );
}

/**
 * A reference box: type a name, pick a row, and the query says the id.
 * "nia", pick "Nia Andersen", the query says owner_id = 14. The list wears
 * the house listbox's clothes and the combobox contract.
 */
/* The table a reference box names rows of, the column it names them by, and the key it writes. */
function referenceTarget(box: Pick<Box, 'meta'>) {
  const meta = box.meta as (ColumnMeta & { references?: { table: string; column: string } }) | undefined;
  const target = findTable(meta?.references?.table ?? '') as TableMeta | undefined;
  return {
    target,
    labelCol: target ? ((labelPath(target) as string | undefined) ?? primaryKey(target)[0]) : undefined,
    pk: target ? ((primaryKey(target) as string[])[0] ?? 'id') : 'id',
    connection: state.activeConnection,
  };
}

/**
 * The read of the name behind a reference's id — `= 9` is "Nia Andersen".
 * One query for one id, so the box that shows it, an App list's chip and
 * the words a condition is said in (useConditionWords.ts) share it.
 */
export function referenceNameQuery(meta: ColumnMeta | undefined, id: string | null, enabled = true) {
  const { target, labelCol, pk, connection } = referenceTarget({ meta });
  return {
    queryKey: ['ref-name', connection, target?.id, pk, id, labelCol],
    queryFn: async (): Promise<string | null> => {
      const data = await api('/api/run', {
        ...ownedBy(connection),
        q: `${target!.id} ${pk} = ${quote(id!)} show ${labelCol} limit 1`,
        limit: 1,
        count: 'none',
      });
      if (data.errors?.length) throw new Error(say('couldNotResolveRecord'));
      const row = data.rows?.[0];
      return row ? String(row[labelCol!]) : null;
    },
    enabled: Boolean(enabled && target && labelCol && id && /^[\w-]+$/.test(id)),
    staleTime: Infinity,
  };
}

/** The name behind a reference's id, once known. */
function useReferenceName(box: Box, id: string | null, enabled = true) {
  return useQuery<string | null>(referenceNameQuery(box.meta, id, enabled));
}

/* `startOpen`: the list is up as the box appears, for a picker opened on
   purpose; `portal`: where the list is drawn (Typeahead.tsx) — both for the
   box inside an App list's popover (ListFilterBar.tsx). */
export function RefBox({
  box,
  tail,
  edit,
  onEdit,
  onSubmit,
  startOpen = false,
  portal,
}: {
  box: Box;
  tail: string;
  edit: BoxEdit | undefined;
  onEdit: (e: BoxEdit) => void;
  onSubmit: () => void;
  startOpen?: boolean;
  portal?: 'dialog' | 'body';
}) {
  const { target, labelCol, pk, connection } = referenceTarget(box);
  const chosenId = edit ? (edit.id ?? null) : tail.startsWith('= ') ? unquote(tail.slice(2).trim()) : null;
  const [open, setOpen] = useState(startOpen);
  const [asked, setAsked] = useState('');

  /* An existing `= 9` shows its name as soon as the name is known; the id
     stays in the tooltip, because the id is the truth. */
  const named = useReferenceName(box, chosenId, !edit);
  const raw = edit?.raw ?? (chosenId ? (named.data ?? chosenId) : '');

  // One request per pause in typing, eight names at a time.
  useEffect(() => {
    const term = (edit?.raw ?? '').trim();
    const timer = setTimeout(() => setAsked(edit && edit.id == null ? term : ''), 160);
    return () => clearTimeout(timer);
  }, [edit?.raw, edit?.id, edit]);
  const matches = useQuery<Array<{ id: unknown; label: string }>>({
    queryKey: ['ref-search', connection, target?.id, pk, asked, labelCol],
    queryFn: async () => {
      const where = asked ? `${labelCol} contains ${quote(asked)}` : '';
      const data = await api('/api/run', {
        ...ownedBy(connection),
        q: [target!.id, where, `show ${[...new Set([labelCol, pk])].join(', ')} sort ${labelCol} limit 8`].filter(Boolean).join(' '),
        limit: 8,
        count: 'none',
      });
      if (data.errors?.length) throw new Error(say('couldNotLoadRecords'));
      return ((data.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({ id: row[pk], label: String(row[labelCol!]) }));
    },
    enabled: Boolean(target && labelCol && open),
    retry: false,
  });
  const waiting = (edit && edit.id == null ? (edit.raw ?? '').trim() : '') !== asked;
  const options = waiting || matches.isError ? [] : (matches.data ?? []);
  const empty =
    !target || !labelCol
      ? say('lookupUnavailable')
      : waiting || matches.isPending
        ? 'Loading...'
        : matches.isError
          ? say('couldNotLoadRecordsClose')
          : asked
            ? say('common.nothingMatches')
            : say('noRecordsAvailable');

  /* An App's reader picks a record by its name; the key under it is the
     Workbench's, where the id is what a person reads (an App labels its
     columns, the Workbench registers none). */
  const appReader = Boolean(target && labelCol && columnLabel(target.id, labelCol) != null);
  const pick = (item: { id: unknown; label: string }) => {
    onEdit({ raw: item.label, id: String(item.id) });
    setOpen(false);
    queueMicrotask(onSubmit);
  };
  return (
    <>
      <Typeahead
        text={raw}
        onText={(next) => onEdit({ raw: next, id: null })}
        open={open}
        onOpenChange={setOpen}
        items={options}
        itemKey={(item) => String(item.id)}
        itemLabel={(item) => item.label}
        itemClassName={(_item, highlighted) => `dd-option${highlighted ? ' active' : ''}`}
        renderItem={(item) => (
          <span className="dd-text">
            <span className="dd-label">{item.label}</span>
            {appReader ? null : <span className="dd-detail">{String(item.id)}</span>}
          </span>
        )}
        onPick={pick}
        inputProps={{
          type: 'text',
          className: 'applist-quick applist-quick-text',
          'aria-label': say('common.filter2', { label: box.label }),
          title:
            chosenId && (!edit || edit.id != null) && !appReader
              ? `${box.column} = ${chosenId}`
              : say('typeANameAndPick', { name: target?.name ?? '' }),
        }}
        popupClassName="dd-popup"
        listClassName="dd-list"
        empty={empty}
        emptyClassName="picker-empty"
        portal={portal}
      />
    </>
  );
}

/**
 * The workbench's mount: the same boxes over the plain table view. No tabs
 * and no Advanced here — the query bar at the top is the workbench's
 * advanced, and the boxes write into the same text it shows.
 */
export function FilterBar({
  table,
  entry,
  names,
  navigate,
}: {
  table: TableMeta;
  entry: { table: string; query: string; tab?: string };
  names: string[];
  navigate: (query: string) => void;
}) {
  const whole = squeeze(entry.query) as string;
  const refinement = whole.startsWith(entry.table) ? whole.slice(entry.table.length).trim() : whole;
  const boxes = boxesFor(table, names, (name) => name);
  const [edits, setEdits] = useState<Record<string, BoxEdit>>({});
  const pending = useRef(edits);
  pending.current = edits;
  const submit = () => {
    (state as { page: number }).page = 0;
    let text = refinement;
    // Touched boxes only: the text already holds everything else.
    for (const box of boxes) {
      const edit = pending.current[box.column];
      if (edit) text = withCondition(text, box.column, boxTail(box, edit, conditionTail(refinement, box.column) as string));
    }
    navigate(squeeze(`${entry.table} ${text}`) as string);
  };
  if (!boxes.length) return null;
  return (
    <form
      className="applist-filterbar"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="applist-fields">
        <FilterBoxes
          boxes={boxes}
          refinement={refinement}
          edits={edits}
          onEdit={(column, edit) => setEdits((m) => ({ ...m, [column]: edit }))}
          onSubmit={submit}
        />
        <button type="submit" className="applist-go">
          {say('common.filter')}
        </button>
        {refinement && (
          <button
            type="button"
            className="applist-toggle"
            title={say('backToTheUnfiltered')}
            onClick={() => {
              (state as { page: number }).page = 0;
              navigate(entry.table);
            }}
          >
            {say('common.clear')}
          </button>
        )}
      </div>
    </form>
  );
}
