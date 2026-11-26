/** Tabbed panels, horizontal navigation menus, breadcrumb trails, and pagination bars over UI SDK. */
'use client';

import { Icon } from '../Icon.js';
import {
  NavigationMenu as SdkNavigationMenu,
  NavigationMenuContent as SdkNavigationMenuContent,
  NavigationMenuItem as SdkNavigationMenuItem,
  NavigationMenuLink as SdkNavigationMenuLink,
  NavigationMenuLinkIcon as SdkNavigationMenuLinkIcon,
  NavigationMenuList as SdkNavigationMenuList,
  NavigationMenuTrigger as SdkNavigationMenuTrigger,
  NavigationMenuViewport as SdkNavigationMenuViewport,
} from '@ui-sdk/react/navigation-menu';
import type { CSSProperties, ComponentProps, MouseEvent, ReactNode, Ref } from 'react';
import { cx } from '../internal/cx.js';
import { useSurfaceSeam } from '../internal/surfaceSeam.js';
import { Pagination, type PaginationProps } from '../Pagination.js';
import { Tabs, type TabItem, type TabItemDefinition, type TabsProps, type TabsVariant } from '../Tabs.js';

type CleanElementProps<T extends keyof React.JSX.IntrinsicElements> = Omit<ComponentProps<T>, 'onChange' | 'aria-label' | 'inlist'> & {
  ariaLabel?: string;
};

/* ============================================================================
 * 1. Tabs (slotted canonical Tabs)
 * ========================================================================== */

export { Tabs, type TabItem, type TabItemDefinition, type TabsProps, type TabsVariant };

/* ============================================================================
 * 2. NavigationMenu
 * ========================================================================== */

/** Sub-link card item inside a `NavigationMenu` dropdown panel. */
export interface NavigationMenuSubLink {
  label: ReactNode;
  description?: ReactNode;
  href: string;
  icon?: ReactNode;
  current?: boolean;
}

/** Top-level link or dropdown entry inside `NavigationMenu`. */
export interface NavigationMenuEntry<T extends string = string> {
  value?: T;
  label: ReactNode;
  href?: string;
  icon?: ReactNode;
  current?: boolean;
  disabled?: boolean;
  links?: ReadonlyArray<NavigationMenuSubLink>;
  content?: ReactNode;
}

/** Props for the `NavigationMenu` site/workspace navigation bar. */
export interface NavigationMenuComponentProps<T extends string = string> {
  items?: ReadonlyArray<NavigationMenuEntry<T>>;
  value?: T | null;
  defaultValue?: T | null;
  onValueChange?: (value: T | null) => void;
  delay?: number;
  closeDelay?: number;
  openOnHover?: boolean;
  closeOnSelect?: boolean;
  orientation?: 'horizontal' | 'vertical';
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
  children?: ReactNode;
}

/** Alias for `NavigationMenuComponentProps`. */
export type NavigationMenuProps<T extends string = string> = NavigationMenuComponentProps<T>;

function NavMenuLink({ href, current, className, children }: { href: string; current?: boolean; className: string; children: ReactNode }) {
  const seam = useSurfaceSeam();
  const linkProps = seam?.useLinkProps ? seam.useLinkProps(href) : { href };
  return (
    <SdkNavigationMenuLink
      href={linkProps.href ?? href}
      onClick={linkProps.onClick as ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined}
      current={current}
      className={className}
    >
      {children}
    </SdkNavigationMenuLink>
  );
}

