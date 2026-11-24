/** Locale-aware formatted values (safe for 64-bit string IDs), collapsible JSON trees, and image croppers. */
'use client';

import {
  ImageCropper as SdkImageCropper,
  ImageCropperFlip as SdkImageCropperFlip,
  ImageCropperGrid as SdkImageCropperGrid,
  ImageCropperHandle as SdkImageCropperHandle,
  type ImageCropperHandlePosition,
  ImageCropperImage as SdkImageCropperImage,
  ImageCropperRotate as SdkImageCropperRotate,
  ImageCropperSelection as SdkImageCropperSelection,
  ImageCropperViewport as SdkImageCropperViewport,
  ImageCropperZoom as SdkImageCropperZoom,
} from '@ui-sdk/react/image-cropper';
import { useState, type CSSProperties, type ComponentProps, type ReactNode, type Ref } from 'react';
import { Icon } from '../Icon.js';
import { CopyIconButton } from '../internal/CopyIconButton.js';
import { cx } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<ComponentProps<T>, 'onChange' | 'aria-label' | 'inlist'> & {
  ariaLabel?: string;
};

/* ============================================================================
 * 1. FormattedValue (BigInt / 2^53-safe IDs & Locale Formatting)
 * ========================================================================== */

/** Display preset for `FormattedValue`. */
export type ValueFormat = 'text' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'bytes' | 'id';

function formatBytes(raw: unknown): string | null {
  let num: number;
  if (typeof raw === 'number') {
    num = raw;
  } else if (typeof raw === 'bigint') {
    num = Number(raw);
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    num = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(num)) return String(raw);
  if (num === 0) return '0 B';
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  let exp = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(abs) / Math.log(1024))));
  while (exp < units.length - 1 && abs / 1024 ** exp >= 1023.95) {
    exp += 1;
  }
  const scaled = abs / 1024 ** exp;
  const decimals = exp === 0 ? 0 : 1;
  return `${sign}${scaled.toFixed(decimals)} ${units[exp]}`;
}

function formatSafeNumeric(raw: unknown, locale: string | undefined, options?: Intl.NumberFormatOptions): string | null {
  if (typeof raw === 'bigint') {
    return new Intl.NumberFormat(locale, options).format(raw);
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return String(raw);
    return new Intl.NumberFormat(locale, options).format(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Preserve exact integer and decimal strings (including >2^53) via Intl.StringNumericLiteral
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      try {
        return new Intl.NumberFormat(locale, options).format(trimmed as Intl.StringNumericLiteral);
      } catch {
        return trimmed;
      }
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return new Intl.NumberFormat(locale, options).format(parsed);
    }
    return trimmed;
  }
  return null;
}

/** Props for the `FormattedValue` inline scalar display. */
export interface FormattedValueProps extends CleanElementProps<'span'> {
  value: unknown;
  format?: ValueFormat;
  currency?: string;
  locale?: string;
  copyable?: boolean;
  copyLabel?: string;
  placeholder?: ReactNode;
}

