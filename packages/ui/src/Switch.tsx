/**
 * A switch: one on/off choice, said as a switch, not a checkbox. Over UI
 * SDK's Switch, which gives it the role, the keyboard (Space toggles, as a
 * checkbox does) and the checked state; the label beside it is a click
 * target too, and a description under it never is. Controlled with
 * `checked`/`onCheckedChange`, uncontrolled with `defaultChecked`.
 * Busy is not disabled here either (Button.tsx): a disabled switch drops
 * the focus it holds, so a switch that is working says `aria-disabled`
 * and refuses the press itself.
 */
import { Switch as Toggle, SwitchThumb } from '@ui-sdk/react/switch';
import { useId, type ReactNode, type Ref } from 'react';
import type { ChangeDetails } from './changeDetails.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

export interface SwitchProps {
  /** The label beside the switch; its click toggles, as the switch's own does. */
  label?: ReactNode;
  /** A line under the label, in the muted ink, never a click target. */
  description?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean, details: ChangeDetails<'toggle'>) => void;
  disabled?: boolean;
  /** Working: pressed once already. Says so and refuses another press, keeping the focus. */
  busy?: boolean;
  id?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

function DefaultSwitch({
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
}: SwitchProps) {
  /* The label names the switch by its id; a caller who gives none gets
     a generated one, never UI SDK's own, which the label cannot know. */
  const generatedId = useId();
  const switchId = id ?? generatedId;
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
          // Refused in UI SDK's own words, so an uncontrolled switch does not move either.
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
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Switch = slotted('Switch', DefaultSwitch, { onCheckedChange: [1, 'toggle'] });
