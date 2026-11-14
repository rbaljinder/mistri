/**
 * The frame every form control stands in, from what it says of itself (../fieldFrame.tsx): the label over it, the
 * mark that says required or the word that says optional beside the label (never in it, so the control's name is
 * the same either way), a help tip (the one a form uses on its own, ./HelpTip.tsx), the hint, and the problem
 * under it. `reserve` keeps the problem's line in the flow while it is empty, so a problem that arrives moves
 * nothing below it.
 *
 * UI SDK's field is the root and does the wiring: its own parts inside (a text box, a listbox's button, a
 * checkbox) read their id, their name, what describes them and `aria-invalid` from it, and the label finds its
 * control whichever of them that is.
 *
 * A control that is not UI SDK's cannot read that field, so one is made the field's control part where it is drawn
 * (`<FieldControl render={…} />`, as ../Choices.tsx does for its cards and ../FileField.tsx for the file input): the
 * field then hands it its id and `aria-labelledby`, `aria-describedby` and `aria-invalid` as props, which is how a
 * control kit's drawing of a slot hears them too.
 */
import { Field, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field';
import type { ReactNode } from 'react';
import type { FieldFrame } from '../fieldFrame.js';
import { HelpTip } from './HelpTip.js';

export function Frame({
  label,
  hint,
  problem,
  required,
  labelHidden,
  optional,
  tip,
  reserve = true,
  kind,
  className,
  check,
  children,
}: FieldFrame & { check?: boolean; children: ReactNode }) {
  const holdsProblem = problem !== undefined && problem !== null && problem !== false && problem !== '';
  const name = (
    <div data-slot="field-head" data-kind={labelHidden ? 'visually-hidden' : undefined}>
      <FieldLabel>{label}</FieldLabel>
      {required ? (
        <span data-slot="field-required" aria-hidden="true">
          *
        </span>
      ) : optional ? (
        <span data-slot="field-optional">{optional}</span>
      ) : null}
      {tip && <HelpTip {...tip} />}
    </div>
  );
  const lines = (
    <>
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {holdsProblem ? <FieldError>{problem}</FieldError> : reserve ? <p data-slot="field-reserve" aria-hidden="true" /> : null}
    </>
  );
  return (
    <Field
      invalid={holdsProblem ? true : undefined}
      className={className}
      data-kind={check ? 'check' : undefined}
      data-answer={kind}
      data-required={required ? '' : undefined}
    >
      {check ? (
        <>
          {children}
          <div>
            {name}
            {lines}
          </div>
        </>
      ) : (
        <>
          {name}
          {children}
          {lines}
        </>
      )}
    </Field>
  );
}