/** Locale-aware scalar formatter preserving `> 2^53` string IDs and tabular numbers with optional copy button. */
export function FormattedValue({
  value,
  format = 'text',
  currency = 'USD',
  locale: explicitLocale,
  copyable = false,
  copyLabel = 'Copy value',
  placeholder = '—',
  ariaLabel,
  className,
  ...props
}: FormattedValueProps) {
  const locale = resolveLocale(explicitLocale);
  if (value === null || value === undefined || value === '') {
    return (
      <span aria-label={ariaLabel} className={cx('nx-fv nx-fv-empty', className)} {...props}>
        {placeholder}
      </span>
    );
  }

  let display = '';
  let rawCopy = '';

  switch (format) {
    case 'id': {
      display = String(value);
      rawCopy = display;
      break;
    }
    case 'number': {
      rawCopy = String(value);
      display = formatSafeNumeric(value, locale) ?? rawCopy;
      break;
    }
    case 'currency': {
      rawCopy = String(value);
      display =
        formatSafeNumeric(value, locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }) ?? rawCopy;
      break;
    }
    case 'percent': {
      rawCopy = String(value);
      display =
        formatSafeNumeric(value, locale, {
          style: 'percent',
          maximumFractionDigits: 2,
        }) ?? rawCopy;
      break;
    }
    case 'bytes': {
      display = formatBytes(value) ?? String(value);
      rawCopy = display;
      break;
    }
    case 'date':
    case 'datetime': {
      const dateObj = value instanceof Date ? value : typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
      /* A day written alone is a calendar day, not an instant. `new Date('2026-03-01')` is that day's UTC midnight, which
         a reader west of Greenwich would be shown as the evening before; it is formatted, and copied, as the day it names. */
      const dayOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
      if (dateObj && !Number.isNaN(dateObj.getTime())) {
        display = new Intl.DateTimeFormat(
          locale,
          dayOnly
            ? { dateStyle: 'medium', timeZone: 'UTC' }
            : format === 'datetime'
              ? { dateStyle: 'medium', timeStyle: 'short' }
              : { dateStyle: 'medium' },
        ).format(dateObj);
        rawCopy = dayOnly ? (value as string).trim() : dateObj.toISOString();
      } else {
        display = String(value);
        rawCopy = display;
      }
      break;
    }
    case 'text':
    default: {
      display = String(value);
      rawCopy = display;
      break;
    }
  }

  const isTabular = format === 'number' || format === 'currency' || format === 'percent' || format === 'bytes';

  return (
    <span
      aria-label={ariaLabel}
      data-format={format}
      data-tabular={isTabular ? '' : undefined}
      className={cx('nx-fv', format === 'id' && 'nx-fv-id', className)}
      {...props}
    >
      <span className="nx-fv-text">{display}</span>
      {copyable && <CopyIconButton text={rawCopy} label={copyLabel} />}
    </span>
  );
}

/* ============================================================================
 * 2. JsonView (Collapsible Syntax-Colored Inspector)
 * ========================================================================== */

interface JsonNodeProps {
  name?: string;
  value: unknown;
  depth: number;
  defaultExpandedDepth: number;
  isLast: boolean;
}

