/**
 * Choices drawn as buttons, cards and checkboxes: Yes/No, icon cards (one or several), a checkbox and a consent. One
 * answer is a native radio dressed, so the arrows, Space and the form's own semantics are the browser's, and the focus
 * ring shows on the face when the keyboard is on the input. Several cards are one group as the radios are (CheckCards):
 * one Tab stop, the arrows move between them, Space turns one on or off, and each says `aria-checked`. Props only.
 * Preview: @mistriwork/ui is Preview at 1.0.
 */
import { useId, useRef, useState, type AriaAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Field } from './Field.js';
import { frameOf, type FieldFrame } from './fieldFrame.js';

export interface ChoiceOption {
  value: string;
  label: string;
  /** A picture for a card. */
  icon?: ReactNode;
}

export interface YesNoProps extends Omit<FieldFrame, 'label'> {
  /** The question. */
  label: ReactNode;
  value: 'yes' | 'no' | '';
  onChange: (value: 'yes' | 'no') => void;
  /** The two words, in the caller's language. */
  yes: string;
  no: string;
}

/** Two buttons answering a question. */
export function YesNo(props: YesNoProps): ReactNode {
  const name = useId();
  return (
    <Field {...frameOf(props)} group>
      {(control) => (
        <div
          className="choice-pair"
          role="radiogroup"
          aria-labelledby={control['aria-labelledby']}
          aria-describedby={control['aria-describedby']}
          aria-invalid={control['aria-invalid']}
        >
          {(['yes', 'no'] as const).map((v) => (
            <label key={v} className={`choice-pick${props.value === v ? ' is-on' : ''}`}>
              <input type="radio" name={name} className="choice-input" checked={props.value === v} onChange={() => props.onChange(v)} />
              {props[v]}
            </label>
          ))}
        </div>
      )}
    </Field>
  );
}

export interface ChoiceCardsProps extends FieldFrame {
  options: ChoiceOption[];
  value: string[];
  onChange: (value: string[]) => void;
  /** Several may be on. */
  multiple?: boolean;
  /** The card that stands alone ("None"): choosing it clears the rest, and choosing another clears it. */
  exclusive?: string;
}

/** Cards with an icon, a label and a box. One choice is a radio group; `multiple` a group of checkboxes. */
export function ChoiceCards(props: ChoiceCardsProps): ReactNode {
  const name = useId();
  const toggle = (v: string, on: boolean): void => {
    if (!props.multiple) return props.onChange(on ? [v] : []);
    if (v === props.exclusive) return props.onChange(on ? [v] : []);
    const rest = props.value.filter((x) => x !== v && x !== props.exclusive);
    props.onChange(on ? props.options.map((o) => o.value).filter((x) => x === v || rest.includes(x)) : rest);
  };
  if (props.multiple)
    return (
      <Field {...frameOf(props)} group>
        {(control) => (
          <CheckCards
            aria-labelledby={control['aria-labelledby']}
            aria-describedby={control['aria-describedby']}
            aria-invalid={control['aria-invalid']}
            cards={props.options.map((o) => ({ key: o.value, label: o.label, icon: o.icon, on: props.value.includes(o.value) }))}
            onToggle={(index, on) => toggle(props.options[index].value, on)}
          />
        )}
      </Field>
    );
  return (
    <Field {...frameOf(props)} group>
      {(control) => (
        <div
          className="choice-cards"
          role="radiogroup"
          aria-labelledby={control['aria-labelledby']}
          aria-describedby={control['aria-describedby']}
          aria-invalid={control['aria-invalid']}
        >
          {props.options.map((o) => {
            const on = props.value.includes(o.value);
            return (
              <label key={o.value} className={`choice-card${on ? ' is-on' : ''}`}>
                {o.icon ? (
                  <span className="choice-card-icon" aria-hidden="true">
                    {o.icon}
                  </span>
                ) : null}
                <span className="choice-card-label">{o.label}</span>
                <input type="radio" name={name} className="choice-input" checked={on} onChange={(e) => toggle(o.value, e.target.checked)} />
                <span className="choice-box" aria-hidden="true" />
              </label>
            );
          })}
        </div>
      )}
    </Field>
  );
}

