/** Responsive workspace frame combining a collapsible navigation sidebar, breadcrumb top bar, and tabbed page header. */
import { Button } from '../Button.js';
import { Icon } from '../Icon.js';
import { Avatar, AvatarFallback, AvatarImage } from '@ui-sdk/react/avatar';
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle } from '@ui-sdk/react/drawer';
import { Menu, MenuContent, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu';
import { Fragment, type MouseEvent, type ReactNode, type Ref, useCallback, useEffect, useId, useRef, useState } from 'react';
import { cx, toDataTone, type Tone } from '../internal/cx.js';
import { viewportBox, viewportSize } from '../internal/ruler.js';
import { type UiSurfaceSeam, useSurfaceSeam } from '../internal/surfaceSeam.js';
import type { BreadcrumbItem } from '../primitives/navigation.js';

export type { BreadcrumbItem };

/** Workspace switcher option rendered in `Sidebar`. */
export interface WorkspaceOption {
  id: string;
  name: string;
  plan?: string;
  monogram?: string;
  accentColor?: string;
}

/** Navigation item entry rendered in `Sidebar`. */
export interface NavItem {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number | string;
  tone?: Tone;
  href?: string;
  shortcut?: string;
  disabled?: boolean;
}

/** Collapsible navigation section rendered in `Sidebar`. */
export interface NavSection {
  id: string;
  label: string;
  items: ReadonlyArray<NavItem>;
  collapsible?: boolean;
  defaultOpen?: boolean;
}

/** Signed-in user profile summary rendered in the `Sidebar` footer. */
export interface SidebarUser {
  name: string;
  email?: string;
  role?: string;
  avatarUrl?: string;
  initials?: string;
  statusTone?: Tone;
}

/** Tab item rendered in `PageHeader`. */
export interface PageHeaderTab {
  id: string;
  label: ReactNode;
  count?: number | string;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Back navigation link descriptor for `PageHeader`. */
export interface PageHeaderBack {
  label: string;
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

/** Props for the `Sidebar` component. */
export interface SidebarProps {
  workspaces?: ReadonlyArray<WorkspaceOption>;
  activeWorkspaceId?: string;
  onWorkspaceChange?: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  /* Search / Command Trigger */
  searchLabel?: string;
  searchShortcut?: string;
  onSearchTrigger?: () => void;
  /* Navigation */
  items?: ReadonlyArray<NavItem>;
  favorites?: ReadonlyArray<NavItem>;
  sections?: ReadonlyArray<NavSection>;
  activeItemId?: string;
  onSelectItem?: (itemId: string, item: NavItem) => void;
  /* Collapse & Footer */
  collapsed?: boolean;
  user?: SidebarUser;
  onSettingsClick?: () => void;
  footerSlot?: ReactNode;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/** Props for the `TopBar` component. */
export interface TopBarProps {
  breadcrumbs?: ReadonlyArray<BreadcrumbItem>;
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
  isMobile?: boolean;
  actions?: ReactNode;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/** Props for the `PageHeader` component. */
export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  back?: PageHeaderBack;
  level?: 1 | 2;
  badge?: ReactNode;
  icon?: ReactNode;
  tabs?: ReadonlyArray<PageHeaderTab>;
  activeTab?: string;
  defaultTab?: string;
  onTabChange?: (tabId: string) => void;
  actions?: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Props for the `AppShell` component. */
export interface AppShellProps {
  sidebarProps: SidebarProps;
  breadcrumbs?: ReadonlyArray<BreadcrumbItem>;
  topBarActions?: ReactNode;
  header?: ReactNode;
  /* Collapse control */
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  mobileBreakpoint?: number;
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'W'
  );
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

/* What a link is given where no host has said how its links are followed: the address, and the click as it is. */
const plainLinkProps: NonNullable<UiSurfaceSeam['useLinkProps']> = (href, onClick) => ({ href, onClick });

/* One navigation item. It is a component of its own because the host's `useLinkProps` is a hook: called from the
   sidebar's loop over its items, and only for the ones with an address, the count of hooks changed whenever an item
   gained or lost its `href`.

   An item with an address is always a link, whether or not the sidebar is also told of the choice. It used to become
   a button as soon as `onSelectItem` was passed, and the mobile drawer always passes one to close itself: under the
   breakpoint every address-only item closed the drawer and went nowhere. A host that follows the item itself in
   `onSelectItem` leaves `href` off, or the item is followed twice. */
function SidebarNavItem({
  item,
  active,
  collapsed,
  onSelectItem,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onSelectItem?: (itemId: string, item: NavItem) => void;
}) {
  const seam = useSurfaceSeam();
  const useLinkProps = seam?.useLinkProps ?? plainLinkProps;
  const linkProps = useLinkProps(item.href, (event) => {
    if (item.disabled) {
      event.preventDefault();
      return;
    }
    onSelectItem?.(item.id, item);
  });

  const content = (
    <>
      {item.icon && <span className="nx-sidebar-item-icon">{item.icon}</span>}
      {!collapsed && (
        <>
          <span className="nx-sidebar-item-label">{item.label}</span>
          {item.count !== undefined && (
            <span className="nx-sidebar-item-count" data-tone={toDataTone(item.tone)}>
              {item.count}
            </span>
          )}
          {item.shortcut && item.count === undefined && <kbd className="nx-kbd">{item.shortcut}</kbd>}
        </>
      )}
    </>
  );

  if (item.href) {
    return (
      <a
        href={linkProps.href ?? item.href}
        onClick={linkProps.onClick as ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined}
        aria-current={active ? 'page' : undefined}
        aria-disabled={item.disabled ? true : undefined}
        title={collapsed ? item.label : undefined}
        className="nx-sidebar-item"
        data-active={active ? '' : undefined}
        data-disabled={item.disabled ? '' : undefined}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      disabled={item.disabled}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className="nx-sidebar-item"
      data-active={active ? '' : undefined}
      onClick={() => onSelectItem?.(item.id, item)}
    >
      {content}
    </button>
  );
}

/** Collapsible workspace navigation rail with workspace switcher, pinned items, and user bar. */
export function Sidebar({
  workspaces = [],
  activeWorkspaceId,
  onWorkspaceChange,
  onCreateWorkspace,
  searchLabel = 'Search or jump to…',
  searchShortcut = '⌘K',
  onSearchTrigger,
  items = [],
  favorites = [],
  sections = [],
  activeItemId,
  onSelectItem,
  collapsed = false,
  user,
  onSettingsClick,
  footerSlot,
  className,
  ref,
}: SidebarProps) {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const sec of sections) {
      init[sec.id] = sec.defaultOpen !== false;
    }
    return init;
  });

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];

  const toggleSection = (secId: string) => {
    setOpenSections((prev) => ({ ...prev, [secId]: !(prev[secId] ?? true) }));
  };

  const renderNavLink = (item: NavItem) => (
    <SidebarNavItem key={item.id} item={item} active={item.id === activeItemId} collapsed={collapsed} onSelectItem={onSelectItem} />
  );

  return (
    <aside ref={ref} className={cx('nx-sidebar', className)} data-collapsed={collapsed ? '' : undefined} aria-label="Workspace navigation">
      {/* Workspace Switcher */}
      {activeWorkspace && (
        <div className="nx-sidebar-top">
          <Menu>
            <MenuTrigger className="nx-workspace-trigger" aria-label={`Switch workspace (${activeWorkspace.name})`}>
              <span
                className="nx-workspace-logo"
                style={activeWorkspace.accentColor ? { background: activeWorkspace.accentColor } : undefined}
              >
                {activeWorkspace.monogram ?? initialsOf(activeWorkspace.name)}
              </span>
              {!collapsed && (
                <>
                  <span className="nx-workspace-info">
                    <span className="nx-workspace-name">{activeWorkspace.name}</span>
                    {activeWorkspace.plan && <span className="nx-workspace-plan">{activeWorkspace.plan}</span>}
                  </span>
                  <Icon name="caret-up-down" size={13} className="nx-workspace-caret" />
                </>
              )}
            </MenuTrigger>

            <MenuContent align="start" sideOffset={6} className="nx-workspace-menu">
              <MenuGroupLabel className="nx-menu-group-label">Workspaces</MenuGroupLabel>
              {workspaces.map((ws) => {
                const selected = ws.id === activeWorkspace.id;
                return (
                  <MenuItem key={ws.id} value={ws.id} onSelect={() => onWorkspaceChange?.(ws.id)} className="nx-workspace-menu-item">
                    <span
                      className="nx-workspace-logo nx-workspace-logo-sm"
                      style={ws.accentColor ? { background: ws.accentColor } : undefined}
                    >
                      {ws.monogram ?? initialsOf(ws.name)}
                    </span>
                    <span className="nx-workspace-menu-name">{ws.name}</span>
                    {selected && <Icon name="check" size={13} weight="bold" className="nx-workspace-check" />}
                  </MenuItem>
                );
              })}
              {onCreateWorkspace && (
                <>
                  <MenuSeparator className="nx-menu-sep" />
                  <MenuItem value="create-workspace" onSelect={onCreateWorkspace} className="nx-workspace-menu-item">
                    <Icon name="plus" size={13} weight="bold" />
                    <span>Create workspace…</span>
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        </div>
      )}

      {/* Search / Command Trigger */}
      {onSearchTrigger && (
        <div className="nx-sidebar-search-wrap">
          <button
            type="button"
            className="nx-sidebar-search-btn"
            onClick={onSearchTrigger}
            title={collapsed ? `${searchLabel} (${searchShortcut})` : undefined}
            aria-label={searchLabel}
          >
            <Icon name="magnifying-glass" size={14} className="nx-sidebar-search-icon" />
            {!collapsed && (
              <>
                <span className="nx-sidebar-search-text">{searchLabel}</span>
                <kbd className="nx-kbd">{searchShortcut}</kbd>
              </>
            )}
          </button>
        </div>
      )}

      {/* Scrollable Navigation Sections */}
      <nav className="nx-sidebar-nav">
        {items.length > 0 && <div className="nx-sidebar-group">{items.map(renderNavLink)}</div>}

        {favorites.length > 0 && (
          <div className="nx-sidebar-section">
            {!collapsed && (
              <div className="nx-sidebar-section-head">
                <Icon name="push-pin" size={11} weight="bold" />
                <span>Pinned</span>
              </div>
            )}
            <div className="nx-sidebar-group">{favorites.map(renderNavLink)}</div>
          </div>
        )}

        {sections.map((section) => {
          const isOpen = openSections[section.id] ?? true;
          const isCollapsible = section.collapsible !== false;
          return (
            <div key={section.id} className="nx-sidebar-section">
              {!collapsed &&
                (isCollapsible ? (
                  <button type="button" className="nx-sidebar-section-btn" aria-expanded={isOpen} onClick={() => toggleSection(section.id)}>
                    <Icon
                      name="caret-down"
                      size={11}
                      weight="bold"
                      className="nx-sidebar-section-caret"
                      data-closed={!isOpen ? '' : undefined}
                    />
                    <span>{section.label}</span>
                  </button>
                ) : (
                  <div className="nx-sidebar-section-head">
                    <span>{section.label}</span>
                  </div>
                ))}
              {(collapsed || isOpen) && <div className="nx-sidebar-group">{section.items.map(renderNavLink)}</div>}
            </div>
          );
        })}
      </nav>

      {/* Bottom User & Settings Bar */}
      {(user || footerSlot || onSettingsClick) && (
        <div className="nx-sidebar-footer">
          {footerSlot}
          {user && (
            <div className="nx-sidebar-user-row">
              <div className="nx-sidebar-user-info" title={collapsed ? user.name : undefined}>
                <Avatar className="nx-sidebar-avatar">
                  {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.name} />}
                  <AvatarFallback className="nx-sidebar-avatar-fallback">{user.initials ?? initialsOf(user.name)}</AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <div className="nx-sidebar-user-text">
                    <span className="nx-sidebar-user-name">{user.name}</span>
                    {(user.email || user.role) && <span className="nx-sidebar-user-sub">{user.email ?? user.role}</span>}
                  </div>
                )}
              </div>

              {!collapsed && onSettingsClick && (
                <button type="button" className="nx-sidebar-settings-btn" onClick={onSettingsClick} aria-label="Workspace settings">
                  <Icon name="gear" size={15} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* TopBar                                                                     */
/* -------------------------------------------------------------------------- */

/** Top workspace header bar with sidebar toggle, breadcrumbs, and trailing actions. */
export function TopBar({ breadcrumbs = [], onToggleSidebar, sidebarCollapsed, isMobile = false, actions, className, ref }: TopBarProps) {
  return (
    <header ref={ref} className={cx('nx-topbar', className)}>
      <div className="nx-topbar-left">
        {onToggleSidebar && (
          <button
            type="button"
            className="nx-topbar-toggle"
            onClick={onToggleSidebar}
            aria-label={isMobile ? 'Open navigation menu' : sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isMobile ? <Icon name="list" size={16} weight="bold" /> : <Icon name="sidebar-simple" size={16} />}
          </button>
        )}

        {breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="nx-breadcrumbs">
            {breadcrumbs.map((crumb, idx) => {
              const isCurrent = idx === breadcrumbs.length - 1;
              return (
                <Fragment key={crumb.id ?? idx}>
                  {idx > 0 && <Icon name="caret-right" size={11} weight="bold" className="nx-breadcrumb-sep" />}
                  {isCurrent ? (
                    <span className="nx-breadcrumb-current" aria-current="page">
                      {crumb.icon && <span className="nx-breadcrumb-icon">{crumb.icon}</span>}
                      <span>{crumb.label}</span>
                    </span>
                  ) : crumb.href ? (
                    <a href={crumb.href} className="nx-breadcrumb-link" onClick={crumb.onClick}>
                      {crumb.icon && <span className="nx-breadcrumb-icon">{crumb.icon}</span>}
                      <span>{crumb.label}</span>
                    </a>
                  ) : crumb.onClick ? (
                    <button type="button" className="nx-breadcrumb-link" onClick={crumb.onClick}>
                      {crumb.icon && <span className="nx-breadcrumb-icon">{crumb.icon}</span>}
                      <span>{crumb.label}</span>
                    </button>
                  ) : (
                    <span className="nx-breadcrumb-link">
                      {crumb.icon && <span className="nx-breadcrumb-icon">{crumb.icon}</span>}
                      <span>{crumb.label}</span>
                    </span>
                  )}
                </Fragment>
              );
            })}
          </nav>
        )}
      </div>

      {actions && <div className="nx-topbar-actions">{actions}</div>}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* PageHeader                                                                 */
/* -------------------------------------------------------------------------- */

/** Unified page heading bar supporting back navigation, description intro, action verbs, and optional section tabs. */
export function PageHeader(props: PageHeaderProps) {
  const {
    title,
    description,
    back,
    level: explicitLevel,
    badge,
    icon,
    tabs,
    activeTab: controlledTab,
    defaultTab,
    onTabChange,
    actions,
    className,
    ref,
  } = props;
  const seam = useSurfaceSeam();
  const legacySubtitle = (props as unknown as { subtitle?: ReactNode }).subtitle;
  const resolvedDescription = description ?? legacySubtitle;
  const resolvedLevel = explicitLevel ?? seam?.defaultPageHeaderLevel ?? 1;
  const TitleTag = resolvedLevel === 1 ? 'h1' : 'h2';

  const [internalTab, setInternalTab] = useState<string>(defaultTab ?? tabs?.[0]?.id ?? '');
  const currentTab = controlledTab !== undefined ? controlledTab : internalTab;

  const selectTab = (tabId: string) => {
    if (controlledTab === undefined) setInternalTab(tabId);
    onTabChange?.(tabId);
  };

  const backControl = back
    ? (() => {
        const clean = back.label.replace(/^back to\s+/i, '').trim() || back.label;
        const fullLabel = seam?.defaultWords?.().backTo?.(clean) ?? `Back to ${clean}`;
        return (
          <Button variant="ghost" size="sm" href={back.href} onClick={back.onClick}>
            {fullLabel}
          </Button>
        );
      })()
    : undefined;

  const hasTabsOrAdornments = Boolean(icon || badge || (tabs && tabs.length > 0));
  const drawnActions = actions !== undefined && actions !== null && actions !== false;

  if (!hasTabsOrAdornments && seam?.defaultPageHeaderLevel === 2) {
    const heading = <TitleTag className="applist-title">{title}</TitleTag>;
    const intro = resolvedDescription ? <p className="note dash-description">{resolvedDescription}</p> : null;
    return (
      <div
        ref={ref}
        className={`applist-head dash-head${drawnActions ? ' has-actions' : ''}${backControl ? ' has-back' : ''}${className ? ` ${className}` : ''}`}
      >
        {backControl ? <div className="dash-head-back">{backControl}</div> : null}
        {drawnActions ? (
          <>
            <div className="dash-head-text">
              {heading}
              {intro}
            </div>
            <div className="applist-head-tools dash-head-actions" data-page-actions="">
              {actions}
            </div>
          </>
        ) : (
          <>
            {heading}
            {intro}
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cx('applist-head dash-head nx-page-header', drawnActions && 'has-actions', backControl && 'has-back', className)}
    >
      {backControl && <div className="dash-head-back nx-page-header-back">{backControl}</div>}
      <div className="nx-page-header-main">
        <div className="dash-head-text nx-page-header-copy">
          <div className="nx-page-header-title-row">
            {icon && <span className="nx-page-header-icon">{icon}</span>}
            <TitleTag className="applist-title nx-page-header-title">{title}</TitleTag>
            {badge}
          </div>
          {resolvedDescription && <p className="note dash-description nx-page-header-subtitle">{resolvedDescription}</p>}
        </div>

        {drawnActions && <div className="applist-head-tools dash-head-actions nx-page-header-actions">{actions}</div>}
      </div>

      {tabs && tabs.length > 0 && (
        <div className="nx-page-header-tabs" role="tablist">
          {tabs.map((tab) => {
            const isActive = tab.id === currentTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                disabled={tab.disabled}
                aria-selected={isActive}
                className="nx-page-header-tab"
                data-active={isActive ? '' : undefined}
                onClick={() => selectTab(tab.id)}
              >
                {tab.icon && <span className="nx-page-tab-icon">{tab.icon}</span>}
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span className="nx-badge" data-tone={isActive ? 'accent' : undefined} data-pill="">
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* AppShell                                                                   */
/* -------------------------------------------------------------------------- */

/** Responsive application workspace shell with desktop rail, mobile drawer, topbar, and main stage. */
export function AppShell({
  sidebarProps,
  breadcrumbs,
  topBarActions,
  header,
  collapsed: controlledCollapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  mobileBreakpoint = 768,
  children,
  className,
  ref: externalRef,
}: AppShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const setShellRef = useCallback(
    (node: HTMLDivElement | null) => {
      shellRef.current = node;
      if (typeof externalRef === 'function') externalRef(node);
      else if (externalRef) (externalRef as { current: HTMLDivElement | null }).current = node;
    },
    [externalRef],
  );
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== 'undefined' && viewportSize().width > 0 && viewportSize().width < mobileBreakpoint,
  );
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);

  const collapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;
  const mainId = useId();

  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const w = viewportBox(el).width;
      if (w > 0) setIsMobile(w < mobileBreakpoint);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mobileBreakpoint]);

  const handleToggleSidebar = () => {
    if (isMobile) {
      setMobileDrawerOpen((prev) => !prev);
      return;
    }
    const next = !collapsed;
    if (controlledCollapsed === undefined) setInternalCollapsed(next);
    onCollapsedChange?.(next);
  };

  return (
    <div
      ref={setShellRef}
      className={cx('nx-app-shell', className)}
      data-mobile={isMobile ? '' : undefined}
      data-sidebar-collapsed={!isMobile && collapsed ? '' : undefined}
    >
      {/* First in the shell, so a keyboard's first Tab can pass the whole navigation rail and the top bar. */}
      <a className="nx-skip-link" href={`#${mainId}`}>
        Skip to main content
      </a>

      {/* Desktop Persistent Sidebar */}
      {!isMobile && <Sidebar {...sidebarProps} collapsed={collapsed} />}

      {/* Mobile Navigation Drawer */}
      {isMobile && (
        <Drawer side="left" open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen}>
          <DrawerBackdrop className="nx-shell-drawer-backdrop" />
          <DrawerContent className="nx-shell-drawer-content">
            <div className="nx-shell-drawer-bar">
              <DrawerTitle className="nx-sr-only">Workspace navigation</DrawerTitle>
              <DrawerClose className="nx-shell-drawer-close" aria-label="Close navigation drawer">
                <Icon name="x" size={15} weight="bold" />
              </DrawerClose>
            </div>
            <Sidebar
              {...sidebarProps}
              collapsed={false}
              onSelectItem={(id, item) => {
                sidebarProps.onSelectItem?.(id, item);
                setMobileDrawerOpen(false);
              }}
              className="nx-sidebar-in-drawer"
            />
          </DrawerContent>
        </Drawer>
      )}

      {/* Main Content Stage */}
      <div className="nx-app-shell-stage">
        <TopBar
          breadcrumbs={breadcrumbs}
          onToggleSidebar={handleToggleSidebar}
          sidebarCollapsed={collapsed}
          isMobile={isMobile}
          actions={topBarActions}
        />
        {header}
        <main id={mainId} tabIndex={-1} className="nx-app-shell-main">
          {children}
        </main>
      </div>
    </div>
  );
}
