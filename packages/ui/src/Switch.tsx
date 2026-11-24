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
import type { ControlSize } from './internal/cx.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

/** Props for the `Switch` toggle control. */
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
  loading?: boolean;
  size?: ControlSize;
  ariaLabel?: string;
  controlPosition?: 'start' | 'end';
  wrapperClassName?: string;
  id?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

function DefaultSwitch(props: SwitchProps) {
  const {
    label,
    description,
    checked,
    defaultChecked,
    onCheckedChange,
    disabled = false,
    loading = false,
    size,
    ariaLabel,
    controlPosition = 'start',
    wrapperClassName,
    id,
    className,
    ref,
  } = props;
  const legacyBusy = Boolean((props as { busy?: boolean }).busy);
  const legacyAriaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined;
  const isLoading = loading || legacyBusy;
  const resolvedAriaLabel = ariaLabel ?? legacyAriaLabel;

  const generatedId = useId();
  const switchId = id ?? generatedId;
  const toggle = (
    <Toggle
      id={switchId}
      ref={ref}
      checked={checked}
      defaultChecked={defaultChecked}
      disabled={disabled}
      data-size={size}
      data-busy={isLoading ? '' : undefined}
      aria-busy={isLoading || undefined}
      aria-disabled={isLoading || undefined}
      aria-label={label === undefined ? resolvedAriaLabel : ariaLabel}
      onCheckedChange={(next, details) => {
        if (isLoading) return details.cancel();
        onCheckedChange?.(next, told('toggle', details));
      }}
    >
      <SwitchThumb />
    </Toggle>
  );
  const copy =
    label !== undefined || description !== undefined ? (
      <span data-slot="switch-copy">
        {label !== undefined ? <label htmlFor={switchId}>{label}</label> : null}
        {description !== undefined ? <span data-slot="switch-description">{description}</span> : null}
      </span>
    ) : null;
  const rowClassName = [wrapperClassName, className].filter(Boolean).join(' ') || undefined;
  return (
    <span data-slot="switch-row" data-control-position={controlPosition === 'end' ? 'end' : undefined} className={rowClassName}>
      {controlPosition === 'end' ? (
        <>
          {copy}
          {toggle}
        </>
      ) : (
        <>
          {toggle}
          {copy}
        </>
      )}
    </span>
  );
}

/** Accessible boolean switch control with label, description, and focus-preserving loading state. */
export const Switch = slotted('Switch', DefaultSwitch, { onCheckedChange: [1, 'toggle'] });
