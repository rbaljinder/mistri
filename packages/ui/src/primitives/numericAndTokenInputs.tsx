/**
 * Numeric stepper inputs, pattern-masked inputs, multi-slot verification codes (OTP),
 * tokenized tag inputs, and drag-and-drop file dropzones over UI SDK primitives.
 */
import * as React from 'react';
import {
  NumberInput as SdkNumberInput,
  NumberInputControl as SdkNumberInputControl,
  NumberInputDecrement as SdkNumberInputDecrement,
  NumberInputGroup as SdkNumberInputGroup,
  NumberInputIncrement as SdkNumberInputIncrement,
  NumberInputScrubArea as SdkNumberInputScrubArea,
  NumberInputScrubAreaCursor as SdkNumberInputScrubAreaCursor,
} from '@ui-sdk/react/number-input';
import {
  OTPInput as SdkOTPInput,
  OTPInputGroup as SdkOTPInputGroup,
  OTPInputSeparator as SdkOTPInputSeparator,
  OTPInputSlot as SdkOTPInputSlot,
} from '@ui-sdk/react/otp-input';
import {
  TokenInput as SdkTokenInput,
  TokenInputEditor as SdkTokenInputEditor,
  TokenInputToken as SdkTokenInputToken,
  TokenInputTokenRemove as SdkTokenInputTokenRemove,
  createTokenInputController,
  type Token,
  type TokenInputValue as SdkTokenInputValue,
} from '@ui-sdk/react/token-input';
import {
  FileInput as SdkFileInput,
  FileInputDropzone as SdkFileInputDropzone,
  FileInputItem as SdkFileInputItem,
  FileInputItemRemove as SdkFileInputItemRemove,
  FileInputList as SdkFileInputList,
  FileInputTrigger as SdkFileInputTrigger,
  formatFileSize,
} from '@ui-sdk/react/file-input';
import { Icon } from '../Icon.js';
import { cx, type ControlSize } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';
import { FieldControlBridge, wrapWithField, type FieldFrameProps } from './fieldShell.js';

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<
  React.ComponentProps<T>,
  'onChange' | 'aria-label' | 'inlist'
> & {
  ariaLabel?: string;
};

/* ============================================================================
 * NumberInput
 * ========================================================================== */

function isHighPrecisionNumericString(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return false;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return true;
  if (/^-?\d+$/.test(trimmed) && !Number.isSafeInteger(parsed)) return true;
  return String(parsed) !== trimmed.replace(/^(-?)0+(\d)/, '$1$2');
}

function formatExactNumericString(raw: string, locale: string | undefined, format?: Intl.NumberFormatOptions): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    try {
      return new Intl.NumberFormat(resolveLocale(locale), format).format(trimmed as Intl.StringNumericLiteral);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/* A decimal string as a whole number of its smallest unit, so stepping "0.10" or a 19-digit id never passes through a
   float. Null for text that is not a number yet ("-", ""). */
function toScaled(text: string): { units: bigint; scale: number } | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m || (!m[2] && !m[3])) return null;
  const fraction = m[3] ?? '';
  const units = BigInt((m[2] || '0') + fraction);
  return { units: m[1] ? -units : units, scale: fraction.length };
}

function fromScaled(units: bigint, scale: number): string {
  const negative = units < BigInt(0);
  const figures = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const body = scale ? `${figures.slice(0, -scale)}.${figures.slice(-scale)}` : figures;
  return negative ? `-${body}` : body;
}

/* A number without the exponent `String` gives small and large ones, which `toScaled` could not read. */
const plainNumber = (n: number): string => n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });

/** `current` moved by `delta` and held within the bounds, exactly; the answer keeps the places of whichever had more. */
function stepExactString(current: string, delta: number, min?: number, max?: number): string | null {
  const from = toScaled(current.trim() || '0');
  const by = toScaled(plainNumber(delta));
  if (!from || !by) return null;
  const low = typeof min === 'number' && Number.isFinite(min) ? toScaled(plainNumber(min)) : null;
  const high = typeof max === 'number' && Number.isFinite(max) ? toScaled(plainNumber(max)) : null;
  const scale = Math.max(from.scale, by.scale, low?.scale ?? 0, high?.scale ?? 0);
  const lift = (v: { units: bigint; scale: number }): bigint => v.units * BigInt(10) ** BigInt(scale - v.scale);
  let next = lift(from) + lift(by);
  if (low && next < lift(low)) next = lift(low);
  if (high && next > lift(high)) next = lift(high);
  return fromScaled(next, scale);
}

