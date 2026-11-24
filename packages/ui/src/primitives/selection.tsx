/** Single and multi-value selection controls: checkboxes, radio groups, choice cards, selects, switches, and ratings. */
import * as React from 'react';
import { CheckboxGroup as SdkCheckboxGroup } from '@ui-sdk/react/checkbox';
import { Radio as SdkRadio, RadioGroup as SdkRadioGroup, RadioIndicator as SdkRadioIndicator } from '@ui-sdk/react/radio';
import { Rating as SdkRating, RatingItem as SdkRatingItem } from '@ui-sdk/react/rating';
import {
  CheckCards,
  Checkbox,
  ChoiceCards,
  Consent,
  YesNo,
  type CheckCard,
  type CheckCardsProps,
  type CheckboxProps,
  type ChoiceCardsProps,
  type ChoiceOption,
  type ConsentProps,
  type YesNoProps,
} from '../Choices.js';
import {
  Dropdown,
  MultiDropdown,
  type DropdownAction,
  type DropdownChange,
  type DropdownItem,
  type DropdownProps,
  type MultiDropdownProps,
} from '../Dropdown.js';
import { Icon } from '../Icon.js';
import { MultiSelect, Select, type MultiSelectProps, type SelectOption, type SelectProps } from '../Select.js';
import { Slider, type SliderProps } from '../Slider.js';
import { Switch, type SwitchProps } from '../Switch.js';
import { Typeahead, type TypeaheadProps, type TypeaheadReason } from '../Typeahead.js';
import { cx, type ControlSize } from '../internal/cx.js';
import { wrapWithField, type FieldFrameProps } from './fieldShell.js';

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<
  React.ComponentProps<T>,
  'onChange' | 'aria-label' | 'inlist'
> & {
  ariaLabel?: string;
};

/* ============================================================================
 * CheckboxGroup (with canonical slotted Checkbox & Consent)
 * ========================================================================== */

/** Single option item for `CheckboxGroup`. */
export interface CheckboxOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}

/** Props for the `CheckboxGroup` multi-selection field. */
export interface CheckboxGroupProps<T extends string = string> extends Omit<CleanElementProps<'div'>, 'defaultValue'>, FieldFrameProps {
  options?: ReadonlyArray<CheckboxOption<T>>;
  value?: T[];
  defaultValue?: T[];
  onValueChange?: (value: T[]) => void;
  allValues?: T[];
  name?: string;
  disabled?: boolean;
  orientation?: 'vertical' | 'horizontal';
  fieldClassName?: string;
}

function CheckboxGroupRoot<T extends string = string>(props: CheckboxGroupProps<T>): React.JSX.Element {
  const {
    options,
    value,
    defaultValue,
    onValueChange,
    allValues,
    orientation = 'vertical',
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    fieldClassName,
    disabled,
    name,
    ariaLabel,
    className,
    children,
    ...rest
  } = props;

  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;

  const groupControl = (
    <SdkCheckboxGroup<T>
      {...rest}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange ? (next) => onValueChange(next) : undefined}
      allValues={allValues}
      disabled={disabled}
      required={required}
      name={name}
      aria-label={resolvedAriaLabel}
      data-orientation={orientation}
      className={cx('nx-checkbox-group', className)}
    >
      {options
        ? options.map((opt) => (
            <Checkbox key={opt.value} value={opt.value} label={opt.label} description={opt.description} disabled={opt.disabled} />
          ))
        : children}
    </SdkCheckboxGroup>
  );

  return wrapWithField(groupControl, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: Boolean(resolvedError),
    fieldClassName,
  });
}

/** Multi-checkbox field group reporting `onValueChange` with the array of checked values. */
export const CheckboxGroup = Object.assign(CheckboxGroupRoot, {
  Item: Checkbox,
});

/* ============================================================================
 * RadioGroup
 * ========================================================================== */

/** Single option item for `RadioGroup`. */
export interface RadioOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}

