/**
 * A switch: one on/off choice, said as a switch, not a checkbox. Over Base
 * UI's Switch, which gives it the role, the keyboard (Space toggles, as a
 * checkbox does) and the checked state; the label beside it is a click
 * target too, and a description under it never is. Controlled with
 * `checked`/`onCheckedChange`, uncontrolled with `defaultChecked`.
 * Busy is not disabled here either (Button.tsx): a disabled switch drops
 * the focus it holds, so a switch that is working says `aria-disabled`
 * and refuses the press itself.
 */
import { useId, type ReactNode, type Ref } from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';

export interface SwitchProps {
  /** The label beside the switch; its click toggles, as the switch's own does. */
  label?: ReactNode;
  /** A line under the label, in the muted ink, never a click target. */
  description?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  /** Base UI reports the reason second; the caller's claim is the state, so the reason is untyped here. */
  onCheckedChange?: (checked: boolean, event: unknown) => void;
  disabled?: boolean;
  /** Working: pressed once already. Says so and refuses another press, keeping the focus. */
  busy?: boolean;
  id?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

export function SwitchControl({
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
     a generated one, never Base UI's own, which the label cannot know. */
  const generatedId = useId();
  const switchId = id ?? generatedId;
  return (
    <span className={['ui-switch-row', className].filter(Boolean).join(' ')}>
      <BaseSwitch.Root
        id={switchId}
        ref={ref}
        className="ui-switch"
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        aria-disabled={busy || undefined}
        onCheckedChange={(next, event) => {
          if (busy) return;
          onCheckedChange?.(next, event);
        }}
      >
        <BaseSwitch.Thumb className="ui-switch-thumb" />
      </BaseSwitch.Root>
      {label !== undefined || description !== undefined ? (
        <span className="ui-switch-copy">
          {label !== undefined ? (
            <label htmlFor={switchId} className="ui-switch-label">
              {label}
            </label>
          ) : null}
          {description !== undefined ? <span className="ui-switch-description">{description}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/** The short name, as the other primitives export theirs. */
export const Switch = SwitchControl;