/* What a number-shaped handler is told for an exact string: the nearest number, or null while there is none. */
function numberOrNull(text: string): number | null {
  const parsed = text.trim() === '' ? Number.NaN : Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Props for the `NumberInput` stepper control. */
export interface NumberInputProps extends FieldFrameProps {
  id?: string;
  name?: string;
  form?: string;
  value?: number | string | null;
  defaultValue?: number | string | null;
  /** Every edit as a number. For a value past a float's precision this is the nearest number: keep `onStringValueChange` for the exact text. */
  onValueChange?: (value: number | null) => void;
  onValueCommit?: (value: number | null) => void;
  /** Every edit as text, exact whatever the size. */
  onStringValueChange?: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  largeStep?: number;
  smallStep?: number;
  format?: Intl.NumberFormatOptions;
  locale?: string;
  wheel?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  ariaLabel?: string;
  'aria-describedby'?: string;
  size?: ControlSize;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  scrubLabel?: React.ReactNode;
  hideSteppers?: boolean;
  invalid?: boolean;
  words?: { decrease?: string; increase?: string };
  className?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
  children?: React.ReactNode;
}

function NumberInputGroupPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkNumberInputGroup aria-label={ariaLabel} className={cx('nx-number-group', className)} {...props} />;
}

function NumberInputControlPart({ ariaLabel, className, ...props }: CleanElementProps<'input'>) {
  return <SdkNumberInputControl aria-label={ariaLabel} className={cx('nx-number-control', className)} {...props} />;
}

function NumberInputIncrementPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>) {
  return <SdkNumberInputIncrement aria-label={ariaLabel} className={cx('nx-number-step', className)} {...props} />;
}

function NumberInputDecrementPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>) {
  return <SdkNumberInputDecrement aria-label={ariaLabel} className={cx('nx-number-step', className)} {...props} />;
}

function NumberInputScrubAreaPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>) {
  return <SdkNumberInputScrubArea aria-label={ariaLabel} className={cx('nx-number-scrub', className)} {...props} />;
}

function NumberInputScrubCursorPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>) {
  return <SdkNumberInputScrubAreaCursor aria-label={ariaLabel} className={cx('nx-number-scrub-cursor', className)} {...props} />;
}

