/** Compositional flex/grid layout containers, bordered cards, dividers, scroll areas, and resizable split panes. */
'use client';

import { Icon } from '../Icon.js';
import {
  Accordion as SdkAccordion,
  AccordionHeader as SdkAccordionHeader,
  AccordionItem as SdkAccordionItem,
  AccordionPanel as SdkAccordionPanel,
  AccordionTrigger as SdkAccordionTrigger,
} from '@ui-sdk/react/accordion';
import {
  Collapsible as SdkCollapsible,
  CollapsiblePanel as SdkCollapsiblePanel,
  CollapsibleTrigger as SdkCollapsibleTrigger,
} from '@ui-sdk/react/collapsible';
import { ResizableHandle as SdkResizableHandle } from '@ui-sdk/react/resizable';
import { Separator as SdkSeparator } from '@ui-sdk/react/separator';
import {
  Children,
  Fragment,
  isValidElement,
  useId,
  type CSSProperties,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { Carousel, type CarouselProps, type CarouselSlide } from '../Carousel.js';
import { cx, toKitTone, type Tone } from '../internal/cx.js';
import { InCardContext, useInCard } from '../internal/surfaceSeam.js';
import { Resizable, type ResizablePanel, type ResizableProps } from '../Resizable.js';
import { ScrollArea, type ScrollAreaProps } from '../ScrollArea.js';

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<ComponentProps<T>, 'onChange' | 'aria-label' | 'inlist'> & {
  ariaLabel?: string;
};

function given(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false;
}

function isRenderableElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return isValidElement(node) && node.type !== Fragment;
}

function hasCompoundChild(children: ReactNode, candidates: ReadonlyArray<unknown>): boolean {
  let found = false;
  Children.forEach(children, (child) => {
    if (isValidElement(child) && candidates.includes(child.type)) {
      found = true;
    }
  });
  return found;
}

/* ============================================================================
 * 1. Spatial Primitives: Box, Container, Stack, Row, Cluster, Grid, Beside
 * ========================================================================== */

/** Spacing scale tokens for padding and grid gaps. */
export type SpaceScale = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** Layout gap scale shared across `Stack`, `Row`, `Cluster`, and `Beside`. */
export type LayoutGap = 'tight' | 'field' | 'section' | SpaceScale;

const SPACE_TOKEN: Record<SpaceScale, string> = {
  none: '0px',
  xs: 'var(--space-1)',
  sm: 'var(--space-2)',
  md: 'var(--space-4h)',
  lg: 'var(--space-6)',
  xl: 'var(--space-7)',
};

const GAP_TOKEN: Record<LayoutGap, string> = {
  tight: 'var(--space-2)',
  field: 'var(--space-5, 20px)',
  section: 'var(--space-8, 40px)',
  ...SPACE_TOKEN,
};

/** Intrinsic HTML tag supported by `Box`. */
export type BoxTag = 'div' | 'section' | 'article' | 'aside' | 'header' | 'footer' | 'main' | 'nav' | 'span';

/** Props for the `Box` surface container. */
export interface BoxProps extends CleanElementProps<'div'> {
  as?: BoxTag;
  padding?: SpaceScale;
  surface?: 'none' | 'subtle' | 'surface' | 'elevated' | 'inset';
  bordered?: boolean;
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
}

/** Generic layout box with tokenized padding, surface fill, border, and corner radius. */
export function Box({ as: Tag = 'div', padding, surface, bordered, rounded, ariaLabel, className, style, ...props }: BoxProps) {
  const boxStyle: CSSProperties = {
    ...(padding ? { padding: SPACE_TOKEN[padding] } : undefined),
    ...style,
  };

  return (
    <Tag
      aria-label={ariaLabel}
      data-surface={surface && surface !== 'none' ? surface : undefined}
      data-bordered={bordered ? '' : undefined}
      data-rounded={rounded}
      className={cx('nx-box', className)}
      style={boxStyle}
      {...props}
    />
  );
}

