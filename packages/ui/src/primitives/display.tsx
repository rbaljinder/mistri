/** Typography headings, badges, status dots, monogram avatars, stat cards, description lists, and item rows. */
'use client';

import { formatShortcut } from '@ui-sdk/react/shortcuts';
import { Children, useId, useRef, type CSSProperties, type ComponentProps, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Avatar, type AvatarProps, type AvatarSize, type AvatarStatus } from '../Avatar.js';
import { Badge, IconRows, PhotoTiles, type BadgeProps, type IconRowsProps, type PhotoTile, type PhotoTilesProps } from '../HeroBlocks.js';
import { Icon } from '../Icon.js';
import { Popover } from '../Popover.js';
import { Sparkline } from '../charts/charts.js';
import { CopyIconButton } from '../internal/CopyIconButton.js';
import { cx, isEmptyStateSpec, toDataTone, toKitTone, type ControlSize, type EmptyStateSpec, type Tone } from '../internal/cx.js';
import { useInCard, useSurfaceSeam } from '../internal/surfaceSeam.js';

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<ComponentProps<T>, 'onChange' | 'aria-label' | 'inlist'> & {
  ariaLabel?: string;
};

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function renderEmptyNode(empty: EmptyStateSpec | ReactNode): ReactNode {
  if (isEmptyStateSpec(empty)) {
    return (
      <div className="nx-empty-inline">
        <div className="nx-empty-inline-title">{empty.title}</div>
        {given(empty.body) && <div className="nx-empty-inline-body">{empty.body}</div>}
        {given(empty.action) && <div className="nx-empty-inline-action">{empty.action}</div>}
      </div>
    );
  }
  return empty;
}

/* ============================================================================
 * 1. Typography: Heading, Text, Code, Kbd, VisuallyHidden
 * ========================================================================== */

/** Section heading outline level (`2`, `3`, or `4`). */
export type HeadingLevel = 2 | 3 | 4;

/** Props for the `Heading` typography component. */
export interface HeadingProps extends CleanElementProps<'h3'> {
  level?: HeadingLevel;
}

/** Section or subsection heading rendered at semantic level `h2`, `h3`, or `h4`. */
export function Heading({ level = 3, ariaLabel, className, children, ref, ...props }: HeadingProps) {
  const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
  const size = level === 2 ? 'lg' : level === 4 ? 'sm' : 'md';
  return (
    <Tag ref={ref} aria-label={ariaLabel} data-size={size} className={cx('kit-heading nx-heading', className)} {...props}>
      {children}
    </Tag>
  );
}

/** Font size scale for `Text`. */
export type TextSize = '2xs' | 'xs' | 'sm' | 'base' | 'md' | 'lg';

/** Ink hierarchy level for `Text`. */
export type TextHierarchy = 'default' | 'secondary' | 'muted' | 'subtle';

/** Font weight options for `Text`. */
export type TextWeight = 'regular' | 'medium' | 'semibold' | 'bold';

/** Props for the `Text` body and caption typography component. */
export interface TextProps extends Omit<CleanElementProps<'p'>, 'ref'> {
  as?: 'span' | 'p' | 'div' | 'label';
  size?: TextSize;
  hierarchy?: TextHierarchy;
  muted?: boolean;
  tone?: Tone;
  mono?: boolean;
  tabular?: boolean;
  weight?: TextWeight;
  truncate?: boolean;
  ref?: Ref<HTMLElement>;
}

/** Body or caption text element supporting ink hierarchy, semantic `Tone`, monospace, and truncation. */
export function Text(props: TextProps) {
  const {
    as = 'p',
    size = 'md',
    hierarchy = 'default',
    muted = false,
    tone,
    mono = false,
    tabular = false,
    weight,
    truncate = false,
    ariaLabel,
    className,
    ref,
    ...rest
  } = props;
  const rawTone = tone as string | undefined;
  const isLegacyMuted = rawTone === 'muted' || rawTone === 'secondary' || rawTone === 'subtle';
  const resolvedHierarchy: TextHierarchy =
    hierarchy !== 'default'
      ? hierarchy
      : muted || rawTone === 'muted'
        ? 'muted'
        : rawTone === 'secondary'
          ? 'secondary'
          : rawTone === 'subtle'
            ? 'subtle'
            : 'default';
  const dataTone = isLegacyMuted || rawTone === 'default' ? undefined : toDataTone(rawTone);
  const isMuted = muted || resolvedHierarchy === 'muted';
  const Tag = as as 'p';

  return (
    <Tag
      ref={ref as Ref<HTMLParagraphElement>}
      aria-label={ariaLabel}
      data-size={size}
      data-hierarchy={resolvedHierarchy !== 'default' ? resolvedHierarchy : undefined}
      data-tone={dataTone}
      data-mono={mono ? '' : undefined}
      data-tabular={tabular ? '' : undefined}
      data-weight={weight}
      data-truncate={truncate ? '' : undefined}
      className={cx(
        'kit-text nx-text',
        isMuted && 'kit-text-muted',
        size === 'sm' && 'kit-text-sm',
        dataTone === 'critical' && 'kit-text-danger',
        className,
      )}
      {...rest}
    />
  );
}