function NumberInputRoot(props: NumberInputProps): React.JSX.Element {
  const {
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    fieldClassName,
    size = 'md',
    prefix,
    suffix,
    scrubLabel,
    hideSteppers = false,
    invalid,
    words,
    value,
    defaultValue,
    onValueChange,
    onStringValueChange,
    onValueCommit,
    min,
    max,
    step,
    largeStep,
    smallStep,
    format,
    locale,
    wheel,
    disabled,
    readOnly,
    name,
    form,
    ariaLabel,
    className,
    ref,
    children,
    ...controlProps
  } = props;

  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);
  const decreaseLabel = words?.decrease ?? 'Decrease value';
  const increaseLabel = words?.increase ?? 'Increase value';
  const resolvedLocale = resolveLocale(locale);

  /* Exact mode is entered once and kept. Deciding it from the value on every render swapped one input element for
     another the moment "9007199254740993" was edited down to a safe number: the box remounted mid-keystroke, focus was
     lost and the text went through a float. */
  const needsExact = isHighPrecisionNumericString(value) || (value === undefined && isHighPrecisionNumericString(defaultValue));
  const [exactLatched, setExactLatched] = React.useState(needsExact);
  if (needsExact && !exactLatched) setExactLatched(true);
  const highPrecisionMode = exactLatched || needsExact;
  const [internalStr, setInternalStr] = React.useState<string>(() =>
    typeof value === 'string' ? value : typeof defaultValue === 'string' ? defaultValue : '',
  );
  const [editingRaw, setEditingRaw] = React.useState<string | null>(null);

  const activeStr = typeof value === 'string' ? value : typeof value === 'number' ? plainNumber(value) : value === null ? '' : internalStr;

  const stepBigString = (deltaSign: -1 | 1, multiplier = 1) => {
    if (disabled || readOnly) return;
    const nextStr = stepExactString(activeStr, deltaSign * (step ?? 1) * multiplier, min, max);
    if (nextStr === null) return;
    if (value === undefined) setInternalStr(nextStr);
    if (editingRaw !== null) setEditingRaw(nextStr);
    onStringValueChange?.(nextStr);
    onValueChange?.(numberOrNull(nextStr));
    onValueCommit?.(numberOrNull(nextStr));
  };

  if (highPrecisionMode) {
    const shownText = editingRaw !== null ? editingRaw : formatExactNumericString(activeStr, resolvedLocale, format);
    const exactControl = (
      <FieldControlBridge
        id={controlProps.id}
        ariaLabel={resolvedAriaLabel}
        ariaDescribedBy={controlProps['aria-describedby']}
        invalid={isInvalid}
      >
        {(fieldAttrs) => (
          <div data-slot="number-input" className={cx('nx-number-input', className)}>
            {name ? <input type="hidden" name={name} form={form} value={activeStr} /> : null}
            <div
              data-slot="number-input-group"
              data-size={size}
              data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
              data-disabled={disabled ? '' : undefined}
              className="nx-number-group"
            >
              {prefix !== undefined && prefix !== null ? (
                <span className="nx-input-affix" data-side="start">
                  {prefix}
                </span>
              ) : null}
              <input
                ref={ref}
                id={fieldAttrs.id}
                type="text"
                role="spinbutton"
                inputMode="decimal"
                value={shownText}
                placeholder={controlProps.placeholder}
                autoFocus={controlProps.autoFocus}
                disabled={disabled}
                readOnly={readOnly}
                required={required}
                aria-label={fieldAttrs['aria-label']}
                aria-labelledby={fieldAttrs['aria-labelledby']}
                aria-describedby={fieldAttrs['aria-describedby']}
                aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                aria-valuenow={numberOrNull(activeStr) ?? undefined}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuetext={activeStr || undefined}
                onFocus={(e) => {
                  setEditingRaw(activeStr);
                  controlProps.onFocus?.(e);
                }}
                onBlur={(e) => {
                  setEditingRaw(null);
                  onValueCommit?.(numberOrNull(activeStr));
                  controlProps.onBlur?.(e);
                }}
                onChange={(e) => {
                  const cleaned = e.target.value.replace(/[^0-9.-]/g, '');
                  setEditingRaw(cleaned);
                  if (value === undefined) setInternalStr(cleaned);
                  onStringValueChange?.(cleaned);
                  onValueChange?.(numberOrNull(cleaned));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    stepBigString(1, e.shiftKey ? 10 : 1);
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    stepBigString(-1, e.shiftKey ? 10 : 1);
                  }
                }}
                data-slot="number-input-control"
                className="nx-number-control"
              />
              {suffix !== undefined && suffix !== null ? (
                <span className="nx-input-affix" data-side="end">
                  {suffix}
                </span>
              ) : null}
              {!hideSteppers ? (
                <div className="nx-number-steppers">
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={disabled || readOnly}
                    aria-label={decreaseLabel}
                    onClick={() => stepBigString(-1)}
                    className="nx-number-step"
                  >
                    <Icon name="minus" size={12} weight="bold" />
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={disabled || readOnly}
                    aria-label={increaseLabel}
                    onClick={() => stepBigString(1)}
                    className="nx-number-step"
                  >
                    <Icon name="plus" size={12} weight="bold" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </FieldControlBridge>
    );

    return wrapWithField(exactControl, {
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

  const numericValue = typeof value === 'string' ? (value.trim() === '' ? null : Number(value)) : value;
  const numericDefaultValue = typeof defaultValue === 'string' ? (defaultValue.trim() === '' ? null : Number(defaultValue)) : defaultValue;

  const numberControl = (
    <FieldControlBridge
      id={controlProps.id}
      ariaLabel={resolvedAriaLabel}
      ariaDescribedBy={controlProps['aria-describedby']}
      invalid={isInvalid}
    >
      {(fieldAttrs) => (
        <SdkNumberInput
          value={numericValue}
          defaultValue={numericDefaultValue}
          onValueChange={
            onValueChange || onStringValueChange
              ? (next) => {
                  onValueChange?.(next);
                  onStringValueChange?.(next === null ? '' : plainNumber(next));
                }
              : undefined
          }
          onValueCommit={onValueCommit ? (next) => onValueCommit(next) : undefined}
          min={min}
          max={max}
          step={step}
          largeStep={largeStep}
          smallStep={smallStep}
          format={format}
          locale={resolvedLocale}
          wheel={wheel}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          name={name}
          form={form}
          className={cx('nx-number-input', className)}
        >
          {children ?? (
            <>
              {scrubLabel !== undefined && scrubLabel !== null ? (
                <>
                  <SdkNumberInputScrubArea className="nx-number-scrub">
                    <Icon name="arrows-left-right" size={13} />
                    <span>{scrubLabel}</span>
                  </SdkNumberInputScrubArea>
                  <SdkNumberInputScrubAreaCursor className="nx-number-scrub-cursor" />
                </>
              ) : null}
              <SdkNumberInputGroup data-size={size} data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined} className="nx-number-group">
                {prefix !== undefined && prefix !== null ? (
                  <span className="nx-input-affix" data-side="start">
                    {prefix}
                  </span>
                ) : null}
                <SdkNumberInputControl
                  {...controlProps}
                  ref={ref}
                  id={fieldAttrs.id}
                  aria-label={fieldAttrs['aria-label']}
                  aria-labelledby={fieldAttrs['aria-labelledby']}
                  aria-describedby={fieldAttrs['aria-describedby']}
                  aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                  className="nx-number-control"
                />
                {suffix !== undefined && suffix !== null ? (
                  <span className="nx-input-affix" data-side="end">
                    {suffix}
                  </span>
                ) : null}
                {!hideSteppers ? (
                  <div className="nx-number-steppers">
                    <SdkNumberInputDecrement aria-label={decreaseLabel} className="nx-number-step">
                      <Icon name="minus" size={12} weight="bold" />
                    </SdkNumberInputDecrement>
                    <SdkNumberInputIncrement aria-label={increaseLabel} className="nx-number-step">
                      <Icon name="plus" size={12} weight="bold" />
                    </SdkNumberInputIncrement>
                  </div>
                ) : null}
              </SdkNumberInputGroup>
            </>
          )}
        </SdkNumberInput>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(numberControl, {
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

/** Numeric spinbutton input with inline increment/decrement steppers, prefix/suffix affixes, and `> 2^53` BigInt preservation. */
export const NumberInput = Object.assign(NumberInputRoot, {
  Root: NumberInputRoot,
  Group: NumberInputGroupPart,
  Control: NumberInputControlPart,
  Increment: NumberInputIncrementPart,
  Decrement: NumberInputDecrementPart,
  ScrubArea: NumberInputScrubAreaPart,
  ScrubAreaCursor: NumberInputScrubCursorPart,
});

/* ============================================================================
 * OTPInput
 * ========================================================================== */

/** Props for the `OTPInput` verification code field. */
export interface OTPInputProps extends Omit<CleanElementProps<'div'>, 'defaultValue' | 'children'>, FieldFrameProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onComplete?: (value: string) => void;
  length?: number;
  maxLength?: number;
  pattern?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  autoComplete?: string;
  autoFocus?: boolean;
  name?: string;
  form?: string;
  disabled?: boolean;
  readOnly?: boolean;
  separatorAfter?: number | ReadonlyArray<number>;
  size?: ControlSize;
  invalid?: boolean;
  fieldClassName?: string;
  children?: React.ReactNode;
}

function buildSlotSegments(length: number, separatorAfter?: number | ReadonlyArray<number>): number[][] {
  if (separatorAfter === undefined) {
    return [Array.from({ length }, (_, i) => i)];
  }
  const splitSet = new Set(typeof separatorAfter === 'number' ? [separatorAfter] : separatorAfter);
  const groups: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < length; i += 1) {
    current.push(i);
    if (splitSet.has(i + 1) && i + 1 < length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function OTPGroupPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkOTPInputGroup aria-label={ariaLabel} className={cx('nx-otp-group', className)} {...props} />;
}

function OTPSlotPart({ index, ariaLabel, className, ...props }: CleanElementProps<'div'> & { index: number }) {
  return <SdkOTPInputSlot index={index} aria-label={ariaLabel} className={cx('nx-otp-slot', className)} {...props} />;
}

function OTPSeparatorPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkOTPInputSeparator aria-label={ariaLabel} className={cx('nx-otp-separator', className)} {...props} />;
}

function OTPInputRoot(props: OTPInputProps): React.JSX.Element {
  const {
    length = 6,
    maxLength,
    separatorAfter,
    size = 'md',
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
    value,
    defaultValue,
    onValueChange,
    onComplete,
    disabled,
    name,
    ariaLabel,
    className,
    children,
    ...rest
  } = props;

  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const totalSlots = maxLength ?? length;
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);
  const groups = React.useMemo(() => buildSlotSegments(totalSlots, separatorAfter), [totalSlots, separatorAfter]);

  const otpControl = (
    <SdkOTPInput
      {...({
        ...rest,
        value,
        defaultValue,
        onValueChange: onValueChange ? (next: string) => onValueChange(next) : undefined,
        onComplete: onComplete ? (code: string) => onComplete(code) : undefined,
        maxLength: totalSlots,
        disabled,
        required,
        name,
        'aria-label': resolvedAriaLabel,
        'aria-invalid': isInvalid ? true : rest['aria-invalid'],
        'data-size': size,
        'data-invalid': isInvalid ? '' : undefined,
        className: cx('nx-otp-input', className),
      } as unknown as React.ComponentProps<typeof SdkOTPInput>)}
    >
      {children ??
        groups.map((group, groupIndex) => (
          <React.Fragment key={groupIndex}>
            {groupIndex > 0 ? <SdkOTPInputSeparator className="nx-otp-separator" /> : null}
            <SdkOTPInputGroup className="nx-otp-group">
              {group.map((slotIndex) => (
                <SdkOTPInputSlot key={slotIndex} index={slotIndex} className="nx-otp-slot" />
              ))}
            </SdkOTPInputGroup>
          </React.Fragment>
        ))}
    </SdkOTPInput>
  );

  return wrapWithField(otpControl, {
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

/** Multi-character one-time passcode verification input with grouped character cells and paste support. */
export const OTPInput = Object.assign(OTPInputRoot, {
  Root: OTPInputRoot,
  Group: OTPGroupPart,
  Slot: OTPSlotPart,
  Separator: OTPSeparatorPart,
});

/* ============================================================================
 * TokenInput & TagInput
 * ========================================================================== */

/** Structured token chip entry inside `TokenInput`. */
export interface TokenItem {
  id: string;
  type: string;
  value: string;
  label: string;
}

/** What `TokenInput` holds: its chips. A string is a tag by its text, so a list of tags can be passed as it is. */
export type TokenInputValue = Array<string | TokenItem>;

/* The chips a caller's list names. A string is a chip, never text in the box: the text being typed is the control's own,
   and a caller that hands back plain labels would otherwise see its tags run together as one unbroken sentence. */
function chipsOf(list: ReadonlyArray<string | TokenItem>): TokenItem[] {
  const out: TokenItem[] = [];
  list.forEach((part, at) => {
    if (typeof part !== 'string') out.push(part);
    else if (part.trim()) out.push({ id: `tag-${at}-${part}`, type: 'tag', value: part, label: part });
  });
  return out;
}

function chipsIn(parts: SdkTokenInputValue): TokenItem[] {
  return parts.filter((part): part is Token => typeof part !== 'string') as TokenItem[];
}

/* Ids are left out: a caller that keeps only the labels hands the same chips back under new ids, and that is no change. */
function sameChips(a: ReadonlyArray<TokenItem>, b: ReadonlyArray<TokenItem>): boolean {
  return (
    a.length === b.length && a.every((chip, at) => chip.type === b[at]!.type && chip.value === b[at]!.value && chip.label === b[at]!.label)
  );
}

/** The tags in a run of typed or pasted text: one per comma or line. */
function tagsIn(text: string): string[] {
  return text
    .split(/[,\n]+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

/** Props for the `TokenInput` / `TagInput` multi-value chip editor. */
export interface TokenInputProps extends FieldFrameProps {
  id?: string;
  name?: string;
  value?: TokenInputValue;
  defaultValue?: TokenInputValue;
  onValueChange?: (value: TokenInputValue) => void;
  placeholder?: string;
  tags?: ReadonlyArray<string>;
  defaultTags?: ReadonlyArray<string>;
  onTagsChange?: (tags: string[]) => void;
  commitOnEnter?: boolean;
  commitOnComma?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  size?: ControlSize;
  invalid?: boolean;
  renderToken?: (token: TokenItem) => React.ReactNode;
  className?: string;
  editorClassName?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}

function TokenEditorPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkTokenInputEditor aria-label={ariaLabel} className={cx('nx-token-editor', className)} {...props} />;
}

function TokenChipPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>) {
  return <SdkTokenInputToken aria-label={ariaLabel} className={cx('nx-token-chip', className)} {...props} />;
}

function TokenChipRemovePart({ ariaLabel, className, ...props }: CleanElementProps<'button'>) {
  return <SdkTokenInputTokenRemove aria-label={ariaLabel} className={cx('nx-token-chip-remove', className)} {...props} />;
}

function TokenInputRoot(props: TokenInputProps): React.JSX.Element {
  const {
    id,
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    fieldClassName,
    placeholder = 'Add item…',
    value,
    defaultValue,
    onValueChange,
    tags,
    defaultTags,
    onTagsChange,
    commitOnEnter = true,
    commitOnComma = true,
    size = 'md',
    invalid,
    renderToken,
    disabled,
    readOnly,
    name,
    ariaLabel,
    className,
    editorClassName,
    ref,
    children,
  } = props;

  const controller = React.useMemo(() => createTokenInputController(), []);
  const resolvedAriaLabel =
    ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'] ?? (typeof label === 'string' ? label : placeholder);
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);

  /* The box's whole content, chips and the text being typed, is kept here and the caller is told the chips alone. A
     caller's list cannot hold the half-typed text: one that keeps tags would drop it on every keystroke. */
  const [parts, setParts] = React.useState<SdkTokenInputValue>(() => chipsOf(value ?? tags ?? defaultValue ?? defaultTags ?? []));
  const controlled = value ?? tags;
  let shownParts = parts;
  if (controlled !== undefined) {
    const wanted = chipsOf(controlled);
    if (!sameChips(wanted, chipsIn(parts))) {
      shownParts = [...wanted, ...parts.filter((part) => typeof part === 'string')];
      setParts(shownParts);
    }
  }
  const partsRef = React.useRef(shownParts);
  partsRef.current = shownParts;

  const adopt = React.useCallback(
    (next: SdkTokenInputValue) => {
      const before = chipsIn(partsRef.current);
      const after = chipsIn(next);
      partsRef.current = next;
      setParts(next);
      if (sameChips(before, after)) return;
      onValueChange?.(after);
      onTagsChange?.(after.map((chip) => chip.value));
    },
    [onValueChange, onTagsChange],
  );

  /* Every run of text becomes chips where it stands. Returns the same list when there was no text to turn. */
  const chipped = React.useCallback((from: SdkTokenInputValue): SdkTokenInputValue => {
    if (!from.some((part) => typeof part === 'string' && part.trim())) return from;
    const out: SdkTokenInputValue = [];
    for (const part of from) {
      if (typeof part !== 'string') out.push(part);
      else {
        for (const tag of tagsIn(part)) {
          out.push({ id: `tag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type: 'tag', value: tag, label: tag });
        }
      }
    }
    return out;
  }, []);

  const handleValueChange = React.useCallback(
    (next: SdkTokenInputValue, details?: { reason?: string }) => {
      /* A pasted list is a list of tags: "a, b, c" from a spreadsheet cell is three chips, not text waiting for Enter. */
      const pastedList = details?.reason === 'paste' && next.some((part) => typeof part === 'string' && /[,\n]/.test(part));
      adopt(pastedList ? chipped(next) : next);
    },
    [adopt, chipped],
  );

  const commitDraft = React.useCallback((): boolean => {
    const current = partsRef.current;
    const next = chipped(current);
    if (next === current) return false;
    adopt(next);
    return true;
  }, [adopt, chipped]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled || readOnly) return;
      /* An input method's Enter (or comma) picks a candidate; it has not finished the word, so it commits nothing.
         229 is what Safari reports for that key once composition has ended. */
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if ((commitOnEnter && event.key === 'Enter' && !event.shiftKey) || (commitOnComma && event.key === ',')) {
        if (commitDraft()) event.preventDefault();
      }
    },
    [disabled, readOnly, commitOnEnter, commitOnComma, commitDraft],
  );

  /* Text left in the box when focus moves on would look entered and never reach the form. */
  const handleBlur = React.useCallback(() => {
    if (!disabled && !readOnly) commitDraft();
  }, [disabled, readOnly, commitDraft]);

  const defaultRenderToken = React.useCallback(
    (token: Token) => (
      <SdkTokenInputToken className="nx-token-chip">
        <span className="nx-token-chip-label">{token.label}</span>
        {!disabled && !readOnly ? (
          <SdkTokenInputTokenRemove aria-label={`Remove ${token.label}`} className="nx-token-chip-remove">
            <Icon name="x" size={11} weight="bold" />
          </SdkTokenInputTokenRemove>
        ) : null}
      </SdkTokenInputToken>
    ),
    [disabled, readOnly],
  );

  const tokenControl = (
    <FieldControlBridge id={id} ariaLabel={resolvedAriaLabel} invalid={isInvalid}>
      {(fieldAttrs) => (
        <div
          ref={ref}
          data-slot="token-input"
          data-size={size}
          data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
          data-disabled={disabled ? '' : undefined}
          className={cx('nx-token-input-box', className)}
        >
          <SdkTokenInput
            value={shownParts}
            onValueChange={handleValueChange}
            disabled={disabled}
            readOnly={readOnly}
            required={required}
            name={name}
            controller={controller}
            renderToken={renderToken ? (t) => renderToken(t as TokenItem) : defaultRenderToken}
          >
            <SdkTokenInputEditor
              id={fieldAttrs.id}
              placeholder={placeholder}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              aria-label={fieldAttrs['aria-label']}
              aria-labelledby={fieldAttrs['aria-labelledby']}
              aria-describedby={fieldAttrs['aria-describedby']}
              aria-invalid={fieldAttrs['aria-invalid'] || undefined}
              className={cx('nx-token-editor', editorClassName)}
            />
            {children}
          </SdkTokenInput>
        </div>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(tokenControl, {
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

/** Inline tokenized chip editor: Enter, a comma, a pasted list or leaving the box turns typed text into removable chips. */
export const TokenInput = Object.assign(TokenInputRoot, {
  Root: TokenInputRoot,
  Editor: TokenEditorPart,
  Token: TokenChipPart,
  TokenRemove: TokenChipRemovePart,
});

/** Props for `TagInput`. */
export type TagInputProps = TokenInputProps;

/** Tag chip input alias for `TokenInput`. */
export const TagInput = TokenInput;

/* ============================================================================
 * FileDropzone
 * ========================================================================== */

/** Props for the `FileDropzone` drag-and-drop upload area. */
export interface FileDropzoneProps extends Omit<CleanElementProps<'div'>, 'title' | 'defaultValue'>, FieldFrameProps {
  value?: File[];
  defaultValue?: File[];
  onValueChange?: (files: File[]) => void;
  accept?: string | string[];
  maxSize?: number;
  maxFiles?: number;
  multiple?: boolean;
  disabled?: boolean;
  name?: string;
  title?: React.ReactNode;
  dropzoneDescription?: React.ReactNode;
  triggerLabel?: React.ReactNode;
  compact?: boolean;
  showFileList?: boolean;
  invalid?: boolean;
  words?: { removeFile?: (name: string) => string; dropHint?: string };
  fieldClassName?: string;
}

function FileDropzoneBoxPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkFileInputDropzone aria-label={ariaLabel} className={cx('nx-dropzone', className)} {...props} />;
}

function FileDropzoneTriggerPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>) {
  return <SdkFileInputTrigger aria-label={ariaLabel} className={cx('nx-dropzone-trigger', className)} {...props} />;
}

function FileDropzoneListPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkFileInputList aria-label={ariaLabel} className={cx('nx-file-list', className)} {...props} />;
}

function FileDropzoneItemPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkFileInputItem aria-label={ariaLabel} className={cx('nx-file-item', className)} {...props} />;
}

function FileDropzoneItemRemovePart({ ariaLabel, className, ...props }: CleanElementProps<'button'>) {
  return <SdkFileInputItemRemove aria-label={ariaLabel} className={cx('nx-file-item-remove', className)} {...props} />;
}

function FileDropzoneRoot(props: FileDropzoneProps): React.JSX.Element {
  const {
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    fieldClassName,
    title = 'Drop files here, or click to browse',
    dropzoneDescription,
    triggerLabel = 'Browse files',
    compact = false,
    showFileList = true,
    invalid,
    words,
    value,
    defaultValue,
    onValueChange,
    accept,
    maxSize,
    maxFiles,
    multiple = true,
    disabled,
    name,
    ariaLabel,
    className,
    children,
    ...rest
  } = props;

  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);

  const autoConstraintText = React.useMemo(() => {
    if (dropzoneDescription !== undefined) return dropzoneDescription;
    const parts: string[] = [];
    if (accept) {
      parts.push(Array.isArray(accept) ? accept.join(', ') : String(accept));
    }
    if (typeof maxSize === 'number') {
      parts.push(`up to ${formatFileSize(maxSize)}`);
    }
    if (typeof maxFiles === 'number' && multiple) {
      parts.push(`max ${maxFiles} files`);
    }
    return parts.length > 0 ? parts.join(' • ') : (words?.dropHint ?? 'Supports drag & drop or clipboard paste');
  }, [dropzoneDescription, accept, maxSize, maxFiles, multiple, words]);

  const fileControl = (
    <SdkFileInput
      {...rest}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange ? (files) => onValueChange(files) : undefined}
      accept={accept}
      maxSize={maxSize}
      maxFiles={maxFiles}
      multiple={multiple}
      disabled={disabled}
      required={required}
      name={name}
      aria-label={resolvedAriaLabel}
      className={cx('nx-file-input', className)}
    >
      {children ?? (
        <>
          <SdkFileInputDropzone data-compact={compact ? '' : undefined} data-invalid={isInvalid ? '' : undefined} className="nx-dropzone">
            <span className="nx-dropzone-icon" aria-hidden="true">
              <Icon name="upload-simple" size={compact ? 18 : 22} />
            </span>
            <div className="nx-dropzone-copy">
              <span className="nx-dropzone-title">{title}</span>
              {autoConstraintText ? <span className="nx-dropzone-hint">{autoConstraintText}</span> : null}
            </div>
            <SdkFileInputTrigger data-slot="button" data-variant="secondary" data-size="sm" className="nx-dropzone-trigger">
              {triggerLabel}
            </SdkFileInputTrigger>
          </SdkFileInputDropzone>

          {showFileList ? (
            <SdkFileInputList className="nx-file-list">
              <SdkFileInputItem className="nx-file-item">
                {(itemState) => (
                  <>
                    <span className="nx-file-item-icon" aria-hidden="true">
                      <Icon name="file-text" size={16} />
                    </span>
                    <div className="nx-file-item-info">
                      <span className="nx-file-item-name">{itemState.file.name}</span>
                      <span className="nx-file-item-size">{formatFileSize(itemState.file.size)}</span>
                    </div>
                    {!disabled ? (
                      <SdkFileInputItemRemove
                        aria-label={words?.removeFile ? words.removeFile(itemState.file.name) : `Remove ${itemState.file.name}`}
                        className="nx-file-item-remove nx-focusable"
                      >
                        <Icon name="x" size={13} weight="bold" />
                      </SdkFileInputItemRemove>
                    ) : null}
                  </>
                )}
              </SdkFileInputItem>
            </SdkFileInputList>
          ) : null}
        </>
      )}
    </SdkFileInput>
  );

  return wrapWithField(fileControl, {
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

/** Drag-and-drop file upload surface with accept/size constraints and removable file queue. */
export const FileDropzone = Object.assign(FileDropzoneRoot, {
  Root: FileDropzoneRoot,
  Dropzone: FileDropzoneBoxPart,
  Trigger: FileDropzoneTriggerPart,
  List: FileDropzoneListPart,
  Item: FileDropzoneItemPart,
  ItemRemove: FileDropzoneItemRemovePart,
});

export { MaskedField, MoneyField, type MaskedFieldProps, type MoneyFieldProps } from '../TextField.js';
