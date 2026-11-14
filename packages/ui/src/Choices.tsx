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
import { useId, type AriaAttributes, type ComponentProps, type ReactNode } from 'react';
import type { FieldFrame } from './fieldFrame.js';
import type { ChangeDetails } from './changeDetails.js';
import { Frame } from './internal/Frame.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

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
  onChange: (value: 'yes' | 'no', details: ChangeDetails<'select'>) => void;
  /** The two words, in the caller's language. */
  yes: string;
  no: string;
}

/** Two buttons answering a question. */
/* Each radio is named by its word, by id, since the word stands beside the radio and not inside it. */
function DefaultYesNo(props: YesNoProps): ReactNode {
  const id = useId();
  return (
    <Frame {...props}>
      <RadioGroup
        data-kind="cards"
        data-fit="pair"
        value={props.value === '' ? null : props.value}
        onValueChange={(next, details) => {
          if (next === 'yes' || next === 'no') props.onChange(next, told('select', details));
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

export interface ChoiceCardsProps extends FieldFrame {
  options: ChoiceOption[];
  value: string[];
  onChange: (value: string[], details: ChangeDetails<'select'>) => void;
  /** Several may be on. */
  multiple?: boolean;
  /** The card that stands alone ("None"): choosing it clears the rest, and choosing another clears it. */
  exclusive?: string;
}

/** Cards with an icon, a label and a box. One choice is a radio group; `multiple` a group of checkboxes. */
function DefaultChoiceCards(props: ChoiceCardsProps): ReactNode {
  const id = useId();
  if (props.multiple)
    return (
      <Frame {...props}>
        {/* The cards are the field's control: it hands them their id, what names and describes them and whether
            they hold a problem, as it does a box. Drawn through the slot, so a kit's cards stand here too. */}
        <FieldControl
          render={
            <CheckCards
              cards={props.options.map((option) => ({
                key: option.value,
                label: option.label,
                icon: option.icon,
                on: props.value.includes(option.value),
              }))}
              onToggle={(index, on, details) => {
                const value = props.options[index]!.value;
                const say: ChangeDetails<'select'> = { ...details, reason: 'select' };
                if (value === props.exclusive) return props.onChange(on ? [value] : [], say);
                const rest = props.value.filter((other) => other !== value && other !== props.exclusive);
                props.onChange(
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
        data-kind="cards"
        value={props.value[0] ?? null}
        onValueChange={(next, details) => props.onChange(next === null ? [] : [String(next)], told('select', details))}
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

export interface CheckCardsProps {
  cards: readonly CheckCard[];
  /** The card at `index` turned on or off. */
  onToggle: (index: number, on: boolean, details: ChangeDetails<'toggle'>) => void;
  id?: string;
  disabled?: boolean;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  /** How short every card's words are, so a wide page can set them side by side (`data-fit`; the page's stylesheet
   * decides what that means): `short` is a label alone, `brief` a label and a line that fit half a column. */
  fit?: 'short' | 'brief';
}

/* Several cards, any of them on, as a UI SDK primitive: which are on is a value with a change. Each card is the
   checkbox, saying `aria-checked`, and the square at its end is its picture. UI SDK's own checkbox is a Tab stop
   each and says so in its slot, which a caller cannot take back; so the card is drawn here. */
type CheckCardsReason = 'press';

type CheckCardsOptions = {
  /* The cards, in order, by their keys. */
  keys: string[];
  /* The keys of the cards that are on. */
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
    /* The card the keyboard was last on. */
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
      /* Where a key takes the keyboard from a card, round the ends, or nowhere. */
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
            // Space is the box's own key; the page does not scroll under it.
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

/**
 * Several cards, any of them on: full-width cards, each an icon, its words and a square at its end that fills when it
 * is on. They are one group to the keyboard, as radios are — one Tab stop (the card last moved to, else the first one
 * on, else the first), the arrows and Home and End move between them, and Space turns the one in hand on or off — and
 * each is a `checkbox` saying `aria-checked`, so a screen reader hears "checked" as it moves.
 */
/* Whatever else it is handed goes on the group: a field that takes the cards as its control (ChoiceCards) gives
   them a ref and its own attributes beside the props a caller names. */
function DefaultCheckCards(props: CheckCardsProps): ReactNode {
  const { cards, onToggle, disabled, fit, ...rest } = props as CheckCardsProps &
    Omit<ComponentProps<'div'>, keyof CheckCardsProps | 'children'>;
  return (
    <cardParts.Root
      {...rest}
      data-fit={fit}
      keys={cards.map((card) => card.key)}
      value={cards.filter((card) => card.on).map((card) => card.key)}
      disabled={disabled}
      onValueChange={(next, details) => {
        // The primitive says the whole list; the caller hears the one card that moved.
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

export interface CheckboxProps extends Omit<FieldFrame, 'label'> {
  checked: boolean;
  onChange: (on: boolean, details: ChangeDetails<'toggle'>) => void;
  /** The text beside the box; it is the label, so it is a click target too. */
  label: ReactNode;
  disabled?: boolean;
}

/** A checkbox beside its text. */
function DefaultCheckbox(props: CheckboxProps): ReactNode {
  return (
    <Frame {...props} check>
      <Box
        id={props.id}
        checked={props.checked}
        disabled={props.disabled}
        aria-required={props.required || undefined}
        onCheckedChange={(next, details) => props.onChange(next === true, told('toggle', details))}
      >
        <CheckboxIndicator />
      </Box>
    </Frame>
  );
}

/** A checkbox for a long notice: the paragraph is the label, in the body's weight. */
function DefaultConsent(props: CheckboxProps): ReactNode {
  return <Checkbox {...props} className={['consent', props.className].filter(Boolean).join(' ')} />;
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const YesNo = slotted('YesNo', DefaultYesNo, { onChange: [1, 'select'] });
export const ChoiceCards = slotted('ChoiceCards', DefaultChoiceCards, { onChange: [1, 'select'] });
export const CheckCards = slotted('CheckCards', DefaultCheckCards, { onToggle: [2, 'toggle'] });
export const Checkbox = slotted('Checkbox', DefaultCheckbox, { onChange: [1, 'toggle'] });
export const Consent = slotted('Consent', DefaultConsent, { onChange: [1, 'toggle'] });