/** Accessible top-level navigation menu bar with hover/keyboard flyout link panels. */
export function NavigationMenu<T extends string = string>({
  items,
  value,
  defaultValue,
  onValueChange,
  delay,
  closeDelay,
  openOnHover,
  closeOnSelect,
  orientation,
  ariaLabel,
  className,
  style,
  ref,
  children,
}: NavigationMenuComponentProps<T>) {
  return (
    <SdkNavigationMenu<T>
      ref={ref}
      value={value ?? undefined}
      defaultValue={defaultValue ?? undefined}
      onValueChange={onValueChange ? (next) => onValueChange(next) : undefined}
      delay={delay}
      closeDelay={closeDelay}
      openOnHover={openOnHover}
      closeOnSelect={closeOnSelect}
      orientation={orientation}
      aria-label={ariaLabel}
      className={cx('nx-nav-menu', className)}
      style={style}
    >
      {items ? (
        <>
          <SdkNavigationMenuList className="nx-nav-menu-list">
            {items.map((item, idx) => {
              const hasPanel = (item.links !== undefined && item.links.length > 0) || item.content !== undefined;

              return (
                <SdkNavigationMenuItem key={item.value ?? idx} value={item.value} className="nx-nav-menu-item">
                  {hasPanel ? (
                    <>
                      <SdkNavigationMenuTrigger disabled={item.disabled} className="nx-nav-menu-trigger">
                        {item.icon !== undefined && (
                          <span className="nx-nav-menu-icon" aria-hidden="true">
                            {item.icon}
                          </span>
                        )}
                        <span>{item.label}</span>
                        <Icon name="caret-down" size={12} className="nx-nav-menu-chevron" />
                      </SdkNavigationMenuTrigger>
                      <SdkNavigationMenuContent className="nx-nav-menu-content">
                        {item.content ?? (
                          <div className="nx-nav-menu-grid">
                            {item.links?.map((sub, subIdx) => (
                              <NavMenuLink key={subIdx} href={sub.href} current={sub.current} className="nx-nav-menu-card">
                                {sub.icon !== undefined && (
                                  <SdkNavigationMenuLinkIcon className="nx-nav-menu-card-icon">{sub.icon}</SdkNavigationMenuLinkIcon>
                                )}
                                <div className="nx-nav-menu-card-copy">
                                  <span className="nx-nav-menu-card-title">{sub.label}</span>
                                  {sub.description !== undefined && <span className="nx-nav-menu-card-desc">{sub.description}</span>}
                                </div>
                              </NavMenuLink>
                            ))}
                          </div>
                        )}
                      </SdkNavigationMenuContent>
                    </>
                  ) : (
                    <NavMenuLink href={item.href ?? '#'} current={item.current} className="nx-nav-menu-link">
                      {item.icon !== undefined && (
                        <SdkNavigationMenuLinkIcon className="nx-nav-menu-icon">{item.icon}</SdkNavigationMenuLinkIcon>
                      )}
                      <span>{item.label}</span>
                    </NavMenuLink>
                  )}
                </SdkNavigationMenuItem>
              );
            })}
          </SdkNavigationMenuList>
          <SdkNavigationMenuViewport sideOffset={6} className="nx-nav-menu-viewport" />
        </>
      ) : (
        children
      )}
    </SdkNavigationMenu>
  );
}

/* ============================================================================
 * 3. Breadcrumbs
 * ========================================================================== */

/** Single step item in a `Breadcrumbs` trail. */
export interface BreadcrumbItem {
  id?: string;
  label: ReactNode;
  href?: string;
  icon?: ReactNode;
  current?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

/** Props for the `Breadcrumbs` ancestor trail. */
export interface BreadcrumbsProps extends CleanElementProps<'nav'> {
  items: ReadonlyArray<BreadcrumbItem>;
  separator?: ReactNode;
}

function BreadcrumbAnchor({ item, children }: { item: BreadcrumbItem; children: ReactNode }) {
  const seam = useSurfaceSeam();
  const linkProps = seam?.useLinkProps ? seam.useLinkProps(item.href, item.onClick) : { href: item.href, onClick: item.onClick };
  return (
    <a
      href={linkProps.href ?? item.href}
      onClick={linkProps.onClick as ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined}
      className="nx-breadcrumb-link nx-focusable"
    >
      {children}
    </a>
  );
}

/** Hierarchical breadcrumb navigation trail marking the active page with `aria-current="page"`. */
export function Breadcrumbs(props: BreadcrumbsProps) {
  const { items, separator, ariaLabel, className, ...rest } = props;
  const resolvedAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'] ?? 'Breadcrumb';

  return (
    <nav aria-label={resolvedAriaLabel} className={cx('nx-breadcrumbs', className)} {...rest}>
      <ol className="nx-breadcrumbs-list">
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          const isCurrent = item.current ?? isLast;
          const inner = (
            <>
              {item.icon !== undefined && (
                <span className="nx-breadcrumb-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span className="nx-breadcrumb-label">{item.label}</span>
            </>
          );

          return (
            <li key={item.id ?? idx} className="nx-breadcrumb-item">
              {idx > 0 && (
                <span className="nx-breadcrumb-separator" aria-hidden="true">
                  {separator ?? <Icon name="caret-right" size={11} weight="bold" />}
                </span>
              )}
              {item.href !== undefined && !isCurrent ? (
                <BreadcrumbAnchor item={item}>{inner}</BreadcrumbAnchor>
              ) : item.onClick !== undefined && !isCurrent ? (
                <button
                  type="button"
                  onClick={item.onClick as (event: MouseEvent<HTMLButtonElement>) => void}
                  className="nx-breadcrumb-btn nx-focusable"
                >
                  {inner}
                </button>
              ) : (
                <span
                  aria-current={isCurrent ? 'page' : undefined}
                  className={cx('nx-breadcrumb-text', isCurrent && 'nx-breadcrumb-current')}
                >
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ============================================================================
 * 4. Pagination (slotted canonical Pagination)
 * ========================================================================== */

export { Pagination, type PaginationProps };
