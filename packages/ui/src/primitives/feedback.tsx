/** Inline alerts, callouts, empty states, loading skeletons, meters, and toast notifications. */
'use client';

import { Icon } from '../Icon.js';
import {
  Meter as SdkMeter,
  MeterIndicator as SdkMeterIndicator,
  MeterLabel as SdkMeterLabel,
  MeterTrack as SdkMeterTrack,
  MeterValue as SdkMeterValue,
} from '@ui-sdk/react/meter';
import {
  Toast as SdkToast,
  ToastAction as SdkToastAction,
  ToastClose as SdkToastClose,
  ToastDescription as SdkToastDescription,
  ToastRegion as SdkToastRegion,
  ToastTitle as SdkToastTitle,
} from '@ui-sdk/react/toast';
import type { CSSProperties, ComponentProps, ReactNode, Ref } from 'react';
import { cx, toDataTone, toKitTone, type ControlSize, type Tone } from '../internal/cx.js';
import { useSurfaceSeam } from '../internal/surfaceSeam.js';

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<ComponentProps<T>, 'onChange' | 'aria-label' | 'inlist'> & {
  ariaLabel?: string;
};

/* ============================================================================
 * 1. Toaster & Imperative toast (Self-contained types without __UiBag / any)
 * ========================================================================== */

/** Semantic notification category for toast messages. */
export type ToastType = 'default' | 'info' | 'success' | 'warning' | 'error' | 'loading';

/** Action button configuration for a toast notification. */
export interface ToastActionSpec {
  label: ReactNode;
  onClick: () => void;
}

/** Cancel button configuration for a toast notification. */
export interface ToastCancelSpec {
  label: ReactNode;
  onCancel?: () => void;
}

/** Payload describing a single toast notification. */
export interface ToastData<Data = ReactNode> {
  id?: string;
  type: ToastType;
  title?: Data;
  description?: Data;
  duration?: number;
  dismissible?: boolean;
  action?: ToastActionSpec;
  cancel?: ToastCancelSpec;
}

/** Options accepted when dispatching a toast notification. */
export interface ToastOptions<Data = ReactNode> {
  id?: string;
  type?: ToastType;
  title?: Data;
  description?: Data;
  duration?: number;
  dismissible?: boolean;
  action?: ToastActionSpec;
  cancel?: ToastCancelSpec;
}

/** Active toast queue item passed to custom `Toaster` render functions. */
export interface ToastItem<Data = ReactNode> {
  id: string;
  data: ToastData<Data>;
}

/** Imperative toast controller returned by `createToaster`. */
export interface ToastController<Data = ReactNode> {
  show: (options: ToastOptions<Data> | Data) => string;
  success: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
  error: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
  warning: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
  info: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
  loading: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
  dismiss: (id?: string) => void;
}

/** Placement and queue props for the toast region container. */
export interface ToastRegionProps {
  toaster?: ToastController<ReactNode>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  maxVisible?: number;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}

function renderToastIcon(type: ToastType): ReactNode {
  switch (type) {
    case 'success':
      return <Icon name="check-circle" size={17} weight="bold" />;
    case 'error':
      return <Icon name="x-circle" size={17} weight="bold" />;
    case 'warning':
      return <Icon name="warning" size={17} weight="bold" />;
    case 'info':
      return <Icon name="info" size={17} weight="bold" />;
    case 'loading':
      return <span className="nx-spinner" />;
    default:
      return null;
  }
}

/** Props for the `Toaster` viewport region. */
export interface ToasterProps extends ToastRegionProps {
  words?: { dismiss?: string };
  children?: (toastData: ToastData<ReactNode>, item: ToastItem<ReactNode>) => ReactNode;
}

function ToasterRegionPart({ ariaLabel, className, children, ...props }: ToastRegionProps & { children?: ReactNode }) {
  return (
    <SdkToastRegion aria-label={ariaLabel} className={cx('nx-toast-region', className)} {...(props as Record<string, unknown>)}>
      {children as never}
    </SdkToastRegion>
  );
}

function ToastCardPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkToast aria-label={ariaLabel} className={cx('nx-toast', className)} {...(props as unknown as Record<string, unknown>)} />;
}

