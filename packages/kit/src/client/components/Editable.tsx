/**
 * A field as an editor, and the bar that says what is pending.
 *
 * Edits share one staged snapshot and expected originals. Explicit Save is
 * the default; an opted-in App can submit on an owned field blur. Staging lives
 * in write.js, keyed by connection, table and row; these components read
 * it and tick with it. Everything about the write itself — the
 * confirmation that shows the statement, the request, the undo — is the
 * store's.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  activateDraft,
  applyStaged,
  applyingStaged,
  booleanChoices,
  canEditRow,
  cancelRecordAutosave,
  captureRecordAutosaveGuard,
  discardStaged,
  dismissSaveFeedback,
  draftNeedsReview,
  draftSchemaChanged,
  pendingCount,
  pendingColumns,
  refreshEditValidation,
  registerInput,
  retainedValues,
  resumeDraft,
  sameRow,
  stage,
  stagedAttempt,
  stagedDiscardVersion,
  stagedEditErrors,
  stagedFeedback,
  stagedOriginal,
  stagedValue,
  subscribeStaged,
  stagedVersion,
  suspendDraft,
  takeFieldFocus,
} from '../write.js';
import { columnKind, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { columnDisplay, columnLabel, findTable, prefersPages, refsFrom, state, toast } from '../core.js';
import { RichTextField, mentionSearch, pictureKeeper } from './RichTextField.js';
import { booleanWords, choiceWord, linkFor, type DisplayRule } from './valueModel.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { Dropdown } from './Dropdown.js';
import { RecordPicker } from './RecordPicker.js';
import { sessionIdentity } from '../sessionIdentity.js';
import type { DefinedFold } from '../recordDrafts.js';
import { shell } from '../shellMode.js';
import { cancelEditInteractions, useEditInteraction } from './editInteraction.js';
import { formatLocale, formatTimezone } from '../locale.js';
import { DateField } from './DateField.js';
import { InputSlot, columnInput } from './inputRenderers.js';
import { say } from '../copy/record/components/Editable.js';

import { JsonValue as JsonView } from './JsonValue.js';
import { jsonValueOf } from './jsonModel.js';
import { portalRoot } from '../shellHost.js';
import { onDemand } from './onDemand.js';
import { liveKeyText, useEditNotice } from '../liveState.js';

const LiveEditNotice = onDemand(() => import('./LiveNotices.js'), 'LiveEditNotice', { quiet: true });

function cancelBlur() {
  cancelEditInteractions();
  cancelRecordAutosave();
}

function editorCurrent(isCurrent?: () => boolean): boolean {
  try {
    return isCurrent === undefined || isCurrent() === true;
  } catch {
    return false;
  }
}

/** Re-render whenever the staging changes. */
function useStaged(): number {
  return useSyncExternalStore(subscribeStaged, stagedVersion, stagedVersion);
}

interface EditableProps {
  table: TableMeta;
  row: Record<string, unknown>;
  column: ColumnMeta & { allowed?: string[] };
  recordKey: Record<string, unknown>;
  app?: boolean;
  /** A formatted App-mode value, replaced only when this field is opened. */
  display?: (value: unknown, referenceLabel?: string) => ReactNode;
  /** Told after a change is staged, and after a write lands (`{ inPlace: true }`). */
  onSaved?: (opts?: { inPlace?: boolean }) => void;
  /** Additional explicit-surface lifetime fence; never replaces draft authority. */
  isCurrent?: () => boolean;
}

