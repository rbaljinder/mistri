/**
 * One field: its label over the control, a hint under it, and the problem
 * it holds under that — in the control's own column, so saying a problem
 * never narrows or moves the control (docs/design.md, Access).
 *
 * The wiring is the point. The control is handed its id, what describes it
 * (the hint, the problem), `aria-invalid` while it holds a problem and
 * `aria-required` beside the star, so no form has to remember to join them.
 * A control that is one element takes them as props (`children` an element);
 * one that is several — a listbox's button, a date and its calendar, a
 * picker — takes them through `children` as a function and puts them where
 * its focusable is.
 */
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
  /** A group's label is not a `<label>`: its control names itself by this. */
  'aria-labelledby'?: string;
}

interface FieldProps {
  label: ReactNode;
  /** A sentence that helps before anything goes wrong. */
  hint?: ReactNode;
  /** What is wrong with the value now, in the reader's words. Empty or absent: nothing. */
  problem?: ReactNode;
  required?: boolean;
  /** The control's id; one is made when not given. */
  id?: string;
  /** A control that is not one labelable element (radios, a listbox's button): the label is a caption the control points at. */
  group?: boolean;
  /** A checkbox: the control first and its label beside it, on one line, the label checking it. */
  check?: boolean;
  /** The word that says a field may be left empty ("(optional)"), drawn quietly after the label; the caller's, in its language. */
  optionalMark?: ReactNode;
  /** The word that says an optional field may be left empty ("(optional)"), in the caller's language. Given on every
      field that is not required, it is drawn only where the worn theme asks for it (`recipes.required:
      'optional-word'`, the stylesheet's to decide) and replaces the star. It stands beside the label, not in it, so
      the label's name is the same either way; `aria-required` is untouched. */
  optionalWord?: ReactNode;
  /** The label is read, not drawn: a group whose question is the heading above it. */
  labelHidden?: boolean;
  /** Something beside the label on its row: a help tip. */
  labelAside?: ReactNode;
  /** Keep the problem's line in the flow while it is empty, so a problem that arrives moves nothing below it. */
  reserve?: boolean;
  /** Compact: a filter's or a dense row's size. */
  size?: 'compact' | 'default';
  className?: string;
  children: ReactElement<Record<string, unknown>> | ((control: FieldControlProps) => ReactNode);
}

export function Field({
  label,
  hint,
  problem,
  required = false,
  id,
  group = false,
  check = false,
  size = 'default',
  optionalMark,
  optionalWord,
  labelAside,
  labelHidden = false,
  reserve = false,
  className = '',
  children,
}: FieldProps) {
  const made = useId();
  const controlId = id ?? `field-${made}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const problemId = `${controlId}-problem`;
  const holdsProblem = problem !== undefined && problem !== null && problem !== false && problem !== '';
  const labelId = `${controlId}-label`;
  const labelClass = labelHidden ? 'form-field-label form-field-label-hidden' : 'form-field-label';
  const caption = group ? (
    <span id={labelId} className={labelClass}>
      {label}
      {optionalMark ? <span className="form-field-optional"> {optionalMark}</span> : null}
    </span>
  ) : (
    <label id={labelId} htmlFor={controlId} className={labelClass}>
      {label}
      {optionalMark ? <span className="form-field-optional"> {optionalMark}</span> : null}
    </label>
  );
  const word = optionalWord && !required ? <span className="form-field-optional-word">{optionalWord}</span> : null;
  const optional = optionalMark ? <span className="form-field-optional"> {optionalMark}</span> : null;
  const control: FieldControlProps = {
    id: controlId,
    ...(hintId || holdsProblem ? { 'aria-describedby': [hintId, holdsProblem ? problemId : undefined].filter(Boolean).join(' ') } : {}),
    ...(holdsProblem ? { 'aria-invalid': true as const } : {}),
    ...(required ? { 'aria-required': true as const } : {}),
    ...(group ? { 'aria-labelledby': labelId } : {}),
  };
  const drawn =
    typeof children === 'function'
      ? children(control)
      : isValidElement(children)
        ? cloneElement(children, { ...control, ...joined(children.props, control) })
        : children;
  /* The star is the stylesheet's (`.is-required`), not text: a label's words
     stay its name, to a query by label as to a screen reader, which hears
     "required" from `aria-required` instead. */
  return (
    <div
      className={[
        'form-field',
        size === 'compact' ? 'form-field-compact' : '',
        check ? 'form-field-check' : '',
        reserve ? 'form-field-reserve' : '',
        required ? 'is-required' : '',
        holdsProblem ? 'is-invalid' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {check ? (
        <div className="form-field-check-row">
          {drawn}
          <label id={labelId} htmlFor={controlId} className="form-field-label">
            {label}
            {optional}
          </label>
          {word}
        </div>
      ) : (
        <>
          {labelAside || word ? (
            <div className="form-field-label-row">
              {caption}
              {word}
              {labelAside}
            </div>
          ) : (
            caption
          )}
          {drawn}
        </>
      )}
      {hint ? (
        <p id={hintId} className="form-field-hint">
          {hint}
        </p>
      ) : null}
      {/* Always drawn, hidden while empty, as the command forms' feedback is: a
        problem that arrives lands in a polite region that was already there,
        and the control names it in its description once it is said. */}
      <p id={problemId} className="form-field-problem" aria-live="polite" hidden={!holdsProblem && !reserve}>
        {holdsProblem ? problem : null}
      </p>
    </div>
  );
}

/** A control's own description joins the field's rather than being replaced by it. */
function joined(props: Record<string, unknown>, control: FieldControlProps): Partial<FieldControlProps> {
  const own = typeof props['aria-describedby'] === 'string' ? props['aria-describedby'] : '';
  const described = [own, control['aria-describedby']].filter(Boolean).join(' ');
  return described ? { 'aria-describedby': described } : {};
}
