/** Calendar grids, date pickers (single and range), wall-clock time inputs, color pickers, and trigger menus. */
import * as React from 'react';
import { addDays, endOfMonth, startOfMonth, todayDate, type ISODate } from '@ui-sdk/react/date';
import { TimeInput as SdkTimeInput, TimeInputSegment as SdkTimeInputSegment } from '@ui-sdk/react/time-input';
import {
  Calendar as SdkCalendar,
  CalendarDay as SdkCalendarDay,
  CalendarGrid as SdkCalendarGrid,
  CalendarHeading as SdkCalendarHeading,
  CalendarMonthSelect as SdkCalendarMonthSelect,
  CalendarNext as SdkCalendarNext,
  CalendarPrevious as SdkCalendarPrevious,
  CalendarWeekday as SdkCalendarWeekday,
  CalendarWeekdays as SdkCalendarWeekdays,
  CalendarWeeks as SdkCalendarWeeks,
  CalendarYearSelect as SdkCalendarYearSelect,
} from '@ui-sdk/react/calendar';
import {
  DatePicker as SdkDatePicker,
  DatePickerClear as SdkDatePickerClear,
  DatePickerContent as SdkDatePickerContent,
  DatePickerInput as SdkDatePickerInput,
  DatePickerPreset as SdkDatePickerPreset,
  DatePickerTrigger as SdkDatePickerTrigger,
} from '@ui-sdk/react/date-picker';
import {
  ColorPicker as SdkColorPicker,
  ColorPickerArea as SdkColorPickerArea,
  ColorPickerAreaCanvas as SdkColorPickerAreaCanvas,
  ColorPickerAreaThumb as SdkColorPickerAreaThumb,
  ColorPickerEyeDropper as SdkColorPickerEyeDropper,
  ColorPickerInput as SdkColorPickerInput,
  ColorPickerSlider as SdkColorPickerSlider,
  ColorPickerSliderThumb as SdkColorPickerSliderThumb,
  ColorPickerSwatch as SdkColorPickerSwatch,
  ColorPickerSwatches as SdkColorPickerSwatches,
  ColorPickerSwatchItem as SdkColorPickerSwatchItem,
} from '@ui-sdk/react/color-picker';
import {
  TriggerMenu as SdkTriggerMenu,
  TriggerMenuContent as SdkTriggerMenuContent,
  TriggerMenuEmpty as SdkTriggerMenuEmpty,
  TriggerMenuHint as SdkTriggerMenuHint,
  TriggerMenuInput as SdkTriggerMenuInput,
  TriggerMenuList as SdkTriggerMenuList,
  TriggerMenuStatus as SdkTriggerMenuStatus,
  type TriggerDefinition as SdkTriggerDefinition,
} from '@ui-sdk/react/trigger-menu';
import { Icon } from '../Icon.js';
import { cx, isEmptyStateSpec, type ControlSize, type EmptyStateSpec } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';
import { PHONE_QUERY } from '../internal/ruler.js';
import { FieldControlBridge, wrapWithField, type FieldFrameProps } from './fieldShell.js';

/** Clock display cycle (`12` or `24` hour). */
export type HourCycle = 12 | 24;

/** Precision unit for `TimeInput`. */
export type TimeInputGranularity = 'hour' | 'minute' | 'second';

/** Selected date value controlled by `DatePicker` (`YYYY-MM-DD`, range tuple, or `null`). */
export type DatePickerValue = string | [string, string] | string[] | null;

function renderEmptyNode(empty: EmptyStateSpec | React.ReactNode): React.ReactNode {
  if (isEmptyStateSpec(empty)) {
    return (
      <div className="nx-empty-inline">
        <div className="nx-empty-inline-title">{empty.title}</div>
        {empty.body !== undefined && <div className="nx-empty-inline-body">{empty.body}</div>}
        {empty.action !== undefined && <div className="nx-empty-inline-action">{empty.action}</div>}
      </div>
    );
  }
  return empty;
}

function usePhoneViewport(): boolean {
  const [phone, setPhone] = React.useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY).matches : false,
  );
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return phone;
}

/* ============================================================================
 * TimeInput
 * ========================================================================== */