export function Editable({ table, row, column, recordKey, onSaved, app = false, display, isCurrent }: EditableProps) {
  useStaged();
  const done = (opts?: { inPlace?: boolean }) => {
    if (editorCurrent(isCurrent)) onSaved?.(opts);
  };
  const value = row[column.name];
  const [committed, setCommitted] = useState<{ source: Record<string, unknown>; value: string | null; label?: string } | null>(null);
  const [opened, setOpened] = useState(false);
  const [saved, setSaved] = useState(false);
  const retainedOriginal = sameRow(table.id, recordKey) ? stagedOriginal(column.name) : undefined;
  const original =
    retainedOriginal !== undefined
      ? retainedOriginal
      : committed?.source === row
        ? committed.value
        : value === null || value === undefined
          ? null
          : String(value);
  const pending = sameRow(table.id, recordKey) ? (stagedValue(column.name) as string | null | undefined) : undefined;
  const shown = pending !== undefined ? pending : original;
  const dirty = pending !== undefined;
  const statusClass = dirty ? ' dirty' : saved && committed?.source === row ? ' saved' : '';
  const attempt = stagedAttempt(table.id, recordKey);
  const pendingWrite = applyingStaged() || attempt?.phase === 'pending';
  const locked = attempt?.phase === 'uncertain' || draftNeedsReview(table.id, recordKey);
  const applying = pendingWrite || locked;
  const input = useRef<HTMLInputElement | HTMLSelectElement | HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const wasOpened = useRef(false);
  const unresolved = useRef(false);
  const [leftInvalid, setLeftInvalid] = useState(false);
  const [pickerGeneration, setPickerGeneration] = useState(0);
  const pickerFocusRequested = useRef(false);
  const discarded = stagedDiscardVersion(table.id, recordKey);
  const lastDiscard = useRef(discarded);
  useLayoutEffect(() => {
    if (lastDiscard.current === discarded) return;
    lastDiscard.current = discarded;
    unresolved.current = false;
    setLeftInvalid(false);
    pickerFocusRequested.current = false;
    if (column.references) setPickerGeneration((generation) => generation + 1);
  }, [discarded, column.references]);
  const errorId = useId();
  const dateId = useId();
  /* A box the browser cannot read (badInput), or the calendar's text box
     holding what is not a date (its own validity), is not a value to save. */
  const readState = () => {
    const node = input.current;
    const control =
      node instanceof HTMLInputElement
        ? node
        : node instanceof HTMLDivElement
          ? node.querySelector<HTMLInputElement>('input.date-field-input')
          : null;
    return {
      unresolvedReference: unresolved.current,
      invalidInput: Boolean(control && (control.validity.badInput || control.validity.customError)),
    };
  };
  const interaction = useEditInteraction({
    enabled:
      app &&
      shell().saveMode() === 'blur' &&
      column.writable !== false &&
      column.changesBy !== 'actions' &&
      !applying &&
      editorCurrent(isCurrent),
    blocked: applying,
    owner: JSON.stringify([sessionIdentity().epoch, table.id, recordKey, column.name]),
    captureGuard: (current) =>
      captureRecordAutosaveGuard(
        table,
        recordKey,
        () => current() && editorCurrent(isCurrent) && shell().saveMode() === 'blur' && canEditRow(table, recordKey),
      ),
    onLeave: (guard) => {
      setLeftInvalid(true);
      void applyStaged(table, recordKey, done, { trigger: 'blur', guard });
    },
    onCancel: cancelRecordAutosave,
  });
  const error =
    stagedEditErrors(table.id, recordKey)[column.name] ??
    (leftInvalid && readState().unresolvedReference
      ? say('common.chooseARecordOrClear')
      : leftInvalid && readState().invalidInput
        ? say('common.enterAValidValue')
        : undefined);

  // Composite controls keep their own ARIA attributes; this field owns one
  // description token, on the actual focusable control, for both renderers.
  useLayoutEffect(() => {
    const node = input.current;
    const control =
      node instanceof HTMLInputElement || node instanceof HTMLSelectElement ? node : node?.querySelector<HTMLElement>('input, .dd-button');
    if (!control || !error) return;
    const described = control.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
    const invalid = control.getAttribute('aria-invalid');
    control.setAttribute('aria-describedby', [...new Set([...described, errorId])].join(' '));
    control.setAttribute('aria-invalid', 'true');
    return () => {
      const remaining =
        control
          .getAttribute('aria-describedby')
          ?.split(/\s+/)
          .filter((id) => id && id !== errorId) ?? [];
      if (remaining.length) control.setAttribute('aria-describedby', remaining.join(' '));
      else control.removeAttribute('aria-describedby');
      if (invalid !== null) control.setAttribute('aria-invalid', invalid);
      else control.removeAttribute('aria-invalid');
    };
  });
  /* A refused Save leaves the focus for the first field it marked; this
     editor takes it once it is drawn — a marked field opens to be answered. */
  useLayoutEffect(() => {
    const node = input.current;
    if (!error || !node || !takeFieldFocus(table.id, recordKey, column.name)) return;
    const control =
      node instanceof HTMLInputElement || node instanceof HTMLSelectElement ? node : node.querySelector<HTMLElement>('input, .dd-button');
    control?.focus();
  });
  useLayoutEffect(() => {
    const control = input.current instanceof HTMLDivElement ? input.current.querySelector('input') : null;
    // Read-only keeps a newly focused field in place while another field saves.
    // The picker API stays unchanged; its search and buttons share this boundary.
    if (control) control.readOnly = pendingWrite;
  });

  /* Kept by the store so a successful write can confirm in place — the saved
     value, in green, on the field you just edited — rather than re-render.
     An unopened field registers its launcher: the store needs to know it is
     on screen to mark it when a refused save names it. */
  useEffect(() => {
    const element = input.current ?? launcher.current;
    if (element && editorCurrent(isCurrent))
      return registerInput(
        table,
        recordKey,
        column.name,
        element,
        (next: unknown) => {
          if (!editorCurrent(isCurrent)) return;
          const label = column.references ? input.current?.querySelector('input')?.value : undefined;
          setCommitted({ source: row, value: next === null || next === undefined ? null : String(next), label });
          setSaved(true);
        },
        readState,
      );
  });
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2200);
    return () => clearTimeout(timer);
  }, [saved]);
  useEffect(() => {
    if (!opened) {
      if (wasOpened.current) launcher.current?.focus();
      return;
    }
    wasOpened.current = true;
    const node = input.current;
    if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) node.focus();
    /* A rich text field is its text, not its toolbar's first button. */ else
      (node?.querySelector<HTMLElement>('[contenteditable="true"]') ?? node?.querySelector<HTMLElement>('input, button'))?.focus();
  }, [opened]);
  useLayoutEffect(() => {
    if (pickerFocusRequested.current && (!display || opened)) input.current?.querySelector<HTMLElement>('input')?.focus();
    pickerFocusRequested.current = false;
  }, [pickerGeneration]);

  // A mounted editor can receive a narrower policy while a field is open; a
  // declared transition is the record's actions' to make, never an editor's.
  if (column.writable === false || column.changesBy === 'actions')
    return <>{display ? display(value) : <span>{value === null || value === undefined ? '—' : String(value)}</span>}</>;
  /* A document is not a line of text: a box would show `[object Object]`
     and stage it back over the value. JSON is read here, never edited. */
  const json = jsonValueOf(column, value);
  if (json) return <JsonView value={json.value} />;

  const onEdit = (next: string) => {
    if (applying || column.writable === false || column.changesBy === 'actions' || !editorCurrent(isCurrent)) return;
    setSaved(false);
    // An empty box on a nullable column means NULL, not the empty string.
    stage(table, recordKey, column, next === '' && column.nullable ? null : next, original);
    interaction.changed();
    refreshEditValidation(table, recordKey);
    done();
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editorCurrent(isCurrent)) return;
    if (applying && e.key !== 'Tab' && e.key !== 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && !interaction.isOpen() && (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      e.stopPropagation();
      cancelBlur();
      if (pendingCount()) void applyStaged(table, recordKey, done);
    }
    if (e.key === 'Escape') {
      cancelBlur();
      if (interaction.isOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      if (applying) return;
      // Restoring is cancellation, never a fresh edit of this or another field.
      stage(table, recordKey, column, original, original);
      unresolved.current = false;
      if (column.references) {
        pickerFocusRequested.current = true;
        setPickerGeneration((generation) => generation + 1);
      }
      setLeftInvalid(false);
      refreshEditValidation(table, recordKey);
      done();
      if (display) setOpened(false);
    }
  };

  /* A box you type `0` or `1` into is not an editor for a column that holds
     two values: the choices are the values the database stores. */
  const choices = booleanChoices(column, row) as { yes: string; no: string } | null;
  // A row-defined field (DefinedFields.tsx) is captioned by its definition, not by a label the App declares.
  const caption = (column as { defined?: DefinedFold }).defined?.label;
  const label = app ? (caption ?? columnLabel(table.id, column.name) ?? humanName(column.name)) : `${column.name} (${column.type})`;
  const inline = app && Boolean(display);
  const freezePointer = (e: React.SyntheticEvent) => {
    if (applying) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const surface = (body: ReactNode) => (
    <div
      ref={interaction.root}
      data-edit-field=""
      className="edit-field-surface"
      onKeyDownCapture={onKey}
      onPointerDownCapture={freezePointer}
      onClickCapture={freezePointer}
    >
      {body}
    </div>
  );
  if (inline && !opened && !dirty && !error) {
    const shownValue = committed?.source === row ? committed.value : value;
    const body = display!(shownValue, committed?.source === row ? committed.label : undefined);
    /* A reference and a link are values to follow, so the value is not the
       edit button: a link inside a button is neither. The pencil beside it edits. */
    const shownRule = columnDisplay(table.id, column.name) as DisplayRule | null;
    /* Formatted text holds links and blocks of its own, so it is not drawn inside a button either. */
    const followed = column.references || shownRule?.format === 'richText' || linkFor(column.name, shownValue, shownRule, true);
    return surface(
      followed && shownValue !== null && shownValue !== undefined ? (
        <div className="inline-field">
          <div className="inline-field-value">{body}</div>
          <button
            ref={launcher}
            type="button"
            className="inline-edit-button"
            aria-label={say('edit', { label })}
            title={say('edit', { label })}
            disabled={applying}
            onClick={() => setOpened(true)}
          >
            ✎
          </button>
        </div>
      ) : (
        <button
          ref={launcher}
          type="button"
          className="inline-edit-value"
          aria-label={say('edit', { label })}
          title={say('edit', { label })}
          disabled={applying}
          onClick={() => setOpened(true)}
        >
          {body}
        </button>
      ),
    );
  }
  const wrap = (editor: ReactNode) =>
    surface(
      <>
        {inline ? (
          <div className="inline-field inline-field-open">
            {editor}
            <button
              type="button"
              className="inline-edit-button"
              aria-label={say('doneEditing', { label })}
              title={say('doneEditing', { label })}
              disabled={dirty || applying}
              onClick={() => setOpened(false)}
            >
              ✓
            </button>
          </div>
        ) : (
          editor
        )}
        {error && (
          <span id={errorId} className="edit-field-error" role="alert">
            {error}
          </span>
        )}
      </>,
    );
  /* The App's own input for this column (`resources.<name>.inputs`): it hands back a value the draft
     stages and Save sends like any other; until its module is here the plain box stands in its place. */
  const custom = app ? columnInput(table.id, column.name) : undefined;
  if (custom) {
    const plain = (
      <input
        className={`cell-edit${statusClass}`}
        disabled={locked}
        aria-label={label}
        type="text"
        value={shown === null ? '' : String(shown)}
        onChange={(e) => onEdit(e.target.value)}
      />
    );
    return wrap(
      <div
        ref={input as React.RefObject<HTMLDivElement>}
        inert={locked}
        aria-disabled={applying || undefined}
        className={`cell-edit-control${statusClass}`}
      >
        <InputSlot
          component={custom}
          fallback={plain}
          value={shown === null ? null : String(shown)}
          onChange={(next) => onEdit(next === null ? '' : String(next))}
          id={`${dateId}-input`}
          invalid={Boolean(error)}
          describedBy={error ? errorId : undefined}
          disabled={locked}
          required={column.nullable === false}
          label={label}
          field={{ name: column.name, resource: table.id }}
          context="edit"
        />
      </div>,
    );
  }
  /* Formatted text: the editor, fetched the first time a rich text field is edited. Save sends the HTML it
     writes, and the server sanitizes it like any other write of the column. */
  const rich = app ? (columnDisplay(table.id, column.name) as DisplayRule | null) : null;
  if (rich?.format === 'richText') {
    const keep = pictureKeeper(rich.images, { table: table.id, key: recordKey }, state.activeConnection);
    return wrap(
      <div
        ref={input as React.RefObject<HTMLDivElement>}
        inert={locked}
        aria-disabled={applying || undefined}
        className={`cell-edit-control rich-edit${statusClass}`}
      >
        <RichTextField
          id={`${dateId}-input`}
          label={label}
          value={shown === null ? '' : String(shown)}
          onChange={onEdit}
          disabled={locked}
          invalid={Boolean(error)}
          {...(error ? { describedBy: errorId } : {})}
          autoFocus={inline}
          onPopupChange={interaction.onOpenChange}
          {...(rich.mentions ? { mentions: mentionSearch(rich.mentions, state.activeConnection) } : {})}
          {...(keep ? { pictures: keep, onProblem: (message: string) => toast(message, 'error') } : {})}
        />
      </div>,
    );
  }
  const composite =
    app &&
    column.references &&
    refsFrom(table.id).some((fk: { from: { columns: string[] } }) => fk.from.columns.length > 1 && fk.from.columns.includes(column.name));
  if (app && column.references && !composite) {
    const target = findTable(column.references.table) as TableMeta | undefined;
    if (target)
      return wrap(
        <div
          ref={input as React.RefObject<HTMLDivElement>}
          inert={locked}
          aria-disabled={applying || undefined}
          className={`cell-edit-control${statusClass}`}
        >
          <RecordPicker
            key={pickerGeneration}
            table={target}
            valueColumn={column.references.column}
            value={shown ?? ''}
            onChange={onEdit}
            ariaLabel={label}
            app
            editing={{
              popupRef: interaction.popupRef,
              onCancel: cancelBlur,
              onStateChange: (next) => {
                unresolved.current = next.unresolvedReference;
                interaction.onOpenChange(next.open);
                refreshEditValidation(table, recordKey);
                if (!next.unresolvedReference) setLeftInvalid(false);
              },
            }}
          />
        </div>,
      );
  }
  if (app && (column.allowed?.length || choices)) {
    const rule = columnDisplay(table.id, column.name) as DisplayRule | null;
    // The words the field says when it is read: an Off/On column is not edited as No/Yes.
    const words = choices ? booleanWords(rule, choices) : {};
    const values = column.allowed?.length
      ? column.allowed.map((v) => ({ value: v, label: choiceWord(rule, v) }))
      : [
          { value: choices!.yes, label: words.yes ?? say('common.yes') },
          { value: choices!.no, label: words.no ?? say('common.no') },
        ];
    if (shown !== null && !values.some((v) => v.value === shown)) values.unshift({ value: shown, label: shown });
    return wrap(
      <div
        ref={input as React.RefObject<HTMLDivElement>}
        inert={locked}
        aria-disabled={applying || undefined}
        className={`cell-edit-control${statusClass}`}
      >
        <Dropdown
          ariaLabel={label}
          value={shown ?? ''}
          items={[...(column.nullable ? [{ value: '', label: say('common.noValue') }] : []), ...values]}
          onChange={onEdit}
          disabled={locked}
          readOnly={pendingWrite}
          popupRef={interaction.popupRef}
          onOpenChange={interaction.onOpenChange}
        />
      </div>,
    );
  }
  if (choices) {
    return wrap(
      <select
        ref={input as React.RefObject<HTMLSelectElement>}
        disabled={applying}
        className={`cell-edit${statusClass}`}
        aria-label={label}
        value={shown === null ? '' : String(shown)}
        onChange={(e) => onEdit(e.target.value)}
      >
        {column.nullable && <option value="">null</option>}
        <option value={choices.yes}>{say('yesValue')}</option>
        <option value={choices.no}>{say('noValue')}</option>
      </select>,
    );
  }
  /* A calendar date in an App is the themed calendar over ISO text, never read
     as an instant. A timestamp keeps its text box: a picker of wall times would
     rewrite a stored offset as a local time. Read-only while a save is in
     flight and the calendar's ownership of focus come from the same hooks as
     the pickers above. */
  if (app && columnKind(column.type) === 'date' && !/time/i.test(column.type)) {
    return wrap(
      <div
        ref={input as React.RefObject<HTMLDivElement>}
        inert={locked}
        aria-disabled={applying || undefined}
        className={`cell-edit-control${statusClass}`}
      >
        <DateField
          id={dateId}
          value={shown === null ? '' : String(shown)}
          onChange={onEdit}
          aria-label={label}
          disabled={locked}
          locale={formatLocale()}
          timezone={formatTimezone()}
          popupRef={interaction.popupRef}
          onOpenChange={interaction.onOpenChange}
        />
      </div>,
    );
  }
  return wrap(
    <input
      ref={input as React.RefObject<HTMLInputElement>}
      className={`cell-edit${statusClass}`}
      disabled={locked}
      readOnly={pendingWrite}
      aria-disabled={applying || undefined}
      aria-label={label}
      type="text"
      value={shown === null ? '' : String(shown)}
      data-null={String(shown === null)}
      /* Where the database pins the vocabulary, say it — but still a text
         box: a select would silently rewrite a value the check would refuse. */
      title={column.allowed?.length ? say('one', { allowed: column.allowed.join(', ') }) : undefined}
      onChange={(e) => onEdit(e.target.value)}
    />,
  );
}

/** Explicit targets never fall back to document.body while a modal is mounting. */
export type PendingBarPlacement = 'inline' | { container: HTMLElement | null };
export interface PendingBarProps {
  table: TableMeta;
  recordKey: Record<string, unknown>;
  onDone?: (opts?: { inPlace?: boolean }) => void;
  /** Omitted: the existing App body dock or Workbench inline bar. */
  placement?: PendingBarPlacement;
  isCurrent?: () => boolean;
}

/** Placement changes presentation only; one bar still owns the existing draft. */
export function PendingBar({ table, recordKey, onDone, placement, isCurrent }: PendingBarProps) {
  useStaged();
  const changedElsewhere = useEditNotice(table.id, liveKeyText(recordKey));
  const owner = JSON.stringify(recordKey);
  useEffect(() => {
    if (!editorCurrent(isCurrent)) return;
    const draft = activateDraft(table, recordKey);
    return () => suspendDraft(draft);
  }, [table, owner]);
  const app = prefersPages();
  const container = placement === undefined ? (app ? portalRoot() : null) : placement === 'inline' ? null : placement.container;
  const present = (node: ReactNode) => (container ? createPortal(node, container) : node);
  const dock = app && placement === undefined ? ' pending-dock' : '';
  const done = (opts?: { inPlace?: boolean }) => {
    if (editorCurrent(isCurrent)) onDone?.(opts);
  };
  if (!editorCurrent(isCurrent)) return null;
  const attempt = stagedAttempt(table.id, recordKey);
  const feedback = app ? stagedFeedback(table.id, recordKey) : undefined;
  if (attempt?.phase === 'uncertain')
    return present(
      <div className={`pending pending-uncertain${dock}`} role="alert">
        <p>{attempt.message}</p>
        <details>
          <summary>{say('proposedChanges')}</summary>
          {!app && attempt.detail && <p>{attempt.detail}</p>}
          <dl>
            {Object.entries(attempt.values).map(([column, value]) => (
              <div key={column}>
                <dt>{columnLabel(table.id, column) ?? column}</dt>
                <dd>{value === null ? 'NULL' : String(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>,
    );
  if (draftNeedsReview(table.id, recordKey) && pendingCount())
    return present(
      <div className={`pending pending-recovery${dock}`} role="region" aria-label={say('retainedDraft')}>
        <span className="pending-count" role="status">
          {say('unsavedChangesFromYourPrevious', { count: pendingCount() })}
        </span>
        <details>
          <summary>{say('proposedChanges')}</summary>
          <dl>
            {Object.entries(retainedValues()).map(([column, value]) => (
              <div key={column}>
                <dt>{columnLabel(table.id, column) ?? column}</dt>
                <dd>{value === null ? 'NULL' : String(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
        {draftSchemaChanged(table) && <p role="alert">{say('theTableDefinitionChanged')}</p>}
        <button
          type="button"
          className="ghost"
          onPointerDown={cancelBlur}
          onKeyDown={cancelBlur}
          onClick={() => {
            cancelBlur();
            if (editorCurrent(isCurrent)) {
              discardStaged();
              done();
            }
          }}
        >
          {say('discardDraft')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={draftSchemaChanged(table) || !canEditRow(table, recordKey)}
          onClick={() => {
            cancelBlur();
            if (editorCurrent(isCurrent)) resumeDraft(table, recordKey);
          }}
        >
          {say('resumeDraft')}
        </button>
      </div>,
    );
  if (feedback && !pendingCount())
    return present(
      <div className={`pending pending-saved${dock}`} role="region" aria-label={say('savedChanges')} aria-busy={applyingStaged()}>
        <span className="pending-count" role={feedback.phase === 'error' ? 'alert' : 'status'}>
          <span className={`pending-status-icon ${feedback.phase === 'error' ? 'is-error' : ''}`} aria-hidden="true">
            {feedback.phase === 'error' ? '!' : '✓'}
          </span>
          {feedback.message}
        </span>
        <span className="pending-cols">{feedback.columns?.map((name: string) => columnLabel(table.id, name) ?? name).join(', ')}</span>
        <button
          type="button"
          className="ghost"
          disabled={applyingStaged()}
          onClick={() => {
            if (editorCurrent(isCurrent)) dismissSaveFeedback();
          }}
        >
          {say('common.dismiss')}
        </button>
      </div>,
    );
  if (!sameRow(table.id, recordKey) || !pendingCount()) return null;
  const n = pendingCount();
  /* Another person changed this record under the draft: said, and the form is left as it is (liveInvalidate.ts). A
     record room's draft docks at the window's foot, often far below the fields; there the notice hangs from the
     record's head instead, where this bar is drawn (PageHead's .page-pending), so the two read together. Elsewhere
     (a dialog, a board's card) the bar is beside the fields, and says it itself. */
  const notice = changedElsewhere && <LiveEditNotice table={table} recordKey={recordKey} {...(dock ? { place: 'anchored' } : {})} />;
  const bar = present(
    <div className={`pending${dock}`} role="region" aria-label={say('unsavedChanges')} aria-busy={applyingStaged()}>
      {!dock && notice}
      <span className="pending-count" role="status">
        {say('countUnsavedChanges', { count: n })}
      </span>
      <span className="pending-cols">
        {pendingColumns()
          .map((name: string) => columnLabel(table.id, name) ?? name)
          .join(', ')}
      </span>
      <button
        type="button"
        className="ghost"
        disabled={applyingStaged()}
        onPointerDown={cancelBlur}
        onKeyDown={cancelBlur}
        onClick={() => {
          cancelBlur();
          if (editorCurrent(isCurrent)) {
            discardStaged();
            done();
          }
        }}
      >
        {say('discard')}
      </button>
      <button
        type="button"
        className="primary"
        disabled={applyingStaged()}
        onPointerDown={cancelBlur}
        onKeyDown={cancelBlur}
        onClick={() => {
          cancelBlur();
          if (editorCurrent(isCurrent)) void applyStaged(table, recordKey, done);
        }}
      >
        {applyingStaged() ? (app ? 'Saving...' : say('awaitingConfirmation')) : app ? say('common.saveChanges') : say('reviewApply')}
      </button>
      {feedback?.phase === 'error' && (
        <p className="pending-error" role="alert">
          {feedback.message}
        </p>
      )}
    </div>,
  );
  return dock ? (
    <>
      {notice}
      {bar}
    </>
  ) : (
    bar
  );
}