/** Props for the inline `Code` snippet component. */
export type CodeProps = CleanElementProps<'code'>;

/** Inline monospace code token. */
export function Code({ ariaLabel, className, ...props }: CodeProps) {
  return <code aria-label={ariaLabel} className={cx('nx-code', className)} {...props} />;
}

/** Props for the `Kbd` keyboard shortcut keycap component. */
export interface KbdProps extends CleanElementProps<'kbd'> {
  shortcut?: string;
}

/** Keyboard keycap badge formatting platform-appropriate shortcut symbols. */
export function Kbd({ shortcut, ariaLabel, className, children, ...props }: KbdProps) {
  const formatted = shortcut !== undefined ? formatShortcut(shortcut) : typeof children === 'string' ? formatShortcut(children) : children;

  return (
    <kbd aria-label={ariaLabel} className={cx('nx-kbd', className)} {...props}>
      {formatted}
    </kbd>
  );
}

/** Props for `VisuallyHidden`. */
export interface VisuallyHiddenProps extends Omit<CleanElementProps<'span'>, 'ref'> {
  as?: 'span' | 'div';
  ref?: Ref<HTMLElement>;
}

/** Screen-reader-only text clipped out of visual layout without leaving the accessibility tree. */
export function VisuallyHidden({ as = 'span', ariaLabel, className, ref, ...props }: VisuallyHiddenProps) {
  const Tag = as as 'span';
  return (
    <Tag ref={ref as Ref<HTMLSpanElement>} aria-label={ariaLabel} className={cx('kit-visually-hidden nx-sr-only', className)} {...props} />
  );
}

/* ============================================================================
 * 2. Badges & Status Indicators: Badge, StatusDot, AiBadge
 * ========================================================================== */

export { Badge, IconRows, PhotoTiles, type BadgeProps, type IconRowsProps, type PhotoTile, type PhotoTilesProps };

/** Props for the `StatusDot` indicator. */
export interface StatusDotProps extends CleanElementProps<'span'> {
  tone?: Tone;
  pulse?: boolean;
}

/** Semantic status dot and optional text label dressed in the active theme's status ink. */
export function StatusDot({ tone = 'neutral', pulse = false, ariaLabel, className, children, ref, ...props }: StatusDotProps) {
  const kitTone = toKitTone(tone) ?? 'neutral';
  const dataTone = toDataTone(tone) ?? 'neutral';
  return (
    <span
      ref={ref}
      aria-label={ariaLabel}
      data-tone={dataTone}
      data-pulse={pulse ? '' : undefined}
      className={cx('tone', `tone-${kitTone}`, 'nx-status-dot', className)}
      {...props}
    >
      {children}
    </span>
  );
}

/** Props for the `AiBadge` provenance indicator. */
export interface AiBadgeProps extends CleanElementProps<'span'> {
  quiet?: boolean;
  pill?: boolean;
  label?: ReactNode;
}

/** Sparkle badge marking AI-generated or AI-assisted content. */
export function AiBadge({ quiet = false, label, pill = true, ariaLabel, className, children, ref, ...props }: AiBadgeProps) {
  const seam = useSurfaceSeam();
  const content = children ?? label ?? seam?.aiLabel?.() ?? 'AI';
  return (
    <span
      ref={ref}
      aria-label={ariaLabel}
      data-quiet={quiet ? '' : undefined}
      data-pill={pill ? '' : undefined}
      className={cx('ai-mark nx-badge nx-ai-badge', className)}
      {...props}
    >
      <Icon name="sparkle" size={11.5} weight="bold" />
      <span className={quiet ? 'kit-visually-hidden nx-sr-only visually-hidden' : undefined}>{content}</span>
    </span>
  );
}

