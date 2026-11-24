/** Action buttons, icon buttons, toggles, segmented controls, toolbars, and bulk-selection bars over UI SDK. */
import * as React from 'react';
import { Button, ButtonLink, type ButtonLinkProps, type ButtonProps, type ButtonSize, type ButtonVariant } from '../Button.js';
import { Toggle as SdkToggle, ToggleGroup as SdkToggleGroup, ToggleIcon as SdkToggleIcon } from '@ui-sdk/react/toggle';
import {
  Toolbar as SdkToolbar,
  ToolbarButton as SdkToolbarButton,
  ToolbarGroup as SdkToolbarGroup,
  ToolbarInput as SdkToolbarInput,
  ToolbarLink as SdkToolbarLink,
  ToolbarSeparator as SdkToolbarSeparator,
} from '@ui-sdk/react/toolbar';
import { Icon } from '../Icon.js';
import { cx, type ControlSize } from '../internal/cx.js';

export { Button, ButtonLink, type ButtonLinkProps, type ButtonProps, type ButtonSize, type ButtonVariant };

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<
  React.ComponentProps<T>,
  'onChange' | 'aria-label' | 'inlist'
> & {
  ariaLabel?: string;
};

/** Props for the `IconButton` square icon-only action button. */
export interface IconButtonProps extends Omit<
  ButtonProps,
  'leadingIcon' | 'trailingIcon' | 'shortcut' | 'loadingLabel' | 'block' | 'children' | 'data-icon-only' | 'iconOnly' | 'ariaLabel'
> {
  /** Required accessible name for the icon-only button. */
  ariaLabel: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

/** Square icon-only button requiring an explicit `ariaLabel`. */
export function IconButton(props: IconButtonProps): React.JSX.Element | null {
  const { icon, children, ariaLabel, loading = false, className, ...rest } = props;
  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'] ?? '';

  return (
    <Button {...rest} ariaLabel={resolvedAriaLabel} loading={loading} iconOnly className={cx('nx-icon-button', className)}>
      {loading ? null : (icon ?? children)}
    </Button>
  );
}

/* ============================================================================
 * Toggle & ToggleGroup
 * ========================================================================== */

/** Surface variant for `Toggle`. */
export type ToggleVariant = 'default' | 'outline' | 'ghost';

/** Props for the `Toggle` two-state press button. */
export interface ToggleProps extends Omit<CleanElementProps<'button'>, 'value'> {
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  value?: string;
  variant?: ToggleVariant;
  size?: ControlSize;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  iconOnly?: boolean;
}

/** Two-state toggle button reporting `onPressedChange`. */
export function Toggle({
  pressed,
  defaultPressed,
  onPressedChange,
  variant = 'default',
  size = 'md',
  leadingIcon,
  trailingIcon,
  iconOnly = false,
  ariaLabel,
  className,
  children,
  ...rest
}: ToggleProps): React.JSX.Element {
  const rawAriaLabel = ariaLabel ?? (rest as { 'aria-label'?: string })['aria-label'];
  return (
    <SdkToggle
      {...rest}
      pressed={pressed}
      defaultPressed={defaultPressed}
      onPressedChange={onPressedChange ? (next) => onPressedChange(next) : undefined}
      aria-label={rawAriaLabel}
      data-variant={variant === 'default' ? undefined : variant}
      data-size={size}
      data-icon-only={iconOnly ? '' : undefined}
      className={cx('nx-toggle', className)}
    >
      {leadingIcon ? <SdkToggleIcon>{leadingIcon}</SdkToggleIcon> : null}
      {children}
      {trailingIcon ? <SdkToggleIcon>{trailingIcon}</SdkToggleIcon> : null}
    </SdkToggle>
  );
}

/** Declarative item option for `ToggleGroup`. */
export interface ToggleGroupItemOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Props for `ToggleGroupItem`. */
export interface ToggleGroupItemProps extends Omit<ToggleProps, 'value'> {
  value: string;
  icon?: React.ReactNode;
}

/** Individual toggle button inside a `ToggleGroup`. */
export function ToggleGroupItem({ icon, leadingIcon, children, ...rest }: ToggleGroupItemProps): React.JSX.Element {
  return (
    <Toggle {...rest} leadingIcon={icon ?? leadingIcon}>
      {children}
    </Toggle>
  );
}

function ToggleIconPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>) {
  return <SdkToggleIcon aria-label={ariaLabel} className={className} {...props} />;
}