/** Props for `RadioItem`. */
export interface RadioItemProps extends Omit<CleanElementProps<'span'>, 'children'> {
  value: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  label?: React.ReactNode;
  description?: React.ReactNode;
  wrapperClassName?: string;
  children?: React.ReactNode;
}

/** Single radio dot option with optional label and description row. */
export function RadioItem({
  value,
  label,
  description,
  disabled,
  readOnly,
  required,
  ariaLabel,
  className,
  wrapperClassName,
  children,
  ...rest
}: RadioItemProps): React.JSX.Element | null {
  const resolvedAriaLabel = ariaLabel ?? (rest as { 'aria-label'?: string })['aria-label'];

  const dot = (
    <SdkRadio
      {...({
        ...rest,
        value,
        disabled,
        readOnly,
        required,
        'data-readonly': readOnly ? '' : undefined,
        'aria-label': resolvedAriaLabel,
        className: cx('nx-radio', className),
      } as unknown as React.ComponentProps<typeof SdkRadio>)}
    >
      {children ?? <SdkRadioIndicator className="nx-radio-indicator" />}
    </SdkRadio>
  );

  if (label === undefined && description === undefined) {
    return dot;
  }

  return (
    <label data-disabled={disabled ? '' : undefined} className={cx('nx-check-row', wrapperClassName)}>
      {dot}
      <span className="nx-check-copy">
        {label !== undefined ? <span className="nx-check-label">{label}</span> : null}
        {description !== undefined ? <span className="nx-check-description">{description}</span> : null}
      </span>
    </label>
  );
}

function RadioDotPart({
  value,
  disabled,
  ariaLabel,
  className,
  ...props
}: CleanElementProps<'span'> & { value: string; disabled?: boolean }) {
  return (
    <SdkRadio
      {...({
        ...props,
        value,
        disabled,
        'aria-label': ariaLabel,
        className: cx('nx-radio', className),
      } as unknown as React.ComponentProps<typeof SdkRadio>)}
    />
  );
}

function RadioIndicatorPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>) {
  return <SdkRadioIndicator aria-label={ariaLabel} className={cx('nx-radio-indicator', className)} {...props} />;
}

/** Props for the `RadioGroup` single-selection field. */
export interface RadioGroupProps<T extends string = string> extends Omit<CleanElementProps<'div'>, 'defaultValue'>, FieldFrameProps {
  options?: ReadonlyArray<RadioOption<T>>;
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  orientation?: 'vertical' | 'horizontal';
  fieldClassName?: string;
}

function RadioGroupRoot<T extends string = string>(props: RadioGroupProps<T>): React.JSX.Element {
  const {
    options,
    value,
    defaultValue,
    onValueChange,
    orientation = 'vertical',
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    fieldClassName,
    disabled,
    readOnly,
    name,
    ariaLabel,
    className,
    children,
    ...rest
  } = props;

  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;

  const groupControl = (
    <SdkRadioGroup<T>
      {...rest}
      value={value}
      defaultValue={defaultValue}
      onValueChange={
        onValueChange
          ? (next) => {
              if (next !== null) onValueChange(next);
            }
          : undefined
      }
      disabled={disabled}
      readOnly={readOnly}
      required={required}
      name={name}
      aria-label={resolvedAriaLabel}
      data-orientation={orientation}
      className={cx('nx-radio-group', className)}
    >
      {options
        ? options.map((opt) => (
            <RadioItem key={opt.value} value={opt.value} label={opt.label} description={opt.description} disabled={opt.disabled} />
          ))
        : children}
    </SdkRadioGroup>
  );

  return wrapWithField(groupControl, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: Boolean(resolvedError),
    fieldClassName,
  });
}

/** Exclusive radio button group reporting `onValueChange` with arrow-key roving focus. */
export const RadioGroup = Object.assign(RadioGroupRoot, {
  Item: RadioItem,
  Radio: RadioDotPart,
  Indicator: RadioIndicatorPart,
});

/* ============================================================================
 * Rating
 * ========================================================================== */