/** Props for the `TimeInput` segmented wall-clock field. */
export interface TimeInputProps extends FieldFrameProps {
  id?: string;
  name?: string;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
  min?: string;
  max?: string;
  granularity?: TimeInputGranularity;
  hourCycle?: HourCycle;
  locale?: string;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  size?: ControlSize;
  showIcon?: boolean;
  invalid?: boolean;
  className?: string;
  style?: React.CSSProperties;
  fieldClassName?: string;
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}

/** Segmented keyboard wall-clock time input (`HH:MM` or `HH:MM:SS`). */
export function TimeInput(props: TimeInputProps): React.JSX.Element {
  const {
    id,
    name,
    value,
    defaultValue,
    onValueChange,
    min,
    max,
    granularity,
    hourCycle,
    locale,
    size = 'md',
    showIcon = true,
    invalid,
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
    ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    className,
    style,
    ref,
    children,
  } = props;

  const rawAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);

  const control = (
    <FieldControlBridge
      id={id}
      ariaLabel={rawAriaLabel}
      explicitAriaLabel={Boolean(rawAriaLabel) && label === undefined}
      ariaLabelledBy={ariaLabelledBy}
      ariaDescribedBy={ariaDescribedBy}
      invalid={isInvalid}
    >
      {(fieldAttrs) => (
        <SdkTimeInput
          ref={ref}
          id={fieldAttrs.id}
          value={value as never}
          defaultValue={defaultValue as never}
          onValueChange={onValueChange ? (next) => onValueChange(next) : undefined}
          min={min as never}
          max={max as never}
          granularity={granularity}
          hourCycle={hourCycle}
          locale={locale ? resolveLocale(locale) : undefined}
          aria-label={fieldAttrs['aria-label']}
          aria-labelledby={fieldAttrs['aria-labelledby']}
          aria-describedby={fieldAttrs['aria-describedby']}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          name={name}
          data-size={size}
          data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
          aria-invalid={fieldAttrs['aria-invalid'] || undefined}
          className={cx('nx-time-input', className)}
          style={style}
        >
          {children ??
            ((state) => (
              <>
                {showIcon ? (
                  <span className="nx-segmented-input-icon" aria-hidden="true">
                    <Icon name="clock" size={15} />
                  </span>
                ) : null}
                <span className="nx-segmented-input-segments">
                  {state.segments.map((segment, index) => (
                    <SdkTimeInputSegment key={`${segment.type}-${index}`} segment={segment} className="nx-time-segment" />
                  ))}
                </span>
              </>
            ))}
        </SdkTimeInput>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(control, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}

/* ============================================================================
 * CalendarGrid & DatePicker (Single + Range)
 * ========================================================================== */

function CalendarInterior({ months = 1, monthYearPicker = false }: { months?: number; monthYearPicker?: boolean }): React.JSX.Element {
  return (
    <div className="nx-calendar-shell">
      <div className="nx-calendar-header">
        <SdkCalendarPrevious className="nx-calendar-nav nx-focusable">
          <Icon name="caret-left" size={14} weight="bold" />
        </SdkCalendarPrevious>
        {monthYearPicker ? (
          <div className="nx-calendar-selects">
            <SdkCalendarMonthSelect className="nx-calendar-select" />
            <SdkCalendarYearSelect className="nx-calendar-select" />
          </div>
        ) : (
          <SdkCalendarHeading className="nx-calendar-heading" />
        )}
        <SdkCalendarNext className="nx-calendar-nav nx-focusable">
          <Icon name="caret-right" size={14} weight="bold" />
        </SdkCalendarNext>
      </div>

      <div className="nx-calendar-months" data-months={months}>
        {Array.from({ length: months }, (_, offset) => (
          <SdkCalendarGrid key={offset} offset={offset} className="nx-calendar-grid">
            <SdkCalendarWeekdays>
              {(index) => <SdkCalendarWeekday key={index} index={index} className="nx-calendar-weekday" />}
            </SdkCalendarWeekdays>
            <SdkCalendarWeeks>
              {(cell) => <SdkCalendarDay key={cell.date} value={cell.date} className="nx-calendar-day" />}
            </SdkCalendarWeeks>
          </SdkCalendarGrid>
        ))}
      </div>
    </div>
  );
}

/** Props for the inline `CalendarGrid` month picker. */
export interface CalendarGridProps {
  mode?: 'single' | 'range' | 'multiple';
  value?: DatePickerValue;
  defaultValue?: DatePickerValue;
  onValueChange?: (value: DatePickerValue) => void;
  focusedValue?: string;
  defaultFocusedValue?: string;
  onFocusedValueChange?: (focused: string) => void;
  min?: string;
  max?: string;
  isDateDisabled?: (date: string) => boolean;
  isDateUnavailable?: (date: string) => boolean;
  months?: number;
  monthYearPicker?: boolean;
  bordered?: boolean;
  fixedWeeks?: boolean;
  showOutsideDays?: boolean;
  locale?: string;
  timeZone?: string;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}

/** Inline interactive month calendar grid supporting single, range, and multi-date selection. */
export function CalendarGrid(props: CalendarGridProps): React.JSX.Element {
  const {
    mode = 'single',
    value,
    defaultValue,
    onValueChange,
    focusedValue,
    defaultFocusedValue,
    onFocusedValueChange,
    min,
    max,
    isDateDisabled,
    isDateUnavailable,
    months = 1,
    monthYearPicker = false,
    bordered = true,
    fixedWeeks = true,
    showOutsideDays = true,
    locale,
    timeZone,
    disabled,
    readOnly,
    ariaLabel,
    className,
    style,
    ref,
    children,
  } = props;

  const rawAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];

  return (
    <SdkCalendar
      {...({
        ref,
        mode,
        value,
        defaultValue,
        onValueChange: onValueChange ? (next: DatePickerValue) => onValueChange(next) : undefined,
        focusedValue,
        defaultFocusedValue,
        onFocusedValueChange: onFocusedValueChange ? (next: string) => onFocusedValueChange(next) : undefined,
        min,
        max,
        isDateDisabled,
        isDateUnavailable,
        months,
        fixedWeeks,
        showOutsideDays,
        locale: locale ? resolveLocale(locale) : undefined,
        timeZone,
        disabled,
        readOnly,
        'aria-label': rawAriaLabel,
        'data-bordered': bordered ? '' : undefined,
        className: cx('nx-calendar', className),
        style,
      } as unknown as React.ComponentProps<typeof SdkCalendar>)}
    >
      {children ?? <CalendarInterior months={months} monthYearPicker={monthYearPicker} />}
    </SdkCalendar>
  );
}

/** Quick-select date preset option for `DatePicker`. */
export interface DatePresetItem<V extends DatePickerValue = DatePickerValue> {
  label: React.ReactNode;
  value: V;
}

function getDefaultSinglePresets(timeZone?: string): DatePresetItem<ISODate>[] {
  const today = todayDate(timeZone);
  return [
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: addDays(today, 1) },
    { label: 'In 7 days', value: addDays(today, 7) },
    { label: 'In 30 days', value: addDays(today, 30) },
  ];
}

function getDefaultRangePresets(timeZone?: string): DatePresetItem<[ISODate, ISODate]>[] {
  const today = todayDate(timeZone);
  return [
    { label: 'Today', value: [today, today] },
    { label: 'Last 7 days', value: [addDays(today, -6), today] },
    { label: 'Last 30 days', value: [addDays(today, -29), today] },
    { label: 'This month', value: [startOfMonth(today), endOfMonth(today)] },
  ];
}

/** Props for the `DatePicker` popover date and date-range field. */
export interface DatePickerProps extends FieldFrameProps {
  id?: string;
  name?: string;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  mode?: 'single' | 'range';
  value?: DatePickerValue;
  defaultValue?: DatePickerValue;
  onValueChange?: (value: DatePickerValue) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  min?: string;
  max?: string;
  isDateDisabled?: (date: string) => boolean;
  isDateUnavailable?: (date: string) => boolean;
  months?: number;
  presets?: boolean | ReadonlyArray<DatePresetItem>;
  clearable?: boolean;
  clearLabel?: string;
  presetsLabel?: string;
  monthYearPicker?: boolean;
  fixedWeeks?: boolean;
  showOutsideDays?: boolean;
  locale?: string;
  timeZone?: string;
  placeholder?: string;
  endPlaceholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  size?: ControlSize;
  invalid?: boolean;
  /** Suppress the inner `data-slot="input-group"` wrapper when embedded inside `DateTimePicker`. */
  unstyledGroup?: boolean;
  words?: {
    openCalendar?: string;
    startDate?: string;
    endDate?: string;
    clearDate?: string;
    quickSelect?: string;
  };
  className?: string;
  contentClassName?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
  children?: React.ReactNode;
}

/** Popover date and date-range field (`mode="single"` or `mode="range"`) with segmented input and quick presets. */
export function DatePicker(props: DatePickerProps): React.JSX.Element {
  const {
    id: explicitId,
    ariaLabel,
    'aria-labelledby': explicitAriaLabelledBy,
    'aria-describedby': explicitAriaDescribedBy,
    mode = 'single',
    value,
    defaultValue,
    onValueChange,
    open,
    defaultOpen,
    onOpenChange,
    min,
    max,
    isDateDisabled,
    isDateUnavailable,
    months,
    presets,
    clearable = true,
    clearLabel,
    presetsLabel,
    monthYearPicker = false,
    placeholder,
    endPlaceholder,
    size = 'md',
    invalid,
    unstyledGroup = false,
    words,
    fixedWeeks = true,
    showOutsideDays = true,
    locale,
    timeZone,
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    contentClassName,
    fieldClassName,
    disabled,
    readOnly,
    name,
    className,
    ref,
    children,
  } = props;

  const isPhone = usePhoneViewport();
  const isRange = mode === 'range';
  const resolvedMonths = months ?? (isRange ? (isPhone ? 1 : 2) : 1);
  const effectivePresets = presets ?? isRange;
  const resolvedPlaceholder = placeholder ?? (isRange ? 'Start date' : undefined);
  const resolvedEndPlaceholder = endPlaceholder ?? (isRange ? 'End date' : resolvedPlaceholder);
  const rawAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);

  const rangeUid = React.useId();
  const startSuffixId = `${rangeUid}-start`;
  const endSuffixId = `${rangeUid}-end`;
  const resolvedClearLabel = clearLabel ?? words?.clearDate ?? 'Clear date';
  const resolvedPresetsLabel = presetsLabel ?? words?.quickSelect ?? 'Quick select';
  const resolvedOpenLabel = words?.openCalendar ?? 'Choose date';
  const resolvedStartWord = words?.startDate ?? 'Start date';
  const resolvedEndWord = words?.endDate ?? 'End date';

  const resolvedPresets = React.useMemo<ReadonlyArray<DatePresetItem>>(() => {
    if (!effectivePresets) return [];
    if (Array.isArray(effectivePresets)) return effectivePresets;
    return isRange ? getDefaultRangePresets(timeZone) : getDefaultSinglePresets(timeZone);
  }, [effectivePresets, isRange, timeZone]);

  const pickerNode = (
    <FieldControlBridge
      id={explicitId}
      ariaLabel={rawAriaLabel ?? (typeof label === 'string' ? label : undefined)}
      ariaLabelledBy={explicitAriaLabelledBy}
      ariaDescribedBy={explicitAriaDescribedBy}
      invalid={isInvalid}
    >
      {(fieldAttrs) => {
        const rangeLabelledByStart = fieldAttrs['aria-labelledby'] ? `${fieldAttrs['aria-labelledby']} ${startSuffixId}` : undefined;
        const rangeLabelledByEnd = fieldAttrs['aria-labelledby'] ? `${fieldAttrs['aria-labelledby']} ${endSuffixId}` : undefined;
        const rangeStartAriaLabel = rangeLabelledByStart
          ? undefined
          : fieldAttrs['aria-label']
            ? `${fieldAttrs['aria-label']} (${resolvedStartWord})`
            : resolvedStartWord;
        const rangeEndAriaLabel = rangeLabelledByEnd
          ? undefined
          : fieldAttrs['aria-label']
            ? `${fieldAttrs['aria-label']} (${resolvedEndWord})`
            : resolvedEndWord;
        const singleAriaLabel = fieldAttrs['aria-labelledby'] ? undefined : (fieldAttrs['aria-label'] ?? resolvedPlaceholder ?? 'Date');

        return (
          <SdkDatePicker
            key={mode}
            {...({
              value,
              defaultValue,
              onValueChange: onValueChange ? (next: DatePickerValue) => onValueChange(next) : undefined,
              open,
              defaultOpen,
              onOpenChange: onOpenChange ? (next: boolean) => onOpenChange(next) : undefined,
              min,
              max,
              isDateDisabled,
              isDateUnavailable,
              readOnly,
              locale: resolveLocale(locale),
              mode,
              months: resolvedMonths,
              fixedWeeks,
              showOutsideDays,
              timeZone,
              disabled,
              required,
              name,
              className: cx('nx-date-picker', className),
            } as unknown as React.ComponentProps<typeof SdkDatePicker>)}
          >
            {children ??
              ((state) => (
                <>
                  <div
                    data-slot={unstyledGroup ? 'date-picker-box' : 'input-group'}
                    data-size={size}
                    data-invalid={!unstyledGroup && fieldAttrs['aria-invalid'] ? '' : undefined}
                    data-disabled={disabled ? '' : undefined}
                    className={cx(!unstyledGroup && 'nx-input-group', 'nx-date-picker-control')}
                  >
                    <SdkDatePickerTrigger aria-label={resolvedOpenLabel} className="nx-date-picker-trigger nx-focusable">
                      <Icon name="calendar-blank" size={15} />
                    </SdkDatePickerTrigger>
                    {isRange && fieldAttrs['aria-labelledby'] ? (
                      <>
                        <span id={startSuffixId} className="nx-sr-only">
                          {resolvedStartWord}
                        </span>
                        <span id={endSuffixId} className="nx-sr-only">
                          {resolvedEndWord}
                        </span>
                      </>
                    ) : null}
                    <SdkDatePickerInput
                      ref={ref}
                      id={fieldAttrs.id}
                      placeholder={resolvedPlaceholder}
                      aria-label={isRange ? rangeStartAriaLabel : singleAriaLabel}
                      aria-labelledby={isRange ? rangeLabelledByStart : fieldAttrs['aria-labelledby']}
                      aria-describedby={fieldAttrs['aria-describedby']}
                      aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                      className="nx-date-picker-input"
                    />
                    {isRange ? (
                      <>
                        <span className="nx-date-picker-range-sep" aria-hidden="true">
                          <Icon name="arrow-right" size={13} />
                        </span>
                        <SdkDatePickerInput
                          end
                          placeholder={resolvedEndPlaceholder}
                          aria-label={rangeEndAriaLabel}
                          aria-labelledby={rangeLabelledByEnd}
                          aria-describedby={fieldAttrs['aria-describedby']}
                          aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                          className="nx-date-picker-input"
                        />
                      </>
                    ) : null}
                    {clearable && state.value !== null && !disabled && !readOnly ? (
                      <SdkDatePickerClear aria-label={resolvedClearLabel} className="nx-input-clear nx-date-picker-clear">
                        <Icon name="x" size={13} weight="bold" />
                      </SdkDatePickerClear>
                    ) : null}
                  </div>

                  <SdkDatePickerContent sideOffset={6} className={cx('nx-date-picker-content', contentClassName)}>
                    <div className="nx-date-picker-popover-layout" data-has-presets={resolvedPresets.length > 0 ? '' : undefined}>
                      {resolvedPresets.length > 0 ? (
                        <div className="nx-date-picker-presets">
                          <span className="nx-popup-group-label">{resolvedPresetsLabel}</span>
                          {resolvedPresets.map((preset, idx) => (
                            <SdkDatePickerPreset key={idx} value={preset.value as never} className="nx-date-picker-preset">
                              {preset.label}
                            </SdkDatePickerPreset>
                          ))}
                        </div>
                      ) : null}
                      <CalendarInterior months={resolvedMonths} monthYearPicker={monthYearPicker} />
                    </div>
                  </SdkDatePickerContent>
                </>
              ))}
          </SdkDatePicker>
        );
      }}
    </FieldControlBridge>
  );

  return wrapWithField(pickerNode, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}

/* ============================================================================
 * ColorPicker
 * ========================================================================== */

const DEFAULT_COLOR_SWATCHES: readonly string[] = [
  '#2563eb',
  '#0891b2',
  '#0d9488',
  '#16a34a',
  '#ca8a04',
  '#ea580c',
  '#dc2626',
  '#e11d48',
  '#7c3aed',
  '#4f46e5',
  '#475569',
  '#18181b',
];

const THEME_SWATCH_TOKENS = [
  '--accent',
  '--status-info',
  '--status-good',
  '--status-warning',
  '--status-critical',
  '--ai',
  '--ink',
  '--ink-muted',
] as const;

function normalizeCssColorToHex(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed.toLowerCase();
  const rgbMatch = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(trimmed);
  if (rgbMatch) {
    const r = Math.min(255, Number(rgbMatch[1])).toString(16).padStart(2, '0');
    const g = Math.min(255, Number(rgbMatch[2])).toString(16).padStart(2, '0');
    const b = Math.min(255, Number(rgbMatch[3])).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  if (typeof globalThis.document !== 'undefined') {
    try {
      const ctx = globalThis.document.createElement('canvas').getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000000';
        ctx.fillStyle = trimmed;
        if (/^#[0-9a-fA-F]{6}$/.test(ctx.fillStyle)) return ctx.fillStyle.toLowerCase();
      }
    } catch {
      // Ignore canvas unavailability in non-browser test environments
    }
  }
  return null;
}

function resolveThemeSwatches(): readonly string[] {
  if (typeof globalThis.document === 'undefined' || typeof globalThis.getComputedStyle !== 'function') {
    return DEFAULT_COLOR_SWATCHES;
  }
  const computed = globalThis.getComputedStyle(globalThis.document.documentElement);
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const token of THEME_SWATCH_TOKENS) {
    const hex = normalizeCssColorToHex(computed.getPropertyValue(token));
    if (hex && !seen.has(hex)) {
      seen.add(hex);
      collected.push(hex);
    }
  }
  if (collected.length === 0) return DEFAULT_COLOR_SWATCHES;
  for (const fallback of DEFAULT_COLOR_SWATCHES) {
    if (collected.length >= 8) break;
    if (!seen.has(fallback)) {
      seen.add(fallback);
      collected.push(fallback);
    }
  }
  return collected;
}

/** Props for the `ColorPicker` spectrum, slider, hex input, and swatch selector. */
export interface ColorPickerProps extends FieldFrameProps {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onValueCommit?: (value: string) => void;
  space?: 'hsv' | 'hsl' | 'rgb';
  swatches?: ReadonlyArray<string>;
  showSwatches?: boolean;
  showAlpha?: boolean;
  showEyeDropper?: boolean;
  showInput?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
  words?: { colorValue?: string; pickFromScreen?: string; swatches?: string };
  className?: string;
  style?: React.CSSProperties;
  fieldClassName?: string;
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}

/** Interactive 2D color spectrum, hue/alpha sliders, hex field, eyedropper, and theme palette swatches. */
export function ColorPicker(props: ColorPickerProps): React.JSX.Element {
  const {
    id: explicitId,
    value,
    defaultValue,
    onValueChange,
    onValueCommit,
    space = 'hsv',
    swatches: explicitSwatches,
    showSwatches = true,
    showAlpha = true,
    showEyeDropper = true,
    showInput = true,
    invalid,
    words,
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
    style,
    ref,
    children,
  } = props;

  const rawAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);
  const [themeSwatches, setThemeSwatches] = React.useState<readonly string[]>(() => explicitSwatches ?? DEFAULT_COLOR_SWATCHES);

  React.useEffect(() => {
    if (explicitSwatches === undefined) {
      setThemeSwatches(resolveThemeSwatches());
    }
  }, [explicitSwatches]);

  const swatches = explicitSwatches ?? themeSwatches;
  const colorValueLabel = rawAriaLabel ?? words?.colorValue ?? 'Color value';
  const pickFromScreenLabel = words?.pickFromScreen ?? 'Pick color from screen';
  const swatchesLabel = words?.swatches ?? 'Preset colors';

  const pickerNode = (
    <FieldControlBridge id={explicitId} ariaLabel={colorValueLabel} invalid={isInvalid}>
      {(fieldAttrs) => (
        <SdkColorPicker
          ref={ref}
          value={value}
          defaultValue={defaultValue}
          onValueChange={onValueChange ? (next) => onValueChange(next) : undefined}
          onValueCommit={onValueCommit ? (next) => onValueCommit(next) : undefined}
          space={space as never}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          name={name}
          className={cx('nx-color-picker', className)}
          style={style}
        >
          {children ?? (
            <>
              <SdkColorPickerArea className="nx-color-area">
                <SdkColorPickerAreaCanvas className="nx-color-area-canvas" />
                <SdkColorPickerAreaThumb className="nx-color-area-thumb" />
              </SdkColorPickerArea>

              <div className="nx-color-sliders">
                <SdkColorPickerSlider channel="hue" className="nx-color-slider">
                  <SdkColorPickerSliderThumb className="nx-color-slider-thumb" />
                </SdkColorPickerSlider>
                {showAlpha ? (
                  <SdkColorPickerSlider channel="alpha" className="nx-color-slider nx-color-slider-alpha">
                    <SdkColorPickerSliderThumb className="nx-color-slider-thumb" />
                  </SdkColorPickerSlider>
                ) : null}
              </div>

              {(showInput || showEyeDropper) && (
                <div className="nx-color-controls">
                  <SdkColorPickerSwatch className="nx-color-current-swatch" />
                  {showInput ? (
                    <SdkColorPickerInput
                      id={fieldAttrs.id}
                      aria-label={fieldAttrs['aria-label'] ?? colorValueLabel}
                      aria-labelledby={fieldAttrs['aria-labelledby']}
                      aria-describedby={fieldAttrs['aria-describedby']}
                      aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                      className="nx-color-hex-input"
                    />
                  ) : null}
                  {showEyeDropper ? (
                    <SdkColorPickerEyeDropper
                      aria-label={pickFromScreenLabel}
                      title={pickFromScreenLabel}
                      className="nx-color-eyedropper nx-focusable"
                    >
                      <Icon name="eyedropper" size={15} />
                    </SdkColorPickerEyeDropper>
                  ) : null}
                </div>
              )}

              {showSwatches && swatches.length > 0 ? (
                <SdkColorPickerSwatches aria-label={swatchesLabel} className="nx-color-swatches">
                  {swatches.map((swatchColor) => (
                    <SdkColorPickerSwatchItem key={swatchColor} value={swatchColor} className="nx-color-swatch-item" />
                  ))}
                </SdkColorPickerSwatches>
              ) : null}
            </>
          )}
        </SdkColorPicker>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(pickerNode, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}

/* ============================================================================
 * TriggerMenu (@mention / /slash autocomplete input)
 * ========================================================================== */

/** Single completion option item for `TriggerMenu`. */
export interface TriggerMenuItemOption<T = string> {
  value: T;
  label: string;
  keywords?: string[];
  disabled?: boolean;
  insertText?: string;
}

/** Trigger character and item source configuration for `TriggerMenu`. */
export interface TriggerMenuTrigger<T = string> {
  char: string;
  items: ReadonlyArray<TriggerMenuItemOption<T>> | ((query: string) => Promise<ReadonlyArray<TriggerMenuItemOption<T>>>);
}

/** Props for the `TriggerMenu` `@mention` and `/slash` text input. */
export interface TriggerMenuProps<T = string> extends FieldFrameProps {
  id?: string;
  name?: string;
  /** Shorthand single trigger character (default `'@'`), used when `triggers` is omitted. */
  trigger?: string;
  /** Shorthand items or async loader for the single `trigger`. */
  items?: ReadonlyArray<TriggerMenuItemOption<T>> | ((query: string) => Promise<ReadonlyArray<TriggerMenuItemOption<T>>>);
  /** Full multi-trigger configuration (e.g. both `'@'` and `'/'`). */
  triggers?: ReadonlyArray<TriggerMenuTrigger<T>>;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSelect?: (item: TriggerMenuItemOption<T>, triggerChar: string) => void;
  empty?: EmptyStateSpec | React.ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
  className?: string;
  inputClassName?: string;
  contentClassName?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLTextAreaElement | HTMLInputElement>;
  children?: React.ReactNode;
}

/** Single- or multi-line text input that opens an inline completion popup on trigger characters (`@`, `/`). */
export function TriggerMenu<T = string>(props: TriggerMenuProps<T>): React.JSX.Element {
  const {
    id,
    trigger = '@',
    items,
    triggers,
    multiline = true,
    rows = 3,
    placeholder,
    value,
    defaultValue,
    onValueChange,
    onSelect,
    empty,
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    disabled,
    readOnly,
    name,
    ariaLabel,
    invalid,
    className,
    inputClassName,
    contentClassName,
    fieldClassName,
    ref,
    children,
  } = props;

  const legacyOnChange = (props as unknown as { onChange?: React.ChangeEventHandler<HTMLTextAreaElement | HTMLInputElement> }).onChange;
  const legacyEmpty = (props as unknown as { emptyMessage?: React.ReactNode }).emptyMessage;
  const resolvedEmpty = empty ?? legacyEmpty ?? 'No matching suggestions';
  const rawAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);

  const resolvedTriggers = React.useMemo<SdkTriggerDefinition<T>[]>(() => {
    if (triggers && triggers.length > 0) return triggers as unknown as SdkTriggerDefinition<T>[];
    return [
      {
        char: trigger,
        items: (items ?? []) as unknown as SdkTriggerDefinition<T>['items'],
      },
    ];
  }, [triggers, trigger, items]);

  const handleInputChange: React.ChangeEventHandler<HTMLTextAreaElement | HTMLInputElement> = (event) => {
    onValueChange?.(event.target.value);
    legacyOnChange?.(event);
  };

  const menuNode = (
    <SdkTriggerMenu<T>
      triggers={resolvedTriggers}
      onSelect={onSelect ? (val, details) => onSelect({ value: val, label: String(val) }, details.trigger) : undefined}
    >
      {children ?? (
        <>
          <div className={cx('nx-trigger-menu-box', className)}>
            {multiline ? (
              <SdkTriggerMenuInput
                ref={ref as React.Ref<HTMLTextAreaElement>}
                id={id}
                rows={rows}
                placeholder={placeholder ?? `Type ${trigger} to mention…`}
                value={value}
                defaultValue={defaultValue}
                onChange={handleInputChange as React.ChangeEventHandler<HTMLTextAreaElement>}
                disabled={disabled}
                readOnly={readOnly}
                required={required}
                name={name}
                aria-label={rawAriaLabel}
                aria-invalid={isInvalid || undefined}
                data-slot="textarea"
                data-invalid={isInvalid ? '' : undefined}
                className={cx('nx-trigger-menu-textarea', inputClassName)}
              />
            ) : (
              <SdkTriggerMenuInput
                ref={ref as React.Ref<HTMLTextAreaElement>}
                id={id}
                render={<input type="text" />}
                placeholder={placeholder ?? `Type ${trigger} for commands…`}
                value={value}
                defaultValue={defaultValue}
                onChange={handleInputChange as unknown as React.ChangeEventHandler<HTMLTextAreaElement>}
                disabled={disabled}
                readOnly={readOnly}
                required={required}
                name={name}
                aria-label={rawAriaLabel}
                aria-invalid={isInvalid || undefined}
                data-slot="input"
                data-invalid={isInvalid ? '' : undefined}
                className={cx('nx-input nx-trigger-menu-input', inputClassName)}
              />
            )}
            <SdkTriggerMenuHint className="nx-trigger-menu-hint" />
          </div>

          <SdkTriggerMenuContent sideOffset={6} className={cx('nx-trigger-menu-content', contentClassName)}>
            <SdkTriggerMenuList className="nx-popup-list" />
            {resolvedEmpty ? <SdkTriggerMenuEmpty className="nx-popup-empty">{renderEmptyNode(resolvedEmpty)}</SdkTriggerMenuEmpty> : null}
          </SdkTriggerMenuContent>
          <SdkTriggerMenuStatus className="nx-sr-only" />
        </>
      )}
    </SdkTriggerMenu>
  );

  return wrapWithField(menuNode, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}

export { DateField, type DateFieldOpenReason, type DateFieldProps, type DateFieldWords } from '../DateField.js';
