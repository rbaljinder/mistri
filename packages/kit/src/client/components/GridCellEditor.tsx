/**
 * A grid's cell edited in place, for a list view that says `editable`.
 *
 * A spreadsheet's contract, on the record form's rules. Enter or F2 on the
 * cell (or a click on it) opens its editor; Enter saves, Esc puts the value
 * back, Tab saves and moves to the row's next editable cell, and leaving the
 * cell saves. The editor is the one a record form draws for the column: a
 * picker for a reference, a list for a vocabulary or a flag, the calendar for
 * a date, a box for the rest.
 *
 * The save is the record form's own request — `/api/update` with the one
 * value and what it replaces as `expected` — so the server judges it as it
 * judges a Save: the reader's grants on the resource and the field, the
 * row policy and tenancy, the resource's validation, its transitions and
 * stamps, and history. Nothing here is a permission; a cell is offered only
 * where that request could succeed.
 *
 * Optimistic, as the board's and the hand order's moves are: the new value
 * is drawn at once, and a refusal puts the stored one back and says why in
 * the same toast those lists use. An unconfirmed write stays drawn and is
 * said as unconfirmed, because the record may hold it. A write that lands
 * offers Undo beside its confirmation, as the Workbench's save does.
 *
 * Not the record form's staged draft: that holds one record's several fields
 * until Save, and a grid's cell is one field saved when it is left. Keeping
 * them apart means a half-typed record form on another tab of the walk is
 * never saved by a cell.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, columnDisplay, columnLabel, findTable, state, toast } from '../core.js';
import { ownedBy } from '../requestIdentity.js';
import { columnKind, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { humanName, vocabularyWord } from '@mistriwork/engine/shared/model.js';
import { booleanChoices, canEditRow } from '../rowEditing.js';
import { updateAttempts } from '../updateAttempts.js';
import { recordKey as wireKey } from '../resourceRequests.js';
import { validateRecordEdits } from '../recordEditValidation.js';
import { shell } from '../shellMode.js';
import { sessionIdentity } from '../sessionIdentity.js';
import { defaultCurrency, formatLocale, formatTimezone } from '../locale.js';
import { rowCurrency } from '@mistriwork/engine/shared/money.js';
import { MinorMoneyInput } from './MinorMoneyInput.js';
import { Dropdown } from './Dropdown.js';
import { RecordPicker } from './RecordPicker.js';
import { DateField } from './DateField.js';
import { booleanWords, type DisplayRule } from './valueModel.js';
import { singleReference, type CellDraw, type EditColumn } from './gridCellModel.js';
import { InputSlot, columnInput } from './inputRenderers.js';
import { say } from '../copy/lists/components/GridCellEditor.js';

const said = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/**
 * The control a record form draws for a column, over a text value (`null`
 * for none). Shared by a cell and the selection's "Set field…".
 */