/** One card of several: its words, its picture and whether it is on. */
export interface CheckCard {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** A line under the label. */
  help?: ReactNode;
  on: boolean;
}

export interface CheckCardsProps {
  cards: readonly CheckCard[];
  /** The card at `index` turned on or off. */
  onToggle: (index: number, on: boolean) => void;
  id?: string;
  disabled?: boolean;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  /** How short every card's words are, so a wide page can set them side by side (`data-fit`; the page's stylesheet
   * decides what that means): `short` is a label alone, `brief` a label and a line that fit half a column. */
  fit?: 'short' | 'brief';
}

/**
 * Several cards, any of them on: full-width cards, each an icon, its words and a square at its end that fills when it
 * is on. They are one group to the keyboard, as radios are — one Tab stop (the card last moved to, else the first one
 * on, else the first), the arrows and Home and End move between them, and Space turns the one in hand on or off — and
 * each is a `checkbox` saying `aria-checked`, so a screen reader hears "checked" as it moves.
 */
export function CheckCards(props: CheckCardsProps): ReactNode {
  const { cards } = props;
  const [held, setHeld] = useState<number | undefined>(undefined);
  const faces = useRef<(HTMLDivElement | null)[]>([]);
  const first = cards.findIndex((card) => card.on);
  const stop = held !== undefined && held < cards.length ? held : Math.max(first, 0);
  const move = (to: number) => {
    const next = (to + cards.length) % cards.length;
    setHeld(next);
    faces.current[next]?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const to =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? cards.length - 1
              : undefined;
    if (to !== undefined) {
      event.preventDefault();
      move(to);
    } else if (event.key === ' ') {
      // Space is the box's own key; the page does not scroll under it.
      event.preventDefault();
      if (!props.disabled) props.onToggle(index, !cards[index].on);
    }
  };
  return (
    <div
      className="choice-cards"
      role="group"
      data-fit={props.fit}
      id={props.id}
      aria-labelledby={props['aria-labelledby']}
      aria-describedby={props['aria-describedby']}
      aria-invalid={props['aria-invalid']}
    >
      {cards.map((card, index) => (
        <div
          key={card.key}
          ref={(face) => {
            faces.current[index] = face;
          }}
          role="checkbox"
          aria-checked={card.on}
          aria-disabled={props.disabled || undefined}
          tabIndex={index === stop ? 0 : -1}
          className={`choice-card${card.on ? ' is-on' : ''}`}
          onClick={() => {
            setHeld(index);
            if (!props.disabled) props.onToggle(index, !card.on);
          }}
          onFocus={() => setHeld(index)}
          onKeyDown={(event) => keys(event, index)}
        >
          {card.icon ? (
            <span className="choice-card-icon" aria-hidden="true">
              {card.icon}
            </span>
          ) : null}
          <span className="choice-card-label">
            {card.label}
            {card.help ? <span className="choice-card-help">{card.help}</span> : null}
          </span>
          <span className="choice-box" aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}

export interface CheckboxProps extends Omit<FieldFrame, 'label'> {
  checked: boolean;
  onChange: (on: boolean) => void;
  /** The text beside the box; it is the label, so it is a click target too. */
  label: ReactNode;
  disabled?: boolean;
}

/** A checkbox beside its text. */
export function Checkbox(props: CheckboxProps): ReactNode {
  return (
    <Field {...frameOf(props)} check>
      {(control) => (
        <input
          {...control}
          type="checkbox"
          className="field-check"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.checked)}
        />
      )}
    </Field>
  );
}

/** A checkbox for a long notice: the paragraph is the label, in the body's weight. */
export function Consent(props: CheckboxProps): ReactNode {
  return <Checkbox {...props} className={['form-field-consent', props.className].filter(Boolean).join(' ')} />;
}
