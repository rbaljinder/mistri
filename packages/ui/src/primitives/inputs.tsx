/**
 * Field framing, labels, single-line text inputs, auto-growing textareas, and password
 * visibility controls built over UI SDK's form primitives, alongside Mistri's slotted fields.
 */
import * as React from 'react';
import { Label as SdkLabel } from '@ui-sdk/react/label';
import { Input as SdkInput, InputClear as SdkInputClear, InputGroup as SdkInputGroup } from '@ui-sdk/react/input';
import {
  PasswordInput as SdkPasswordInput,
  PasswordInputControl as SdkPasswordInputControl,
  PasswordInputToggle as SdkPasswordInputToggle,
} from '@ui-sdk/react/password-input';
import { Icon } from '../Icon.js';
import { cx, type ControlSize, type Tone } from '../internal/cx.js';
import { FieldControlBridge, wrapWithField, type FieldFrameProps } from './fieldShell.js';

export type { FieldFrameProps };

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<
  React.ComponentProps<T>,
  'onChange' | 'aria-label' | 'inlist'
> & {
  ariaLabel?: string;
};

/* ============================================================================
 * Label
 * ========================================================================== */

/** Props for the `Label` form caption element. */
export type LabelProps = CleanElementProps<'label'>;

/** Accessible `<label>` element styled for form controls. */
export function Label({ ariaLabel, className, ...rest }: LabelProps): React.ReactElement | null {
  const resolvedAriaLabel = ariaLabel ?? (rest as { 'aria-label'?: string })['aria-label'];
  return <SdkLabel {...rest} aria-label={resolvedAriaLabel} className={cx('nx-field-label', className)} />;
}

/* ============================================================================
 * Input
 * ========================================================================== */

/** Props for the `Input` single-line text control. */
export interface TextInputProps extends Omit<CleanElementProps<'input'>, 'size' | 'prefix' | 'value' | 'defaultValue'>, FieldFrameProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  size?: ControlSize;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  clearable?: boolean;
  clearLabel?: string;
  shortcut?: string;
  invalid?: boolean;
  monospace?: boolean;
  groupClassName?: string;
  fieldClassName?: string;
}

function InputGroupPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkInputGroup aria-label={ariaLabel} className={cx('nx-input-group', className)} {...props} />;
}

function InputClearPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>) {
  return <SdkInputClear aria-label={ariaLabel} className={cx('nx-input-clear', className)} {...props} />;
}

