/**
 * "Set field…" for a selection: one of the list's editable columns and one
 * value, written to every selected record. "Assign these twelve to Maya" is
 * one choice here, not a declared action per person.
 *
 * The value is chosen with the record form's own control for the column
 * (GridCellEditor's ValueControl) and checked as a record form checks it
 * before anything is sent. The write itself is the selection's fixed-update
 * path (bulkActions.ts): each record its own update, judged on its own by
 * the server, answered in the same report of applied and refused. This
 * dialog is the confirmation — it says how many records it will write.
 */
import { useState } from 'react';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { columnLabel } from '../core.js';
import { validateRecordEdits } from '../recordEditValidation.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { Dropdown } from './Dropdown.js';
import { ValueControl } from './GridCellEditor.js';
import { say } from '../copy/forms/components/SetFieldDialog.js';

export function SetFieldDialog({
  table,
  columns,
  count,
  row,
  onApply,
  onClose,
}: {
  table: TableMeta;
  /** The columns offered, in the list's order. */
  columns: readonly string[];
  /** How many records the selection holds. */
  count: number;
  /** A selected row, so a flag's values are read as the column stores them. */
  row?: Record<string, unknown>;
  onApply: (column: string, value: string | null) => void;
  onClose: () => void;
}) {
  const [column, setColumn] = useState(columns[0]);
  const [value, setValue] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [unresolved, setUnresolved] = useState(false);
  const nameOf = (name: string) => columnLabel(table.id, name) ?? humanName(name);
  const meta = table.columns.find((c) => c.name === column);
  const apply = () => {
    if (!meta) return;
    const refused = validateRecordEdits(table, { [column]: value }, unresolved ? { [column]: { unresolvedReference: true } } : {});
    if (refused[column]) {
      setProblem(refused[column]);
      return;
    }
    onApply(column, value);
  };
  const records = say('countSelectedRecords', { count });
  return (
    <Modal className="confirm set-field-dialog" ariaLabel={say('setAField')} onClose={onClose}>
      <h2>{say('setAField')}</h2>
      <p>{say('writesOneValueToEach', { records })}</p>
      {columns.length > 1 && (
        <Field label={say('field')} group>
          {(control) => (
            <Dropdown
              ariaLabel={say('field')}
              id={control.id}
              value={column}
              items={columns.map((name) => ({ value: name, label: nameOf(name) }))}
              onChange={(next) => {
                setColumn(next);
                setValue(null);
                setProblem('');
                setUnresolved(false);
              }}
            />
          )}
        </Field>
      )}
      {meta && (
        <Field key={column} label={nameOf(column)} problem={problem} group={Boolean(meta.references || meta.allowed?.length)}>
          {(control) => (
            <ValueControl
              table={table}
              column={meta}
              value={value}
              row={row}
              label={nameOf(column)}
              id={control.id}
              describedBy={control['aria-describedby']}
              invalid={Boolean(control['aria-invalid'])}
              onChange={(next) => {
                setValue(next);
                setProblem('');
              }}
              onPickerState={(state) => setUnresolved(state.unresolvedReference)}
            />
          )}
        </Field>
      )}
      <div className="confirm-actions">
        <Button intent="secondary" onClick={onClose}>
          {say('common.cancel')}
        </Button>
        <Button intent="primary" onClick={apply}>
          {say('set', { column: nameOf(column) })}
        </Button>
      </div>
    </Modal>
  );
}