/** Props for the `Rating` star-score selector. */
export interface RatingProps extends Omit<CleanElementProps<'div'>, 'defaultValue' | 'children'>, FieldFrameProps {
  value?: number | null;
  defaultValue?: number | null;
  onValueChange?: (value: number | null) => void;
  max?: number;
  allowHalf?: boolean;
  allowClear?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  name?: string;
  formatValueLabel?: (value: number, max: number) => string;
  size?: ControlSize;
  showValue?: boolean;
  fieldClassName?: string;
  children?: React.ReactNode;
}

const RATING_ICON_SIZES: Record<ControlSize, number> = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
};

function RatingItemPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>) {
  return <SdkRatingItem aria-label={ariaLabel} className={cx('nx-rating-item', className)} {...props} />;
}

function RatingRoot(props: RatingProps): React.JSX.Element {
  const {
    size = 'md',
    showValue = false,
    max = 5,
    allowHalf,
    allowClear,
    value,
    defaultValue,
    onValueChange,
    formatValueLabel,
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    fieldClassName,
    disabled,
    readOnly,
    name,
    ariaLabel,
    className,
    children,
    ...rest
  } = props;

  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const legacyGetValueLabel = (props as unknown as { getValueLabel?: (value: number, max: number) => string }).getValueLabel;
  const resolvedFormatLabel = formatValueLabel ?? legacyGetValueLabel;
  const resolvedError = problem ?? error;

  const [internalScore, setInternalScore] = React.useState<number | null>(() => value ?? defaultValue ?? null);
  const activeScore = value !== undefined ? value : internalScore;
  const iconPx = RATING_ICON_SIZES[size];

  const handleChange = React.useCallback(
    (next: number | null) => {
      if (value === undefined) {
        setInternalScore(next);
      }
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const ratingControl = (
    <div className="nx-rating-row" data-size={size}>
      <SdkRating
        {...rest}
        max={max}
        {...({ allowHalf, allowClear } as Record<string, unknown>)}
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleChange}
        getValueLabel={resolvedFormatLabel ? (v) => resolvedFormatLabel(v, max) : undefined}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        name={name}
        aria-label={resolvedAriaLabel}
        className={cx('nx-rating', className)}
      >
        {children ?? (
          <SdkRatingItem className="nx-rating-item">
            {(state) => (
              <span
                className="nx-rating-star"
                data-filled={state.fill > 0 ? '' : undefined}
                data-highlighted={state.highlighted ? '' : undefined}
              >
                <Icon name="star" size={iconPx} weight="regular" className="nx-rating-star-empty" />
                {state.fill > 0 ? (
                  <span className="nx-rating-star-fill" style={{ width: `${Math.round(state.fill * 100)}%` }} aria-hidden="true">
                    <Icon name="star" size={iconPx} weight="bold" />
                  </span>
                ) : null}
              </span>
            )}
          </SdkRatingItem>
        )}
      </SdkRating>
      {showValue ? <span className="nx-rating-readout">{activeScore !== null ? `${activeScore} / ${max}` : `— / ${max}`}</span> : null}
    </div>
  );

  return wrapWithField(ratingControl, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: Boolean(resolvedError),
    fieldClassName,
  });
}

/** Star rating selector supporting half-star precision, keyboard arrows, and numeric readout. */
export const Rating = Object.assign(RatingRoot, {
  Root: RatingRoot,
  Item: RatingItemPart,
});

export {
  CheckCards,
  Checkbox,
  ChoiceCards,
  Consent,
  Dropdown,
  MultiDropdown,
  MultiSelect,
  Select,
  Slider,
  Switch,
  Typeahead,
  YesNo,
  type CheckCard,
  type CheckCardsProps,
  type CheckboxProps,
  type ChoiceCardsProps,
  type ChoiceOption,
  type ConsentProps,
  type DropdownAction,
  type DropdownChange,
  type DropdownItem,
  type DropdownProps,
  type MultiDropdownProps,
  type MultiSelectProps,
  type SelectOption,
  type SelectProps,
  type SliderProps,
  type SwitchProps,
  type TypeaheadProps,
  type TypeaheadReason,
  type YesNoProps,
};