export function ValueControl(props: {
  table: TableMeta;
  column: EditColumn;
  value: string | null;
  onChange: (value: string | null) => void;
  label: string;
  id?: string;
  row?: Record<string, unknown>;
  /** The name of the reference `value` holds, where the caller already has it drawn. */
  valueLabel?: string;
  /** A reference's search text is not a value until one is chosen. */
  onPickerState?: (state: { unresolvedReference: boolean; open: boolean }) => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  const inputId = useId();
  /* The App's own input for this column, where it names one (`resources.<name>.inputs`): the
     editor still keeps, checks and saves the value it hands back, as text like every control here. */
  const custom = columnInput(props.table.id, props.column.name);
  if (!custom) return <PlatformControl {...props} />;
  return (
    <InputSlot
      component={custom}
      fallback={<PlatformControl {...props} />}
      value={props.value}
      onChange={(next) => props.onChange(next === null || next === '' ? (props.column.nullable ? null : '') : String(next))}
      id={props.id ?? inputId}
      describedBy={props.describedBy}
      invalid={props.invalid === true}
      disabled={false}
      required={props.column.nullable === false}
      label={props.label}
      field={{ name: props.column.name, resource: props.table.id }}
      context="edit"
    />
  );
}

function PlatformControl({
  table,
  column,
  value,
  onChange,
  label,
  id,
  row,
  onPickerState,
  describedBy,
  invalid,
  valueLabel,
}: Parameters<typeof ValueControl>[0]) {
  const dateId = useId();
  const change = (next: string) => onChange(next === '' && column.nullable ? null : next);
  const target =
    column.references && singleReference(table, column) ? (findTable(column.references.table) as TableMeta | undefined) : undefined;
  if (target) {
    return (
      <RecordPicker
        table={target}
        valueColumn={column.references!.column}
        value={value ?? ''}
        onChange={change}
        ariaLabel={label}
        app
        {...(valueLabel && value ? { known: { value, label: valueLabel } } : {})}
        editing={{ onStateChange: (next) => onPickerState?.(next) }}
      />
    );
  }
  const choices = booleanChoices(column, row) as { yes: string; no: string } | null;
  if (column.allowed?.length || choices) {
    const words = choices ? booleanWords(columnDisplay(table.id, column.name) as DisplayRule | null, choices) : {};
    const items = column.allowed?.length
      ? column.allowed.map((v) => ({ value: v, label: vocabularyWord(v) || humanName(v) }))
      : [
          { value: choices!.yes, label: words.yes ?? say('common.yes') },
          { value: choices!.no, label: words.no ?? say('common.no') },
        ];
    if (value !== null && !items.some((item) => item.value === value)) items.unshift({ value, label: value });
    return (
      <Dropdown
        ariaLabel={label}
        id={id}
        value={value ?? ''}
        ariaInvalid={invalid}
        ariaDescribedBy={describedBy}
        items={[...(column.nullable ? [{ value: '', label: say('common.noValue') }] : []), ...items]}
        onChange={change}
      />
    );
  }
  if (columnKind(column.type) === 'date' && !/time/i.test(column.type)) {
    return (
      <DateField
        id={id ?? dateId}
        value={value ?? ''}
        onChange={change}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        locale={formatLocale()}
        timezone={formatTimezone()}
      />
    );
  }
  /* Money kept as minor units is typed as the figure it is ("19.99") and held as what is stored (1999). */
  const rule = columnDisplay(table.id, column.name) as { format?: string; minor?: true; currency?: string; currencyColumn?: string } | null;
  if (rule?.format === 'money' && rule.minor)
    return (
      <MinorMoneyInput value={value ?? ''} currency={rowCurrency(rule, row, rule.currency || defaultCurrency())} onChange={change}>
        {(text, typed) => (
          <input
            id={id}
            type="text"
            inputMode="decimal"
            className="cell-edit"
            aria-label={label}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            value={text}
            data-null={String(value === null)}
            onChange={(event) => typed(event.target.value)}
          />
        )}
      </MinorMoneyInput>
    );
  return (
    <input
      id={id}
      type="text"
      className="cell-edit"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={value ?? ''}
      data-null={String(value === null)}
      onChange={(event) => change(event.target.value)}
      title={column.allowed?.length ? say('one', { allowed: column.allowed.join(', ') }) : undefined}
    />
  );
}

/** The row's next (or previous) editable cell after this one, opened. */
function openNeighbor(from: HTMLElement | null, backward: boolean): boolean {
  const cell = from?.closest('td');
  const row = cell?.closest('tr');
  if (!cell || !row) return false;
  const cells = [...row.querySelectorAll<HTMLElement>(':scope > td.cell-editable')];
  const next = cells[cells.indexOf(cell) + (backward ? -1 : 1)];
  next?.querySelector<HTMLElement>('[data-cell-edits]')?.click();
  return Boolean(next);
}

interface Shown {
  value: unknown;
  label?: unknown;
}

export function GridCellEdit({
  table,
  row,
  column,
  recordKey,
  draw,
  byName = false,
  valueLabel,
}: {
  table: TableMeta;
  row: Record<string, unknown>;
  column: EditColumn;
  recordKey: Record<string, unknown>;
  draw: CellDraw;
  /** The cell draws the reference's record by name (`owner_id.name`), not the key it holds. */
  byName?: boolean;
  /** The stored reference's name as the cell draws it: the picker opens on it, never on the bare key. */
  valueLabel?: string;
}) {
  const client = useQueryClient();
  const errorId = useId();
  const label = columnLabel(table.id, column.name) ?? humanName(column.name);
  const stored = said(row[column.name]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(stored);
  const [problem, setProblem] = useState('');
  /* What the reader saved, drawn until the list's own answer carries it. */
  const [shown, setShown] = useState<(Shown & { from: unknown }) | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const unresolved = useRef(false);
  const pickerOpen = useRef(false);
  /* Where focus goes once the editor closes: back to the cell, unless Tab sent it on. */
  const refocus = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A refetch that carries a new stored value is the answer; the optimistic drawing yields to it.
  useEffect(() => {
    if (shown && shown.from !== row[column.name]) setShown(null);
  }, [row, column.name, shown]);

  useLayoutEffect(() => {
    if (!editing) {
      if (refocus.current) {
        refocus.current = false;
        (launcher.current?.closest('td') as HTMLElement | null)?.focus();
      }
      return;
    }
    const node = surface.current;
    node?.querySelector<HTMLElement>('input, .dd-button, button')?.focus();
  }, [editing]);

  const open = () => {
    if (
      !canEditRow(table, recordKey) ||
      updateAttempts.get({ connection: state.activeConnection ?? null, table: table.id, key: recordKey })
    )
      return;
    setDraft(said(shown ? shown.value : row[column.name]));
    setProblem('');
    unresolved.current = false;
    setEditing(true);
  };
  const close = (focusCell: boolean) => {
    refocus.current = focusCell;
    setProblem('');
    setEditing(false);
  };

  /** Close the editor and send the value; false while the value is not one to send (the editor stays, saying why). */
  const commit = (value: string | null, focusCell: boolean, labelText?: string): boolean => {
    const original = shown ? said(shown.value) : stored;
    if (value === original) {
      close(focusCell);
      return true;
    }
    const values = { [column.name]: value };
    const refused = validateRecordEdits(table, values, unresolved.current ? { [column.name]: { unresolvedReference: true } } : {});
    if (refused[column.name]) {
      setProblem(refused[column.name]);
      return false;
    }
    let key: ReturnType<typeof wireKey>;
    try {
      key = wireKey(recordKey);
    } catch (error) {
      setProblem((error as Error).message);
      return false;
    }
    if (!canEditRow(table, recordKey)) {
      close(focusCell);
      return true;
    }
    // Drawn at once; put back below if the server says no.
    setShown({ value, label: labelText, from: row[column.name] });
    close(focusCell);
    void send(values, original, key);
    return true;
  };
  const send = async (values: Record<string, string | null>, original: string | null, key: ReturnType<typeof wireKey>) => {
    const connection = state.activeConnection ?? null;
    const identity = sessionIdentity();
    const outcome = await updateAttempts.run({ connection, table: table.id, key: recordKey }, values, () =>
      api('/api/update', { ...ownedBy(connection), table: table.id, key, values, expected: { [column.name]: original } }),
    );
    if (identity !== sessionIdentity()) return;
    if (outcome.kind === 'applied') {
      void shell().undo.refresh();
      void client.invalidateQueries({ queryKey: ['run', connection] });
      void client.invalidateQueries({ queryKey: ['count', connection] });
      toast(
        say('saved', { label }),
        'ok',
        !identity.tenantRequired && outcome.undoId
          ? {
              label: say('common.undo'),
              run: () => {
                if (identity === sessionIdentity() && connection === (state.activeConnection ?? null))
                  void shell().undo.last(outcome.undoId);
              },
            }
          : undefined,
      );
      return;
    }
    // A refusal is the stored value's to keep; an unconfirmed write may have landed, so it stays drawn.
    if (outcome.kind !== 'uncertain' && alive.current) setShown(null);
    toast(outcome.message, 'error');
  };

  const pickedLabel = () => (column.references ? surface.current?.querySelector<HTMLInputElement>('input')?.value : undefined);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // A picker or a list closes its own popup first; the next Escape puts the value back.
      if (pickerOpen.current || (event.target as Element).closest('[aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !pickerOpen.current) {
      event.preventDefault();
      event.stopPropagation();
      commit(draft, true, pickedLabel());
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const cell = surface.current?.closest('td') as HTMLElement | null;
      const backward = event.shiftKey;
      // Moving on is the save; a value that cannot be sent keeps the reader here.
      if (commit(draft, false, pickedLabel())) {
        requestAnimationFrame(() => {
          if (!openNeighbor(cell, backward)) cell?.focus();
        });
      }
    }
  };
  /* Leaving the cell saves it, as a spreadsheet's does. A popup the editor
     opened (a picker's list, a calendar) is still the editor. */
  const onBlur = () => {
    requestAnimationFrame(() => {
      const node = surface.current;
      const active = document.activeElement;
      if (!alive.current || !node || !editing) return;
      if (active && (node.contains(active) || active.closest('[role="listbox"], [role="dialog"], .dd-popup, .date-field-popup'))) return;
      void commit(draft, false, pickedLabel());
    });
  };

  if (!editing) {
    const body = !shown
      ? draw()
      : byName
        ? draw({ value: shown.value === null ? null : (shown.label ?? shown.value) })
        : draw({ value: shown.value, label: shown.label });
    /* The cell's value is the button: a click edits it rather than opening
       the row, and the grid's Enter and F2 press it (useGridKeyboard). */
    return (
      <button
        ref={launcher}
        type="button"
        className="cell-edit-launch"
        aria-label={say('edit', { label })}
        data-cell-opens=""
        data-cell-edits=""
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
      >
        {body}
      </button>
    );
  }
  const change = (next: string | null) => {
    setDraft(next);
    setProblem('');
    /* Choosing from a list or a picker is the whole edit: nothing left to
       type. A picker reports a choice as its value; a cleared one waits for
       Enter, since clearing may be the start of a new search. */
    if (column.references && next !== null && next !== '') unresolved.current = false;
    if (column.references ? next !== null && next !== '' : Boolean(column.allowed?.length || booleanChoices(column, row))) {
      requestAnimationFrame(() => {
        void commit(next, true, pickedLabel());
      });
    }
  };
  return (
    <div
      ref={surface}
      className="cell-edit-surface"
      data-edit-field=""
      onKeyDownCapture={onKey}
      onBlur={onBlur}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <ValueControl
        table={table}
        column={column}
        value={draft}
        onChange={change}
        label={label}
        row={row}
        valueLabel={shown ? (typeof shown.label === 'string' ? shown.label : undefined) : valueLabel}
        describedBy={problem ? errorId : undefined}
        invalid={Boolean(problem)}
        onPickerState={(next) => {
          unresolved.current = next.unresolvedReference;
          pickerOpen.current = next.open;
        }}
      />
      {problem && (
        <span id={errorId} className="edit-field-error" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