/* ============================================================================
 * 3. Avatar, AvatarGroup & Person
 * ========================================================================== */

export { Avatar, type AvatarProps, type AvatarSize, type AvatarStatus };

/** Single member entry for `AvatarGroup`. */
export interface AvatarGroupMember {
  id?: string;
  name: string;
  src?: string;
  status?: AvatarStatus;
}

/** Props for the `AvatarGroup` overlapping stack. */
export interface AvatarGroupProps extends CleanElementProps<'div'> {
  items?: ReadonlyArray<AvatarGroupMember>;
  max?: number;
  size?: AvatarSize;
}

/** Overlapping row of member avatars with an overflow `+N` counter chip. */
export function AvatarGroup({ items, max = 4, size = 'sm', ariaLabel, className, children, ...props }: AvatarGroupProps) {
  if (items !== undefined) {
    const visible = items.slice(0, max);
    const extra = items.length - visible.length;

    return (
      <div aria-label={ariaLabel} data-size={size} className={cx('nx-avatar-group', className)} {...props}>
        {visible.map((member, idx) => (
          <Avatar
            key={member.id ?? `${member.name}-${idx}`}
            name={member.name}
            src={member.src}
            status={member.status}
            size={size}
            className="nx-avatar-group-item"
          />
        ))}
        {extra > 0 && (
          <span data-size={size} className="nx-avatar-overflow" aria-label={`${extra} more`}>
            +{extra}
          </span>
        )}
      </div>
    );
  }

  const nodes = Children.toArray(children);
  const visibleNodes = nodes.slice(0, max);
  const extraCount = nodes.length - visibleNodes.length;

  return (
    <div aria-label={ariaLabel} data-size={size} className={cx('nx-avatar-group', className)} {...props}>
      {visibleNodes}
      {extraCount > 0 && (
        <span data-size={size} className="nx-avatar-overflow" aria-label={`${extraCount} more`}>
          +{extraCount}
        </span>
      )}
    </div>
  );
}

/** Props for the `Person` identity lockup. */
export interface PersonProps extends Omit<CleanElementProps<'div'>, 'role' | 'ref'> {
  name: string;
  secondary?: ReactNode;
  role?: ReactNode;
  email?: string;
  src?: string;
  href?: string;
  status?: AvatarStatus;
  size?: ControlSize;
  meta?: ReactNode;
  hoverDetails?: ReactNode | boolean;
  ref?: Ref<HTMLElement>;
}

/** Person avatar, truncated primary name, optional secondary role/email, and optional hover profile card. */
export function Person({
  name,
  secondary,
  role,
  email,
  src,
  href,
  status,
  size = 'sm',
  meta,
  hoverDetails,
  ariaLabel,
  className,
  ref,
  ...props
}: PersonProps) {
  const seam = useSurfaceSeam();
  const linkProps = seam?.useLinkProps ? seam.useLinkProps(href) : { href };
  const secondaryNode = secondary ?? role ?? email;

  const badgeNode = (
    <div
      ref={ref as Ref<HTMLDivElement>}
      aria-label={ariaLabel}
      data-size={size}
      className={cx('kit-person nx-person', Boolean(hoverDetails) && 'nx-person-interactive', className)}
      {...props}
    >
      <span className="kit-person-avatar" aria-hidden={status === undefined ? 'true' : undefined}>
        <Avatar name={name} src={src} status={status} size={size} />
      </span>
      <div className="kit-person-text nx-person-copy">
        {href !== undefined && !hoverDetails ? (
          <a className="kit-person-name nx-person-name" href={linkProps.href ?? href} onClick={linkProps.onClick}>
            {name}
          </a>
        ) : (
          <span className="kit-person-name nx-person-name">{name}</span>
        )}
        {given(secondaryNode) && secondaryNode !== '' && <span className="kit-person-secondary nx-person-secondary">{secondaryNode}</span>}
      </div>
      {given(meta) && <div className="nx-person-meta">{meta}</div>}
    </div>
  );

  if (!hoverDetails) {
    return badgeNode;
  }

  const statusTone: Tone = status === 'online' ? 'good' : status === 'busy' ? 'critical' : status === 'away' ? 'warning' : 'neutral';

  return (
    <Popover
      trigger={
        <button type="button" className="nx-person-trigger nx-focusable">
          {badgeNode}
        </button>
      }
      align="start"
      ariaLabel={ariaLabel ?? name}
    >
      <div className="nx-person-card">
        <div className="nx-person-card-head">
          <Avatar name={name} src={src} status={status} size="lg" />
          <div className="nx-person-card-titles">
            <div className="nx-person-card-name">{name}</div>
            {given(secondary ?? role) && <div className="nx-person-card-role">{secondary ?? role}</div>}
            {status !== undefined && (
              <StatusDot tone={statusTone} className="nx-person-card-status">
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </StatusDot>
            )}
          </div>
        </div>
        {email !== undefined && (
          <div className="nx-person-card-email">
            <span>{email}</span>
            <CopyIconButton text={email} label="Copy email" />
          </div>
        )}
        {typeof hoverDetails !== 'boolean' && <div className="nx-person-card-extra">{hoverDetails}</div>}
      </div>
    </Popover>
  );
}

