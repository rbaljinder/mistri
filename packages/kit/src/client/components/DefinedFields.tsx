/**
 * Row-defined fields (`resources.<r>.defined`, shared/definedFields.ts): a
 * JSON column whose keys an admin defines as rows. Drawn as the record's own
 * fields — the same captions, the same editor, the same Save — on the record
 * page (DefinedFields), as the New form's fields (DefinedInputs), and as a
 * list's refinements (DefinedBoxes).
 *
 * The definitions are read like any of the reader's rows (`/api/query`, routed
 * to the tenant by core.js), so the fields a record is shown with are the ones
 * the server will hold its write to. Loaded on demand (onDemand.tsx): an App
 * without a bound column never fetches this.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, findTable, state } from '../core.js';
import { ownedBy } from '../requestIdentity.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { DEFINITIONS_MOST, type DefinedBinding, type DefinedField } from '@mistriwork/engine/shared/definedFields.js';
import {
  definedFromInput,
  definedObject,
  definitionColumns,
  definitionFilter,
  readDefinitions,
} from '@mistriwork/engine/shared/definedValues.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { DefinedFold } from '../recordDrafts.js';
import { Editable } from './Editable.js';
import { Value } from './Value.js';
import type { PlatformControl } from './NewRecord.js';
import { fieldInput } from './newRecordModel.js';
import type { Box } from './FilterBoxes.js';

/** The fields a record of this `per` value has, in their order; a definitions table this reader cannot read has none. */
function useDefinitions(binding: DefinedBinding, per: unknown, connection?: string) {
  const from = findTable(binding.from) as TableMeta | undefined;
  const owner = connection || (state.activeConnection as string | null) || '';
  const scoped = binding.per ? (per === undefined || per === null || per === '' ? null : String(per)) : null;
  return useQuery({
    queryKey: ['defined-fields', owner, binding.from, binding.per ?? '', scoped],
    enabled: Boolean(from),
    staleTime: 30_000,
    queryFn: async () => {
      const filter = definitionFilter(binding.per, per);
      const data = (await api('/api/query', {
        ...ownedBy(owner),
        table: from!.id,
        columns: definitionColumns(from!, binding.per),
        ...(filter ? { filter } : {}),
        limit: DEFINITIONS_MOST,
        offset: 0,
      })) as { rows?: Record<string, unknown>[] };
      return readDefinitions(data.rows ?? [], binding.per);
    },
  });
}

const TYPES: Record<DefinedField['type'], string> = {
  text: 'text',
  textarea: 'text',
  number: 'numeric',
  money: 'numeric',
  date: 'date',
  datetime: 'timestamp',
  bool: 'boolean',
  choice: 'text',
  choices: 'text',
};

/** A field as a column the platform's controls draw: `specs.capacity`, of the type its definition names. */
function fieldColumn(column: string, field: DefinedField): ColumnMeta & { allowed?: string[] } {
  return {
    name: `${column}.${field.key}`,
    type: TYPES[field.type],
    nullable: true,
    primaryKey: false,
    ...(field.type === 'choice' && field.options.length ? { allowed: field.options } : {}),
  };
}

