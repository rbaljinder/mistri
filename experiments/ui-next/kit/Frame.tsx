import { Field, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import type { ReactNode } from 'react';
import type { FieldFrame } from '@mistriwork/ui/fieldFrame.js';

/* The frame every control stands in, from mistri's FieldFrame: the label over it, the mark that says required or
   optional beside the label (never in it, so the control's name is the same either way), a help tip, the hint, and
   the problem under it. `reserve` keeps the problem's line in the flow while it is empty, so a problem that
   arrives moves nothing below it. UI SDK's Field does the wiring: the label names the control and the hint and the
   problem describe it. */
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
      {tip && (
        <Popover>
          <PopoverTrigger aria-label={tip.label} data-kind="help-tip">
            {tip.icon ?? 'i'}
          </PopoverTrigger>
          <PopoverContent sideOffset={6}>{tip.text}</PopoverContent>
        </Popover>
      )}
    </div>
  );
  const lines = (
    <>
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {problem ? <FieldError>{problem}</FieldError> : reserve ? <p data-slot="field-reserve" aria-hidden="true" /> : null}
    </>
  );
  return (
    <Field invalid={problem ? true : undefined} className={className} data-kind={check ? 'check' : undefined} data-answer={kind}>
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
