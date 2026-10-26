/**
 * What every form control says about its frame, once: the label, the hint, the problem, the word for an optional
 * field and a help tip. `frameOf` turns it into the Field's props, so a control never joins them by hand.
 */
import type { ReactNode } from 'react';
import { HelpTip, type HelpTipProps } from './FormParts.js';

export interface FieldFrame {
  label: ReactNode;
  /** A sentence under the control that helps before anything goes wrong. */
  hint?: ReactNode;
  /** What is wrong now, in the reader's words. Its line is kept in the flow, so saying it moves nothing (`reserve`). */
  problem?: ReactNode;
  required?: boolean;
  /** The label is read to assistive technology but not drawn. */
  labelHidden?: boolean;
  /** The word that marks a field as optional ("(optional)"), in the caller's language. */
  optional?: ReactNode;
  /** A help tip beside the label. */
  tip?: HelpTipProps;
  /** Keep the problem's line in the flow while empty. On by default for a form's controls; turn it off for a dense row. */
  reserve?: boolean;
  /** The control's id; one is made when not given. */
  id?: string;
  className?: string;
}

export function frameOf(p: FieldFrame) {
  return {
    label: p.label,
    hint: p.hint,
    problem: p.problem,
    required: p.required,
    labelHidden: p.labelHidden,
    id: p.id,
    className: p.className,
    optionalMark: p.optional,
    labelAside: p.tip ? <HelpTip {...p.tip} /> : undefined,
    reserve: p.reserve ?? true,
  };
}