function JsonNode({ name, value, depth, defaultExpandedDepth, isLast }: JsonNodeProps) {
  const isArray = Array.isArray(value);
  const isPlainObject = !isArray && typeof value === 'object' && value !== null;
  const isExpandable = isArray || isPlainObject;

  const entries: Array<[string, unknown]> = isArray
    ? value.map((item, i) => [String(i), item])
    : isPlainObject
      ? Object.entries(value as Record<string, unknown>)
      : [];

  const isEmpty = isExpandable && entries.length === 0;
  const [expanded, setExpanded] = useState(() => depth < defaultExpandedDepth && !isEmpty);

  const comma = isLast ? null : <span className="nx-json-punct">,</span>;

  const keyPrefix =
    name !== undefined ? (
      <>
        <span className="nx-json-key">&quot;{name}&quot;</span>
        <span className="nx-json-punct">: </span>
      </>
    ) : null;

  if (!isExpandable) {
    let tokenNode: ReactNode;
    if (value === null) {
      tokenNode = <span className="nx-json-null">null</span>;
    } else if (value === undefined) {
      tokenNode = <span className="nx-json-null">undefined</span>;
    } else if (typeof value === 'boolean') {
      tokenNode = <span className="nx-json-bool">{String(value)}</span>;
    } else if (typeof value === 'number' || typeof value === 'bigint') {
      tokenNode = <span className="nx-json-num">{String(value)}</span>;
    } else if (typeof value === 'string') {
      tokenNode = <span className="nx-json-str">&quot;{value}&quot;</span>;
    } else {
      tokenNode = <span className="nx-json-str">{String(value)}</span>;
    }

    return (
      <div className="nx-json-line">
        <span className="nx-json-leaf-indent" />
        {keyPrefix}
        {tokenNode}
        {comma}
      </div>
    );
  }

  const openBr = isArray ? '[' : '{';
  const closeBr = isArray ? ']' : '}';

  if (isEmpty) {
    return (
      <div className="nx-json-line">
        <span className="nx-json-leaf-indent" />
        {keyPrefix}
        <span className="nx-json-punct">
          {openBr}
          {closeBr}
        </span>
        {comma}
      </div>
    );
  }

  const summary = isArray
    ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
    : `${entries.length} ${entries.length === 1 ? 'key' : 'keys'}`;

  return (
    <div className="nx-json-branch">
      <div className="nx-json-line">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="nx-json-toggle nx-focusable"
        >
          {expanded ? <Icon name="caret-down" size={11} /> : <Icon name="caret-right" size={11} />}
        </button>
        {keyPrefix}
        <span className="nx-json-punct">{openBr}</span>
        {!expanded && (
          <>
            <button type="button" onClick={() => setExpanded(true)} className="nx-json-summary">
              {summary}
            </button>
            <span className="nx-json-punct">{closeBr}</span>
            {comma}
          </>
        )}
      </div>
      {expanded && (
        <>
          <div className="nx-json-children">
            {entries.map(([k, v], idx) => (
              <JsonNode
                key={k}
                name={isArray ? undefined : k}
                value={v}
                depth={depth + 1}
                defaultExpandedDepth={defaultExpandedDepth}
                isLast={idx === entries.length - 1}
              />
            ))}
          </div>
          <div className="nx-json-line">
            <span className="nx-json-leaf-indent" />
            <span className="nx-json-punct">{closeBr}</span>
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

function safeJsonStringify(data: unknown): string {
  try {
    return JSON.stringify(data, (_key, val: unknown) => (typeof val === 'bigint' ? val.toString() : val), 2) ?? String(data);
  } catch {
    return String(data);
  }
}

/** Props for the `JsonView` interactive JSON tree inspector. */
export interface JsonViewProps extends CleanElementProps<'div'> {
  data: unknown;
  defaultExpandedDepth?: number;
  copyable?: boolean;
  maxHeight?: number | string;
}

/** Syntax-colored collapsible JSON tree inspector with one-click copy toolbar. */
export function JsonView({
  data,
  defaultExpandedDepth = 2,
  copyable = true,
  maxHeight,
  ariaLabel,
  className,
  style,
  ...props
}: JsonViewProps) {
  const serialized = copyable ? safeJsonStringify(data) : '';

  return (
    <div aria-label={ariaLabel} className={cx('nx-json-view', className)} style={{ maxHeight, ...style }} {...props}>
      {copyable && (
        <div className="nx-json-toolbar">
          <CopyIconButton text={serialized} label="Copy JSON" />
        </div>
      )}
      <div className="nx-json-tree">
        <JsonNode value={data} depth={0} defaultExpandedDepth={defaultExpandedDepth} isLast />
      </div>
    </div>
  );
}

/* ============================================================================
 * 3. ImageCropper
 * ========================================================================== */

/** Crop geometry and transform state controlled by `ImageCropper`. */
export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
}

/** Crop mask shape (`'rectangle'` or `'circle'`). */
export type ImageCropperShape = 'rectangle' | 'circle';

/** Interaction mode for `ImageCropper` (`'box'` or `'pan'`). */
export type ImageCropperMode = 'box' | 'pan';

const CROP_HANDLES: readonly ImageCropperHandlePosition[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Props for the `ImageCropper` interactive image framing control. */
export interface ImageCropperProps {
  src: string;
  alt?: string;
  aspectRatio?: number;
  shape?: ImageCropperShape;
  mode?: ImageCropperMode;
  crop?: ImageCrop;
  defaultCrop?: Partial<ImageCrop>;
  onValueChange?: (crop: Required<ImageCrop>) => void;
  onValueCommit?: (crop: Required<ImageCrop>) => void;
  onCrop?: (crop: Required<ImageCrop>) => void;
  minWidth?: number;
  minHeight?: number;
  maxZoom?: number;
  disabled?: boolean;
  showControls?: boolean;
  zoomLabel?: string;
  rotateLabel?: string;
  flipLabel?: string;
  viewportHeight?: number | string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Interactive image cropper supporting zoom, 90° rotation, horizontal flip, and aspect-ratio lock. */
export function ImageCropper(props: ImageCropperProps) {
  const {
    src,
    alt = 'Image to crop',
    aspectRatio,
    shape = 'rectangle',
    mode = 'box',
    crop,
    defaultCrop,
    onValueChange,
    onValueCommit,
    onCrop,
    minWidth,
    minHeight,
    maxZoom = 5,
    disabled,
    showControls = true,
    zoomLabel = 'Zoom',
    rotateLabel = 'Rotate 90 degrees',
    flipLabel = 'Flip horizontally',
    viewportHeight = '18rem',
    ariaLabel,
    className,
    style,
    ref,
    children,
  } = props;

  const legacyOnCropChange = (props as unknown as { onCropChange?: (crop: Required<ImageCrop>) => void }).onCropChange;
  const resolvedChange = onValueChange ?? legacyOnCropChange;
  const resolvedCommit = onValueCommit ?? onCrop;

  if (!src || !src.trim()) {
    return (
      <div
        ref={ref}
        aria-label={ariaLabel}
        data-slot="image-cropper"
        data-empty=""
        className={cx('nx-image-cropper', className)}
        style={style}
      >
        <div style={{ height: viewportHeight }} role="img" aria-label={alt} className="nx-cropper-viewport nx-cropper-empty" />
      </div>
    );
  }
  return (
    <SdkImageCropper
      ref={ref}
      src={src}
      aspectRatio={aspectRatio}
      shape={shape}
      mode={mode as never}
      crop={crop as never}
      defaultCrop={defaultCrop as never}
      onCropChange={resolvedChange ? (next) => resolvedChange(next) : undefined}
      onCropCommit={resolvedCommit ? (next) => resolvedCommit(next) : undefined}
      minWidth={minWidth}
      minHeight={minHeight}
      maxZoom={maxZoom}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cx('nx-image-cropper', className)}
      style={style}
    >
      {children ?? (
        <>
          <SdkImageCropperViewport style={{ height: viewportHeight }} className="nx-cropper-viewport">
            <SdkImageCropperImage alt={alt} className="nx-cropper-image" />
            <SdkImageCropperSelection className="nx-cropper-selection">
              <SdkImageCropperGrid className="nx-cropper-grid" />
              {mode === 'box' &&
                CROP_HANDLES.map((pos) => (
                  <SdkImageCropperHandle key={pos} position={pos} data-position={pos} className="nx-cropper-handle" />
                ))}
            </SdkImageCropperSelection>
          </SdkImageCropperViewport>
          {showControls && (
            <div className="nx-cropper-controls">
              <div className="nx-cropper-zoom-group">
                <Icon name="magnifying-glass-plus" size={15} className="nx-cropper-zoom-icon" />
                <SdkImageCropperZoom aria-label={zoomLabel} className="nx-cropper-zoom" />
              </div>
              <div className="nx-cropper-actions">
                <SdkImageCropperRotate data-slot="button" data-size="xs" data-variant="ghost" data-icon-only="" aria-label={rotateLabel}>
                  <Icon name="arrow-clockwise" size={14} />
                </SdkImageCropperRotate>
                <SdkImageCropperFlip
                  direction="horizontal"
                  data-slot="button"
                  data-size="xs"
                  data-variant="ghost"
                  data-icon-only=""
                  aria-label={flipLabel}
                >
                  <Icon name="flip-horizontal" size={14} />
                </SdkImageCropperFlip>
              </div>
            </div>
          )}
        </>
      )}
    </SdkImageCropper>
  );
}
