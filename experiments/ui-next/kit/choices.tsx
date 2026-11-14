import { Checkbox as Box, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Radio, RadioGroup } from '@ui-sdk/react/radio';
import { Slider as Range, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from '@ui-sdk/react/slider';
import { Switch as Toggle, SwitchThumb } from '@ui-sdk/react/switch';
import { useId } from 'react';
import type { CheckCardsProps } from '@mistriwork/ui/Choices.js';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';
import { Frame } from './Frame';
import { told } from './told';

/* A whole number with thousands separators, as mistri's own slider says one. */
const grouped = (n: number): string => n.toLocaleString('en-US');

export const Checkbox: UiKitSlots['Checkbox'] = (props) => (
  <Frame {...props} check>
    <Box
      id={props.id}
      checked={props.checked}
      disabled={props.disabled}
      required={props.required}
      onCheckedChange={(next, details) => props.onChange(next === true, told('toggle', details))}
    >
      <CheckboxIndicator />
    </Box>
  </Frame>
);

/* A checkbox for a long notice: the paragraph is the label, in the body's weight. */
export const Consent: UiKitSlots['Consent'] = (props) => (
  <Checkbox {...props} className={['consent', props.className].filter(Boolean).join(' ')} />
);

/* Two answers to a question, as a radio group: the arrows move between them and choose. Each radio is named by
   its word, by id, since the word stands beside the radio and not inside it. */
export const YesNo: UiKitSlots['YesNo'] = (props) => {
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
          <label key={answer} data-slot="choice">
            <Radio value={answer} aria-labelledby={`${id}-${answer}`} />
            <span data-slot="choice-label" id={`${id}-${answer}`}>
              {props[answer]}
            </span>
          </label>
        ))}
      </RadioGroup>
    </Frame>
  );
};

/* Several cards, any of them on. Each is a checkbox of its own, so each is a Tab stop: UI SDK's checkboxes do
   not rove, where mistri's own cards share one stop and move by the arrows. */
function Cards(props: CheckCardsProps) {
  const id = useId();
  return (
    <div
      data-slot="check-cards"
      role="group"
      data-fit={props.fit}
      id={props.id}
      aria-labelledby={props['aria-labelledby']}
      aria-describedby={props['aria-describedby']}
      aria-invalid={props['aria-invalid']}
    >
      {props.cards.map((card, index) => (
        <label key={card.key} data-slot="choice" data-kind="check">
          {card.icon ? (
            <span data-slot="choice-icon" aria-hidden="true">
              {card.icon}
            </span>
          ) : null}
          <span data-slot="choice-label" id={`${id}-${index}`}>
            {card.label}
            {card.help ? <span data-slot="choice-hint">{card.help}</span> : null}
          </span>
          <Box
            aria-labelledby={`${id}-${index}`}
            checked={card.on}
            disabled={props.disabled}
            onCheckedChange={(next, details) => props.onToggle(index, next === true, told('toggle', details))}
          >
            <CheckboxIndicator />
          </Box>
        </label>
      ))}
    </div>
  );
}

export const CheckCards: UiKitSlots['CheckCards'] = Cards;

/* Cards with a picture and a word. One choice is a radio group; `multiple` is the check cards. `exclusive` is the
   card that stands alone: choosing it clears the rest, and choosing another clears it. */
export const ChoiceCards: UiKitSlots['ChoiceCards'] = (props) => {
  const id = useId();
  if (props.multiple)
    return (
      <Frame {...props}>
        <Cards
          cards={props.options.map((option) => ({
            key: option.value,
            label: option.label,
            icon: option.icon,
            on: props.value.includes(option.value),
          }))}
          onToggle={(index, on, details) => {
            const value = props.options[index]!.value;
            const say = told('select', details);
            if (value === props.exclusive) return props.onChange(on ? [value] : [], say);
            const rest = props.value.filter((other) => other !== value && other !== props.exclusive);
            props.onChange(
              on ? props.options.map((option) => option.value).filter((other) => other === value || rest.includes(other)) : rest,
              say,
            );
          }}
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
          <label key={option.value} data-slot="choice">
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
};

/* One on/off choice, said as a switch. Busy is not disabled here either: a working switch says aria-disabled and
   refuses the press, keeping the focus. */
export const Switch: UiKitSlots['Switch'] = ({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false,
  busy = false,
  id,
  className,
  ref,
}) => {
  const made = useId();
  const switchId = id ?? made;
  return (
    <span data-slot="switch-row" className={className}>
      <Toggle
        id={switchId}
        ref={ref}
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        aria-disabled={busy || undefined}
        onCheckedChange={(next, details) => {
          if (busy) return details.cancel();
          onCheckedChange?.(next, told('toggle', details));
        }}
      >
        <SwitchThumb />
      </Toggle>
      {label !== undefined || description !== undefined ? (
        <span data-slot="switch-copy">
          {label !== undefined ? <label htmlFor={switchId}>{label}</label> : null}
          {description !== undefined ? <span data-slot="switch-description">{description}</span> : null}
        </span>
      ) : null}
    </span>
  );
};

/* An amount set by a slider and read out above it, the range's ends said under it. */
export const Slider: UiKitSlots['Slider'] = (props) => {
  const say = props.format ?? grouped;
  return (
    <Frame {...props}>
      <div data-slot="slider-readout" aria-hidden="true">
        {say(props.value)}
      </div>
      <Range
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        onValueChange={(next, details) => props.onChange(Number(next), told('slide', details))}
      >
        <SliderControl>
          <SliderTrack>
            <SliderIndicator />
            <SliderThumb id={props.id} aria-valuetext={say(props.value)} />
          </SliderTrack>
        </SliderControl>
      </Range>
      <div data-slot="slider-ends" aria-hidden="true">
        <span>{say(props.min)}</span>
        <span>{say(props.max)}</span>
      </div>
    </Frame>
  );
};