/** Props for the `ToggleGroup` single- or multi-toggle button bar. */
export interface ToggleGroupProps<T extends string = string> extends Omit<CleanElementProps<'div'>, 'defaultValue'> {
  items?: ReadonlyArray<ToggleGroupItemOption<T>>;
  value?: T[];
  defaultValue?: T[];
  onValueChange?: (value: T[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  loopFocus?: boolean;
  size?: ControlSize;
}

function ToggleGroupRoot<T extends string = string>({
  items,
  value,
  defaultValue,
  onValueChange,
  multiple,
  disabled,
  orientation,
  loopFocus,
  size = 'md',
  ariaLabel,
  className,
  children,
  ...rest
}: ToggleGroupProps<T>): React.JSX.Element {
  const rawAriaLabel = ariaLabel ?? (rest as { 'aria-label'?: string })['aria-label'];
  return (
    <SdkToggleGroup<T>
      {...rest}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange ? (next) => onValueChange(next) : undefined}
      multiple={multiple}
      disabled={disabled}
      orientation={orientation}
      loop={loopFocus}
      aria-label={rawAriaLabel}
      data-size={size}
      className={cx('nx-toggle-group', className)}
    >
      {items
        ? items.map((item) => {
            const itemAriaLabel = item.ariaLabel ?? (item as { 'aria-label'?: string })['aria-label'];
            return (
              <ToggleGroupItem
                key={item.value}
                value={item.value}
                size={size}
                icon={item.icon}
                disabled={item.disabled}
                ariaLabel={itemAriaLabel}
              >
                {item.label}
              </ToggleGroupItem>
            );
          })
        : children}
    </SdkToggleGroup>
  );
}

/** Grouped bar of related `Toggle` buttons with roving keyboard focus. */
export const ToggleGroup = Object.assign(ToggleGroupRoot, {
  Item: ToggleGroupItem,
  Icon: ToggleIconPart,
});

/* ============================================================================
 * SegmentedControl (Unified Single Family)
 * ========================================================================== */

/** Single exclusive choice in `SegmentedControl`. */
export interface SegmentOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  count?: React.ReactNode;
  /** Accessible name when `label` is non-text or abbreviated. */
  ariaLabel?: string;
  name?: string;
  disabled?: boolean;
}

/** Alias for `SegmentOption`. */
export type SegmentedControlOption<T extends string = string> = SegmentOption<T>;

/** Props for the unified `SegmentedControl` radio pill bar. */
export interface SegmentedControlProps<T extends string = string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  /** Accessible name for the radio group (`ariaLabel` preferred; `label` supported for parity). */
  ariaLabel?: string;
  label?: string;
  size?: ControlSize;
  block?: boolean;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLDivElement>;
}

