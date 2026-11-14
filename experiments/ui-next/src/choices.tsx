import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Field, FieldError, FieldLabel } from '@ui-sdk/react/field';
import { Radio, RadioGroup } from '@ui-sdk/react/radio';
import { type ReactNode, useState } from 'react';
import { FieldFrame } from './fields';
import { words } from './words';

/* The answers that are a choice and not something typed: a yes or a no, several of a few, and an agreement. */

export type YesNoFieldProps = {
  label: string;
  name?: string;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  value?: boolean | null;
  defaultValue?: boolean | null;
  onValueChange?: (value: boolean) => void;
  /* The two words, where Yes and No are not the answer's own. */
  yes?: string;
  no?: string;
};

/* A question with two answers, both in view and neither chosen for the reader: two cards side by side, as wide as
   each other, so the answer is one press and what was pressed is plain. A checkbox would answer No by being left
   alone, which is not an answer. */
export function YesNoField({
  label,
  name,
  hint,
  error,
  optional,
  value,
  defaultValue,
  onValueChange,
  yes = words.yes,
  no = words.no,
}: YesNoFieldProps) {
  const said = (answer: boolean | null | undefined) => (answer === true ? 'yes' : answer === false ? 'no' : undefined);
  return (
    <FieldFrame {...{ label, hint, error, optional }}>
      <RadioGroup
        name={name}
        data-kind="cards"
        data-shape="pair"
        value={value === undefined ? undefined : (said(value) ?? null)}
        defaultValue={said(defaultValue)}
        onValueChange={(next) => next !== null && onValueChange?.(next === 'yes')}
      >
        {(
          [
            ['yes', yes],
            ['no', no],
          ] as const
        ).map(([answer, word]) => (
          <label key={answer} data-slot="choice">
            <Radio value={answer} />
            <span data-slot="choice-label">{word}</span>
          </label>
        ))}
      </RadioGroup>
    </FieldFrame>
  );
}

export type CheckCard = { value: string; label: string; hint?: string; icon?: ReactNode; disabled?: boolean };

export type CheckCardsFieldProps = {
  label: string;
  name?: string;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  options: CheckCard[];
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  columns?: number;
  /* The most that may be chosen. Reached, the rest stand back and say why. */
  max?: number;
  /* The one card that means none of the others ("None of these"): ticking it unticks the rest, and ticking any
     other unticks it, so the two answers can never both be given. */
  exclusive?: string;
};

/* Several of a few, all in view: each a card that fills when ticked, the whole card the target. With a limit, the
   field says how many are left as the reader goes, and at the limit the unticked cards stand back rather than
   refusing a press after the fact. */
export function CheckCardsField({
  label,
  name,
  hint,
  error,
  optional,
  options,
  value,
  defaultValue,
  onValueChange,
  columns,
  max,
  exclusive,
}: CheckCardsFieldProps) {
  const [own, setOwn] = useState(defaultValue ?? []);
  const chosen = value ?? own;
  const counted = chosen.filter((each) => each !== exclusive).length;
  const full = max !== undefined && counted >= max;
  const left = max === undefined ? undefined : max - counted;
  return (
    <FieldFrame
      {...{ label, error, optional }}
      hint={
        max === undefined ? (
          hint
        ) : (
          <>
            {hint} <span data-slot="field-count">{left === 0 ? words.allChosen(max) : words.moreMayBeChosen(left ?? 0)}</span>
          </>
        )
      }
    >
      <div
        role="group"
        aria-label={label}
        data-slot="check-cards"
        style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      >
        {options.map((option) => {
          const on = chosen.includes(option.value);
          return (
            <label
              key={option.value}
              data-slot="choice"
              data-off={(full && !on && option.value !== exclusive) || option.disabled ? '' : undefined}
            >
              <Checkbox
                name={name}
                value={option.value}
                checked={on}
                disabled={option.disabled || (full && !on && option.value !== exclusive)}
                onCheckedChange={(next) => {
                  const after =
                    next !== true
                      ? chosen.filter((each) => each !== option.value)
                      : option.value === exclusive
                        ? [option.value]
                        : [...chosen.filter((each) => each !== exclusive), option.value];
                  setOwn(after);
                  onValueChange?.(after);
                }}
              >
                <CheckboxIndicator />
              </Checkbox>
              <span data-slot="choice-label">
                {option.icon}
                {option.label}
              </span>
              {option.hint && <span data-slot="choice-hint">{option.hint}</span>}
            </label>
          );
        })}
      </div>
    </FieldFrame>
  );
}

export type ConsentFieldProps = {
  /* What is agreed to, in full: a sentence, with its links. */
  children: ReactNode;
  name?: string;
  error?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  required?: boolean;
};

/* An agreement: a tick beside the words agreed to, the words the label. It is never ticked for the reader, and
   what it says when it was needed and left alone stands under it. */
export function ConsentField({ children, name, error, checked, defaultChecked, onCheckedChange, required }: ConsentFieldProps) {
  return (
    <Field data-kind="check" data-shape="consent" invalid={error ? true : undefined}>
      <Checkbox
        name={name}
        required={required}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(next) => onCheckedChange?.(next === true)}
      >
        <CheckboxIndicator />
      </Checkbox>
      <div>
        <FieldLabel>{children}</FieldLabel>
        {error && <FieldError>{error}</FieldError>}
      </div>
    </Field>
  );
}