/** Props for the `Container` max-width wrapper. */
export interface ContainerProps extends CleanElementProps<'div'> {
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  padded?: boolean;
}

/** Centered max-width page or section container. */
export function Container({ size = 'xl', padded = true, ariaLabel, className, ...props }: ContainerProps) {
  return (
    <div
      aria-label={ariaLabel}
      data-size={size}
      data-padded={padded ? '' : undefined}
      className={cx('nx-container', className)}
      {...props}
    />
  );
}

/** Props for the `Stack` vertical flex container. */
export interface StackProps extends CleanElementProps<'div'> {
  as?: 'div' | 'ul' | 'ol';
  gap?: LayoutGap;
  align?: 'stretch' | 'start' | 'center' | 'end';
  justify?: 'start' | 'center' | 'end' | 'between';
}

/** Vertical flex stack with tokenized spacing between children. */
export function Stack({ as = 'div', gap = 'field', align = 'stretch', justify, ariaLabel, className, style, ref, ...props }: StackProps) {
  const Tag = as as 'div';
  return (
    <Tag
      ref={ref}
      aria-label={ariaLabel}
      data-align={align}
      data-justify={justify}
      className={cx('kit-stack', `kit-gap-${gap}`, 'nx-stack', className)}
      style={{ '--layout-gap': GAP_TOKEN[gap], ...style } as CSSProperties}
      {...props}
    />
  );
}

/** Props for the `Row` horizontal flex container. */
export interface RowProps extends CleanElementProps<'div'> {
  gap?: LayoutGap;
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  foot?: boolean;
}

/** Horizontal flex row that wraps onto new lines when needed. */
export function Row({
  gap = 'field',
  align = 'center',
  justify,
  wrap = true,
  foot = false,
  ariaLabel,
  className,
  style,
  ...props
}: RowProps) {
  return (
    <div
      aria-label={ariaLabel}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? '' : undefined}
      data-foot-actions={foot ? '' : undefined}
      className={cx('kit-row', `kit-gap-${gap}`, `kit-align-${align}`, 'nx-row', className)}
      style={{ '--layout-gap': GAP_TOKEN[gap], ...style } as CSSProperties}
      {...props}
    />
  );
}

/** Props for the `Cluster` responsive auto-fit column grid. */
export interface ClusterProps extends CleanElementProps<'div'> {
  /** Minimum column width as a CSS length (`'16rem'` by default). */
  min?: string;
  gap?: LayoutGap;
}

/** Responsive grid of equal columns at least `min` wide that wraps without sideways scroll. */
export function Cluster({ min = '16rem', gap = 'field', ariaLabel, className, style, ...props }: ClusterProps) {
  return (
    <div
      aria-label={ariaLabel}
      data-auto-grid=""
      className={cx('kit-cluster', `kit-gap-${gap}`, 'nx-cluster', className)}
      style={
        {
          '--kit-cluster-min': min,
          '--layout-cluster-min': min,
          '--layout-gap': GAP_TOKEN[gap],
          ...style,
        } as CSSProperties
      }
      {...props}
    />
  );
}

/** Props for the `Grid` CSS grid container. */
export interface GridProps extends CleanElementProps<'div'> {
  columns?: number | string;
  gap?: LayoutGap;
  align?: 'start' | 'center' | 'end' | 'stretch';
}

/** Multi-column CSS grid layout container. */
export function Grid({ columns = 2, gap = 'md', align = 'stretch', ariaLabel, className, style, ...props }: GridProps) {
  const gridTemplateColumns = typeof columns === 'number' ? `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` : columns;

  return (
    <div
      aria-label={ariaLabel}
      data-align={align}
      data-cols={typeof columns === 'number' ? String(Math.max(1, columns)) : undefined}
      className={cx('nx-grid', className)}
      style={
        {
          '--layout-gap': GAP_TOKEN[gap],
          '--layout-grid-cols': gridTemplateColumns,
          ...style,
        } as CSSProperties
      }
      {...props}
    />
  );
}

