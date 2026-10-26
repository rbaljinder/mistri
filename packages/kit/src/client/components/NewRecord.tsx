/**
 * Adding a row, in a form the schema wrote.
 *
 * Nobody declares a form for this: the columns, their types, what is
 * required and what the database will fill are all in the catalog already.
 * Required is NOT NULL with no default and no auto-assigned key; everything
 * else is optional, and an empty box means "leave it to the database" — its
 * defaults are part of the schema's design and pre-filling them here would
 * turn every default into a value somebody appears to have chosen.
 *
 * Validation checks required values against the catalog. Constraints such
 * as uniqueness and reference integrity remain the database's responsibility.
 *
 * Two readers. The workbench reads the schema: `account_id integer
 * required`, `→ account`. An app's reader reads a form: "Account", a search
 * box that finds an account by name, and no word about integers. Same
 * fields, same values on the wire; only the dress differs. And two frames:
 * the workbench's dialog and the app's drawer over the list, one form
 * wearing either.
 */
import { useMessageLanguage } from './useMessageLanguage.js';
import { MultiStepForm } from './MultiStepForm.js';
import { Columns } from '@mistriwork/ui/FormParts.js';
import type { FormStep } from '@mistriwork/engine/shared/formValues.js';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { state, viewportBox, writeAllowed } from '../core.js';
import { RichTextField, mentionSearch } from './RichTextField.js';
import { createPortal } from 'react-dom';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Button } from '@mistriwork/ui/Button.js';
import { ConfirmDialog } from './Prompt.js';
import { useForm } from '@tanstack/react-form';
import { columnKind, isFlagColumn, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { humanName, vocabularyWord } from '@mistriwork/engine/shared/model.js';
import { inferredFormDefaults } from '@mistriwork/engine/shared/formValues.js';
import { sessionIdentity } from '../sessionIdentity.js';
import { Dropdown } from './Dropdown.js';
import { RecordPicker } from './RecordPicker.js';
import { DateField } from './DateField.js';
import { isPickerDate } from '@mistriwork/ui/datePickerModel.js';
import { formatLocale, formatTimezone } from '../locale.js';
import { InputSlot, columnInput } from './inputRenderers.js';
import { autoKey, isRequired } from '@mistriwork/engine/shared/form.js';
import { columnTextRule, textRuleBreak, type TextRule } from '@mistriwork/engine/shared/textRules.js';
import { shell } from '../shellMode.js';
import { resourceOf } from './appRooms.js';
import { Icon } from './Icon.js';
import { isAppIcon, type AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { onDemand, useArrived } from './onDemand.js';
import type { FormScalar } from '@mistriwork/engine/shared/formValues.js';
import { isPickerDateTime } from '@mistriwork/ui/datePickerModel.js';
import { defaultCurrency } from '../locale.js';
import { wordFor, type DisplayRule } from './valueModel.js';
import { rowCurrency } from '@mistriwork/engine/shared/money.js';
import { MinorMoneyInput, minorProblem } from './MinorMoneyInput.js';
import type { LineDraft } from '../shellMode.js';
import {
  fieldInput,
  flagStart,
  formColumns,
  formFrame,
  formGroups,
  hasFormChanges,
  insertValues,
  isFormFieldVisible,
  missingFields,
  narrowingCondition,
  presetValue,
  type FieldInput,
  type FormCuration,
} from './newRecordModel.js';
import { derivedValue, formWords, resolvedForm, useMeDefaults } from './formDefaults.js';
import { useRecordInsert, type InsertResponse, type InsertResult } from './useRecordInsert.js';
import { say } from '../copy/forms/components/NewRecord.js';

export type { FormCuration } from './newRecordModel.js';
export { autoKey, isRequired } from '@mistriwork/engine/shared/form.js';

const DefinedInputs = onDemand(() => import('./DefinedFields.js'), 'DefinedInputs', { quiet: true });

const dateOnly = (column: ColumnMeta) => columnKind(column.type) === 'date' && !/time/i.test(column.type);
/* A date is judged in the Workbench too; a date and time only where an App draws its picker. */
const invalidDate = (column: ColumnMeta, value: string, kind?: FieldInput) =>
  value !== '' && (dateOnly(column) ? !isPickerDate(value) : kind === 'datetime' && !isPickerDateTime(value));

export type { InsertResponse, InsertResult } from './useRecordInsert.js';
import type { InsertExtra } from './useRecordInsert.js';
import { addHostListener, removeHostListener, shellById, shellQuery } from '../shellHost.js';

/* What a text rule says when a value breaks it: the App's sentence, else the rule in plain words. */
const textRuleMessage = (rule: TextRule, value: string) => {
  const broken = textRuleBreak(rule, value);
  if (!broken) return '';
  if (rule.message) return rule.message;
  return broken === 'min'
    ? say('useAtLeast', { min: rule.min! })
    : broken === 'max'
      ? say('useAtMost', { max: rule.max! })
      : say('enterTheExpectedForm');
};

export interface NewRecordProps {
  table: TableMeta;
  form?: FormCuration;
  /** An app's reader, or the workbench's. */
  app: boolean;
  /** A column's name as this app's reader knows it. */
  label: (column: ColumnMeta) => string;
  /** The table a reference points at, when the schema has it. */
  target: (tableId: string) => TableMeta | undefined;
  insert: (values: Record<string, unknown>, extra?: InsertExtra) => Promise<InsertResponse>;
  onAdded: (result: InsertResult) => void;
  onCancel: () => void;
  /** Veto voluntary dismissal before the frame changes its own open state. */
  canClose?: () => boolean;
  /** Nested/inline hosts keep an uncertain insert visible and non-dismissible. */
  retainUncertain?: boolean;
  /** How the App dresses a column (`display`): its vocabulary's words, its currency. */
  display?: (column: ColumnMeta) => DisplayRule | null | undefined;
  /** The App's name, over a New form drawn as a page. */
  appName?: string;
  /** True synchronously before dispatch; false only after a known local phase.
   * Cleanup never emits settlement. Used by the host's existing exit guard. */
  onUnresolvedChange?: (unresolved: boolean) => void;
}

type Focusable = HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement;

type FormBodyProps = NewRecordProps & {
  onPendingChange?: (pending: boolean) => void;
  onDiscardChange?: (needed: boolean) => void;
  /** Inline hosts omit introductory copy and retain uncertain attempts. */
  compact?: boolean;
  /** The frame the form stands in: its actions are that frame's. */
  frame?: 'drawer' | 'page' | 'dialog';
};

/* Where the shell has no lines part, nothing to wait for. */
const NO_LINES = { ready: () => Promise.resolve(), here: () => true };

/** The fields, the required check and the save, apart from any frame: once its starting words (`today`, `me`) are values. */
export function NewRecordForm(props: FormBodyProps) {
  /* An App's form with lines or live figures waits for their part (FormLines.tsx, the shell's: shellMode.ts
     `formLines`), fetched the first time a form has them, so the form is drawn whole. */
  const wantsLines = props.app && !props.compact && Boolean(props.form?.lines?.length || props.form?.live?.length);
  const linesHere = useArrived(shell().slots.formLines ?? NO_LINES, wantsLines);
  if (wantsLines && !linesHere)
    return (
      <p className="insert-status" role="status">
        {say('common.loading')}
      </p>
    );
  const words = formWords(props.table, props.form, props.app);
  /* `me` is the server's to say, so only a form that starts with it waits on a question. */
  if (words.some((w) => w.word === 'me')) return <NewRecordFormAsking {...props} words={words} />;
  return <NewRecordFormBody {...props} form={resolvedForm(props.form, words)} />;
}

function NewRecordFormAsking({ words, ...props }: FormBodyProps & { words: ReturnType<typeof formWords> }) {
  const me = useMeDefaults(props.table, words, props.target);
  if (!me)
    return (
      <p className="insert-status" role="status">
        {say('common.loading')}
      </p>
    );
  return <NewRecordFormBody {...props} form={resolvedForm(props.form, words, me)} />;
}

function NewRecordFormBody({
  table,
  form,
  app,
  label: columnLabel,
  target,
  insert,
  onAdded,
  onCancel,
  onPendingChange,
  onDiscardChange,
  onUnresolvedChange,
  compact = false,
  retainUncertain = compact,
  display,
  frame = app ? 'drawer' : 'dialog',
}: FormBodyProps) {
  useMessageLanguage();
  const assigned = autoKey(table);
  const columns = formColumns(table, form, app);
  const groups = formGroups(table, form, app);
  /* A switch is on or off, never "leave it": a flag it draws starts where the
     form, else the database, says — off for one that must be answered — and
     that start is sent like any default. */
  const flags = app
    ? columns
        .filter((column) => isFlagColumn(column) && !column.allowed?.length)
        .flatMap((column) => {
          const start = flagStart(column, form?.defaults ?? {});
          return start === undefined ? [] : [[column.name, start] as const];
        })
    : [];
  /* A vocabulary opens on the choice the database would write (`default 'booked'`), unless the form says another. */
  const defaults: Record<string, unknown> = {
    ...Object.fromEntries(flags),
    ...(app ? inferredFormDefaults({ columns }) : {}),
    ...(form?.defaults ?? {}),
  };
  const switches = new Set(flags.map(([name]) => name));
  /* Each field's dress on this form (`form.fields`), in an App only: the Workbench reads the schema. */
  /* The database's text rule, with the App's own on top (textRules.ts): judged as someone types. */
  const authoredText = app ? shell().app()?.resources?.[table.id]?.text : undefined;
  const textRule = (column: ColumnMeta) => columnTextRule(column, authoredText?.[column.name]);
  /* A record's tags (`tags` on the resource), chosen with the record and sent
     with it: the server inserts the link rows in the record's own transaction.
     Offered where this reader may add link rows. A tenant App's insert takes
     the row alone. */
  const tagRule = app && !sessionIdentity().tenantRequired ? shell().app()?.resources?.[table.id]?.tags : undefined;
  const tagThrough = tagRule ? target(tagRule.through) : undefined;
  const tagTable = tagRule ? target(tagRule.to) : undefined;
  /* The link table as the New form itself is judged (insert.js canInsert): the record's own connection is writable already. */
  const offersTags = Boolean(
    tagThrough && tagTable && !tagThrough.isView && tagThrough.insertable !== false && writeAllowed(tagThrough.id),
  );
  const [tagValues, setTagValues] = useState<string[]>([]);
  const textBroken = (column: ColumnMeta, value: unknown) => {
    const rule = textRule(column);
    return Boolean(rule && textRuleBreak(rule, value));
  };
  const dress = (column: ColumnMeta) =>
    app && form?.fields && Object.hasOwn(form.fields, column.name) ? form.fields[column.name] : undefined;
  const label = (column: ColumnMeta) => dress(column)?.label ?? columnLabel(column);
  const kindOf = (column: ColumnMeta): FieldInput | undefined =>
    app
      ? fieldInput(column, {
          money: display?.(column)?.format === 'money',
          richText: display?.(column)?.format === 'richText',
          multiline: dress(column)?.multiline,
          required: isRequired(column, assigned),
          hasStart:
            switches.has(column.name) ||
            (!isFlagColumn(column) && (presetValue(column, defaults) !== '' || column.default !== undefined || column.hasDefault === true)),
          reference: Boolean(column.references && target(column.references.table)),
        })
      : undefined;
  /* A money rule over the draft: where each record keeps its own currency (`currency: { column }`), the code the form holds. */
  const ruleIn = (column: ColumnMeta, values: Record<string, unknown>): DisplayRule | undefined => {
    const rule = display?.(column) ?? undefined;
    return rule?.currencyColumn
      ? {
          ...rule,
          currency: rowCurrency(rule, values, rule.currency ?? '') || undefined,
        }
      : rule;
  };
  /* An amount of minor units the box could not read as one (MinorMoneyInput.tsx). */
  const amountProblem = (column: ColumnMeta, values: Record<string, string>) => {
    const rule = app ? ruleIn(column, { ...defaults, ...values }) : undefined;
    return rule?.format === 'money' && rule.minor ? minorProblem(values[column.name], rule.currency ?? defaultCurrency()) : '';
  };
  /* The record's lines (`form.lines`), asked under its fields and inserted with it in one transaction
     (FormLines.tsx), on a tenant lease and under a row policy as anywhere else. */
  const linesPart = app && !compact ? shell().slots.formLines?.get() : undefined;
  const lineSets = (linesPart ? (form?.lines ?? []) : []).flatMap((line) => {
    const child = target(line.from);
    return child ? [{ ...line, table: child }] : [];
  });
  const [lines, setLines] = useState<Record<string, LineDraft[]>>(() =>
    Object.fromEntries(lineSets.map((line) => [line.table.id, Array.from({ length: line.min ?? 0 }, linesPart!.blankLine)])),
  );
  const [linesTried, setLinesTried] = useState(false);
  const lineChecks = Object.fromEntries(
    lineSets.map((line) => [
      line.table.id,
      linesPart!.lineProblems(line.table, line.show, lines[line.table.id] ?? [], [line.whose, ...(line.order ? [line.order] : [])]),
    ]),
  );
  const linesShort = lineSets.find((line) => (lines[line.table.id]?.length ?? 0) < (line.min ?? 0));
  const live = linesPart ? (form?.live ?? []) : [];
  /* What the form fills without asking (a bound parent key, a hidden default), as its boxes would hold it. */
  const draftDefaults = Object.fromEntries(
    Object.entries(defaults).map(([name, value]) => [name, value === null || value === undefined ? '' : String(value)]),
  );
  /* The fields whose choices read another: a picker narrowed by a project empties when the project changes. */
  const dependents = (name: string) => columns.filter((column) => Object.values(dress(column)?.where ?? {}).includes(name));
  /* Steps carve the New form into pages (`form.steps`); an inline Quick Add stays one row. */
  const steps = !compact && form?.steps?.length ? form.steps : undefined;
  const [stepIndex, setStepIndex] = useState(0);
  const stepOf = (name: string) => Math.max(0, steps?.findIndex((step) => step.fields.includes(name)) ?? 0);
  const errorPrefix = useId();
  const [validationAttempt, setValidationAttempt] = useState<{
    firstField?: string;
  }>();
  const tried = validationAttempt !== undefined;
  const [clearedServerFields, setClearedServerFields] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const controls = useRef(new Map<string, Focusable | null>());
  const edited = useRef(new Set<string>());
  const pendingChange = useCallback(
    (pending: boolean) => {
      if (pending) onUnresolvedChange?.(true);
      onPendingChange?.(pending);
    },
    [onPendingChange, onUnresolvedChange],
  );
  const submission = useRecordInsert(insert, onAdded, pendingChange);
  useEffect(() => {
    setClearedServerFields(new Set());
  }, [submission.fieldErrors]);
  const hasVisibleServerErrors = submission.fieldErrors.some((error) => columns.some((column) => column.name === error.field));
  const firstVisibleServerField = submission.fieldErrors.find((error) => columns.some((column) => column.name === error.field))?.field;
  // useRecordInsert's pending=false also means a lost response or timeout.
  // Only its actual phase can release the supplemental host exit guard.
  useLayoutEffect(() => {
    onUnresolvedChange?.(submission.phase === 'pending' || submission.phase === 'uncertain');
  }, [submission.phase, onUnresolvedChange]);
  const needsDiscard = dirty && submission.phase === 'idle';
  useLayoutEffect(() => {
    onDiscardChange?.(needsDiscard);
  }, [needsDiscard, onDiscardChange]);
  useEffect(() => {
    if (!needsDiscard) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    addHostListener(window, 'beforeunload', warn);
    return () => removeHostListener(window, 'beforeunload', warn);
  }, [needsDiscard]);
  const feedback = useRef<HTMLParagraphElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const firstServerField = firstVisibleServerField && controls.current.has(firstVisibleServerField) ? firstVisibleServerField : undefined;
    if (firstServerField) controls.current.get(firstServerField)?.focus();
    else if (submission.problem) feedback.current?.focus();
    else if (submission.phase === 'pending') status.current?.focus();
  }, [submission.fieldErrors, submission.problem, submission.phase]);
  useLayoutEffect(() => {
    if (!validationAttempt) return;
    // Focus after the field descriptions and invalid state have been rendered.
    const control = validationAttempt.firstField === undefined ? feedback.current : controls.current.get(validationAttempt.firstField);
    control?.focus();
  }, [validationAttempt]);

  const preset = (column: ColumnMeta) => presetValue(column, defaults);
  const required = (column: ColumnMeta) => isRequired(column, assigned);
  const visibilityOf = (values: Record<string, string>) => {
    /* Untouched defaults are part of the draft even when the control
     * intentionally renders as an empty/omitted input. Once a user
     * edits a field, the live value wins, including an explicit clear. */
    const visibilityValues: Record<string, FormScalar> = {};
    for (const column of columns) {
      const candidate =
        edited.current.has(column.name) || !Object.hasOwn(defaults, column.name) ? values[column.name] : defaults[column.name];
      /* An empty box is no value: `insurer_id is not empty` is false while the picker is empty, not unknown. */
      if (candidate === '') visibilityValues[column.name] = null;
      else if (
        candidate === null ||
        typeof candidate === 'string' ||
        typeof candidate === 'boolean' ||
        (typeof candidate === 'number' && Number.isFinite(candidate))
      )
        visibilityValues[column.name] = candidate as FormScalar;
    }
    return visibilityValues;
  };

  const f = useForm({
    defaultValues: Object.fromEntries(columns.map((c) => [c.name, preset(c)])) as Record<string, string>,
    onSubmit: async ({ value }) => {
      if (submission.locked) return;
      submission.clearProblem();
      /* Required means required here, before the wire: a form that let the
         database say "NOT NULL constraint failed: task.due_on" had told the
         reader nothing it did not already know about the row and everything
         about the schema. Each missing field is marked where it is, and the
         first gets focus. */
      const values = insertValues(value, defaults, edited.current, table.columns);
      const missing = [
        ...missingFields(columns, values, assigned),
        ...missingFields(
          table.columns.filter((c) => !columns.includes(c)),
          values,
          assigned,
          form?.derived,
        ),
      ];
      const invalid = columns.filter(
        (column) =>
          invalidDate(column, value[column.name] ?? '', kindOf(column)) ||
          textBroken(column, value[column.name]) ||
          amountProblem(column, value),
      );
      const linesWrong =
        lineSets.length > 0 && (Boolean(linesShort) || Object.values(lineChecks).some((problems) => Object.keys(problems).length));
      if (linesWrong) setLinesTried(true);
      if (missing.length || invalid.length || linesWrong) {
        const firstField = missing.find((c) => columns.includes(c))?.name ?? invalid[0]?.name;
        // A field left empty on an earlier page takes the reader back to it.
        if (steps && firstField) setStepIndex(stepOf(firstField));
        setValidationAttempt({ firstField });
        return;
      }
      const sentLines = lineSets.length
        ? {
            lines: Object.fromEntries(
              lineSets.map((line) => [
                line.table.id,
                (lines[line.table.id] ?? []).map((row) => ({
                  values: linesPart!.lineValues(row, line.show),
                })),
              ]),
            ),
          }
        : {};
      const extra = {
        ...(tagValues.length ? { tags: tagValues } : {}),
        ...sentLines,
      };
      await submission.submit(values, Object.keys(extra).length ? extra : undefined);
    },
  });

  /* The first box someone has to fill, not the first box. */
  useEffect(() => {
    const initialValues = Object.fromEntries(columns.map((c) => [c.name, preset(c)]));
    const first =
      columns.find((c) => isFormFieldVisible(form, c, initialValues, table) && required(c) && !preset(c)) ??
      columns.find((c) => isFormFieldVisible(form, c, initialValues, table));
    if (first) controls.current.get(first.name)?.focus();
  }, []);

  /* Leaving a step checks only what it owns; the next step starts unmarked. */
  const stepReady = (step: FormStep) => {
    const values = f.state.values;
    const visible = visibilityOf(values);
    const owned = columns.filter((column) => step.fields.includes(column.name) && isFormFieldVisible(form, column, visible, table));
    const missing = missingFields(owned, insertValues(values, defaults, edited.current, table.columns), assigned);
    const invalid = owned.filter(
      (column) =>
        invalidDate(column, values[column.name] ?? '', kindOf(column)) ||
        textBroken(column, values[column.name]) ||
        amountProblem(column, values),
    );
    setValidationAttempt(missing.length || invalid.length ? { firstField: missing[0]?.name ?? invalid[0]?.name } : undefined);
    return !missing.length && !invalid.length;
  };
  /* Enter goes forward a step rather than adding the record from its first page. */
  const advance = () => {
    const at = Math.min(stepIndex, steps!.length - 1);
    if (!stepReady(steps![at])) return;
    if (at === steps!.length - 1) void f.handleSubmit();
    else setStepIndex(at + 1);
  };
  useEffect(() => {
    if (steps && firstVisibleServerField) setStepIndex(stepOf(firstVisibleServerField));
  }, [submission.fieldErrors]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The groups, laid out; within a step, only the fields that step owns. */
  const fieldsFor = (only?: ReadonlySet<string>, rows?: readonly (readonly string[])[]) => (
    <f.Subscribe selector={(state) => state.values}>
      {(values) => {
        const visibilityValues = visibilityOf(values);
        return (
          <>
            {groups.map((group, groupIndex) => {
              const fields = group.columns.filter(
                (column) => (!only || only.has(column.name)) && isFormFieldVisible(form, column, visibilityValues, table),
              );
              if (!fields.length) return null;
              const body = fields.map((column) => {
                const index = columns.indexOf(column);
                const kind = kindOf(column);
                const own = dress(column);
                /* A narrowed picker offers nothing until the fields it reads are filled, and says which. */
                /* It reads the draft, and the values the form fills without asking (a bound parent key, a default). */
                const narrowed = own?.where && kind === 'reference' ? narrowingCondition(own.where, { ...defaults, ...values }) : '';
                const waitingOn =
                  narrowed === undefined
                    ? Object.values(own!.where!)
                        .map((name) => table.columns.find((c) => c.name === name))
                        .filter((c): c is ColumnMeta => Boolean(c))
                        .map(label)
                        .join(' and ')
                    : '';
                /* A row-defined column is its fields, for the definitions the chosen `per` picks (DefinedFields.tsx). */
                const binding = app ? resourceOf(shell().app(), table.id)?.defined?.[column.name] : undefined;
                if (binding)
                  return (
                    <f.Field key={column.name} name={column.name}>
                      {(field) => (
                        <DefinedInputs
                          column={column.name}
                          binding={binding}
                          per={binding.per ? ({ ...defaults, ...values } as Record<string, unknown>)[binding.per] : undefined}
                          value={field.state.value}
                          errors={submission.fieldErrors}
                          Control={PlatformControl}
                          onChange={(text) => {
                            edited.current.add(column.name);
                            field.handleChange(text);
                            setDirty(hasFormChanges(columns, f.state.values, defaults, edited.current));
                          }}
                        />
                      )}
                    </f.Field>
                  );
                return (
                  <f.Field key={column.name} name={column.name}>
                    {(field) => {
                      const missing =
                        tried &&
                        missingFields(
                          [column],
                          insertValues({ [column.name]: field.state.value }, defaults, edited.current, table.columns),
                          assigned,
                        ).length > 0;
                      const serverError = submission.fieldErrors.find((error) => error.field === column.name);
                      const fieldMessage = missing
                        ? say('fill', { column: label(column) })
                        : tried && invalidDate(column, field.state.value, kind)
                          ? kind === 'datetime'
                            ? say('enterAValidDate')
                            : say('enterAValidDateInYyyy')
                          : tried && amountProblem(column, values)
                            ? amountProblem(column, values)
                            : textRule(column) &&
                                typeof field.state.value === 'string' &&
                                textRuleMessage(textRule(column)!, field.state.value)
                              ? textRuleMessage(textRule(column)!, field.state.value)
                              : serverError && !clearedServerFields.has(column.name)
                                ? serverError.message
                                : '';
                      const errorId = `${errorPrefix}-${index}-error`;
                      const help = [own?.help, waitingOn ? say('chooseFirst', { waitingOn }) : ''].filter(Boolean).join(' ') || undefined;
                      const helpId = help ? `${errorPrefix}-${index}-help` : undefined;
                      return (
                        <div className={`insert-field${app ? ' form-field' : ''}${fieldMessage ? ' missing is-invalid' : ''}`}>
                          {app ? (
                            /* A record's form asks as a command form does: an answer that may be left empty says so
                               in a word beside its label, and a needed one is simply asked (docs/design.md, Access). */
                            <div className="form-field-label-row">
                              <label className="form-field-label">{label(column)}</label>
                              {/* The space is in the markup: the stylesheet that once put it in a ::before is the
                                 forms room's, which a New drawer does not load ("Phone(optional)"). */}
                              {!required(column) && (
                                <>
                                  {' '}
                                  <span className="form-field-optional-word">{say('optionalWord')}</span>
                                </>
                              )}
                            </div>
                          ) : (
                            <label>
                              {label(column)}
                              <span className="type">{column.type.toLowerCase()}</span>
                              {column.primaryKey && <span className="pk">{say('common.key')}</span>}
                              {required(column) && (
                                <span className="req" title={say('notNullWithNoDefault')}>
                                  {say('requiredMark')}
                                </span>
                              )}
                            </label>
                          )}
                          <Control
                            column={column}
                            app={app}
                            input={app ? columnInput(table.id, column.name) : undefined}
                            resource={table.id}
                            required={required(column)}
                            assigned={assigned}
                            spoken={label(column)}
                            target={target}
                            value={field.state.value}
                            kind={kind}
                            rule={app ? ruleIn(column, { ...defaults, ...values }) : (display?.(column) ?? undefined)}
                            placeholder={own?.placeholder}
                            as={own?.as}
                            where={narrowed === undefined ? undefined : narrowed || undefined}
                            waiting={narrowed === undefined}
                            helpId={helpId}
                            onChange={(value) => {
                              edited.current.add(column.name);
                              field.handleChange(value);
                              /* A value taken from the record this field names follows the choice, until the person says their own. */
                              for (const [name, path] of Object.entries(form?.derived ?? {})) {
                                if (!path?.startsWith(`${column.name}.`) || edited.current.has(name)) continue;
                                void derivedValue(path, column, value, target).then((taken) => {
                                  if (!edited.current.has(name) && f.getFieldValue(column.name) === value) f.setFieldValue(name, taken);
                                });
                              }
                              /* A choice narrowed by this field no longer belongs to it. */
                              for (const dependent of dependents(column.name)) {
                                if (f.getFieldValue(dependent.name)) {
                                  edited.current.add(dependent.name);
                                  f.setFieldValue(dependent.name, '');
                                }
                              }
                              if (serverError)
                                setClearedServerFields((previous) => {
                                  const next = new Set(previous);
                                  next.add(column.name);
                                  return next;
                                });
                              setDirty(hasFormChanges(columns, f.state.values, defaults, edited.current));
                            }}
                            explicitNull={
                              !edited.current.has(column.name) && Object.hasOwn(defaults, column.name) && defaults[column.name] === null
                            }
                            register={(node) => controls.current.set(column.name, node)}
                            errorId={fieldMessage ? errorId : undefined}
                          />
                          {help && (
                            <p id={helpId} className="form-field-hint">
                              {help}
                            </p>
                          )}
                          <span id={errorId} className="insert-missing" aria-live="polite" hidden={!fieldMessage}>
                            {fieldMessage}
                          </span>
                        </div>
                      );
                    }}
                  </f.Field>
                );
              });
              const placed = inRows(
                fields.map((column) => column.name),
                body,
                rows,
              );
              const groupHelp = app ? form?.groups?.find((authored) => authored.label === group.label)?.description : undefined;
              return group.label ? (
                <fieldset className="insert-group" key={`${group.label}:${groupIndex}`}>
                  <legend>{group.label}</legend>
                  {groupHelp && <p className="insert-group-description">{groupHelp}</p>}
                  <div className="insert-group-fields">{placed}</div>
                </fieldset>
              ) : (
                <div className="insert-group-fields" key={`ungrouped:${groupIndex}`}>
                  {placed}
                </div>
              );
            })}
          </>
        );
      }}
    </f.Subscribe>
  );

  /* The Workbench says what an empty box means; an App's form says what the
     author wrote (`description`), if anything — each field's own help says
     what leaving it empty does, where that is worth a sentence. */
  /* The form's `live` figures as its fields and lines change (FormLines.tsx). */
  const liveSummary = (
    <f.Subscribe selector={(state) => state.values}>
      {(values) => linesPart && <linesPart.LiveValues table={table} names={live} values={{ ...draftDefaults, ...values }} lines={lines} />}
    </f.Subscribe>
  );
  const lede = app ? form?.description : say('emptyFieldsAreLeft');
  const cancel = (
    <Button intent="secondary" onClick={onCancel} disabled={submission.phase === 'pending' || (retainUncertain && submission.locked)}>
      {submission.locked && submission.phase !== 'pending' && !retainUncertain ? say('common.close') : say('common.cancel')}
    </Button>
  );

  return (
    <form
      className={`insert-form${app ? ' insert-form-app' : ''}`}
      aria-busy={submission.phase === 'pending'}
      onSubmit={(e) => {
        e.preventDefault();
        if (steps) advance();
        else void f.handleSubmit();
      }}
    >
      {!compact && lede && frame !== 'page' && <p className="insert-lede">{lede}</p>}
      <fieldset className="insert-fields" disabled={submission.locked}>
        {steps ? (
          <MultiStepForm
            steps={steps}
            step={stepIndex}
            onStepChange={(index) => setStepIndex(index)}
            className="insert-steps"
            validateStep={(step) => stepReady(step)}
            onComplete={() => f.handleSubmit()}
            completeLabel={app ? say('common.add') : say('addRow')}
            leading={cancel}
            presentation={frame === 'page' ? 'page' : 'dialog'}
            {...(form?.style === 'intake' ? { style: 'intake' as const } : {})}
          >
            {(step) =>
              fieldsFor(new Set(step.fields), [...(step.rows ?? []), ...(form?.groups?.flatMap((group) => group.rows ?? []) ?? [])])
            }
          </MultiStepForm>
        ) : (
          fieldsFor(undefined, form?.showRows)
        )}
        {linesPart && lineSets.length > 0 && (!steps || stepIndex === steps.length - 1) && (
          <>
            {lineSets.map((line, at) => (
              <linesPart.LinesEditor
                key={line.table.id}
                title={line.label}
                table={line.table}
                columns={line.show}
                rows={lines[line.table.id] ?? []}
                ordered={Boolean(line.order)}
                max={line.max}
                problems={{
                  ...(linesTried ? lineChecks[line.table.id] : {}),
                  ...linesPart.lineServerProblems(line.table, submission.fieldErrors),
                }}
                onChange={(rows) => {
                  setLines((previous) => ({
                    ...previous,
                    [line.table.id]: rows,
                  }));
                  setDirty(true);
                }}
                /* The totals stand beside the last grid's Add line, their figures under its amounts. */
                summary={at === lineSets.length - 1 && live.length > 0 ? liveSummary : undefined}
              />
            ))}
            {linesTried && linesShort && (
              <p className="form-lines-problem" role="alert">
                {say('addAtLeastLines', { min: linesShort.min! })}
              </p>
            )}
          </>
        )}
        {live.length > 0 && !lineSets.length && (!steps || stepIndex === steps.length - 1) && liveSummary}
        {offersTags && (!steps || stepIndex === steps.length - 1) && (
          <div className={`insert-field${app ? ' form-field' : ''}`}>
            <label className="form-field-label">{humanName(tagTable!.name)}</label>
            <RecordPicker
              table={tagTable!}
              multiple
              value={tagValues}
              onChange={setTagValues}
              app
              hideKey
              ariaLabel={humanName(tagTable!.name)}
            />
          </div>
        )}
      </fieldset>
      <p ref={status} className="insert-status" role="status" tabIndex={-1} hidden={submission.phase !== 'pending'}>
        {say('adding')}
      </p>
      <f.Subscribe selector={(state) => state.values}>
        {(values) => {
          const hiddenMissing = tried
            ? missingFields(
                table.columns.filter((c) => !columns.includes(c)),
                insertValues(values, defaults, edited.current, table.columns),
                assigned,
                form?.derived,
              )
            : [];
          const problem = hasVisibleServerErrors
            ? ''
            : submission.problem ||
              (hiddenMissing.length
                ? say('cannotAddThisRecord', {
                    map: hiddenMissing.map(label).join(', '),
                  })
                : '');
          return (
            <p ref={feedback} className="insert-problem" role="alert" tabIndex={-1} hidden={!problem}>
              {problem}
            </p>
          );
        }}
      </f.Subscribe>
      {/* A stepped form's Cancel stands in the step's own row of actions, beside Back and Next. */}
      {!steps && (
        <NewRecordFrameFooter
          app={app}
          frame={frame}
          onCancel={onCancel}
          pending={submission.phase === 'pending'}
          locked={submission.locked}
          retainUncertain={retainUncertain}
        />
      )}
    </form>
  );
}

/**
 * A form's rows — a step's, a group's, `show`'s: fields the author put in one row (`[['first_name', 'last_name'], 'dob']`) stand side by side in
 * one Columns, where the form draws them in this order; a row with a field hidden or in another group is what is
 * left of it. Rows only gather neighbours, so the order of the fields is never changed.
 */
function inRows(names: string[], nodes: ReactNode[], rows: readonly (readonly string[])[] | undefined): ReactNode[] {
  if (!rows?.some((row) => row.length > 1)) return nodes;
  const placed: ReactNode[] = [];
  let at = 0;
  while (at < names.length) {
    const row = rows.find((candidate) => candidate.length > 1 && candidate.includes(names[at]));
    let end = at + 1;
    while (row && end < names.length && row.includes(names[end])) end++;
    placed.push(end - at > 1 ? <Columns key={`row-${at}`}>{nodes.slice(at, end)}</Columns> : nodes[at]);
    at = end;
  }
  return placed;
}

/**
 * One control per shape, every one the page's own: a listbox for a
 * vocabulary or a flag, a record picker for a reference, a date box for a
 * date, a text box for the rest. Nothing native draws its menu over the
 * page in the OS's font.
 */
function Control(
  props: Parameters<typeof PlatformControl>[0] & {
    /** The App's own input component for this column (`resources.<name>.inputs`). */
    input?: string;
    resource: string;
  },
) {
  const { input, resource, ...rest } = props;
  const id = useId();
  if (!input) return <PlatformControl {...rest} />;
  /* The App's own input: it hands back text the form keeps, checks and inserts like any control's. */
  return (
    <InputSlot
      component={input}
      fallback={<PlatformControl {...rest} />}
      value={rest.value}
      onChange={(next) => rest.onChange(next === null ? '' : String(next))}
      id={`new-${id}`}
      describedBy={rest.errorId}
      invalid={Boolean(rest.errorId)}
      disabled={false}
      required={rest.required}
      label={rest.spoken}
      field={{ name: rest.column.name, resource }}
      context="new"
    />
  );
}

let controlsStyled = false;
/** Whether the cards-and-buttons rules are here; the first field that wants them fetches the sheet. */
function useControlsStyle(wanted: boolean): boolean {
  const [here, setHere] = useState(controlsStyled);
  useEffect(() => {
    if (!wanted || controlsStyled) return;
    let live = true;
    void import('./formControlsStyle.js').then(() => {
      controlsStyled = true;
      if (live) setHere(true);
    });
    return () => {
      live = false;
    };
  }, [wanted]);
  return here || controlsStyled;
}

export function PlatformControl({
  column,
  app,
  required,
  assigned,
  spoken,
  target,
  value,
  onChange,
  register,
  explicitNull,
  errorId,
  kind,
  rule,
  placeholder,
  as,
  where,
  waiting = false,
  helpId,
}: {
  column: ColumnMeta;
  app: boolean;
  /** Said to assistive technology as well as starred: the star is outside the control's name. */
  required: boolean;
  assigned: string | null;
  spoken: string;
  target: (tableId: string) => TableMeta | undefined;
  value: string;
  onChange: (value: string) => void;
  register: (node: Focusable | null) => void;
  explicitNull: boolean;
  errorId?: string;
  /** In an App, the input the column is drawn as (newRecordModel.fieldInput); the Workbench has none. */
  kind?: FieldInput;
  /** The column's display rule: its vocabulary's words, its currency. */
  rule?: DisplayRule;
  placeholder?: string;
  /** How the form's author draws a vocabulary or a flag (`form.fields.<column>.as`): cards, buttons, radios or a listbox. */
  as?: 'cards' | 'buttons' | 'radios' | 'select';
  /** A narrowed reference's condition; `waiting` while a field it reads is empty. */
  where?: string;
  waiting?: boolean;
  helpId?: string;
}) {
  const dateId = useId();
  const radioName = useId();
  const styled = useControlsStyle(app && (as === 'cards' || as === 'buttons'));
  // The shared pickers expose their actual control through these refs. Keep
  // form validation on that focusable element, including after picker renders.
  const validation = useRef<{
    node: Focusable;
    errorId?: string;
    helpId?: string;
    invalid: string | null;
  } | null>(null);
  const setControl = (node: Focusable | null) => {
    const previous = validation.current;
    if (previous) {
      // Remove only our descriptions; picker owners may have changed theirs.
      const descriptions = (previous.node.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((id) => id && id !== previous.errorId && id !== previous.helpId);
      if (descriptions.length) previous.node.setAttribute('aria-describedby', descriptions.join(' '));
      else previous.node.removeAttribute('aria-describedby');
      if (previous.errorId && previous.node.getAttribute('aria-invalid') === 'true') {
        if (previous.invalid === null) previous.node.removeAttribute('aria-invalid');
        else previous.node.setAttribute('aria-invalid', previous.invalid);
      }
      validation.current = null;
    }
    if (node && (errorId || helpId)) {
      validation.current = {
        node,
        errorId,
        helpId,
        invalid: node.getAttribute('aria-invalid'),
      };
      const descriptions = (node.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      if (errorId) node.setAttribute('aria-invalid', 'true');
      // The help first, then what is wrong: read in the order they are drawn.
      node.setAttribute(
        'aria-describedby',
        [...new Set([...descriptions, ...(helpId ? [helpId] : []), ...(errorId ? [errorId] : [])])].join(' '),
      );
    }
    // A field that takes typing says it is required; a listbox's button cannot carry the state.
    if (node && node.matches('input, textarea, [role="combobox"]')) {
      if (required) node.setAttribute('aria-required', 'true');
      else node.removeAttribute('aria-required');
    }
    register(node);
  };
  /* The default as the database spells it in the workbench — `'open'`,
     `CURRENT_TIMESTAMP` — and as a person would in an app: quotes off,
     capitalised, no arrow to a table name. */
  const plainDefault = String(column.default ?? '').replace(/^'(.*)'$/, '$1');
  const allowed = (column as ColumnMeta & { allowed?: string[] }).allowed;
  /* A stored word as the App says it everywhere else: its `values`, else the vocabulary's words. */
  const word = (stored: string) => (app ? (wordFor(rule, stored) ?? vocabularyWord(stored)) : stored);
  const hint = explicitNull
    ? app
      ? say('common.noValue')
      : 'null'
    : column.identity || column.name === assigned
      ? say('assignedByTheDatabase')
      : column.default !== undefined
        ? app
          ? say('defaultValue', {
              value: allowed?.includes(plainDefault) ? word(plainDefault) : plainDefault,
            })
          : `default: ${column.default}`
        : column.hasDefault === true
          ? say('defaultSuppliedByTheDatabase')
          : column.references
            ? `→ ${column.references.table}`
            : '';
  const said = placeholder ?? hint;
  /* An App's listbox with nothing chosen asks, quietly, as a command form's does; the workbench keeps its dash. */
  const unchosen = hint || (app ? say('choosePlaceholder', { label: spoken.toLowerCase() }) : '—');
  const quietWhenEmpty = value === '' ? 'is-empty' : undefined;

  /* The author's word over the default the kind and the size pick (formRules.ts says which columns may take one). */
  if (app && (as === 'cards' || as === 'buttons') && (allowed?.length || isFlagColumn(column))) {
    if (!styled) return null;
    const words: readonly (readonly [string, string])[] = allowed?.length
      ? allowed.map((stored) => [stored, word(stored)] as const)
      : [
          ['1', say('common.yes')],
          ['0', say('common.no')],
        ];
    const cards = as === 'cards';
    return (
      <div className={cards ? 'choice-cards' : 'choice-pair'} role="radiogroup" aria-label={spoken} aria-required={required || undefined}>
        {words.map(([stored, said], index) => (
          <label key={stored} className={`${cards ? 'choice-card' : 'choice-pick'}${value === stored ? ' is-on' : ''}`}>
            {cards && rule?.icons?.[stored] && isAppIcon(rule.icons[stored]) ? (
              <span className="choice-card-icon" aria-hidden="true">
                <Icon name={rule.icons[stored] as AppIconName} />
              </span>
            ) : null}
            {cards ? <span className="choice-card-label">{said}</span> : null}
            <input
              type="radio"
              name={radioName}
              value={stored}
              className="choice-input"
              checked={value === stored}
              onChange={() => onChange(stored)}
              ref={index === 0 ? setControl : undefined}
            />
            {cards ? <span className="choice-box" aria-hidden="true" /> : said}
          </label>
        ))}
      </div>
    );
  }
  if (((kind === 'radios' && as !== 'select') || (as === 'radios' && app)) && allowed?.length) {
    return (
      <div className="command-choices insert-choices" role="radiogroup" aria-label={spoken} aria-required={required || undefined}>
        {allowed.map((stored, index) => (
          <label className="command-choice" key={stored}>
            <input
              type="radio"
              name={radioName}
              value={stored}
              checked={value === stored}
              onChange={() => onChange(stored)}
              ref={index === 0 ? setControl : undefined}
            />
            {word(stored)}
          </label>
        ))}
      </div>
    );
  }
  if (allowed?.length) {
    return (
      <Dropdown
        items={[{ value: '', label: unchosen }, ...allowed.map((v) => ({ value: v, label: word(v) }))]}
        value={value}
        valueClassName={quietWhenEmpty}
        ariaLabel={`${spoken}${app ? '' : say('one', { allowed: allowed.join(', ') })}`}
        onChange={onChange}
        buttonRef={setControl}
      />
    );
  }
  if (kind === 'switch' && as !== 'select') {
    /* A flag that is answered either way is a switch: on is yes, off is no — never "leave it to the database". */
    return (
      <label className="insert-switch">
        <input
          ref={setControl}
          type="checkbox"
          role="switch"
          aria-label={spoken}
          checked={value === '1'}
          onChange={(e) => onChange(e.target.checked ? '1' : '0')}
        />
        <span aria-hidden="true">{value === '1' ? say('common.yes') : say('common.no')}</span>
      </label>
    );
  }
  if (isFlagColumn(column)) {
    return (
      <Dropdown
        items={[
          { value: '', label: unchosen },
          { value: '1', label: app ? say('common.yes') : 'yes' },
          { value: '0', label: app ? say('common.no') : 'no' },
        ]}
        value={value}
        valueClassName={quietWhenEmpty}
        ariaLabel={`${spoken}${app ? '' : ` (${column.type})`}`}
        onChange={onChange}
        buttonRef={setControl}
      />
    );
  }
  const referenced = column.references ? target(column.references.table) : undefined;
  if (referenced) {
    return (
      <RecordPicker
        table={referenced}
        value={value}
        onChange={onChange}
        ariaLabel={spoken}
        app={app}
        inputRef={setControl}
        where={where}
        disabled={waiting}
        {...(placeholder ? { placeholder } : {})}
      />
    );
  }
  if (dateOnly(column) || kind === 'datetime') {
    return (
      <DateField
        id={dateId}
        inputRef={setControl}
        className="insert-input"
        value={value}
        onChange={onChange}
        withTime={kind === 'datetime'}
        aria-label={app ? spoken : `${column.name} (${column.type})`}
        placeholder={said || (kind === 'datetime' ? say('yyyyMmDdHh') : 'YYYY-MM-DD')}
        locale={formatLocale()}
        timezone={formatTimezone()}
      />
    );
  }
  /* Formatted text: the editor, fetched when the form first draws one. A new record has no row yet for a
     picture to be attached to, so it takes pictures once it is saved and edited. */
  if (kind === 'richText') {
    return (
      <RichTextField
        label={spoken}
        value={value}
        onChange={onChange}
        {...(said ? { placeholder: said } : {})}
        {...(rule?.mentions ? { mentions: mentionSearch(rule.mentions, state.activeConnection) } : {})}
      />
    );
  }
  if (kind === 'textarea') {
    return (
      <textarea
        ref={setControl}
        className="insert-input"
        rows={4}
        placeholder={said}
        aria-label={spoken}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const box = (style?: CSSProperties, shown = value, change = onChange) => (
    <input
      ref={setControl}
      style={style}
      type="text"
      className="insert-input"
      placeholder={app && column.name === assigned ? '' : said}
      aria-label={app ? spoken : `${column.name} (${column.type})`}
      autoComplete="off"
      spellCheck={false}
      {...(kind === 'number' || kind === 'money' ? { inputMode: 'decimal' as const } : {})}
      value={shown}
      onChange={(e) => change(e.target.value)}
    />
  );
  if (kind !== 'money') return box();
  /* Money says its currency in the box, before the figure, as the figure will read once stored. */
  const currency = rule?.currency ?? defaultCurrency();
  /* Kept as minor units: typed as the figure, "19.99", and held as stored, 1999 (MinorMoneyInput.tsx). */
  if (rule?.minor)
    return (
      <MinorMoneyInput value={value} currency={currency} onChange={onChange}>
        {(text, typed) => <MoneyAffix sign={currencySymbol(currency)} box={(style) => box(style, text, typed)} />}
      </MinorMoneyInput>
    );
  return <MoneyAffix sign={currencySymbol(currency)} box={box} />;
}

/* Room between the sign and the first digit, as between a word and the next. */
const AFFIX_GAP = 4;

/* The sign a currency is written with here: "$", "€", "CHF". Its own, as FilterRail's is: the lines grid that has
   the same (FormLines.tsx) is the App framework's part, fetched apart from the form. */
function currencySymbol(currency: string): string {
  try {
    return (
      new Intl.NumberFormat(formatLocale(), { style: 'currency', currency }).formatToParts(0).find((part) => part.type === 'currency')
        ?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/**
 * The currency sign before a money box's figure, and the box's text starting
 * after it. Where the text starts is measured from the sign as drawn — its
 * look's font, a wide sign ("CHF") — on the zoom-aware ruler, and given to
 * the box itself: a padding in `ch` of the box's font, which a look's own
 * padding outranked, left "$" over the first digit of "1850".
 */
function MoneyAffix({ sign, box }: { sign: string; box: (style?: CSSProperties) => ReactNode }) {
  const unit = useRef<HTMLSpanElement>(null);
  const [inset, setInset] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const node = unit.current;
    const host = node?.parentElement;
    if (!node || !host) return;
    const measure = () => {
      const end = viewportBox(node).right - viewportBox(host).left;
      if (end > 0) setInset(Math.ceil(end) + AFFIX_GAP);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [sign]);
  return (
    <span className="insert-affix">
      <span ref={unit} className="insert-affix-unit" aria-hidden="true">
        {sign}
      </span>
      {box(inset === undefined ? undefined : { paddingLeft: `${inset}px` })}
    </span>
  );
}

/** Cancel and Add, in the frame's own dress: a drawer's foot, a page's actions under its last field, a dialog's row. */
function NewRecordFrameFooter({
  app,
  frame,
  onCancel,
  pending,
  locked,
  retainUncertain = false,
}: {
  app: boolean;
  frame: 'drawer' | 'page' | 'dialog';
  onCancel: () => void;
  pending: boolean;
  locked: boolean;
  retainUncertain?: boolean;
}) {
  return (
    <div className={frame === 'page' ? 'form-actions' : app ? 'newpanel-foot' : 'confirm-actions'}>
      <Button intent="secondary" onClick={onCancel} disabled={pending || (retainUncertain && locked)}>
        {locked && !pending && !retainUncertain ? say('common.close') : say('common.cancel')}
      </Button>
      <Button intent="primary" type="submit" disabled={locked}>
        {app ? say('common.add') : say('addRow')}
      </Button>
    </div>
  );
}

/** What Tab stops on inside the drawer. */
const TAB_STOPS =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The form's heading, the way both frames say it. */
function newRecordTitle(table: TableMeta, app: boolean): string {
  return say('newThing', {
    thing: app ? humanName(table.name).toLowerCase() : table.name,
  });
}

/**
 * The New form as an app shows it: a drawer over the list. A modal hid the
 * list you were on, fought the picker's menu for room, and could not be
 * linked to. Escape closes it — unless a picker or listbox inside is open,
 * which takes the first Escape.
 */
export function NewRecordDrawer(props: NewRecordProps) {
  const frame = props.app ? formFrame(props.form, formColumns(props.table, props.form, props.app).length) : 'drawer';
  const pane = frame === 'page' ? shellById('content') : null;
  return pane ? <NewRecordPage {...props} pane={pane} /> : <NewRecordSheet {...props} />;
}

/**
 * The New form as a page of its own (`form.open: 'page'`, or a long or
 * stepped form): drawn in the content pane, beside the App's menu, as a
 * command form is — one centred measure under the App's name and the
 * form's title. The list it was opened from stays where it was, hidden
 * rather than taken down, so Cancel finds it as it was left.
 */
function NewRecordPage({ pane, ...props }: NewRecordProps & { pane: HTMLElement }) {
  const title = newRecordTitle(props.table, props.app);
  const titleId = useId();
  const dismissal = useRecordClose(props.onCancel, props.canClose);
  const opener = useRef(document.activeElement);
  useLayoutEffect(() => {
    pane.classList.add('has-new-page');
    pane.scrollTo?.({ top: 0 });
    return () => pane.classList.remove('has-new-page');
  }, [pane]);
  useEffect(
    () => () => {
      const back = opener.current;
      queueMicrotask(() => {
        const now = document.activeElement;
        if ((!now || now === document.body) && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
      });
    },
    [],
  );
  return createPortal(
    <div className="newrecord-page-host">
      <section className="form-page newrecord-page" aria-labelledby={titleId}>
        {props.appName && <p className="eyebrow">{props.appName}</p>}
        <h1 id={titleId}>{title}</h1>
        {props.form?.description && <p className="form-page-description">{props.form.description}</p>}
        <NewRecordForm
          {...props}
          frame="page"
          onCancel={dismissal.close}
          onPendingChange={dismissal.change}
          onDiscardChange={dismissal.discardChange}
        />
      </section>
      {dismissal.discard && <DiscardNewRecord onDone={dismissal.resolve} />}
    </div>,
    pane,
  );
}

/** The drawer frame: over the list's right side, which stays in sight. */
function NewRecordSheet(props: NewRecordProps) {
  const title = newRecordTitle(props.table, props.app);
  const dismissal = useRecordClose(props.onCancel, props.canClose);
  const { pending, close: onCancel, discard } = dismissal;
  /* The drawer is not Modal.tsx (the list stays in sight), so nothing handed
     focus back when it went: the field that had it is removed and focus fell
     to the page itself. It goes back to what opened the drawer — the New
     button — unless the reader has already put it somewhere. */
  const opener = useRef(document.activeElement);
  const panel = useRef<HTMLElement>(null);
  useEffect(
    () => () => {
      const back = opener.current;
      queueMicrotask(() => {
        const now = document.activeElement;
        if ((!now || now === document.body) && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
      });
    },
    [],
  );
  useEffect(() => {
    const popupOpen = () => shellQuery('.picker-popup:not([data-closed]) .picker-list, .dd-popup:not([data-closed]) .dd-list');
    /* Tab stays in the drawer. A pointer on the list closes the drawer first,
       so the keyboard gets no more of the list than the pointer does; and the
       drawer covers the list's right side, where Tab walked on under it. An
       open picker or listbox inside keeps its own keys. */
    const holdTab = (e: KeyboardEvent) => {
      const box = panel.current;
      if (!box || discard || popupOpen()) return;
      const stops = [...box.querySelectorAll<HTMLElement>(TAB_STOPS)].filter((el) => el.checkVisibility?.() ?? true);
      const first = stops[0],
        last = stops[stops.length - 1];
      if (!first || !last) return;
      const at = document.activeElement;
      if (!box.contains(at)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        holdTab(e);
        return;
      }
      if (e.key !== 'Escape') return;
      if (discard) return;
      if (popupOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onCancel, discard]);

  return (
    <div className="peekpanel-root">
      <div className="peekpanel-backdrop" onPointerDown={onCancel} />
      <aside ref={panel} className="peekpanel newpanel" role="dialog" aria-modal="true" aria-label={title}>
        <div className="peekpanel-head">
          <h2 className="peekpanel-title">{title}</h2>
          <button type="button" className="peekpanel-close" aria-label={say('common.close')} onClick={onCancel} disabled={pending}>
            ×
          </button>
        </div>
        <div className="peekpanel-body newpanel-body">
          <NewRecordForm {...props} onCancel={onCancel} onPendingChange={dismissal.change} onDiscardChange={dismissal.discardChange} />
        </div>
      </aside>
      {discard && <DiscardNewRecord onDone={dismissal.resolve} />}
    </div>
  );
}

/** Workbench and nested related creation share this dialog and the same form. */
export function NewRecordDialog(props: NewRecordProps) {
  const title = newRecordTitle(props.table, props.app);
  const dismissal = useRecordClose(props.onCancel, props.canClose);
  const unresolved = useCallback(
    (next: boolean) => {
      if (props.retainUncertain) dismissal.change(next);
      props.onUnresolvedChange?.(next);
    },
    [props.retainUncertain, props.onUnresolvedChange, dismissal.change],
  );
  return (
    <Modal
      className="confirm insert-dialog"
      onClose={props.onCancel}
      closeDisabled={dismissal.pending}
      beforeClose={dismissal.beforeClose}
      aria-label={title}
    >
      <h2>{title}</h2>
      <NewRecordForm
        {...props}
        onCancel={dismissal.close}
        onPendingChange={props.retainUncertain ? undefined : dismissal.change}
        onUnresolvedChange={unresolved}
        onDiscardChange={dismissal.discardChange}
      />
      {dismissal.discard && <DiscardNewRecord onDone={dismissal.resolve} />}
    </Modal>
  );
}

export function DiscardNewRecord({ onDone }: { onDone: (confirmed: boolean) => void }) {
  return (
    <ConfirmDialog
      title={say('discardNewRecord')}
      body={say('yourEntriesHaveNotBeen')}
      confirmLabel={say('discardRecord')}
      cancelLabel={say('keepEditing')}
      onDone={onDone}
    />
  );
}

export function useRecordClose(onCancel: () => void, canClose?: () => boolean) {
  const [pending, setPending] = useState(false);
  const [discard, setDiscard] = useState(false);
  const busy = useRef(false);
  const dirty = useRef(false);
  const change = useCallback((next: boolean) => {
    busy.current = next;
    setPending(next);
  }, []);
  const discardChange = useCallback((next: boolean) => {
    dirty.current = next;
  }, []);
  const beforeClose = () => {
    if (busy.current || canClose?.() === false) return false;
    if (dirty.current) {
      setDiscard(true);
      return false;
    }
    return true;
  };
  const close = () => {
    if (beforeClose()) onCancel();
  };
  const resolve = (confirmed: boolean) => {
    setDiscard(false);
    if (confirmed && !busy.current && canClose?.() !== false) onCancel();
  };
  return {
    pending,
    change,
    close,
    beforeClose,
    discard,
    discardChange,
    resolve,
  };
}