/** Exclusive radio pill bar with arrow-key roving focus that folds to a native `<select>` past four options on narrow viewports. */
export function SegmentedControl<T extends string = string>(props: SegmentedControlProps<T>): React.JSX.Element {
  const {
    options,
    value: controlledValue,
    defaultValue,
    onValueChange,
    ariaLabel,
    label,
    size = 'md',
    block = false,
    disabled = false,
    orientation = 'horizontal',
    className,
    style,
    ref,
  } = props;

  const legacyOnChange = (props as unknown as { onChange?: (value: T) => void }).onChange;
  const rawAriaLabel = ariaLabel ?? label ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const [uncontrolled, setUncontrolled] = React.useState<T | undefined>(() => defaultValue ?? options[0]?.value);
  const currentValue = controlledValue !== undefined ? controlledValue : uncontrolled;

  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const firstEnabledIdx = Math.max(
    0,
    options.findIndex((opt) => !opt.disabled),
  );
  const activeIdx = options.findIndex((opt) => opt.value === currentValue && !opt.disabled);
  const tabStopIdx = activeIdx >= 0 ? activeIdx : firstEnabledIdx;

  const commit = (next: T) => {
    if (disabled) return;
    if (controlledValue === undefined) setUncontrolled(next);
    if (onValueChange) onValueChange(next);
    else legacyOnChange?.(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled || options.length === 0) return;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;

    let nextIndex = -1;
    if (step !== 0) {
      for (let i = 1; i <= options.length; i++) {
        const candidate = (index + step * i + options.length) % options.length;
        if (!options[candidate]?.disabled) {
          nextIndex = candidate;
          break;
        }
      }
    } else if (event.key === 'Home') {
      nextIndex = options.findIndex((opt) => !opt.disabled);
    } else if (event.key === 'End') {
      for (let i = options.length - 1; i >= 0; i--) {
        if (!options[i]?.disabled) {
          nextIndex = i;
          break;
        }
      }
    }

    if (nextIndex < 0) return;
    event.preventDefault();
    const chosen = options[nextIndex];
    if (!chosen) return;
    commit(chosen.value);
    buttons.current[nextIndex]?.focus();
  };

  const said = (option: SegmentOption<T>) => {
    const base = typeof option.label === 'string' ? option.label : (option.ariaLabel ?? option.name ?? option.value);
    return `${base}${option.count === undefined || option.count === null ? '' : ` (${String(option.count)})`}`;
  };

  const folds = options.length > 4;

  return (
    <>
      <div
        ref={ref}
        role="radiogroup"
        aria-label={rawAriaLabel}
        aria-orientation={orientation}
        aria-disabled={disabled || undefined}
        data-size={size}
        data-block={block ? '' : undefined}
        data-orientation={orientation}
        className={cx(
          'kit-segmented nx-segmented-control',
          (size === 'sm' || size === 'xs') && 'kit-segmented-compact',
          folds && 'kit-segmented-folds',
          className,
        )}
        style={style}
      >
        {options.map((option, index) => {
          const itemDisabled = disabled || Boolean(option.disabled);
          const checked = option.value === currentValue;
          return (
            <button
              key={option.value}
              ref={(node) => {
                buttons.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={option.ariaLabel ?? option.name}
              disabled={itemDisabled}
              tabIndex={index === tabStopIdx ? 0 : -1}
              data-checked={checked ? '' : undefined}
              className="kit-segment nx-segmented-item"
              onClick={() => {
                if (!itemDisabled) commit(option.value);
              }}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {option.icon ? (
                <span className="nx-segmented-icon" aria-hidden="true">
                  {option.icon}
                </span>
              ) : null}
              <span>{option.label}</span>
              {option.count !== undefined && option.count !== null && (
                <span className="kit-segment-count nx-segmented-count">{option.count}</span>
              )}
            </button>
          );
        })}
      </div>
      {folds && (
        <select
          data-slot="input"
          className={cx('kit-segmented-pick', className)}
          aria-label={rawAriaLabel}
          disabled={disabled}
          value={options.some((option) => option.value === currentValue) ? currentValue : ''}
          onChange={(event) => commit(event.target.value as T)}
        >
          {!options.some((option) => option.value === currentValue) && <option value="" disabled hidden />}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {said(option)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

/* ============================================================================
 * Toolbar
 * ========================================================================== */

/** Props for the `Toolbar` action strip. */
export interface ToolbarProps extends CleanElementProps<'div'> {
  orientation?: 'horizontal' | 'vertical';
  disabled?: boolean;
  loopFocus?: boolean;
  size?: ControlSize;
  variant?: 'surface' | 'subtle' | 'plain';
}

/** Props for `ToolbarButton`. */
export interface ToolbarButtonProps extends CleanElementProps<'button'> {
  variant?: ButtonVariant;
  size?: ControlSize;
  iconOnly?: boolean;
}

/** Action button participating in a `Toolbar`'s roving keyboard focus. */
export function ToolbarButton({
  variant = 'ghost',
  size = 'sm',
  iconOnly = false,
  ariaLabel,
  className,
  ...rest
}: ToolbarButtonProps): React.JSX.Element | null {
  return (
    <SdkToolbarButton
      {...rest}
      aria-label={ariaLabel}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? '' : undefined}
      className={cx('nx-toolbar-button', className)}
    />
  );
}

/** Props for `ToolbarLink`. */
export interface ToolbarLinkProps extends CleanElementProps<'a'> {
  variant?: ButtonVariant;
  size?: ControlSize;
}

/** Navigation link participating in a `Toolbar`'s roving keyboard focus. */
export function ToolbarLink({ variant = 'ghost', size = 'sm', ariaLabel, className, ...rest }: ToolbarLinkProps): React.JSX.Element | null {
  return (
    <SdkToolbarLink {...rest} aria-label={ariaLabel} data-variant={variant} data-size={size} className={cx('nx-toolbar-link', className)} />
  );
}

/** Props for `Toolbar.Group`. */
export type ToolbarGroupProps = CleanElementProps<'div'>;

function ToolbarGroupPart({ ariaLabel, className, ...props }: ToolbarGroupProps) {
  return <SdkToolbarGroup aria-label={ariaLabel} className={className} {...props} />;
}

/** Props for `Toolbar.Separator`. */
export type ToolbarSeparatorProps = CleanElementProps<'div'>;

function ToolbarSeparatorPart({ ariaLabel, className, ...props }: ToolbarSeparatorProps) {
  return <SdkToolbarSeparator aria-label={ariaLabel} className={className} {...props} />;
}

/** Props for `Toolbar.Input`. */
export interface ToolbarInputProps extends CleanElementProps<'input'> {
  onValueChange?: (value: string) => void;
}

function ToolbarInputPart({ ariaLabel, onValueChange, className, ...props }: ToolbarInputProps) {
  return (
    <SdkToolbarInput
      {...props}
      aria-label={ariaLabel}
      onChange={onValueChange ? (e) => onValueChange(e.target.value) : undefined}
      className={className}
    />
  );
}

function ToolbarRoot({ size = 'sm', variant = 'surface', ariaLabel, className, ...rest }: ToolbarProps): React.JSX.Element {
  return <SdkToolbar {...rest} aria-label={ariaLabel} data-size={size} data-variant={variant} className={cx('nx-toolbar', className)} />;
}

/** Accessible WAI-ARIA toolbar strip with grouped controls and arrow-key roving focus. */
export const Toolbar = Object.assign(ToolbarRoot, {
  Button: ToolbarButton,
  Link: ToolbarLink,
  Group: ToolbarGroupPart,
  Separator: ToolbarSeparatorPart,
  Input: ToolbarInputPart,
});

/* ============================================================================
 * BulkActionBar
 * ========================================================================== */

/** Props for the `BulkActionBar` multi-selection command bar. */
export interface BulkActionBarProps extends CleanElementProps<'div'> {
  floating?: boolean;
  open?: boolean;
  selectedCount?: number;
  label?: React.ReactNode;
  onClearSelection?: () => void;
  clearLabel?: string;
  children: React.ReactNode;
}

/** Contextual action bar shown when one or more collection items are selected. */
export function BulkActionBar({
  floating = false,
  open,
  selectedCount,
  label,
  onClearSelection,
  clearLabel = 'Clear selection',
  ariaLabel,
  className,
  children,
  ...rest
}: BulkActionBarProps): React.JSX.Element | null {
  const isVisible = open ?? (selectedCount === undefined ? true : selectedCount > 0);
  if (!isVisible) return null;

  const summaryText = label ?? (selectedCount !== undefined ? `${selectedCount} ${selectedCount === 1 ? 'item' : 'items'} selected` : null);

  return (
    <div
      role="region"
      aria-label={ariaLabel ?? (typeof summaryText === 'string' ? summaryText : 'Bulk actions')}
      data-slot="action-bar"
      data-floating={floating ? '' : undefined}
      className={cx('nx-action-bar', className)}
      {...rest}
    >
      {(selectedCount !== undefined || summaryText !== null || onClearSelection) && (
        <div className="nx-action-bar-status">
          {selectedCount !== undefined && <span className="nx-action-bar-count">{selectedCount}</span>}
          {summaryText !== null && <span className="nx-action-bar-label">{summaryText}</span>}
          {onClearSelection && (
            <button
              type="button"
              onClick={onClearSelection}
              aria-label={clearLabel}
              title={clearLabel}
              className="nx-action-bar-clear nx-focusable"
            >
              <Icon name="x" size={13} weight="bold" />
            </button>
          )}
          <span className="nx-action-bar-divider" aria-hidden="true" />
        </div>
      )}
      <div className="nx-action-bar-actions">{children}</div>
    </div>
  );
}
