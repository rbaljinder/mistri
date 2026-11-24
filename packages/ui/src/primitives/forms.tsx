/** Multi-column form sections, field column grids, and sticky form action bars. */
import * as React from 'react';
import { cx } from '../internal/cx.js';

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<
  React.ComponentProps<T>,
  'onChange' | 'aria-label' | 'inlist'
> & {
  ariaLabel?: string;
};

/* ============================================================================
 * FormSection
 * ========================================================================== */

/** Props for the `FormSection` titled field group. */
export interface FormSectionProps extends Omit<CleanElementProps<'section'>, 'title'> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  footer?: React.ReactNode;
  layout?: 'horizontal' | 'stacked';
  bordered?: boolean;
  children: React.ReactNode;
}

/** Titled form section pairing an introductory heading/description column with a stack of fields. */
export function FormSection({
  title,
  description,
  aside,
  footer,
  layout = 'horizontal',
  bordered = true,
  ariaLabel,
  className,
  children,
  ...rest
}: FormSectionProps): React.JSX.Element {
  const hasIntro = title !== undefined || description !== undefined || aside !== undefined;

  return (
    <section
      aria-label={ariaLabel}
      data-slot="form-section"
      data-layout={hasIntro ? layout : 'stacked'}
      data-bordered={bordered ? '' : undefined}
      className={cx('nx-form-section', className)}
      {...rest}
    >
      {hasIntro ? (
        <div className="nx-form-section-intro">
          <div className="nx-form-section-heading-group">
            {title !== undefined ? <h3 className="nx-form-section-title">{title}</h3> : null}
            {description !== undefined ? <p className="nx-form-section-description">{description}</p> : null}
          </div>
          {aside !== undefined ? <div className="nx-form-section-aside">{aside}</div> : null}
        </div>
      ) : null}

      <div className="nx-form-section-body">
        <div className="nx-form-section-fields">{children}</div>
        {footer !== undefined ? <div className="nx-form-section-footer">{footer}</div> : null}
      </div>
    </section>
  );
}

/* ============================================================================
 * FormColumns & FormActions
 * ========================================================================== */

/** Props for the `FormColumns` multi-column form field grid. */
export interface FormColumnsProps extends CleanElementProps<'div'> {
  columns?: 1 | 2 | 3 | 4;
  gap?: 'sm' | 'md' | 'lg';
  align?: 'start' | 'center' | 'end' | 'stretch';
}

/** Responsive multi-column grid for arranging related form fields side by side. */
export function FormColumns({
  columns = 2,
  gap = 'md',
  align = 'start',
  ariaLabel,
  className,
  children,
  ...rest
}: FormColumnsProps): React.JSX.Element {
  return (
    <div
      aria-label={ariaLabel}
      data-slot="form-columns"
      data-columns={columns}
      data-gap={gap}
      data-align={align}
      className={cx('nx-form-columns', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Props for the `FormActions` submit/cancel button footer. */
export interface FormActionsProps extends CleanElementProps<'div'> {
  align?: 'start' | 'end' | 'between';
  bordered?: boolean;
  sticky?: boolean;
}

/** Form footer bar aligning primary and secondary form action buttons. */
export function FormActions({
  align = 'end',
  bordered = true,
  sticky = false,
  ariaLabel,
  className,
  children,
  ...rest
}: FormActionsProps): React.JSX.Element {
  return (
    <div
      aria-label={ariaLabel}
      data-slot="form-actions"
      data-align={align}
      data-bordered={bordered ? '' : undefined}
      data-sticky={sticky ? '' : undefined}
      className={cx('nx-form-actions', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export {
  ActionBar,
  ProgressBar,
  ReviewList,
  StepHeader,
  type ActionBarProps,
  type ProgressBarProps,
  type ReviewListProps,
  type StepHeaderProps,
} from '../FormParts.js';