/** Props for the `Beside` main-plus-rail asymmetric two-column layout. */
export interface BesideProps extends CleanElementProps<'div'> {
  rail: ReactNode;
  railWidth?: string;
  side?: 'start' | 'end';
  gap?: LayoutGap;
  stackBelow?: string;
}

/** Main content column beside a fixed-width rail that stacks cleanly on narrow containers. */
export function Beside({
  rail,
  railWidth = '20rem',
  side = 'end',
  gap,
  stackBelow,
  ariaLabel,
  className,
  style,
  children,
  ref,
  ...props
}: BesideProps) {
  const mark = `kit-beside-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const stacks = stackBelow !== undefined && /^\d+(\.\d+)?(rem|em|px|ch)$/.test(stackBelow.trim()) ? stackBelow.trim() : undefined;

  return (
    <div ref={ref} aria-label={ariaLabel} className="kit-beside-host" {...props}>
      {stacks && (
        <style>{`@container kit-beside (max-width: ${stacks}) { .${mark} > .kit-beside-main, .${mark} > .kit-beside-rail { flex-basis: 100%; } }`}</style>
      )}
      <div
        data-side={side}
        className={cx('kit-beside nx-beside', side === 'start' && 'kit-beside-start', stacks && mark, gap && `kit-gap-${gap}`, className)}
        style={
          {
            '--kit-beside-rail': railWidth,
            '--layout-rail-width': railWidth,
            ...(gap ? { '--layout-gap': GAP_TOKEN[gap] } : undefined),
            ...(stacks ? { '--layout-stack-below': stacks } : undefined),
            ...style,
          } as CSSProperties
        }
      >
        <div className="kit-beside-main nx-beside-main">{children}</div>
        <div className="kit-beside-rail nx-beside-rail">{rail}</div>
      </div>
    </div>
  );
}

/* ============================================================================
 * 2. Separator / Divider
 * ========================================================================== */

/** Props for the `Separator` horizontal or vertical rule. */
export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical';
  decorative?: boolean;
  label?: ReactNode;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}

/** Visual and accessible divider line with optional inline label. */
export function Separator({ orientation = 'horizontal', decorative = false, label, className, style, ref }: SeparatorProps) {
  if (label !== undefined && orientation === 'horizontal') {
    return (
      <div
        ref={ref}
        role={decorative ? 'none' : 'separator'}
        aria-orientation={decorative ? undefined : 'horizontal'}
        className={cx('nx-separator-with-label', className)}
        style={style}
      >
        <SdkSeparator decorative orientation="horizontal" className="nx-separator" />
        <span className="nx-separator-label">{label}</span>
        <SdkSeparator decorative orientation="horizontal" className="nx-separator" />
      </div>
    );
  }

  return (
    <SdkSeparator ref={ref} orientation={orientation} decorative={decorative} className={cx('nx-separator', className)} style={style} />
  );
}

/* ============================================================================
 * 3. Card (Unified Kit + Compound Surface)
 * ========================================================================== */

/** Surface elevation variant for `Card`. */
export type CardVariant = 'default' | 'subtle' | 'elevated' | 'ghost';

/** Props for `Card.Header`. */
export interface CardHeaderProps extends CleanElementProps<'div'> {
  bordered?: boolean;
}

/** Header bar inside a compound `Card`. */
export function CardHeader({ bordered = false, ariaLabel, className, ...props }: CardHeaderProps) {
  return <div aria-label={ariaLabel} data-bordered={bordered ? '' : undefined} className={cx('nx-card-header', className)} {...props} />;
}

/** Props for `Card.Title`. */
export type CardTitleProps = CleanElementProps<'h3'>;

/** Heading element inside a compound `Card.Header`. */
export function CardTitle({ ariaLabel, className, ...props }: CardTitleProps) {
  return <h3 aria-label={ariaLabel} className={cx('kit-card-title nx-card-title', className)} {...props} />;
}

/** Props for `Card.Description`. */
export type CardDescriptionProps = CleanElementProps<'p'>;

/** Secondary description line inside a compound `Card.Header`. */
export function CardDescription({ ariaLabel, className, ...props }: CardDescriptionProps) {
  return <p aria-label={ariaLabel} className={cx('kit-card-description nx-card-description', className)} {...props} />;
}

/** Props for `Card.Body`. */
export interface CardBodyProps extends CleanElementProps<'div'> {
  flush?: boolean;
}

/** Content body inside a compound `Card`. */
export function CardBody({ flush = false, ariaLabel, className, ...props }: CardBodyProps) {
  return <div aria-label={ariaLabel} data-flush={flush ? '' : undefined} className={cx('nx-card-body', className)} {...props} />;
}

/** Props for `Card.Footer`. */
export type CardFooterProps = CleanElementProps<'div'>;

/** Footer bar inside a compound `Card`. */
export function CardFooter({ ariaLabel, className, ...props }: CardFooterProps) {
  return <div aria-label={ariaLabel} className={cx('nx-card-footer', className)} {...props} />;
}

/** Props for the unified `Card` container. */
export interface CardProps extends Omit<CleanElementProps<'div'>, 'title'> {
  title?: ReactNode;
  level?: 2 | 3 | 4;
  count?: ReactNode;
  action?: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  footer?: ReactNode;
  tone?: Tone;
  ground?: 'nav';
  variant?: CardVariant;
  interactive?: boolean;
  flush?: boolean;
  borderedHeader?: boolean;
}

function CardBase({
  title,
  level = 3,
  count,
  action,
  actions,
  description,
  badge,
  footer,
  tone,
  ground,
  variant = 'default',
  interactive = false,
  flush = false,
  borderedHeader = false,
  ariaLabel,
  className,
  children,
  ...props
}: CardProps) {
  const nested = Boolean(useInCard());
  const resolvedAction = action ?? actions;
  const hasHeader = title !== undefined || given(description) || given(count) || given(resolvedAction) || given(badge);
  const isCompound = !hasHeader && footer === undefined && hasCompoundChild(children, [CardHeader, CardBody, CardFooter]);

  const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
  const kitTone = toKitTone(tone);
  const heading = title !== undefined && (
    <Tag className={cx('kit-card-title nx-card-title', kitTone && `kit-card-title-${kitTone}`)}>{title}</Tag>
  );

  return (
    <div
      aria-label={ariaLabel}
      data-ground={ground}
      data-variant={nested ? undefined : variant}
      data-interactive={interactive ? '' : undefined}
      className={cx(nested ? 'kit-group' : 'kit-card nx-card', interactive && 'nx-focusable', className)}
      {...props}
    >
      {isCompound ? (
        <InCardContext.Provider value={{ titled: false, level }}>{children}</InCardContext.Provider>
      ) : (
        <>
          {given(count) || given(resolvedAction) || given(badge) ? (
            <div className={cx('kit-card-head', borderedHeader && 'nx-card-header')} data-bordered={borderedHeader ? '' : undefined}>
              {heading}
              {given(badge) && badge}
              {given(count) && <span className="kit-card-count">{count}</span>}
              {given(resolvedAction) && <span className="kit-card-action nx-card-actions">{resolvedAction}</span>}
            </div>
          ) : (
            heading
          )}
          {given(description) && <p className="kit-card-description nx-card-description">{description}</p>}
          <InCardContext.Provider value={{ titled: title !== undefined, level }}>
            {flush ? (
              <div data-flush="" className="nx-card-body">
                {children}
              </div>
            ) : (
              children
            )}
          </InCardContext.Provider>
          {given(footer) && <CardFooter>{footer}</CardFooter>}
        </>
      )}
    </div>
  );
}

/** Bordered surface card that collapses to a plain group when nested inside another `Card`. */
export const Card = Object.assign(CardBase, {
  Header: CardHeader,
  Title: CardTitle,
  Description: CardDescription,
  Body: CardBody,
  Footer: CardFooter,
});

/* ============================================================================
 * 4. Accordion & Collapsible
 * ========================================================================== */

/** Single disclosure item definition for `Accordion`. */
export interface AccordionItemDefinition<T extends string = string> {
  value: T;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

/** Props for the `Accordion` disclosure stack. */
export interface AccordionProps<T extends string = string> {
  items?: ReadonlyArray<AccordionItemDefinition<T>>;
  value?: T[];
  defaultValue?: T[];
  onValueChange?: (value: T[]) => void;
  multiple?: boolean;
  collapsible?: boolean;
  disabled?: boolean;
  keepMounted?: boolean;
  hiddenUntilFound?: boolean;
  orientation?: 'vertical' | 'horizontal';
  variant?: 'default' | 'bordered' | 'separated';
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Props for `Accordion.Item`. */
export interface AccordionItemProps extends CleanElementProps<'div'> {
  value: string;
  disabled?: boolean;
}

function AccordionItemPart({ ariaLabel, className, ...props }: AccordionItemProps) {
  return <SdkAccordionItem aria-label={ariaLabel} className={cx('nx-accordion-item', className)} {...props} />;
}

/** Props for `Accordion.Header`. */
export type AccordionHeaderProps = CleanElementProps<'h3'>;

function AccordionHeaderPart({ ariaLabel, className, ...props }: AccordionHeaderProps) {
  return <SdkAccordionHeader aria-label={ariaLabel} className={cx('nx-accordion-header', className)} {...props} />;
}

/** Props for `AccordionTrigger`. */
export type AccordionTriggerProps = CleanElementProps<'button'>;

/** Expand/collapse button header inside an `Accordion` item. */
export function AccordionTrigger({ children, ariaLabel, className, ...props }: AccordionTriggerProps) {
  return (
    <SdkAccordionTrigger
      aria-label={ariaLabel}
      className={cx('nx-accordion-trigger', className)}
      {...(props as unknown as Record<string, unknown>)}
    >
      <span className="nx-accordion-trigger-main">{children}</span>
      <Icon name="caret-down" size={14} className="nx-accordion-chevron" />
    </SdkAccordionTrigger>
  );
}

/** Props for `Accordion.Panel`. */
export interface AccordionPanelProps extends CleanElementProps<'div'> {
  keepMounted?: boolean;
  hiddenUntilFound?: boolean;
}

function AccordionPanelPart({ ariaLabel, className, ...props }: AccordionPanelProps) {
  return <SdkAccordionPanel aria-label={ariaLabel} className={cx('nx-accordion-panel', className)} {...props} />;
}

function AccordionBase<T extends string = string>({
  items,
  value,
  defaultValue,
  onValueChange,
  multiple,
  collapsible = true,
  disabled,
  keepMounted,
  hiddenUntilFound,
  orientation,
  variant = 'default',
  ariaLabel,
  className,
  style,
  ref,
  children,
}: AccordionProps<T>) {
  return (
    <SdkAccordion<T>
      {...({
        ref,
        value,
        defaultValue,
        onValueChange: onValueChange ? (next: T[]) => onValueChange(next) : undefined,
        multiple,
        collapsible,
        disabled,
        keepMounted,
        hiddenUntilFound,
        orientation,
        'aria-label': ariaLabel,
        'data-variant': variant,
        className: cx('nx-accordion', className),
        style,
      } as unknown as React.ComponentProps<typeof SdkAccordion<T>>)}
    >
      {items
        ? items.map((item) => (
            <SdkAccordionItem key={item.value} value={item.value} disabled={item.disabled} className="nx-accordion-item">
              <SdkAccordionHeader className="nx-accordion-header">
                <AccordionTrigger>
                  {item.icon !== undefined && (
                    <span className="nx-accordion-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  )}
                  <span className="nx-accordion-heading-copy">
                    <span className="nx-accordion-title">{item.title}</span>
                    {item.subtitle !== undefined && <span className="nx-accordion-subtitle">{item.subtitle}</span>}
                  </span>
                </AccordionTrigger>
              </SdkAccordionHeader>
              <SdkAccordionPanel className="nx-accordion-panel">
                <div className="nx-accordion-panel-inner">{item.content}</div>
              </SdkAccordionPanel>
            </SdkAccordionItem>
          ))
        : children}
    </SdkAccordion>
  );
}

/** Vertically stacked disclosure sections with single or multiple expansion. */
export const Accordion = Object.assign(AccordionBase, {
  Root: AccordionBase,
  Item: AccordionItemPart,
  Header: AccordionHeaderPart,
  Trigger: AccordionTrigger,
  Panel: AccordionPanelPart,
});

/** Props for the `Collapsible` disclosure panel. */
export interface CollapsibleProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  disabled?: boolean;
  trigger?: ReactNode;
  title?: ReactNode;
  keepMounted?: boolean;
  hiddenUntilFound?: boolean;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Props for `Collapsible.Trigger`. */
export type CollapsibleTriggerProps = CleanElementProps<'button'>;

function CollapsibleTriggerPart({ ariaLabel, className, ...props }: CollapsibleTriggerProps) {
  return <SdkCollapsibleTrigger aria-label={ariaLabel} className={className} {...props} />;
}

/** Props for `Collapsible.Panel`. */
export interface CollapsiblePanelProps extends CleanElementProps<'div'> {
  keepMounted?: boolean;
  hiddenUntilFound?: boolean;
}

function CollapsiblePanelPart({ ariaLabel, className, ...props }: CollapsiblePanelProps) {
  return <SdkCollapsiblePanel aria-label={ariaLabel} className={cx('nx-collapsible-panel', className)} {...props} />;
}

function CollapsibleBase({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  disabled,
  trigger,
  title,
  keepMounted,
  hiddenUntilFound,
  ariaLabel,
  className,
  style,
  ref,
  children,
}: CollapsibleProps) {
  const isCompound =
    trigger === undefined &&
    title === undefined &&
    hasCompoundChild(children, [SdkCollapsibleTrigger, SdkCollapsiblePanel, CollapsibleTriggerPart, CollapsiblePanelPart]);

  return (
    <SdkCollapsible
      ref={ref}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
      onOpenChangeComplete={onOpenChangeComplete}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cx('nx-collapsible', className)}
      style={style}
    >
      {isCompound ? (
        children
      ) : (
        <>
          {trigger !== undefined && isRenderableElement(trigger) ? (
            <SdkCollapsibleTrigger render={trigger} />
          ) : (
            <SdkCollapsibleTrigger className="nx-collapsible-trigger">
              <span>{trigger ?? title}</span>
              <Icon name="caret-down" size={14} className="nx-accordion-chevron" />
            </SdkCollapsibleTrigger>
          )}
          <SdkCollapsiblePanel keepMounted={keepMounted} hiddenUntilFound={hiddenUntilFound} className="nx-collapsible-panel">
            {children}
          </SdkCollapsiblePanel>
        </>
      )}
    </SdkCollapsible>
  );
}

/** Single expandable/collapsible section with trigger button and content panel. */
export const Collapsible = Object.assign(CollapsibleBase, {
  Root: CollapsibleBase,
  Trigger: CollapsibleTriggerPart,
  Panel: CollapsiblePanelPart,
});

/* ============================================================================
 * 5. Resizable, ScrollArea & Carousel (canonical slotted implementations)
 * ========================================================================== */

/** Props for `ResizableHandle`. */
export interface ResizableHandleProps extends CleanElementProps<'div'> {
  disabled?: boolean;
}

/** Draggable and keyboard-accessible separator handle between resizable panels. */
export function ResizableHandle({ children, ariaLabel, className, ...props }: ResizableHandleProps) {
  return (
    <SdkResizableHandle aria-label={ariaLabel} className={cx('nx-resizable-handle', className)} {...props}>
      {children ?? <span className="nx-resizable-grip" aria-hidden="true" />}
    </SdkResizableHandle>
  );
}

export {
  Carousel,
  Resizable,
  ScrollArea,
  type CarouselProps,
  type CarouselSlide,
  type ResizablePanel,
  type ResizableProps,
  type ScrollAreaProps,
};