function ToastTitlePart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkToastTitle aria-label={ariaLabel} className={cx('nx-toast-title', className)} {...props} />;
}

function ToastDescriptionPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkToastDescription aria-label={ariaLabel} className={cx('nx-toast-description', className)} {...props} />;
}

function ToastActionPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>) {
  return <SdkToastAction aria-label={ariaLabel} className={cx('nx-toast-action-btn', className)} {...props} />;
}

function ToastClosePart({ ariaLabel, className, action, ...props }: CleanElementProps<'button'> & { action?: () => void }) {
  return <SdkToastClose aria-label={ariaLabel} action={action} className={cx('nx-toast-close-btn', className)} {...props} />;
}

function ToasterBase({
  toaster,
  side = 'bottom',
  align = 'end',
  maxVisible = 4,
  ariaLabel,
  className,
  style,
  ref,
  words,
  children,
}: ToasterProps) {
  const dismissLabel = words?.dismiss ?? 'Dismiss notification';
  return (
    <SdkToastRegion
      ref={ref}
      toaster={toaster as never}
      side={side}
      align={align}
      maxVisible={maxVisible}
      aria-label={ariaLabel}
      className={cx('nx-toast-region', className)}
      style={style}
    >
      {children
        ? (t: unknown, item: unknown) => children(t as ToastData<ReactNode>, item as ToastItem<ReactNode>)
        : (t) => {
            const icon = renderToastIcon(t.type as ToastType);
            return (
              <SdkToast className="nx-toast" data-type={t.type}>
                {icon !== null && (
                  <span className="nx-toast-icon" data-type={t.type} aria-hidden="true">
                    {icon}
                  </span>
                )}
                <div className="nx-toast-body">
                  {t.title != null && <SdkToastTitle className="nx-toast-title" />}
                  {t.description != null && <SdkToastDescription className="nx-toast-description" />}
                </div>
                {(t.action || t.cancel) && (
                  <div className="nx-toast-actions">
                    {t.action && <SdkToastAction className="nx-toast-action-btn" />}
                    {t.cancel && (
                      <SdkToastClose action={t.cancel.onCancel} className="nx-toast-cancel-btn">
                        {t.cancel.label}
                      </SdkToastClose>
                    )}
                  </div>
                )}
                {t.dismissible !== false && !t.cancel && (
                  <SdkToastClose className="nx-toast-close-btn" aria-label={dismissLabel}>
                    <Icon name="x" size={14} weight="bold" />
                  </SdkToastClose>
                )}
              </SdkToast>
            );
          }}
    </SdkToastRegion>
  );
}

/** Accessible toast notification region rendering stacked alerts in the viewport corner. */
export const Toaster = Object.assign(ToasterBase, {
  Region: ToasterRegionPart,
  Toast: ToastCardPart,
  Title: ToastTitlePart,
  Description: ToastDescriptionPart,
  Action: ToastActionPart,
  Close: ToastClosePart,
});

/* ============================================================================
 * 2. Alert / Callout
 * ========================================================================== */

function defaultAlertIcon(dataTone: Tone): ReactNode {
  switch (dataTone) {
    case 'good':
      return <Icon name="check-circle" size={17} weight="bold" />;
    case 'warning':
      return <Icon name="warning" size={17} weight="bold" />;
    case 'critical':
      return <Icon name="x-circle" size={17} weight="bold" />;
    case 'info':
    case 'accent':
    case 'neutral':
    default:
      return <Icon name="info" size={17} weight="bold" />;
  }
}