/* ============================================================================
 * 4. StatCard
 * ========================================================================== */

/** Period-over-period change descriptor for `StatCard`. */
export interface StatCardDelta {
  value: number | string;
  direction?: 'up' | 'down' | 'flat';
  good?: 'up' | 'down';
  tone?: Tone;
  against?: string;
}

/** Props for the `StatCard` KPI summary figure. */
export interface StatCardProps extends Omit<CleanElementProps<'div'>, 'children' | 'ref'> {
  label: ReactNode;
  value: ReactNode;
  delta?: StatCardDelta;
  trend?: ReadonlyArray<number | { key?: string; value: number }>;
  sparkline?: ReactNode;
  formatValue?: (value: number) => string;
  hint?: ReactNode;
  icon?: ReactNode;
  href?: string;
  locale?: string;
  ref?: Ref<HTMLElement>;
}

/** KPI metric figure with period delta badge, comparison note, and inline trend sparkline. */
export function StatCard({
  label,
  value,
  delta,
  trend,
  sparkline,
  formatValue,
  hint,
  icon,
  href,
  locale,
  ariaLabel,
  className,
  ref,
  ...props
}: StatCardProps) {
  const nested = Boolean(useInCard());
  const seam = useSurfaceSeam();
  const linkProps = seam?.useLinkProps ? seam.useLinkProps(href) : { href };

  const points = (trend ?? []).map((pt) => (typeof pt === 'number' ? pt : pt.value));
  const fmt =
    formatValue ??
    ((num: number) => seam?.formatPreset?.(num, 'number', locale) ?? (locale ? new Intl.NumberFormat(locale).format(num) : String(num)));

  let resolvedText: string | undefined;
  let resolvedDir: 'up' | 'down' | 'flat' | undefined = delta?.direction;
  let resolvedTone: Tone | undefined = delta?.tone;
  const againstText = delta?.against;

  if (delta !== undefined) {
    if (typeof delta.value === 'string') {
      resolvedText = delta.value;
      const trimmed = delta.value.trim();
      if (!resolvedDir) {
        if (trimmed.startsWith('+')) resolvedDir = 'up';
        else if (trimmed.startsWith('-') || trimmed.startsWith('\u2212')) resolvedDir = 'down';
      }
    } else if (Number.isFinite(delta.value)) {
      resolvedDir = resolvedDir ?? (delta.value > 0 ? 'up' : delta.value < 0 ? 'down' : 'flat');
      const prefix = delta.value > 0 ? '+' : delta.value < 0 ? '\u2212' : '';
      resolvedText = `${prefix}${fmt(Math.abs(delta.value))}`;
    }
    if (!resolvedTone) {
      if (resolvedDir && resolvedDir !== 'flat' && delta.good) {
        resolvedTone = resolvedDir === delta.good ? 'good' : 'critical';
      } else if (resolvedDir === 'up') {
        resolvedTone = 'good';
      } else if (resolvedDir === 'down') {
        resolvedTone = 'critical';
      } else {
        resolvedTone = 'neutral';
      }
    }
  }

  const kitDeltaTone = toKitTone(resolvedTone);
  const dataDeltaTone = toDataTone(resolvedTone) ?? 'neutral';

  const sparkNode =
    sparkline !== undefined ? (
      sparkline
    ) : points.length >= 1 ? (
      <Sparkline data={points} formatValue={formatValue} tone={resolvedTone} />
    ) : undefined;

  const content = (
    <>
      <div className="kit-stat-label nx-stat-top">
        <span className="nx-stat-label">{label}</span>
        {given(icon) && (
          <span className="kit-stat-icon nx-stat-icon" aria-hidden="true">
            {icon}
          </span>
        )}
      </div>
      <div className="kit-stat-row nx-stat-middle">
        <div className="kit-stat-figure nx-stat-value">{value}</div>
        {sparkNode !== undefined && (
          <div className="spark-host kit-stat-spark nx-stat-sparkline" aria-hidden="true">
            {sparkNode}
          </div>
        )}
      </div>
      {(resolvedText !== undefined || againstText !== undefined || given(hint)) && (
        <div className={cx('kit-stat-change nx-stat-bottom', kitDeltaTone && `kit-stat-${kitDeltaTone}`)}>
          {resolvedText !== undefined && (
            <span data-tone={dataDeltaTone} className="nx-badge nx-stat-delta">
              {resolvedDir === 'up' && <Icon name="arrow-up-right" size={12} weight="bold" />}
              {resolvedDir === 'down' && <Icon name="arrow-down-right" size={12} weight="bold" />}
              {resolvedDir === 'flat' && <Icon name="minus" size={12} weight="bold" />}
              <span>{resolvedText}</span>
            </span>
          )}
          {againstText !== undefined && <span className="kit-stat-against nx-stat-hint">{againstText}</span>}
          {given(hint) && <span className="kit-stat-against nx-stat-hint">{hint}</span>}
        </div>
      )}
    </>
  );

  const rootClass = cx(
    'kit-stat nx-stat-card',
    nested ? 'kit-stat-plain' : 'kit-card nx-card',
    href !== undefined && 'kit-stat-link nx-focusable',
    className,
  );

  if (href !== undefined) {
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        aria-label={ariaLabel}
        href={linkProps.href ?? href}
        onClick={linkProps.onClick}
        className={rootClass}
      >
        {content}
      </a>
    );
  }

  return (
    <div ref={ref as Ref<HTMLDivElement>} aria-label={ariaLabel} className={rootClass} {...props}>
      {content}
    </div>
  );
}

