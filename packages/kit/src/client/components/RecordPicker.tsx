/**
 * A record picker: choose a row of another table by its name.
 *
 * A foreign key is a number that means a record, and a form asking for the
 * number is asking the person to know the database by heart. This asks for
 * the name — type a few letters, pick from what matches — and keeps the id
 * as the value. The search is the query language's own `contains` on the
 * target's naming column, bounded, one request per pause in typing and
 * cached by Query, so the same letters twice cost one request. The list is
 * the product's listbox, drawn by the page and not by the OS, with the
 * keyboard contract a listbox owes: arrows move, Enter chooses, Escape
 * closes, Tab leaves.
 *
 * `multiple` keeps every choice as a chip and reports an array — the shape
 * a filter's `in (…)` wants. A single picker reports one id or ''.
 */
import { ownedBy } from '../requestIdentity.js';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, labelPath, recordLabel, rowLabel, state } from '../core.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import { offeredChoices } from './pickerStaleness.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { shell } from '../shellMode.js';
import { resourceOf } from './appRooms.js';
import { sessionIdentity, subscribeSessionIdentity } from '../sessionIdentity.js';
import { say } from '../copy/forms/components/RecordPicker.js';

const LIMIT = 20;

interface Choice {
  value: string;
  label: string;
  /** The row the choice was read from, where the picker draws more of it than its name (`face`). */
  row?: Record<string, unknown>;
}

/** More of each choice than its name: the columns it is read with, and how a choice is drawn from them (FormLines.tsx). */
interface PickerFace {
  columns: readonly string[];
  /** One choice, beside every row the list holds now, so what the choices share (their photos) is asked once. */
  draw: (row: Record<string, unknown>, label: string, rows: readonly Record<string, unknown>[]) => ReactNode;
}

export interface RecordPickerEditing {
  onStateChange(state: { unresolvedReference: boolean; open: boolean }): void;
  onCancel?: () => void;
  popupRef?: Ref<HTMLDivElement>;
}

interface Common {
  table: TableMeta;
  ariaLabel?: string;
  placeholder?: string;
  /** In an app, the placeholder speaks the table's human name. */
  app?: boolean;
  /** The box, for a form that needs to put focus on this control. */
  inputRef?: Ref<HTMLInputElement>;
  /** A reference may point to a unique natural key rather than the primary key. */
  valueColumn?: string;
  /** Leave the key off each choice: where a name is the whole of a record (a tag), the id beside it is noise. */
  hideKey?: boolean;
  /** Only the rows this condition (the query language, over the table) admits: a New form's narrowed reference. */
  where?: string;
  disabled?: boolean;
  /** The field is wrong: the box says so (`aria-invalid`), as every other input does. */
  invalid?: boolean;
  /** What explains the field, by id: the error beside it. */
  describedBy?: string;
  face?: PickerFace;
}

export type RecordPickerProps = Common &
  (
    | {
        multiple?: false;
        value: string;
        onChange: (value: string) => void;
        editing?: RecordPickerEditing;
        /** The chosen record's name where the caller already draws it (a grid's cell): the box says it from the
        first paint, where it would say the key until the name was fetched. */
        known?: Choice;
      }
    | {
        multiple: true;
        value: string[];
        onChange: (value: string[]) => void;
        editing?: never;
      }
  );

/** The rows whose name contains the text, twenty at a time, every value bound. */
async function searchRecords(
  table: TableMeta,
  text: string,
  valueColumn = primaryKey(table)[0],
  connection = state.activeConnection,
  narrowed = '',
  more: readonly string[] = [],
): Promise<Choice[]> {
  const naming = labelPath(table) ?? valueColumn;
  const pk = valueColumn;
  if (!pk) return [];
  const where = [narrowed, text ? `${naming} contains ${JSON.stringify(text)}` : ''].filter(Boolean).join(' and ');
  const q = [table.id, where, `show ${[...new Set([naming, pk, ...primaryKey(table), ...more])].join(', ')}`, `sort ${naming}`]
    .filter(Boolean)
    .join(' ');
  const data = await api('/api/run', {
    q,
    limit: LIMIT,
    offset: 0,
    count: 'none',
    ...ownedBy(connection),
  });
  return ((data.rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    value: String(r[pk]),
    label: recordLabel(table) === undefined ? String(r[naming] ?? r[pk]) : rowLabel(table, r),
    ...(more.length ? { row: r } : {}),
  }));
}

export function RecordPicker(props: RecordPickerProps) {
  return props.editing ? <EditingRecordPicker {...props} /> : <RecordPickerControl {...props} />;
}

function EditingRecordPicker(props: RecordPickerProps) {
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  // Replacement owners start with a fresh interaction and isolated query answers.
  const scope = JSON.stringify([
    identity.epoch,
    state.activeConnection,
    props.table.id,
    props.valueColumn ?? primaryKey(props.table)[0],
    labelPath(props.table),
  ]);
  return <RecordPickerControl key={scope} {...props} scope={scope} />;
}

