/**
 * The text boxes of a form: a plain box, a box that draws its value through a mask, and whole money. A Field's label,
 * hint and problem are wired into the box; a valid mark stands at its inline end in space that is always reserved, so
 * it arrives without moving the text. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import type { ReactNode, Ref } from 'react';
import { Field } from './Field.js';
import { frameOf, type FieldFrame } from './fieldFrame.js';
import { masks, type Mask } from './masks.js';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { slotted } from './internal/uiKitContext.js';

/** The mark at a box's inline end: drawn in CSS unless a picture is lent. Decorative: validity is `aria-invalid`'s to say. */
export function ValidMark({ icon }: { icon?: ReactNode }): ReactNode {
  return (
    <span className="field-mark" aria-hidden="true">
      {icon}
    </span>
  );
}

export interface TextFieldProps extends FieldFrame {
  value: string;
  onChange: (value: string, details: ChangeDetails<'input-change'>) => void;
  onBlur?: () => void;
  /** Present, the box reserves room for the mark; true draws it. Leave it out for a box that never shows one. */
  valid?: boolean;
  /** A picture for the mark in place of the drawn check. */
  validIcon?: ReactNode;
  type?: 'text' | 'email' | 'tel' | 'url';
  inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'url';
  autoComplete?: string;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Something drawn under the box: a computed line, say. */
  after?: ReactNode;
}

function DefaultTextField(props: TextFieldProps): ReactNode {
  return (
    <Field {...frameOf(props)}>
      {(control) => (
        <>
          <div className={`field-box${props.valid === undefined ? '' : ' has-mark'}`}>
            <input
              {...control}
              ref={props.inputRef}
              className="field-control"
              type={props.type ?? 'text'}
              name={props.name}
              value={props.value}
              inputMode={props.inputMode}
              autoComplete={props.autoComplete ?? 'off'}
              placeholder={props.placeholder}
              disabled={props.disabled}
              readOnly={props.readOnly}
              onChange={(e) => props.onChange(e.target.value, changeDetails('input-change', e))}
              onBlur={props.onBlur}
            />
            {props.valid ? <ValidMark icon={props.validIcon} /> : null}
          </div>
          {props.after}
        </>
      )}
    </Field>
  );
}

export interface MaskedFieldProps extends Omit<TextFieldProps, 'value' | 'onChange'> {
  mask: Mask;
  /** The raw value: the digits, usually. */
  value: string;
  onChange: (raw: string, details: ChangeDetails<'input-change'>) => void;
}

/** A box that shows its value through a mask and keeps the raw one: `masks.phone`, `masks.date` (typed MM/DD/YYYY), `masks.ssn`… */
function DefaultMaskedField({ mask, value, onChange, ...rest }: MaskedFieldProps): ReactNode {
  return (
    <TextField
      {...rest}
      value={mask.format(value)}
      onChange={(typed, details) => onChange(mask.parse(typed), details)}
      inputMode={rest.inputMode ?? mask.inputMode}
      placeholder={rest.placeholder ?? mask.placeholder}
    />
  );
}

/** Whole money, drawn `$2,500` (or `25,000` with `symbol=""`). The value is the digits. */
function DefaultMoneyField({ symbol = '$', ...rest }: Omit<MaskedFieldProps, 'mask'> & { symbol?: string }): ReactNode {
  return <MaskedField kind="money" {...rest} mask={masks.money(symbol)} />;
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const TextField = slotted('TextField', DefaultTextField, { onChange: [1, 'input-change'] });
export const MaskedField = slotted('MaskedField', DefaultMaskedField, { onChange: [1, 'input-change'] });
export const MoneyField = slotted('MoneyField', DefaultMoneyField, { onChange: [1, 'input-change'] });