/* ============================================================================
 * 5. DescriptionList
 * ========================================================================== */

/** Explicit label/value pair item for `DescriptionList`. */
export interface DescriptionListItem {
  id?: string;
  label: ReactNode;
  value: ReactNode;
}

/** Field descriptor for record-backed `DescriptionList` (`fields` mode). */
export type DescriptionField = string | { field: string; label?: ReactNode } | { id?: string; label: ReactNode; value: ReactNode };

/** Props for `DescriptionList` in explicit `items` mode. */
export interface DescriptionListItemsProps extends CleanElementProps<'dl'> {
  items: ReadonlyArray<DescriptionListItem>;
  columns?: 1 | 2 | 3;
}

/** Props for `DescriptionList` in schema-aware `resource` + `row` + `fields` mode. */
export interface DescriptionListRecordProps<
  Row extends Readonly<Record<string, unknown>> = Record<string, unknown>,
> extends CleanElementProps<'dl'> {
  resource: string;
  row: Row;
  fields: ReadonlyArray<DescriptionField>;
  columns?: 1 | 2 | 3;
}

/** Props for the unified `DescriptionList` term-and-value grid. */
export type DescriptionListProps<Row extends Readonly<Record<string, unknown>> = Record<string, unknown>> =
  | DescriptionListItemsProps
  | DescriptionListRecordProps<Row>;

function formatFallbackValue(raw: unknown): ReactNode {
  if (raw === null || raw === undefined || raw === '') {
    return <span className="null">{'\u2014'}</span>;
  }
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') {
    return String(raw);
  }
  if (typeof raw === 'boolean') {
    return raw ? 'Yes' : 'No';
  }
  return String(raw);
}