function InputRoot(props: TextInputProps): React.JSX.Element | null {
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
    value,
    defaultValue,
    onValueChange,
    size = 'md',
    leadingIcon,
    trailingIcon,
    prefix,
    suffix,
    clearable = false,
    clearLabel = 'Clear input',
    shortcut,
    invalid,
    monospace = false,
    disabled,
    name,
    ariaLabel,
    className,
    groupClassName,
    ...rest
  } = props;

  const legacyOnChange = (props as unknown as { onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void }).onChange;
  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);
  const showClear = clearable && !disabled && !rest.readOnly;
  const hasDecorations =
    Boolean(leadingIcon) || Boolean(trailingIcon) || prefix !== undefined || suffix !== undefined || clearable || Boolean(shortcut);

  const sdkInputEl = (
    <SdkInput
      {...rest}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange ? (next) => onValueChange(next) : undefined}
      onChange={legacyOnChange}
      aria-label={resolvedAriaLabel}
      name={name}
      required={required}
      disabled={disabled}
      data-size={size}
      data-invalid={!hasDecorations && isInvalid ? '' : undefined}
      data-monospace={monospace ? '' : undefined}
      aria-invalid={isInvalid ? true : rest['aria-invalid']}
      className={cx('nx-input', className)}
    />
  );

  const control = !hasDecorations ? (
    sdkInputEl
  ) : (
    <SdkInputGroup
      data-size={size}
      data-invalid={isInvalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cx('nx-input-group', groupClassName)}
    >
      {prefix !== undefined && prefix !== null ? (
        <span className="nx-input-affix" data-side="start">
          {prefix}
        </span>
      ) : null}
      {leadingIcon ? (
        <span className="nx-input-icon" data-side="start" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      {sdkInputEl}
      {showClear ? (
        <SdkInputClear className="nx-input-clear" aria-label={clearLabel}>
          <Icon name="x" size={13} weight="bold" />
        </SdkInputClear>
      ) : null}
      {trailingIcon ? (
        <span className="nx-input-icon" data-side="end" aria-hidden="true">
          {trailingIcon}
        </span>
      ) : null}
      {shortcut ? <kbd className="nx-kbd nx-input-kbd">{shortcut}</kbd> : null}
      {suffix !== undefined && suffix !== null ? (
        <span className="nx-input-affix" data-side="end">
          {suffix}
        </span>
      ) : null}
    </SdkInputGroup>
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

/** Single-line text input supporting adornments, clear button, keyboard shortcut badge, and field framing. */
export const Input = Object.assign(InputRoot, {
  Group: InputGroupPart,
  Clear: InputClearPart,
});

/* ============================================================================
 * PasswordInput
 * ========================================================================== */

function computePasswordStrength(password: string): {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  tone: Tone;
} {
  if (!password) return { score: 0, label: 'Enter a password', tone: 'neutral' };
  let pts = 0;
  if (password.length >= 8) pts += 1;
  if (password.length >= 12) pts += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) pts += 1;
  if (/\d/.test(password) && /[^a-zA-Z0-9]/.test(password)) {
    pts += 1;
  } else if (/\d|[^a-zA-Z0-9]/.test(password) && password.length >= 10) {
    pts += 1;
  }
  const clamped = Math.max(1, Math.min(4, pts)) as 1 | 2 | 3 | 4;
  const map: Record<1 | 2 | 3 | 4, { label: string; tone: Tone }> = {
    1: { label: 'Weak', tone: 'critical' },
    2: { label: 'Fair', tone: 'warning' },
    3: { label: 'Good', tone: 'info' },
    4: { label: 'Strong', tone: 'good' },
  };
  return { score: clamped, ...map[clamped] };
}

/** Props for the `PasswordInput` visibility-toggleable secret field. */
export interface PasswordInputProps extends FieldFrameProps {
  id?: string;
  name?: string;
  form?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  visible?: boolean;
  defaultVisible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  disabled?: boolean;
  readOnly?: boolean;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  ariaLabel?: string;
  'aria-describedby'?: string;
  size?: ControlSize;
  leadingIcon?: React.ReactNode;
  showStrength?: boolean;
  invalid?: boolean;
  monospace?: boolean;
  copyable?: boolean;
  toggleLabel?: string;
  capsLockTitle?: string;
  copyLabel?: string;
  copiedLabel?: string;
  className?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
}

function PasswordInputControlPart({ ariaLabel, className, ...props }: CleanElementProps<'input'>) {
  return <SdkPasswordInputControl aria-label={ariaLabel} className={cx('nx-password-control', className)} {...props} />;
}

function PasswordInputTogglePart({ ariaLabel, className, ...props }: CleanElementProps<'button'>) {
  return <SdkPasswordInputToggle aria-label={ariaLabel} className={cx('nx-password-toggle', className)} {...props} />;
}

function PasswordInputRoot(props: PasswordInputProps): React.JSX.Element {
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
    leadingIcon,
    showStrength = false,
    invalid,
    monospace = false,
    copyable = false,
    toggleLabel = 'Show password',
    capsLockTitle = 'Caps Lock is on',
    copyLabel = 'Copy value',
    copiedLabel = 'Copied',
    value,
    defaultValue,
    onValueChange,
    visible,
    defaultVisible,
    onVisibleChange,
    autoComplete,
    name,
    form,
    disabled,
    readOnly,
    ariaLabel,
    className,
    ref,
    ...controlProps
  } = props;

  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const [internalVal, setInternalVal] = React.useState<string>(() => value ?? defaultValue ?? '');
  const [copied, setCopied] = React.useState(false);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const currentValue = value !== undefined ? value : internalVal;
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);

  const handleValueChange = React.useCallback(
    (next: string) => {
      if (value === undefined) {
        setInternalVal(next);
      }
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const handleCopy = async () => {
    if (!currentValue || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(currentValue);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard failures silently
    }
  };

  const strength = showStrength ? computePasswordStrength(currentValue) : null;

  const passwordBox = (
    <FieldControlBridge
      id={controlProps.id}
      ariaLabel={resolvedAriaLabel}
      ariaDescribedBy={controlProps['aria-describedby']}
      invalid={isInvalid}
    >
      {(fieldAttrs) => (
        <div className="nx-password-stack">
          <SdkPasswordInput
            value={value}
            defaultValue={defaultValue}
            onValueChange={handleValueChange}
            visible={visible}
            defaultVisible={defaultVisible}
            onVisibleChange={onVisibleChange ? (next) => onVisibleChange(next) : undefined}
            autoComplete={autoComplete}
            name={name}
            form={form}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            data-size={size}
            data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
            className={cx('nx-password-input', className)}
          >
            {(state) => (
              <>
                {leadingIcon ? (
                  <span className="nx-input-icon" data-side="start" aria-hidden="true">
                    {leadingIcon}
                  </span>
                ) : null}
                <SdkPasswordInputControl
                  {...controlProps}
                  ref={ref}
                  id={fieldAttrs.id}
                  aria-label={fieldAttrs['aria-label']}
                  aria-labelledby={fieldAttrs['aria-labelledby']}
                  aria-describedby={fieldAttrs['aria-describedby']}
                  aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                  data-monospace={monospace ? '' : undefined}
                  className="nx-password-control"
                />
                {state.capsLock ? (
                  <span className="nx-caps-badge" title={capsLockTitle}>
                    CAPS
                  </span>
                ) : null}
                {copyable ? (
                  <button
                    type="button"
                    onClick={handleCopy}
                    disabled={!currentValue || disabled}
                    aria-label={copied ? copiedLabel : copyLabel}
                    title={copied ? copiedLabel : copyLabel}
                    className="nx-input-action nx-focusable"
                  >
                    {copied ? <Icon name="check" size={14} weight="bold" /> : <Icon name="copy" size={14} />}
                  </button>
                ) : null}
                <SdkPasswordInputToggle aria-label={toggleLabel} className="nx-password-toggle">
                  {(toggleState) => (toggleState.visible ? <Icon name="eye-slash" size={15} /> : <Icon name="eye" size={15} />)}
                </SdkPasswordInputToggle>
              </>
            )}
          </SdkPasswordInput>
          {strength ? (
            <div className="nx-password-strength" data-tone={strength.tone}>
              <div className="nx-password-strength-bars" aria-hidden="true">
                {[1, 2, 3, 4].map((segment) => (
                  <span key={segment} className="nx-password-strength-bar" data-active={strength.score >= segment ? '' : undefined} />
                ))}
              </div>
              <span className="nx-password-strength-label">{strength.label}</span>
            </div>
          ) : null}
        </div>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(passwordBox, {
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

/** Single-box password input with reveal toggle, Caps Lock indicator, optional copy action, and strength meter. */
export const PasswordInput = Object.assign(PasswordInputRoot, {
  Root: PasswordInputRoot,
  Control: PasswordInputControlPart,
  Toggle: PasswordInputTogglePart,
});

export { Field, type AnswerKind, type FieldControlProps, type FieldProps } from '../Field.js';
export { FileField, type FileFieldProps } from '../FileField.js';
export { SensitiveField, type SensitiveFieldProps } from '../SensitiveField.js';
export { TextArea, type TextAreaProps } from '../TextArea.js';
export { TextField, ValidMark, type TextFieldProps, type ValidMarkProps } from '../TextField.js';