function RecordPickerControl(props: RecordPickerProps & { scope?: string }) {
  const { table, ariaLabel, placeholder, app, inputRef } = props;
  const editing = props.editing;
  const connection = state.activeConnection;
  const valueColumn = props.valueColumn ?? primaryKey(table)[0];
  const ids = props.multiple === true ? props.value : props.value ? [props.value] : [];
  /* Labels for what is chosen: known once a name has been picked, the id
     itself until then (a preset value arrives as an id alone). */
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  /* A value's name: fetched, else the one the caller draws for it (`known`), else the value itself. */
  const known = props.multiple !== true ? props.known : undefined;
  const nameOf = (value: string) => labels.get(value) ?? (known?.value === value ? known.label : undefined) ?? value;
  const [legacyText, setText] = useState(() => (props.multiple !== true && props.value ? nameOf(props.value) : ''));
  // Even an empty search is unresolved until the user chooses or explicitly clears.
  const [search, setSearch] = useState<string | null>(null);
  const text = editing && typeof props.value === 'string' ? (search ?? (props.value ? nameOf(props.value) : '')) : legacyText;
  /* What the person typed, for the stale-rows rule below. An editable field
     shows its record's label until someone types (`search` is null); that
     label names the record already chosen, not a search, so it must not
     narrow what a browsing person can pick. */
  const typedSearch = editing && typeof props.value === 'string' ? (search ?? '') : legacyText;
  const [asked, setAsked] = useState('');
  const [open, setOpen] = useState(false);
  const signature = JSON.stringify(ids);
  const previous = useRef(signature);
  const reported = useRef<string | null>(null);
  const [editingValue, setEditingValue] = useState(signature);
  if (editing && editingValue !== signature) {
    setEditingValue(signature);
    if (reported.current !== signature) {
      setSearch(null);
      setOpen(false);
      setAsked('');
      setLabels(new Map());
    }
    reported.current = null;
  }
  const unresolvedReference = Boolean(editing && search !== null);
  const notified = useRef<{
    unresolvedReference: boolean;
    open: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (editing && (notified.current?.unresolvedReference !== unresolvedReference || notified.current?.open !== open)) {
      notified.current = { unresolvedReference, open };
      editing.onStateChange(notified.current);
    }
  });
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setLabels(new Map());
  }, [connection, table.id, valueColumn]);

  const setInput = (node: HTMLInputElement | null) => {
    input.current = node;
    if (typeof inputRef === 'function') inputRef(node);
    else if (inputRef) inputRef.current = node;
  };

  // One request per pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setAsked(text.trim()), 150);
    return () => clearTimeout(timer);
  }, [text]);

  const results = useQuery({
    queryKey: [
      'picker',
      connection,
      table.id,
      valueColumn,
      asked,
      props.scope,
      editing ? signature : undefined,
      labelPath(table),
      recordLabel(table),
      props.where ?? '',
      props.face?.columns.join(),
    ],
    queryFn: () => searchRecords(table, asked, valueColumn, connection, props.where, props.face?.columns),
    enabled: open && !props.disabled,
    /* The last answer stays on screen while the next is fetched: a list
       that empties between keystrokes flickers, and an option someone is
       about to click must not be unmounted under the pointer. */
    placeholderData: (data, previous) =>
      previous &&
      previous.queryKey[1] === connection &&
      previous.queryKey[2] === table.id &&
      previous.queryKey[3] === valueColumn &&
      previous.queryKey[5] === props.scope &&
      (!editing || previous.queryKey[6] === signature) &&
      previous.queryKey[7] === labelPath(table) &&
      previous.queryKey[8] === recordLabel(table) &&
      previous.queryKey[9] === (props.where ?? '')
        ? data
        : undefined,
  });
  /* A list still answering earlier text offers only the rows the box's text
     also names — its lit first row is otherwise a record nobody named. */
  const { choices: options, answered } = offeredChoices({
    typed: typedSearch,
    asked,
    placeholder: results.isPlaceholderData,
    rows: results.data,
    label: (o) => o.label,
  });

  const selected = useQuery<Choice[]>({
    queryKey: ['picker-labels', connection, table.id, valueColumn, ids, props.scope, labelPath(table), recordLabel(table)],
    enabled: Boolean(valueColumn && ids.length),
    queryFn: async () => {
      const naming = labelPath(table) ?? valueColumn;
      const columns = [...new Set([valueColumn, naming, ...primaryKey(table)])];
      /* A walked name and a label template (`$label`) are paths, which a view reads and a plain query does not. */
      const data =
        naming.includes('.') || naming.startsWith('$')
          ? await api('/api/view/run', {
              ...ownedBy(connection),
              view: {
                id: `picker:${table.id}`,
                name: '',
                base: table.id,
                columns: columns.map((path) => ({ path })),
                filter: {
                  groups: [[{ path: valueColumn, op: 'in', value: ids }]],
                },
                limit: ids.length,
              },
            })
          : await api('/api/query', {
              ...ownedBy(connection),
              table: table.id,
              columns,
              filter: {
                groups: [[{ column: valueColumn, op: 'in', value: ids }]],
              },
              limit: ids.length,
              offset: 0,
            });
      return ((data.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
        value: String(row[valueColumn]),
        label: recordLabel(table) === undefined ? String(row[naming] ?? row[valueColumn]) : rowLabel(table, row),
      }));
    },
  });
  useEffect(() => {
    if (selected.data) setLabels((known) => new Map([...known, ...selected.data!.map((choice) => [choice.value, choice.label] as const)]));
  }, [selected.data]);
  useEffect(() => {
    if (editing) return;
    const changed = previous.current !== signature;
    previous.current = signature;
    const ownChange = reported.current === signature;
    if (ownChange) reported.current = null;
    if (props.multiple !== true && ((!open && !ownChange) || (changed && !ownChange))) {
      setText(props.value ? nameOf(props.value) : '');
    }
  }, [signature, labels, open]);

  const report = (next: string[]) => {
    reported.current = JSON.stringify(next);
    if (props.multiple === true) props.onChange(next);
    else props.onChange(next[0] ?? '');
  };

  const pick = (choice: Choice) => {
    setLabels((m) => new Map(m).set(choice.value, choice.label));
    if (props.multiple) {
      report(ids.includes(choice.value) ? ids.filter((v) => v !== choice.value) : [...ids, choice.value]);
      setText('');
    } else {
      setSearch(null);
      report([choice.value]);
      setText(choice.label);
      setOpen(false);
    }
  };

  const remove = (value: string) => {
    report(ids.filter((v) => v !== value));
    input.current?.focus();
  };

  const clear = () => {
    setSearch(null);
    report([]);
    setText('');
    input.current?.focus();
  };

  const shownLabel = (value: string) => labels.get(value) ?? value;

  return (
    <div
      className={`picker${props.multiple ? ' picker-multi' : ''}`}
      ref={wrap}
      onKeyDownCapture={(e) => {
        if (editing && open && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          editing.onCancel?.();
          setSearch(null);
          setOpen(false);
        }
      }}
    >
      <span className="picker-chips">
        {props.multiple &&
          ids.map((value) => (
            <span key={value} className="picker-chip">
              <span>{shownLabel(value)}</span>
              <button
                type="button"
                className="picker-chip-x"
                aria-label={say('remove', { shownLabel: shownLabel(value) })}
                onClick={() => remove(value)}
              >
                ×
              </button>
            </span>
          ))}
      </span>
      <Typeahead
        text={text}
        onText={(next) => {
          if (editing) setSearch(next);
          else setText(next);
          setOpen(true);
          if (!editing && !props.multiple && ids.length) report([]);
        }}
        open={open}
        onOpenChange={setOpen}
        items={options}
        itemKey={(o) => o.value}
        itemLabel={(o) => o.label}
        itemClassName={(o, highlighted) => `picker-option${highlighted ? ' active' : ''}${ids.includes(o.value) ? ' chosen' : ''}`}
        renderItem={(o) =>
          props.face && o.row ? (
            props.face.draw(
              o.row,
              o.label,
              options.flatMap((each) => (each.row ? [each.row] : [])),
            )
          ) : (
            <>
              <span className="picker-option-label">{o.label}</span>
              {!props.hideKey && o.label !== o.value && <span className="picker-option-detail">{o.value}</span>}
            </>
          )
        }
        onPick={pick}
        inputRef={setInput}
        popupRef={editing?.popupRef}
        anchorRef={wrap}
        fit="width"
        inputProps={{
          type: 'text',
          className: 'picker-input',
          'aria-label': ariaLabel ?? say('choose', { name: humanName(table.name) }),
          /* In an App the resource's own noun ("lead"), not the table's name ("crm_lead"). */
          placeholder:
            placeholder ??
            (app
              ? say('search', {
                  name: (resourceOf(shell().app(), table.id)?.noun?.one ?? humanName(table.name)).toLowerCase(),
                })
              : `→ ${table.name}`),
          autoComplete: 'off',
          spellCheck: false,
          ...(props.disabled ? { disabled: true } : {}),
          ...(props.invalid ? { 'aria-invalid': true } : {}),
          ...(props.describedBy ? { 'aria-describedby': props.describedBy } : {}),
          /* Backspace on an empty box takes the last chip off. */
          onKeyDown: (e) => {
            // Base UI clears text on closed-popup Escape. Let the editor receive
            // that key without manufacturing a new search or selection first.
            if (editing && e.key === 'Escape') {
              (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
            }
            if (e.key === 'Backspace' && props.multiple && !text && ids.length) report(ids.slice(0, -1));
          },
        }}
        popupClassName="picker-popup"
        listClassName="picker-list"
        empty={results.isPending || !answered ? undefined : text ? say('common.nothingMatches') : say('nothingToChoose')}
        emptyClassName="picker-empty"
      />
      <button
        type="button"
        className="picker-clear"
        aria-label={say('common.clear')}
        hidden={ids.length === 0 && !unresolvedReference}
        onClick={clear}
      >
        ×
      </button>
    </div>
  );
}