/** A value as a box holds it: a list as its choices with commas, a yes or no as the flag controls spell it. */
function boxText(field: DefinedField, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.join(', ');
  if (field.type === 'bool' && typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/** What a page shows for a value: a list said with commas, a yes or no as a flag column says one. */
const shownValue = (field: DefinedField, value: unknown) =>
  Array.isArray(value) ? value.join(', ') : field.type === 'bool' && typeof value === 'boolean' ? (value ? 1 : 0) : value;

/** The keys an object holds, as fields to show where no definition can be read: said, never edited. */
const keysOf = (object: Record<string, unknown>): DefinedField[] =>
  Object.keys(object).map((key) => ({ key, label: humanName(key), type: 'text', options: [], required: false }));

/** The record page: one `page-field` per definition, in the section's own list, editable where the record is. */
export function DefinedFields({
  base,
  row,
  column,
  binding,
  recordKey,
  editing,
  onSaved,
  isCurrent,
  connection,
}: {
  base: TableMeta;
  row: Record<string, unknown>;
  column: string;
  binding: DefinedBinding;
  recordKey: Record<string, unknown>;
  editing: boolean;
  onSaved?: (opts?: { inPlace?: boolean }) => void;
  isCurrent?: () => boolean;
  connection?: string;
}) {
  const definitions = useDefinitions(binding, binding.per ? row[binding.per] : undefined, connection);
  const object = useMemo(() => definedObject(row[column]) ?? {}, [row, column]);
  // One row per draw, so an editor's "this is what was saved" stays with the row it was read from.
  const fieldRow = useMemo(() => {
    const shown: Record<string, unknown> = { ...row };
    for (const field of definitions.data ?? []) shown[`${column}.${field.key}`] = boxText(field, object[field.key]);
    return shown;
  }, [row, column, object, definitions.data]);
  if (definitions.isPending && definitions.fetchStatus !== 'idle') return null;
  const read = definitions.data !== undefined;
  const fields = read ? definitions.data : keysOf(object);
  return (
    <>
      {fields.map((field) => {
        const meta = fieldColumn(column, field);
        const value = object[field.key];
        let dd: ReactNode;
        if (editing && read) {
          const defined: DefinedFold = { column, label: field.label, object, toValue: (text) => definedFromInput(field, text) };
          dd = (
            <dd className="page-field-edit">
              <Editable
                table={base}
                row={fieldRow}
                column={{ ...meta, defined } as ColumnMeta}
                recordKey={recordKey}
                onSaved={onSaved}
                isCurrent={isCurrent}
                app
                display={(next) => <Value col={meta} value={next === null ? null : shownValue(field, definedFromInput(field, next))} />}
              />
            </dd>
          );
        } else if (value === undefined || value === null || value === '') {
          dd = (
            <dd className="null" title="null">
              —
            </dd>
          );
        } else {
          dd = (
            <dd>
              <Value col={meta} value={shownValue(field, value)} />
            </dd>
          );
        }
        return (
          <div key={field.key} className="page-field">
            <dt title={field.help ?? meta.name}>{field.label}</dt>
            {dd}
          </div>
        );
      })}
    </>
  );
}

/**
 * The New form: one field per definition the chosen `per` value picks, drawn
 * with the form's own controls; the object travels as the column's JSON text.
 * A refusal naming `specs.capacity` is said under that field.
 */
export function DefinedInputs({
  column,
  binding,
  per,
  value,
  onChange,
  errors,
  connection,
  Control,
}: {
  column: string;
  binding: DefinedBinding;
  per: unknown;
  /** The New form's own control, handed in (NewRecord.tsx loads this module, so it cannot import it back). */
  Control: typeof PlatformControl;
  value: string;
  onChange: (text: string) => void;
  errors: readonly { field: string; message: string }[];
  connection?: string;
}) {
  const definitions = useDefinitions(binding, per, connection);
  const object = definedObject(value) ?? {};
  const [boxes, setBoxes] = useState<Record<string, string>>({});
  const set = (field: DefinedField, text: string) => {
    setBoxes((previous) => ({ ...previous, [field.key]: text }));
    const next = { ...object };
    const typed = definedFromInput(field, text);
    if (typed === undefined) delete next[field.key];
    else next[field.key] = typed;
    onChange(JSON.stringify(next));
  };
  return (
    <>
      {(definitions.data ?? []).map((field) => {
        const meta = fieldColumn(column, field);
        const name = meta.name;
        const error = errors.find((candidate) => candidate.field === name)?.message;
        const errorId = `${name}-error`;
        const helpId = field.help ? `${name}-help` : undefined;
        const text = Object.hasOwn(boxes, field.key) ? boxes[field.key] : (boxText(field, object[field.key]) ?? '');
        const kind = fieldInput(meta, {
          required: field.required,
          hasStart: false,
          reference: false,
          multiline: field.type === 'textarea',
          money: field.type === 'money',
        });
        return (
          <div key={field.key} className={`insert-field form-field${error ? ' missing is-invalid' : ''}`}>
            <label className="form-field-label">
              {field.label}
              {field.required && <span className="req">*</span>}
            </label>
            {field.type === 'choices' ? (
              <div className="command-choices insert-choices" role="group" aria-label={field.label}>
                {field.options.map((option) => {
                  const chosen = text.split(',').map((item) => item.trim());
                  return (
                    <label className="command-choice" key={option}>
                      <input
                        type="checkbox"
                        checked={chosen.includes(option)}
                        onChange={(event) =>
                          set(
                            field,
                            field.options.filter((item) => (item === option ? event.target.checked : chosen.includes(item))).join(', '),
                          )
                        }
                      />
                      {option}
                    </label>
                  );
                })}
              </div>
            ) : (
              <Control
                column={meta}
                app
                required={field.required}
                assigned={null}
                spoken={field.label}
                target={() => undefined}
                value={text}
                kind={kind}
                onChange={(next) => set(field, next)}
                register={() => {}}
                explicitNull={false}
                errorId={error ? errorId : undefined}
                helpId={helpId}
              />
            )}
            {field.help && (
              <p id={helpId} className="form-field-hint">
                {field.help}
              </p>
            )}
            <span id={errorId} className="insert-missing" aria-live="polite" hidden={!error}>
              {error}
            </span>
          </div>
        );
      })}
    </>
  );
}

/* The facet a field is asked with: a choice is a checklist of its options, a
   yes or no a toggle, a list of choices its options asked with `has`, a
   number what its values are (a range or a short list); text and a date are
   a box. */
const BOX_KINDS: Record<DefinedField['type'], Box['kind']> = {
  text: 'text',
  textarea: 'text',
  number: 'text',
  money: 'text',
  date: 'text',
  datetime: 'text',
  bool: 'flag',
  choice: 'enum',
  choices: 'tags',
};

/**
 * A list's refinements: a bound column in a view's `filters` stands for one
 * box per field, handed to the list (AppList.tsx), which draws them as it
 * draws any — the rail's facets, the bar's pickers, chips that say their
 * labels. The fields are those of the list's `per` where it asks one value
 * (`category_id = 3`), and every field otherwise.
 */
export function DefinedBoxes({
  column,
  binding,
  per,
  onBoxes,
}: {
  column: string;
  binding: DefinedBinding;
  per: string | undefined;
  onBoxes: (column: string, boxes: Box[]) => void;
}) {
  const definitions = useDefinitions(per === undefined ? { from: binding.from } : binding, per);
  useEffect(() => {
    if (!definitions.data) return;
    onBoxes(
      column,
      definitions.data.map((field) => {
        const meta = { ...fieldColumn(column, field), ...(field.type === 'choices' ? { allowed: field.options } : {}) };
        return { column: meta.name, label: field.label, kind: BOX_KINDS[field.type], meta };
      }),
    );
  }, [definitions.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