/** Multi-column key-value `<dl>` supporting either explicit `{ label, value }` items or schema-bound record fields. */
export function DescriptionList<Row extends Readonly<Record<string, unknown>> = Record<string, unknown>>(props: DescriptionListProps<Row>) {
  const seam = useSurfaceSeam();
  if ('fields' in props) {
    const { resource, row, fields, columns = 2, ariaLabel, className, style, ref, ...rest } = props;
    if (seam?.renderRecordFacts) {
      return (
        <>
          {seam.renderRecordFacts({
            resource,
            row,
            fields,
            columns,
            className,
            ref,
          })}
        </>
      );
    }
    const dlStyle: CSSProperties = {
      ...(columns ? { '--page-field-columns': `repeat(${columns}, minmax(0, 1fr))` } : undefined),
      ...style,
    } as CSSProperties;

    return (
      <dl
        ref={ref}
        aria-label={ariaLabel}
        data-columns={columns}
        className={cx('page-field-grid kit-details kit-details-wrap kit-facts nx-dl', className)}
        style={dlStyle}
        {...rest}
      >
        {fields.map((entry, idx) => {
          if (typeof entry === 'string') {
            return (
              <div key={entry} className="page-field nx-dl-item">
                <dt className="nx-dl-term">{entry}</dt>
                <dd className="nx-dl-details">
                  <span className="nx-dl-value">{formatFallbackValue(row[entry])}</span>
                </dd>
              </div>
            );
          }
          if ('field' in entry) {
            return (
              <div key={entry.field} className="page-field nx-dl-item">
                <dt className="nx-dl-term">{entry.label ?? entry.field}</dt>
                <dd className="nx-dl-details">
                  <span className="nx-dl-value">{formatFallbackValue(row[entry.field])}</span>
                </dd>
              </div>
            );
          }
          const val = entry.value;
          return (
            <div key={entry.id ?? `dl-${idx}`} className="page-field nx-dl-item">
              <dt className="nx-dl-term">{entry.label}</dt>
              <dd className="nx-dl-details">
                {given(val) && val !== '' ? <span className="nx-dl-value">{val}</span> : <span className="null">{'\u2014'}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }

  const { items, columns = 2, ariaLabel, className, style, ref, ...rest } = props;
  const dlStyle: CSSProperties = {
    ...(columns ? { '--page-field-columns': `repeat(${columns}, minmax(0, 1fr))` } : undefined),
    ...style,
  } as CSSProperties;

  return (
    <dl
      ref={ref}
      aria-label={ariaLabel}
      data-columns={columns}
      className={cx('page-field-grid kit-details kit-details-wrap kit-facts nx-dl', className)}
      style={dlStyle}
      {...rest}
    >
      {items.map((item, idx) => (
        <div key={item.id ?? `dl-${idx}`} className="page-field nx-dl-item">
          <dt className="nx-dl-term">{item.label}</dt>
          <dd className="nx-dl-details">
            {given(item.value) && item.value !== '' ? (
              <span className="nx-dl-value">{item.value}</span>
            ) : (
              <span className="null">{'\u2014'}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ============================================================================
 * 6. ItemList & ItemRow
 * ========================================================================== */

/** Sticky-headed section run inside `ItemList`. */
export interface ItemGroup {
  key?: string;
  title: ReactNode;
  count?: ReactNode;
  items: ReactNode;
}

/** Props for the `ItemList` vertical entity list. */
export interface ItemListProps extends CleanElementProps<'ul'> {
  label?: string;
  empty?: EmptyStateSpec | ReactNode;
  groups?: ReadonlyArray<ItemGroup>;
  flush?: boolean;
  divided?: boolean;
  bordered?: boolean;
  compact?: boolean;
}

function ItemRun({ group }: { group: ItemGroup }) {
  const id = useId();
  return (
    <li className="kit-items-run">
      <div id={id} className="kit-items-head">
        <span className="kit-items-head-title">{group.title}</span>
        {given(group.count) && <span className="kit-items-head-count">{group.count}</span>}
      </div>
      <ul className="kit-items-run-rows" aria-labelledby={id}>
        {group.items}
      </ul>
    </li>
  );
}

/** Headerless list of `ItemRow`s supporting grouped sticky headers, empty state, and automatic card-flush layout. */
export function ItemList({
  label,
  ariaLabel,
  empty,
  groups,
  flush,
  divided = true,
  bordered,
  compact = false,
  className,
  children,
  ref,
  ...props
}: ItemListProps) {
  const inCard = Boolean(useInCard());
  const isFlush = flush ?? inCard;
  const isBordered = bordered ?? !isFlush;
  const runs = (groups ?? []).filter((group) => Children.toArray(group.items).length > 0);
  const childArray = Children.toArray(children);

  if (childArray.length === 0 && runs.length === 0) {
    if (!given(empty)) return null;
    return <div className={cx('kit-items-empty', isFlush && 'kit-items-empty-flush', className)}>{renderEmptyNode(empty)}</div>;
  }

  return (
    <ul
      ref={ref}
      aria-label={ariaLabel ?? label}
      data-divided={divided ? '' : undefined}
      data-bordered={isBordered ? '' : undefined}
      data-compact={compact ? '' : undefined}
      className={cx('kit-items nx-item-list', isFlush && 'kit-items-flush', className)}
      {...props}
    >
      {runs.map((group, at) => (
        <ItemRun key={group.key ?? at} group={group} />
      ))}
      {children}
    </ul>
  );
}

/** Props for a single `ItemRow` inside `ItemList`. */
export interface ItemRowProps extends Omit<CleanElementProps<'li'>, 'title'> {
  leading?: ReactNode;
  lead?: ReactNode;
  tone?: Tone;
  leadTone?: Tone;
  title: ReactNode;
  description?: ReactNode;
  subtitle?: ReactNode;
  note?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  actions?: ReactNode;
  trailing?: ReactNode;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  href?: string;
  selected?: boolean;
  disabled?: boolean;
}

/** Single row of `ItemList` with leading slot/tone mark, single keyboard target on `title`, and isolated trailing actions. */
export function ItemRow({
  leading,
  lead,
  tone,
  leadTone,
  title,
  description,
  subtitle,
  note,
  meta,
  action,
  actions,
  trailing,
  onClick,
  href,
  selected = false,
  disabled = false,
  ariaLabel,
  className,
  ref,
  ...props
}: ItemRowProps) {
  const seam = useSurfaceSeam();
  const targetRef = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const interactive = !disabled && (href !== undefined || onClick !== undefined);
  const linkProps = seam?.useLinkProps ? seam.useLinkProps(href, onClick) : { href, onClick };

  const resolvedLead = leading ?? lead;
  const resolvedTone = tone ?? leadTone;
  const kitTone = toKitTone(resolvedTone);
  const resolvedDescription = description ?? subtitle ?? note;
  const resolvedActions = action ?? actions ?? trailing;
  const hasEndSlot = given(meta) || given(resolvedActions);
  const marked = given(resolvedLead) || resolvedTone !== undefined;

  const titleNode =
    !disabled && href !== undefined ? (
      <a
        ref={targetRef}
        className="kit-item-target nx-focusable"
        href={linkProps.href ?? href}
        onClick={linkProps.onClick as ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined}
      >
        {title}
      </a>
    ) : !disabled && onClick ? (
      <button
        ref={targetRef}
        type="button"
        className="kit-item-target nx-focusable"
        onClick={onClick as (event: MouseEvent<HTMLButtonElement>) => void}
      >
        {title}
      </button>
    ) : (
      title
    );

  return (
    <li
      ref={ref}
      aria-label={ariaLabel}
      data-interactive={interactive ? '' : undefined}
      data-selected={selected ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cx('kit-item nx-item-row', interactive && 'kit-item-clickable', className)}
      onClick={
        interactive
          ? (event) => {
              if (!targetRef.current?.contains(event.target as Node)) {
                targetRef.current?.click();
              }
            }
          : undefined
      }
      {...props}
    >
      {marked && (
        <span className={cx('kit-item-lead nx-item-row-leading', kitTone && `kit-item-lead-${kitTone}`)}>
          {given(resolvedLead) ? resolvedLead : <span className="kit-item-mark" aria-hidden="true" />}
        </span>
      )}
      <span className="kit-item-main">
        <span className="kit-item-body nx-item-row-copy">
          <span className="kit-item-title nx-item-row-title">{titleNode}</span>
          {given(resolvedDescription) && <span className="kit-item-note nx-item-row-description">{resolvedDescription}</span>}
        </span>
        {hasEndSlot && (
          <span className="kit-item-action nx-item-row-actions" onClick={(event) => event.stopPropagation()}>
            {given(meta) && <span className="nx-item-row-meta">{meta}</span>}
            {resolvedActions}
          </span>
        )}
      </span>
    </li>
  );
}
