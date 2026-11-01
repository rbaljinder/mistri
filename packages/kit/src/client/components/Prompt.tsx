/**
 * A themed replacement for `window.prompt`: one question, one field, or a
 * range asked as one question rather than two. `prompt.js` keeps the
 * promise-shaped callers and mounts these into the body.
 */
import { useId, useRef, useState } from 'react';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { DateField } from './DateField.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { isPickerDate, isPickerDateTime } from '@mistriwork/ui/internal/datePickerModel.js';
import { formatLocale, formatTimezone } from '../locale.js';
import { say } from '../copy/shell/components/Prompt.js';

interface Common {
  title: string;
  hint?: string;
  type?: string;
  placeholder?: string;
}
export interface PromptProps extends Common {
  label: string;
  value?: string;
  multiline?: boolean;
  confirmLabel?: string;
  onDone: (value: string | null) => void;
}
export interface RangeProps extends Common {
  fromLabel: string;
  toLabel: string;
  onDone: (value: { from: string; to: string } | null) => void;
}
export interface ConfirmProps {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onDone: (ok: boolean) => void;
}

/** A modal that resolves once, whatever path closes it — Escape included. */
export function PromptDialog({
  title,
  label,
  value = '',
  hint,
  confirmLabel = say('common.save'),
  placeholder,
  type = 'text',
  multiline = false,
  onDone,
}: PromptProps) {
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const fieldId = useId();
  const [date, setDate] = useState(value);
  const dateOnly = type === 'date' && !multiline;
  const dateTime = type === 'datetime-local' && !multiline;
  const settled = useRef(false);
  const finish = (result: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(result);
  };
  const dialog = useRef<ModalHandle>(null);
  const submit = () => {
    const trimmed = input.current?.value.trim() ?? '';
    if (!trimmed || (dateOnly && !isPickerDate(trimmed)) || (dateTime && !isPickerDateTime(trimmed))) {
      input.current?.focus();
      return;
    }
    // Settled before the close, so the close event's own answer (null) finds nothing left to say.
    finish(trimmed);
    dialog.current?.close();
  };
  return (
    <Modal className="confirm" ref={dialog} onClose={() => finish(null)} initialFocus={input}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2>{title}</h2>
        {/* The dialog's field is a form's field — its label 13px in the text ink,
            its control the one field — where it spoke a second grammar of 11px
            captions and a ring drawn inside an edge of the same ink (N04). */}
        <Field label={label} id={fieldId}>
          {/* Dates stay calendar dates, and a date and time stays a wall time with no zone: what
              datetime-local handed back, now in the themed calendar, and never read as an instant. */}
          {multiline ? (
            <textarea
              ref={(node) => {
                input.current = node;
              }}
              className="field-control prompt-multiline"
              rows={10}
              defaultValue={value}
              placeholder={placeholder ?? ''}
            />
          ) : dateOnly || dateTime ? (
            <DateField
              id={fieldId}
              inputRef={(node) => {
                input.current = node;
              }}
              value={date}
              onChange={setDate}
              withTime={dateTime}
              className="field-control"
              aria-label={label}
              placeholder={dateTime ? undefined : placeholder}
              locale={formatLocale()}
              timezone={formatTimezone()}
            />
          ) : (
            <input
              ref={(node) => {
                input.current = node;
              }}
              type={type}
              className="field-control"
              defaultValue={value}
              placeholder={placeholder ?? ''}
            />
          )}
        </Field>
        {hint ? <p className="confirm-params">{hint}</p> : null}
        <div className="confirm-actions">
          <Button
            intent="secondary"
            onClick={() => {
              finish(null);
              dialog.current?.close();
            }}
          >
            {say('common.cancel')}
          </Button>
          <Button intent="primary" type="submit">
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Two values at once, for `between`: "from where to where" is one question, so it is one dialog. */
export function RangeDialog({ title, fromLabel, toLabel, hint, type = 'text', placeholder, onDone }: RangeProps) {
  const from = useRef<HTMLInputElement>(null);
  const to = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  /* A calendar is offered for a date and for a date and time; any other type keeps its own box. */
  const calendar = type === 'date' || type === 'datetime-local';
  const settled = useRef(false);
  const finish = (result: { from: string; to: string } | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(result);
  };
  const dialog = useRef<ModalHandle>(null);
  const submit = () => {
    /* A date's box shows the locale's writing of it; the field's value (ISO) is the state, never the box's text. */
    const a = (calendar ? fromDate : (from.current?.value ?? '')).trim();
    const b = (calendar ? toDate : (to.current?.value ?? '')).trim();
    /* Focus the end that is missing rather than refusing as a whole. */
    const valid = (v: string) => (type === 'date' ? isPickerDate(v) : type === 'datetime-local' ? isPickerDateTime(v) : true);
    if (!a || !valid(a)) {
      from.current?.focus();
      return;
    }
    if (!b || !valid(b)) {
      to.current?.focus();
      return;
    }
    finish({ from: a, to: b });
    dialog.current?.close();
  };
  return (
    <Modal className="confirm" ref={dialog} onClose={() => finish(null)} initialFocus={from}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2>{title}</h2>
        <div className="confirm-fields">
          <Field label={fromLabel} id={`${fieldId}-from`}>
            {calendar ? (
              <DateField
                id={`${fieldId}-from`}
                inputRef={from}
                value={fromDate}
                onChange={setFromDate}
                className="field-control"
                withTime={type === 'datetime-local'}
                aria-label={fromLabel}
                placeholder={type === 'date' ? placeholder : undefined}
                locale={formatLocale()}
                timezone={formatTimezone()}
              />
            ) : (
              <input ref={from} type={type} className="field-control" placeholder={placeholder ?? ''} />
            )}
          </Field>
          <Field label={toLabel} id={`${fieldId}-to`}>
            {calendar ? (
              <DateField
                id={`${fieldId}-to`}
                inputRef={to}
                value={toDate}
                onChange={setToDate}
                className="field-control"
                withTime={type === 'datetime-local'}
                aria-label={toLabel}
                placeholder={type === 'date' ? placeholder : undefined}
                locale={formatLocale()}
                timezone={formatTimezone()}
              />
            ) : (
              <input ref={to} type={type} className="field-control" placeholder={placeholder ?? ''} />
            )}
          </Field>
        </div>
        {hint ? <p className="confirm-params">{hint}</p> : null}
        <div className="confirm-actions">
          <Button
            intent="secondary"
            onClick={() => {
              finish(null);
              dialog.current?.close();
            }}
          >
            {say('common.cancel')}
          </Button>
          <Button intent="primary" type="submit">
            {say('common.apply')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A themed confirm: the question, one sentence of consequence, and a danger button that says what it does. */
export function ConfirmDialog({ title, body, confirmLabel = 'OK', cancelLabel = say('common.cancel'), onDone }: ConfirmProps) {
  const settled = useRef(false);
  const finish = (ok: boolean) => {
    if (settled.current) return;
    settled.current = true;
    onDone(ok);
  };
  const dialog = useRef<ModalHandle>(null);
  return (
    <Modal className="confirm" ref={dialog} onClose={() => finish(false)} ariaLabel={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
          dialog.current?.close();
        }}
      >
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="confirm-actions">
          <Button
            intent="secondary"
            onClick={() => {
              finish(false);
              dialog.current?.close();
            }}
          >
            {cancelLabel}
          </Button>
          <Button intent="danger" type="submit">
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
