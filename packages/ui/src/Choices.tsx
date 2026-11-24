/**
 * Choices drawn as buttons, cards and checkboxes: Yes/No, icon cards (one or several), a checkbox and a consent. One
 * answer is UI SDK's radio group, so the arrows move between the answers and choose, and the focus ring shows on the
 * face when the keyboard is on the radio. Several cards are one group as the radios are (CheckCards): one Tab stop,
 * the arrows move between them, Space turns one on or off, and each says `aria-checked`. Props only.
 * Preview: @mistriwork/ui is Preview at 1.0.
 */
import { type ChangeDetails as SdkChangeDetails, createChange, definePrimitive } from '@ui-sdk/core';
import { Checkbox as Box, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { FieldControl } from '@ui-sdk/react/field';
import { createParts } from '@ui-sdk/react/primitive';
import { Radio, RadioGroup } from '@ui-sdk/react/radio';
import { useId, type AriaAttributes, type ComponentProps, type ReactNode, type Ref } from 'react';
import type { FieldFrame } from './fieldFrame.js';
import type { ChangeDetails } from './changeDetails.js';
import type { ControlSize } from './internal/cx.js';
import { Frame } from './internal/Frame.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

/** Option descriptor for `ChoiceCards`. */
export interface ChoiceOption {
  value: string;
  label: string;
  /** A picture for a card. */
  icon?: ReactNode;
}

/** Props for the `YesNo` binary radio card pair. */
export interface YesNoProps extends Omit<FieldFrame, 'label'> {
  /** The question. */
  label: ReactNode;
  value: 'yes' | 'no' | '';
  onValueChange?: (value: 'yes' | 'no', details: ChangeDetails<'select'>) => void;
  /** The two words, in the caller's language. */
  yes: string;
  no: string;
  ref?: Ref<HTMLDivElement>;
}

/** Two buttons answering a question. */
function DefaultYesNo(props: YesNoProps): ReactNode {
  const id = useId();
  const legacyChange = (props as { onChange?: (value: 'yes' | 'no', details: ChangeDetails<'select'>) => void }).onChange;
  return (
    <Frame {...props}>
      <RadioGroup
        ref={props.ref}
        data-kind="cards"
        data-fit="pair"
        value={props.value === '' ? null : props.value}
        onValueChange={(next, details) => {
          if (next === 'yes' || next === 'no') {
            const info = told('select', details);
            props.onValueChange?.(next, info);
            legacyChange?.(next, info);
          }
        }}
      >
        {(['yes', 'no'] as const).map((answer) => (
          <label key={answer} data-slot="choice" data-checked={props.value === answer ? '' : undefined}>
            <Radio value={answer} aria-labelledby={`${id}-${answer}`} />
            <span data-slot="choice-label" id={`${id}-${answer}`}>
              {props[answer]}
            </span>
          </label>
        ))}
      </RadioGroup>
    </Frame>
  );
}

/** Props for `ChoiceCards` single-choice or multi-choice card group. */
export interface ChoiceCardsProps extends FieldFrame {
  options: readonly ChoiceOption[];
  value: readonly string[];
  onValueChange?: (value: string[], details: ChangeDetails<'select'>) => void;
  /** Several may be on. */
  multiple?: boolean;
  /** The card that stands alone ("None"): choosing it clears the rest, and choosing another clears it. */
  exclusive?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Cards with an icon, a label and a box. One choice is a radio group; `multiple` a group of checkboxes. */
function DefaultChoiceCards(props: ChoiceCardsProps): ReactNode {
  const id = useId();
  const legacyChange = (props as { onChange?: (value: string[], details: ChangeDetails<'select'>) => void }).onChange;
  const emit = (next: string[], details: ChangeDetails<'select'>) => {
    props.onValueChange?.(next, details);
    legacyChange?.(next, details);
  };
  if (props.multiple)
    return (
      <Frame {...props}>
        <FieldControl
          render={
            <CheckCards
              ref={props.ref}
              cards={props.options.map((option) => ({
                key: option.value,
                label: option.label,
                icon: option.icon,
                on: props.value.includes(option.value),
              }))}
              onToggle={(index, on, details) => {
                const value = props.options[index]!.value;
                const say: ChangeDetails<'select'> = { ...details, reason: 'select' };
                if (value === props.exclusive) return emit(on ? [value] : [], say);
                const rest = props.value.filter((other) => other !== value && other !== props.exclusive);
                emit(
                  on ? props.options.map((option) => option.value).filter((other) => other === value || rest.includes(other)) : rest,
                  say,
                );
              }}
            />
          }
        />
      </Frame>
    );
  return (
    <Frame {...props}>
      <RadioGroup
        ref={props.ref}
        data-kind="cards"
        value={props.value[0] ?? null}
        onValueChange={(next, details) => emit(next === null ? [] : [String(next)], told('select', details))}
      >
        {props.options.map((option) => (
          <label key={option.value} data-slot="choice" data-checked={props.value[0] === option.value ? '' : undefined}>
            <Radio value={option.value} aria-labelledby={`${id}-${option.value}`} />
            {option.icon ? (
              <span data-slot="choice-icon" aria-hidden="true">
                {option.icon}
              </span>
            ) : null}
            <span data-slot="choice-label" id={`${id}-${option.value}`}>
              {option.label}
            </span>
          </label>
        ))}
      </RadioGroup>
    </Frame>
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

/** Props for the `CheckCards` roving-focus checkbox card group. */
export interface CheckCardsProps {
  cards: readonly CheckCard[];
  /** The card at `index` turned on or off. */
  onToggle: (index: number, on: boolean, details: ChangeDetails<'toggle'>) => void;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  /** How short every card's words are (`short` or `brief`). */
  fit?: 'short' | 'brief';
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

type CheckCardsReason = 'press';

type CheckCardsOptions = {
  keys: string[];
  value?: string[];
  onValueChange?: (value: string[], details: SdkChangeDetails<CheckCardsReason>) => void;
  disabled?: boolean;
};

const checkCards = definePrimitive({
  name: 'check-cards',
  options: { keys: 'list', value: 'list', onValueChange: 'callback', disabled: 'boolean' },
  controlled: ['value'],
  state: (options: CheckCardsOptions) => ({
    value: (options.value ?? []) as string[],
    cursor: null as string | null,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const keys = (): string[] => context.options().keys ?? [];
    return {
      disabled: (): boolean => context.options().disabled === true,
      on: (key: string): boolean => context.store.get().value.includes(key),
      stop(): string | null {
        const { value, cursor } = context.store.get();
        const all = keys();
        if (cursor !== null && all.includes(cursor)) return cursor;
        return all.find((key) => value.includes(key)) ?? all[0] ?? null;
      },
      walked(key: string) {
        if (context.store.get().cursor !== key) context.store.set({ cursor: key });
      },
      step(from: string, key: string): string | undefined {
        const all = keys();
        const at = all.indexOf(from);
        const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 }[key];
        return to === undefined || at < 0 ? undefined : all[(to + all.length) % all.length];
      },
      toggle(key: string, event: Event): boolean {
        if (context.options().disabled) return false;
        const { value } = context.store.get();
        const next = value.includes(key)
          ? value.filter((other) => other !== key)
          : keys().filter((other) => other === key || value.includes(other));
        return change('value', next, { reason: 'press', event });
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}>({
      attrs: (_state, part) => ({ role: 'group', 'data-disabled': part.api.disabled() ? '' : undefined }),
    }),
    card: slot<{ value: string }, { on: boolean }>({
      props: { value: 'string' },
      state: (state, part) => ({ on: state.value.includes(part.props.value) }),
      attrs: (state, part) => ({
        role: 'checkbox',
        tabindex: part.api.stop() === part.props.value ? '0' : '-1',
        'data-key': part.props.value,
        'aria-checked': String(state.value.includes(part.props.value)),
        'aria-disabled': part.api.disabled() ? 'true' : undefined,
        'data-checked': state.value.includes(part.props.value) ? '' : undefined,
      }),
      on: {
        keydown: (event, { api, el, props }) => {
          const to = api.step(props.value, event.key);
          if (to !== undefined) {
            event.preventDefault();
            api.walked(to);
            el?.parentElement?.querySelector<HTMLElement>(`[data-slot="check-cards-card"][data-key="${CSS.escape(to)}"]`)?.focus();
          } else if (event.key === ' ') {
            event.preventDefault();
            api.toggle(props.value, event);
          }
        },
        focus: (_event, { api, props }) => api.walked(props.value),
        click: (event, { api, props }) => {
          api.walked(props.value);
          api.toggle(props.value, event);
        },
      },
    }),
  }),
});

const cardParts = createParts(checkCards, { root: 'div', card: 'div' });

function DefaultCheckCards(props: CheckCardsProps): ReactNode {
  const { cards, onToggle, disabled, fit, ariaLabel, className, ref, ...rest } = props as CheckCardsProps &
    Omit<ComponentProps<'div'>, keyof CheckCardsProps | 'children'>;
  const legacyAriaLabel = (rest as Record<string, unknown>)['aria-label'] as string | undefined;
  return (
    <cardParts.Root
      {...rest}
      ref={ref}
      className={className}
      aria-label={ariaLabel ?? legacyAriaLabel}
      data-fit={fit}
      keys={cards.map((card) => card.key)}
      value={cards.filter((card) => card.on).map((card) => card.key)}
      disabled={disabled}
      onValueChange={(next, details) => {
        const index = cards.findIndex((card) => card.on !== next.includes(card.key));
        if (index >= 0) onToggle(index, !cards[index]!.on, told('toggle', details));
      }}
    >
      {cards.map((card) => (
        <cardParts.Card key={card.key} value={card.key}>
          {card.icon ? (
            <span data-slot="choice-icon" aria-hidden="true">
              {card.icon}
            </span>
          ) : null}
          <span data-slot="choice-label">
            {card.label}
            {card.help ? <span data-slot="choice-hint">{card.help}</span> : null}
          </span>
          <span data-slot="checkbox" data-checked={card.on ? '' : undefined} aria-hidden="true">
            {card.on ? <span data-slot="checkbox-indicator" data-checked="" /> : null}
          </span>
        </cardParts.Card>
      ))}
    </cardParts.Root>
  );
}

/** Props for the `Checkbox` control. */
export interface CheckboxProps extends Omit<FieldFrame, 'label'> {
  value?: string;
  checked?: boolean | 'indeterminate';
  defaultChecked?: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (on: boolean, details: ChangeDetails<'toggle'>) => void;
  /** The text beside the box; it is the label, so it is a click target too. Omit for a standalone checkbox with `ariaLabel`. */
  label?: ReactNode;
  description?: ReactNode;
  ariaLabel?: string;
  size?: ControlSize;
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** Props for the `Consent` long-notice checkbox control. */
export type ConsentProps = CheckboxProps;

/** A checkbox beside its text, or standalone when `label` is omitted. */
function DefaultCheckbox(props: CheckboxProps): ReactNode {
  const isIndeterminate = props.indeterminate === true || props.checked === 'indeterminate';
  const resolvedChecked = isIndeterminate ? 'indeterminate' : props.checked;
  const legacyChange = (props as { onChange?: (on: boolean, details: ChangeDetails<'toggle'>) => void }).onChange;
  const legacyAriaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined;
  const resolvedAriaLabel = props.ariaLabel ?? legacyAriaLabel;
  const handleToggle = (next: boolean | 'indeterminate', details: SdkChangeDetails<string>) => {
    const info = told('toggle', details);
    const bool = next === true;
    props.onCheckedChange?.(bool, info);
    legacyChange?.(bool, info);
  };
  const control = (
    <Box
      id={props.id}
      ref={props.ref}
      value={props.value}
      checked={resolvedChecked}
      defaultChecked={props.defaultChecked}
      disabled={props.disabled}
      data-size={props.size}
      aria-label={props.label === undefined ? resolvedAriaLabel : props.ariaLabel}
      aria-required={props.required || undefined}
      className={props.label === undefined ? props.className : undefined}
      onCheckedChange={handleToggle}
    >
      <CheckboxIndicator />
    </Box>
  );
  if (props.label === undefined) {
    return control;
  }
  return (
    <Frame {...props} label={props.label} hint={props.hint ?? props.description} check>
      {control}
    </Frame>
  );
}

/** A checkbox for a long notice: the paragraph is the label, in the body's weight. */
function DefaultConsent(props: ConsentProps): ReactNode {
  return <Checkbox {...props} className={['consent', props.className].filter(Boolean).join(' ')} />;
}

/** Framed Yes/No radio card pair for binary questions. */
export const YesNo = slotted('YesNo', DefaultYesNo, { onValueChange: [1, 'select'] });

/** Framed single-choice or multi-choice option cards with icons and exclusive option support. */
export const ChoiceCards = slotted('ChoiceCards', DefaultChoiceCards, { onValueChange: [1, 'select'] });

/** Roving-focus multi-select checkbox card group with single Tab stop and arrow-key navigation. */
export const CheckCards = slotted('CheckCards', DefaultCheckCards, { onToggle: [2, 'toggle'] });

/** Accessible checkbox control with optional indeterminate state, label, hint, and problem wiring. */
export const Checkbox = slotted('Checkbox', DefaultCheckbox, { onCheckedChange: [1, 'toggle'] });

/** Long-notice consent checkbox styled in body text weight. */
export const Consent = slotted('Consent', DefaultConsent, { onCheckedChange: [1, 'toggle'] });