/** Props for the `Alert` inline banner. */
export interface AlertProps extends Omit<CleanElementProps<'div'>, 'title'> {
  tone?: Tone;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode | false;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

/** Inline status alert banner with semantic tone icon, title, description, and optional dismiss action. */
export function Alert({
  tone = 'neutral',
  title,
  description,
  icon,
  action,
  onDismiss,
  dismissLabel = 'Dismiss alert',
  role,
  ariaLabel,
  className,
  children,
  ...props
}: AlertProps) {
  const dataTone = toDataTone(tone) ?? 'neutral';
  const resolvedIcon = icon === false ? null : (icon ?? defaultAlertIcon(dataTone));
  const resolvedRole = role ?? (dataTone === 'critical' || dataTone === 'warning' ? 'alert' : 'status');

  return (
    <div role={resolvedRole} aria-label={ariaLabel} data-tone={dataTone} className={cx('nx-alert', className)} {...props}>
      {resolvedIcon !== null && (
        <span className="nx-alert-icon" aria-hidden="true">
          {resolvedIcon}
        </span>
      )}
      <div className="nx-alert-content">
        {title !== undefined && <div className="nx-alert-title">{title}</div>}
        {description !== undefined && <div className="nx-alert-description">{description}</div>}
        {children}
      </div>
      {action !== undefined && <div className="nx-alert-actions">{action}</div>}
      {onDismiss !== undefined && (
        <button type="button" onClick={onDismiss} className="nx-alert-dismiss" aria-label={dismissLabel}>
          <Icon name="x" size={14} weight="bold" />
        </button>
      )}
    </div>
  );
}

/** Contextual callout banner alias for `Alert`. */
export const Callout = Alert;

/** Props for `Callout`. */
export type CalloutProps = AlertProps;

/* ============================================================================
 * 3. EmptyState
 * ========================================================================== */

/** Props for the `EmptyState` placeholder block. */
export interface EmptyStateProps extends Omit<CleanElementProps<'div'>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  compact?: boolean;
}

