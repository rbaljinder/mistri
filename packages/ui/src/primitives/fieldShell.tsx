/** Internal field shell and ARIA control-attribute bridge shared across form primitives. */
import * as React from 'react';
import { Field as SdkField, FieldDescription, FieldError, FieldLabel, useFieldControl, type FieldState } from '@ui-sdk/react/field';
import { cx } from '../internal/cx.js';

/** Shared field framing props (`label`, `hint`, `error`, `optional`, `required`) accepted by form primitives. */
export interface FieldFrameProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  problem?: React.ReactNode;
  optional?: React.ReactNode | boolean;
  required?: boolean;
  labelTrailing?: React.ReactNode;
}

type SdkFieldBaseProps = React.ComponentProps<typeof SdkField>;

interface FieldShellProps extends Omit<SdkFieldBaseProps, 'children'>, FieldFrameProps {
  orientation?: 'vertical' | 'horizontal';
  children?: React.ReactNode | ((state: FieldState) => React.ReactNode);
}

function FieldShell({
  label,
  hint,
  description,
  error,
  problem,
  optional,
  required,
  labelTrailing,
  orientation = 'vertical',
  invalid,
  className,
  children,
  ...rest
}: FieldShellProps): React.JSX.Element {
  const resolvedError = problem ?? error;
  const hasError = resolvedError !== undefined && resolvedError !== null && resolvedError !== false && resolvedError !== '';
  const resolvedInvalid = invalid ?? (hasError ? true : undefined);
  const resolvedHint = hint ?? description;
  const isShorthand =
    label !== undefined || resolvedHint !== undefined || hasError || optional !== undefined || labelTrailing !== undefined;

  const resolvedClassName =
    typeof className === 'function' ? (state: FieldState) => cx('nx-field', className(state)) : cx('nx-field', className);

  const optionalBadge =
    optional !== undefined && optional !== false && !required ? (
      <span data-slot="field-optional" className="nx-field-optional">
        {typeof optional === 'boolean' ? 'Optional' : optional}
      </span>
    ) : null;

  return (
    <SdkField {...rest} invalid={resolvedInvalid} data-orientation={orientation} className={resolvedClassName}>
      {isShorthand
        ? (state) => {
            const controlContent = typeof children === 'function' ? children(state) : children;
            return (
              <>
                {(label !== undefined || optionalBadge || labelTrailing) && (
                  <div data-slot="field-head" className="nx-field-header">
                    {label !== undefined ? (
                      <div className="nx-field-label-wrap">
                        <FieldLabel className="nx-field-label">{label}</FieldLabel>
                        {required ? (
                          <span data-slot="field-required" className="nx-field-required" aria-hidden="true">
                            *
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span />
                    )}
                    {(labelTrailing || optionalBadge) && (
                      <div className="nx-field-meta">
                        {optionalBadge}
                        {labelTrailing}
                      </div>
                    )}
                  </div>
                )}
                <div className="nx-field-body">
                  {controlContent}
                  {resolvedHint !== undefined && resolvedHint !== null ? (
                    <FieldDescription className="nx-field-hint">{resolvedHint}</FieldDescription>
                  ) : null}
                  {hasError ? <FieldError className="nx-field-error">{resolvedError}</FieldError> : null}
                </div>
              </>
            );
          }
        : children}
    </SdkField>
  );
}

/** Internal helper wrapping a control in `<FieldShell>` only when frame metadata is supplied. */
export function wrapWithField(
  control: React.ReactNode,
  frame: FieldFrameProps & {
    name?: string;
    disabled?: boolean;
    invalid?: boolean;
    fieldClassName?: string;
  },
): React.JSX.Element {
  const { label, hint, description, error, problem, optional, required, labelTrailing, name, disabled, invalid, fieldClassName } = frame;
  const resolvedError = problem ?? error;

  const hasFrame =
    label !== undefined ||
    hint !== undefined ||
    description !== undefined ||
    (resolvedError !== undefined && resolvedError !== null && resolvedError !== false && resolvedError !== '') ||
    optional !== undefined ||
    labelTrailing !== undefined;

  if (!hasFrame) {
    return <>{control}</>;
  }

  return (
    <FieldShell
      name={name}
      disabled={disabled}
      invalid={invalid}
      label={label}
      hint={hint}
      description={description}
      error={resolvedError}
      optional={optional}
      required={required}
      labelTrailing={labelTrailing}
      className={fieldClassName}
    >
      {control}
    </FieldShell>
  );
}

/** Resolved accessibility attributes bridged from an enclosing `<Field>`. */
export interface ResolvedFieldControlAttrs {
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/** Internal bridge resolving `<Field>` context (`id`, `aria-labelledby`, `aria-describedby`, `aria-invalid`) inside `wrapWithField`. */
export function FieldControlBridge({
  id: explicitId,
  ariaLabel,
  explicitAriaLabel = false,
  ariaLabelledBy,
  ariaDescribedBy,
  invalid,
  children,
}: {
  id?: string;
  ariaLabel?: string;
  explicitAriaLabel?: boolean;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  invalid?: boolean;
  children: (attrs: ResolvedFieldControlAttrs) => React.ReactNode;
}): React.JSX.Element {
  const raw = useFieldControl()?.props({}) as Record<string, unknown> | undefined;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const inheritFieldIdentity = !explicitAriaLabel || Boolean(ariaLabelledBy);
  const fieldId = inheritFieldIdentity ? text(raw?.id) : undefined;
  const fieldLabelledBy = inheritFieldIdentity ? text(raw?.['aria-labelledby']) : undefined;
  const fieldDescribedBy = inheritFieldIdentity ? text(raw?.['aria-describedby']) : undefined;
  const fieldInvalid = raw?.['aria-invalid'] === true || raw?.['aria-invalid'] === 'true';
  const mergedDescribedBy =
    [ariaDescribedBy, fieldDescribedBy && fieldDescribedBy !== ariaDescribedBy ? fieldDescribedBy : undefined].filter(Boolean).join(' ') ||
    undefined;
  const resolvedLabelledBy = ariaLabelledBy ?? fieldLabelledBy;
  return (
    <>
      {children({
        id: explicitId ?? fieldId,
        'aria-label': resolvedLabelledBy ? undefined : ariaLabel,
        'aria-labelledby': resolvedLabelledBy,
        'aria-describedby': mergedDescribedBy,
        'aria-invalid': invalid || fieldInvalid ? true : undefined,
      })}
    </>
  );
}