/** Placeholder card shown when a collection, search, or view has no items to display. */
export function EmptyState({
  icon,
  title,
  body,
  description,
  action,
  secondaryAction,
  compact = false,
  ariaLabel,
  className,
  children,
  ...props
}: EmptyStateProps) {
  const detail = body ?? description;
  return (
    <div aria-label={ariaLabel} data-compact={compact ? '' : undefined} className={cx('nx-empty-state', className)} {...props}>
      {icon !== undefined && (
        <div className="nx-empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="nx-empty-state-copy">
        <h3 className="nx-empty-state-title">{title}</h3>
        {detail !== undefined && <p className="nx-empty-state-description">{detail}</p>}
      </div>
      {children}
      {(action !== undefined || secondaryAction !== undefined) && (
        <div className="nx-empty-state-actions">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 4. Skeleton, SkeletonText & SkeletonCard
 * ========================================================================== */

/** Props for the `Skeleton` loading placeholder bar. */
export interface SkeletonProps extends CleanElementProps<'span'> {
  width?: number | string;
  height?: number | string;
  lines?: number;
  circle?: boolean;
  radius?: 'xs' | 'sm' | 'md' | 'lg' | 'full';
}

/** Presentational loading placeholder bar or multi-line stack (`aria-hidden="true"`). */
export function Skeleton({ width, height, lines, circle = false, radius, ariaLabel, className, style, ref, ...props }: SkeletonProps) {
  const borderRadius = circle
    ? '9999px'
    : radius === 'sm'
      ? 'max(0px, calc(var(--radius) - 2px))'
      : radius === 'lg'
        ? 'var(--radius-card)'
        : radius
          ? 'var(--radius)'
          : undefined;

  if (lines !== undefined && lines > 1) {
    const count = Math.max(1, Math.floor(lines));
    return (
      <span
        ref={ref}
        aria-hidden="true"
        aria-label={ariaLabel}
        className={cx('kit-skeleton nx-skeleton-text', className)}
        style={style}
        {...props}
      >
        {Array.from({ length: count }, (_, at) => (
          <span
            key={at}
            className="sk-bar kit-skeleton-bar nx-skeleton"
            style={{
              height: height ?? '0.875rem',
              width: width ?? (at === count - 1 ? '60%' : '100%'),
              borderRadius,
            }}
          />
        ))}
      </span>
    );
  }

  const resolvedHeight = height ?? '0.875rem';
  const computedStyle: CSSProperties = {
    width: width ?? (circle ? resolvedHeight : '100%'),
    height: resolvedHeight,
    borderRadius,
    ...style,
  };

  return (
    <span
      ref={ref}
      aria-hidden="true"
      aria-label={ariaLabel}
      className={cx('sk-bar kit-skeleton-bar nx-skeleton', className)}
      style={computedStyle}
      {...props}
    />
  );
}

/** Props for `SkeletonText`. */
export interface SkeletonTextProps extends CleanElementProps<'div'> {
  lines?: number;
  lastLineWidth?: string;
  lineHeight?: number | string;
}

/** Multi-line paragraph skeleton placeholder. */
export function SkeletonText({
  lines = 3,
  lastLineWidth = '64%',
  lineHeight = '0.75rem',
  ariaLabel,
  className,
  ...props
}: SkeletonTextProps) {
  const count = Math.max(1, lines);
  return (
    <div aria-hidden="true" aria-label={ariaLabel} className={cx('nx-skeleton-text', className)} {...props}>
      {Array.from({ length: count }, (_, idx) => (
        <Skeleton key={idx} height={lineHeight} width={idx === count - 1 && count > 1 ? lastLineWidth : '100%'} />
      ))}
    </div>
  );
}

/** Props for `SkeletonCard`. */
export interface SkeletonCardProps extends CleanElementProps<'div'> {
  showHeader?: boolean;
  showAvatar?: boolean;
  lines?: number;
  showFooter?: boolean;
}

/** Structured card skeleton placeholder with optional header, avatar, body lines, and footer. */
export function SkeletonCard({
  showHeader = true,
  showAvatar = false,
  lines = 3,
  showFooter = false,
  ariaLabel,
  className,
  ...props
}: SkeletonCardProps) {
  return (
    <div aria-hidden="true" aria-label={ariaLabel} className={cx('nx-card nx-skeleton-card', className)} {...props}>
      {showHeader && (
        <div className="nx-card-header">
          <div className="nx-skeleton-card-head">
            {showAvatar && <Skeleton width="2rem" height="2rem" circle />}
            <div className="nx-skeleton-card-titles">
              <Skeleton width="8.5rem" height="0.875rem" />
              <Skeleton width="12rem" height="0.6875rem" />
            </div>
          </div>
          <Skeleton width="3.5rem" height="1.375rem" radius="sm" />
        </div>
      )}
      <div className="nx-card-body">
        <SkeletonText lines={lines} />
      </div>
      {showFooter && (
        <div className="nx-card-footer">
          <Skeleton width="6rem" height="0.75rem" />
          <Skeleton width="4.5rem" height="1.75rem" radius="md" />
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 5. Meter (Unified Kit + Gauge Surface)
 * ========================================================================== */

/** Size alias for `Meter`. */
export type GaugeSize = ControlSize;

/** Props for the unified `Meter` component. */
export interface MeterProps {
  value: number;
  min?: number;
  max?: number;
  indeterminate?: boolean;
  tone?: Tone;
  label?: ReactNode;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  valueLabel?: string;
  formatValue?: (value: number) => string;
  format?: 'number' | 'percent';
  showValue?: boolean;
  size?: ControlSize;
  fluid?: boolean;
  locale?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
  children?: ReactNode;
}

function MeterTrackPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkMeterTrack aria-label={ariaLabel} className={cx('pct-bar nx-gauge-track', className)} {...props} />;
}

function MeterIndicatorPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>) {
  return <SdkMeterIndicator aria-label={ariaLabel} className={cx('pct-fill nx-gauge-indicator', className)} {...props} />;
}

function MeterLabelPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>) {
  return <SdkMeterLabel aria-label={ariaLabel} className={cx('nx-gauge-label', className)} {...props} />;
}

function MeterValuePart({ ariaLabel, className, ...props }: CleanElementProps<'span'>) {
  return <SdkMeterValue aria-label={ariaLabel} className={cx('num-value nx-gauge-value', className)} {...props} />;
}

function MeterBase(props: MeterProps) {
  const {
    label,
    value,
    min = 0,
    max = 100,
    indeterminate = false,
    showValue = false,
    formatValue,
    format,
    locale,
    tone,
    size = 'md',
    fluid = false,
    ariaLabel,
    'aria-labelledby': ariaLabelledby,
    valueLabel,
    className,
    style,
    ref,
    children,
  } = props;

  const seam = useSurfaceSeam();
  const rawAriaLabel = ariaLabel ?? (props as { 'aria-label'?: string })['aria-label'];
  const rawSize = size as string;
  const isFluid = fluid || rawSize === 'fluid';
  const resolvedSize: ControlSize = rawSize === 'fluid' ? 'md' : size;
  const kitTone = toKitTone(tone);
  const dataTone = toDataTone(tone) ?? 'accent';
  const dataStatus = indeterminate ? 'indeterminate' : undefined;

  const fmt =
    formatValue ??
    (format
      ? (num: number) =>
          seam?.formatPreset?.(num, format, locale) ??
          (format === 'percent' ? `${Math.round(num)}%` : locale ? new Intl.NumberFormat(locale).format(num) : String(num))
      : undefined);

  const resolvedAriaLabel =
    rawAriaLabel ?? (typeof label === 'string' ? label : label === undefined && ariaLabelledby === undefined ? 'Meter' : undefined);

  if (children !== undefined) {
    return (
      <SdkMeter
        ref={ref as Ref<HTMLDivElement>}
        value={value}
        min={min}
        max={max}
        format={fmt}
        locale={locale}
        getValueLabel={valueLabel ? () => valueLabel : undefined}
        aria-label={resolvedAriaLabel}
        aria-labelledby={ariaLabelledby}
        data-slot="meter"
        data-status={dataStatus}
        data-tone={dataTone}
        data-size={resolvedSize}
        className={cx('meter-wrap nx-meter', kitTone && `meter-${kitTone}`, isFluid && 'meter-fluid', className)}
        style={style}
      >
        {children}
      </SdkMeter>
    );
  }

  const span = max - min;
  const fill = span > 0 && Number.isFinite(value) ? Math.max(0, Math.min(100, ((value - min) / span) * 100)) : 0;

  if (showValue || indeterminate) {
    const formattedValue = fmt ? fmt(value) : String(value);
    return (
      <div
        ref={ref as Ref<HTMLDivElement>}
        role="meter"
        aria-valuenow={indeterminate || !Number.isFinite(value) ? undefined : Math.max(min, Math.min(max, value))}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={valueLabel}
        aria-label={resolvedAriaLabel}
        aria-labelledby={ariaLabelledby}
        data-slot="meter"
        data-status={dataStatus}
        data-tone={dataTone}
        data-size={resolvedSize}
        className={cx('meter-wrap nx-meter', kitTone && `meter-${kitTone}`, isFluid && 'meter-fluid', className)}
        style={style}
      >
        {(label !== undefined || showValue) && (
          <div className="nx-gauge-header">
            {label !== undefined && <span className="nx-gauge-label">{label}</span>}
            {showValue && <span className="num-value nx-gauge-value">{formattedValue}</span>}
          </div>
        )}
        <div className="pct-bar nx-gauge-track">
          <div className="pct-fill nx-gauge-indicator" style={indeterminate ? undefined : { width: `${fill}%` }} />
        </div>
      </div>
    );
  }

  return (
    <span
      ref={ref as Ref<HTMLSpanElement>}
      role="meter"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={valueLabel}
      aria-label={resolvedAriaLabel}
      aria-labelledby={ariaLabelledby}
      data-slot="meter"
      data-tone={dataTone}
      data-size={resolvedSize}
      className={cx('meter-wrap', kitTone && `meter-${kitTone}`, isFluid && 'meter-fluid', className)}
      style={style}
    >
      <span className="pct-bar nx-gauge-track">
        <span className="pct-fill nx-gauge-indicator" style={{ width: `${fill}%` }} />
      </span>
      {label !== undefined && <span className="num-value">{label}</span>}
    </span>
  );
}

/** Proportional bar meter supporting inline kit layout, labeled header gauge layout, and compound subparts. */
export const Meter = Object.assign(MeterBase, {
  Root: MeterBase,
  Track: MeterTrackPart,
  Indicator: MeterIndicatorPart,
  Label: MeterLabelPart,
  Value: MeterValuePart,
});
