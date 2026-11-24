/** Dropdown menus, right-click context menus, menubars, and command palettes over UI SDK menu primitives. */
'use client';

import { Icon } from '../Icon.js';
import {
  Command as SdkCommand,
  CommandEmpty as SdkCommandEmpty,
  CommandGroup as SdkCommandGroup,
  CommandGroupLabel as SdkCommandGroupLabel,
  CommandInput as SdkCommandInput,
  CommandItem as SdkCommandItem,
  CommandItemIcon as SdkCommandItemIcon,
  CommandItemText as SdkCommandItemText,
  CommandList as SdkCommandList,
  CommandShortcut as SdkCommandShortcut,
} from '@ui-sdk/react/command';
import {
  Dialog as SdkDialog,
  DialogBackdrop as SdkDialogBackdrop,
  DialogContent as SdkDialogContent,
  DialogTitle as SdkDialogTitle,
} from '@ui-sdk/react/dialog';
import {
  Menu as SdkMenu,
  MenuCheckboxItem as SdkMenuCheckboxItem,
  MenuContent as SdkMenuContent,
  MenuContextTrigger as SdkMenuContextTrigger,
  MenuGroup as SdkMenuGroup,
  MenuGroupLabel as SdkMenuGroupLabel,
  MenuItem as SdkMenuItem,
  MenuItemIcon as SdkMenuItemIcon,
  MenuItemIndicator as SdkMenuItemIndicator,
  MenuRadioGroup as SdkMenuRadioGroup,
  MenuRadioItem as SdkMenuRadioItem,
  MenuSeparator as SdkMenuSeparator,
  MenuSub as SdkMenuSub,
  MenuSubContent as SdkMenuSubContent,
  MenuSubTrigger as SdkMenuSubTrigger,
  MenuTrigger as SdkMenuTrigger,
} from '@ui-sdk/react/menu';
import { Menubar as SdkMenubar } from '@ui-sdk/react/menubar';
import { useShortcut } from '@ui-sdk/react/shortcuts';
import { Fragment, isValidElement, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type Ref } from 'react';
import {
  DropGroup,
  DropItem,
  DropMenu,
  DropSeparator,
  type DropGroupProps,
  type DropItemProps,
  type DropMenuProps,
  type DropSeparatorProps,
} from '../DropMenu.js';
import { cx, isEmptyStateSpec, type EmptyStateSpec } from '../internal/cx.js';

function isRenderableElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return isValidElement(node) && node.type !== Fragment;
}

function renderEmptyNode(empty: EmptyStateSpec | ReactNode): ReactNode {
  if (isEmptyStateSpec(empty)) {
    return (
      <div className="nx-empty-inline">
        <div className="nx-empty-inline-title">{empty.title}</div>
        {empty.body !== undefined && <div className="nx-empty-inline-body">{empty.body}</div>}
        {empty.action !== undefined && <div className="nx-empty-inline-action">{empty.action}</div>}
      </div>
    );
  }
  return empty;
}

/* ============================================================================
 * 1. Menu Data Types & Recursive Entry Renderer
 * ========================================================================== */

/** Standard action item inside a `DropdownMenu`, `ContextMenu`, or `Menubar`. */
export interface MenuActionEntry {
  type?: 'item';
  id?: string;
  value?: string;
  label: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  closeOnSelect?: boolean;
  onSelect?: () => unknown;
}

/** Visual divider entry between menu sections. */
export interface MenuSeparatorEntry {
  type: 'separator';
  id?: string;
}

/** Titled group of menu entries. */
export interface MenuGroupEntry {
  type: 'group';
  id?: string;
  label?: ReactNode;
  items: ReadonlyArray<MenuEntry>;
}

/** Checkable boolean toggle item inside a menu. */
export interface MenuCheckboxEntry {
  type: 'checkbox';
  id?: string;
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  closeOnSelect?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/** Exclusive radio selection group inside a menu. */
export interface MenuRadioGroupEntry {
  type: 'radio-group';
  id?: string;
  name: string;
  label?: ReactNode;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
  items: ReadonlyArray<{
    value: string;
    label: ReactNode;
    disabled?: boolean;
  }>;
}

/** Nested cascading submenu entry. */
export interface MenuSubmenuEntry {
  type?: 'submenu';
  id?: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  submenu: ReadonlyArray<MenuEntry>;
}

/** Union of declarative menu entries supported by `DropdownMenu`, `ContextMenu`, and `Menubar`. */
export type MenuEntry = MenuActionEntry | MenuSeparatorEntry | MenuGroupEntry | MenuCheckboxEntry | MenuRadioGroupEntry | MenuSubmenuEntry;

function isSubmenuEntry(entry: MenuEntry): entry is MenuSubmenuEntry {
  return 'submenu' in entry && Array.isArray(entry.submenu);
}

function renderMenuEntries(entries: ReadonlyArray<MenuEntry>): ReactNode {
  return entries.map((entry, idx) => {
    const key = entry.id ?? idx;

    if (entry.type === 'separator') {
      return <SdkMenuSeparator key={key} className="nx-menu-separator" />;
    }

    if (entry.type === 'group') {
      return (
        <SdkMenuGroup key={key} className="nx-menu-group">
          {entry.label !== undefined && <SdkMenuGroupLabel className="nx-menu-group-label">{entry.label}</SdkMenuGroupLabel>}
          {renderMenuEntries(entry.items)}
        </SdkMenuGroup>
      );
    }

    if (entry.type === 'checkbox') {
      return (
        <SdkMenuCheckboxItem
          key={entry.id ?? entry.value}
          value={entry.value}
          label={typeof entry.label === 'string' ? entry.label : undefined}
          checked={entry.checked}
          defaultChecked={entry.defaultChecked}
          disabled={entry.disabled}
          closeOnSelect={entry.closeOnSelect}
          onCheckedChange={entry.onCheckedChange ? (next) => entry.onCheckedChange?.(next) : undefined}
          className="nx-menu-item nx-menu-checkable-item"
        >
          <span className="nx-menu-indicator-slot">
            <SdkMenuItemIndicator className="nx-menu-item-indicator">
              <Icon name="check" size={12} weight="bold" />
            </SdkMenuItemIndicator>
          </span>
          {entry.icon !== undefined && <SdkMenuItemIcon className="nx-menu-item-icon">{entry.icon}</SdkMenuItemIcon>}
          <span className="nx-menu-item-label">{entry.label}</span>
        </SdkMenuCheckboxItem>
      );
    }

    if (entry.type === 'radio-group') {
      return (
        <SdkMenuRadioGroup
          key={entry.id ?? entry.name}
          name={entry.name}
          value={entry.value ?? undefined}
          defaultValue={entry.defaultValue ?? undefined}
          onValueChange={entry.onValueChange ? (next) => entry.onValueChange?.(next) : undefined}
          className="nx-menu-group"
        >
          {entry.label !== undefined && <SdkMenuGroupLabel className="nx-menu-group-label">{entry.label}</SdkMenuGroupLabel>}
          {entry.items.map((radio) => (
            <SdkMenuRadioItem
              key={radio.value}
              value={radio.value}
              label={typeof radio.label === 'string' ? radio.label : undefined}
              disabled={radio.disabled}
              className="nx-menu-item nx-menu-checkable-item"
            >
              <span className="nx-menu-indicator-slot">
                <SdkMenuItemIndicator className="nx-menu-item-indicator">
                  <span className="nx-menu-radio-dot" />
                </SdkMenuItemIndicator>
              </span>
              <span className="nx-menu-item-label">{radio.label}</span>
            </SdkMenuRadioItem>
          ))}
        </SdkMenuRadioGroup>
      );
    }

    if (isSubmenuEntry(entry)) {
      return (
        <SdkMenuSub key={key}>
          <SdkMenuSubTrigger disabled={entry.disabled} className="nx-menu-item nx-menu-sub-trigger">
            {entry.icon !== undefined && <SdkMenuItemIcon className="nx-menu-item-icon">{entry.icon}</SdkMenuItemIcon>}
            <span className="nx-menu-item-label">{entry.label}</span>
            <Icon name="caret-right" size={13} className="nx-menu-caret" />
          </SdkMenuSubTrigger>
          <SdkMenuSubContent sideOffset={4} className="nx-menu-content">
            {renderMenuEntries(entry.submenu)}
          </SdkMenuSubContent>
        </SdkMenuSub>
      );
    }

    const isDanger = Boolean(entry.danger || entry.destructive);
    const val = entry.value ?? entry.id ?? (typeof entry.label === 'string' ? entry.label : `item-${idx}`);

    return (
      <SdkMenuItem
        key={entry.id ?? val}
        value={val}
        label={typeof entry.label === 'string' ? entry.label : undefined}
        disabled={entry.disabled}
        shortcut={entry.shortcut}
        closeOnSelect={entry.closeOnSelect}
        destructive={isDanger}
        data-danger={isDanger ? '' : undefined}
        onSelect={entry.onSelect ? () => entry.onSelect?.() : undefined}
        className="nx-menu-item"
      >
        {entry.icon !== undefined && <SdkMenuItemIcon className="nx-menu-item-icon">{entry.icon}</SdkMenuItemIcon>}
        <span className="nx-menu-item-label">{entry.label}</span>
      </SdkMenuItem>
    );
  });
}

/* ============================================================================
 * 2. DropdownMenu & ContextMenu
 * ========================================================================== */

/** Props for the `DropdownMenu` action menu. */
export interface DropdownMenuProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  loopFocus?: boolean;
  trigger?: ReactNode;
  items?: ReadonlyArray<MenuEntry>;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Button-triggered popup menu supporting actions, checkboxes, radio groups, shortcuts, and cascading submenus. */
export function DropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  disabled,
  loopFocus,
  trigger,
  items,
  side = 'bottom',
  align = 'start',
  sideOffset = 5,
  ariaLabel,
  className,
  style,
  ref,
  children,
}: DropdownMenuProps) {
  const rootProps = {
    open,
    defaultOpen,
    disabled,
    loopFocus,
    onOpenChange: onOpenChange ? (next: boolean) => onOpenChange(next) : undefined,
  };

  if (trigger === undefined && items === undefined) {
    return <SdkMenu {...rootProps}>{children}</SdkMenu>;
  }

  return (
    <SdkMenu {...rootProps}>
      {trigger !== undefined &&
        (isRenderableElement(trigger) ? (
          <SdkMenuTrigger render={trigger} />
        ) : (
          <SdkMenuTrigger data-slot="button">{trigger}</SdkMenuTrigger>
        ))}
      <SdkMenuContent
        ref={ref}
        aria-label={ariaLabel}
        side={side}
        align={align}
        sideOffset={sideOffset}
        className={cx('nx-menu-content', className)}
        style={style}
      >
        {items ? renderMenuEntries(items) : children}
      </SdkMenuContent>
    </SdkMenu>
  );
}

/** Props for the `ContextMenu` right-click/long-press menu. */
export interface ContextMenuProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  loopFocus?: boolean;
  items?: ReadonlyArray<MenuEntry>;
  content?: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  contentClassName?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Right-click and long-press context menu wrapping an arbitrary target region. */
export function ContextMenu({
  open,
  defaultOpen,
  onOpenChange,
  loopFocus,
  items,
  content,
  disabled,
  ariaLabel,
  className,
  contentClassName,
  style,
  ref,
  children,
}: ContextMenuProps) {
  const rootProps = {
    open,
    defaultOpen,
    loopFocus,
    onOpenChange: onOpenChange ? (next: boolean) => onOpenChange(next) : undefined,
  };

  if (items === undefined && content === undefined) {
    return <SdkMenu {...rootProps}>{children}</SdkMenu>;
  }

  return (
    <SdkMenu {...rootProps}>
      <SdkMenuContextTrigger ref={ref} disabled={disabled} className={cx('nx-context-trigger', className)} style={style}>
        {children}
      </SdkMenuContextTrigger>
      <SdkMenuContent aria-label={ariaLabel} sideOffset={5} className={cx('nx-menu-content', contentClassName)}>
        {items ? renderMenuEntries(items) : content}
      </SdkMenuContent>
    </SdkMenu>
  );
}

/* ============================================================================
 * 3. Menubar
 * ========================================================================== */

/** Single top-level menu definition inside a `Menubar`. */
export interface MenubarMenuDefinition {
  id?: string;
  label: ReactNode;
  disabled?: boolean;
  items: ReadonlyArray<MenuEntry>;
}

/** Props for the `Menubar` horizontal application menu strip. */
export interface MenubarProps {
  menus?: ReadonlyArray<MenubarMenuDefinition>;
  disabled?: boolean;
  loopFocus?: boolean;
  orientation?: 'horizontal' | 'vertical';
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Horizontal application menubar with keyboard arrow navigation across top-level dropdown menus. */
export function Menubar({ menus, disabled, loopFocus, orientation, ariaLabel, className, style, ref, children }: MenubarProps) {
  return (
    <SdkMenubar
      ref={ref}
      disabled={disabled}
      loop={loopFocus}
      orientation={orientation}
      aria-label={ariaLabel}
      className={cx('nx-menubar', className)}
      style={style}
    >
      {menus
        ? menus.map((menu, idx) => (
            <SdkMenu key={menu.id ?? idx}>
              <SdkMenuTrigger disabled={menu.disabled} className="nx-menubar-trigger">
                {menu.label}
              </SdkMenuTrigger>
              <SdkMenuContent align="start" sideOffset={5} className="nx-menu-content">
                {renderMenuEntries(menu.items)}
              </SdkMenuContent>
            </SdkMenu>
          ))
        : children}
    </SdkMenubar>
  );
}

/* ============================================================================
 * 4. CommandBox & CommandPalette
 * ========================================================================== */

/** Single executable command entry inside `CommandBox` or `CommandPalette`. */
export interface CommandEntry {
  id: string;
  label: string;
  keywords?: string[];
  icon?: ReactNode;
  shortcut?: string;
  badge?: string;
  disabled?: boolean;
  onSelect?: () => void;
}

/** Titled section of command items inside `CommandBox` or `CommandPalette`. */
export interface CommandGroupEntry {
  heading: string;
  items: ReadonlyArray<CommandEntry>;
}

/** Props for the inline `CommandBox` filterable command list. */
export interface CommandBoxProps {
  placeholder?: string;
  groups?: ReadonlyArray<CommandGroupEntry>;
  empty?: EmptyStateSpec | ReactNode;
  footer?: ReactNode;
  hideSearchIcon?: boolean;
  ariaLabel?: string;
  inputAriaLabel?: string;
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  onAction?: (value: string) => unknown;
  loopFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Inline searchable command menu with grouped items, keyboard shortcuts, and empty state. */
export function CommandBox(props: CommandBoxProps) {
  const {
    placeholder = 'Type a command or search…',
    groups,
    empty,
    footer,
    hideSearchIcon = false,
    ariaLabel,
    inputAriaLabel,
    query,
    defaultQuery,
    onQueryChange,
    onAction,
    loopFocus,
    className,
    style,
    ref,
    children,
  } = props;

  const legacyEmpty = (props as unknown as { emptyMessage?: ReactNode }).emptyMessage;
  const resolvedEmpty = empty ?? legacyEmpty ?? 'No matching commands found.';
  const isCompound = groups === undefined && children !== undefined;

  const commandOptions = {
    query,
    defaultQuery,
    onQueryChange: onQueryChange ? (q: string) => onQueryChange(q) : undefined,
    onAction: onAction ? (val: string) => onAction(val) : undefined,
    loopFocus,
  };

  if (isCompound) {
    return (
      <SdkCommand ref={ref} aria-label={ariaLabel} className={cx('nx-command-box', className)} style={style} {...commandOptions}>
        {children}
      </SdkCommand>
    );
  }

  return (
    <SdkCommand ref={ref} aria-label={ariaLabel} className={cx('nx-command-box', className)} style={style} {...commandOptions}>
      <div className="nx-command-header">
        {!hideSearchIcon && <Icon name="magnifying-glass" size={16} className="nx-command-search-icon" />}
        <SdkCommandInput placeholder={placeholder} aria-label={inputAriaLabel ?? ariaLabel ?? placeholder} className="nx-command-input" />
      </div>
      <SdkCommandList className="nx-command-list">
        {groups?.map((group) => (
          <SdkCommandGroup key={group.heading} className="nx-command-group">
            <SdkCommandGroupLabel className="nx-command-group-label">{group.heading}</SdkCommandGroupLabel>
            {group.items.map((item) => (
              <SdkCommandItem
                key={item.id}
                value={item.id}
                label={item.label}
                keywords={item.keywords}
                disabled={item.disabled}
                shortcut={item.shortcut}
                onSelect={item.onSelect ? () => item.onSelect?.() : undefined}
                className="nx-command-item"
              >
                {item.icon !== undefined && <SdkCommandItemIcon className="nx-command-item-icon">{item.icon}</SdkCommandItemIcon>}
                <SdkCommandItemText className="nx-command-item-text">{item.label}</SdkCommandItemText>
                {item.badge !== undefined && <span className="nx-badge nx-command-badge">{item.badge}</span>}
                {item.shortcut && <SdkCommandShortcut shortcut={item.shortcut} className="nx-command-shortcut" />}
              </SdkCommandItem>
            ))}
          </SdkCommandGroup>
        ))}
        {children}
      </SdkCommandList>
      <SdkCommandEmpty className="nx-command-empty">{renderEmptyNode(resolvedEmpty)}</SdkCommandEmpty>
      {footer !== undefined && <div className="nx-command-footer">{footer}</div>}
    </SdkCommand>
  );
}

/** Props for the modal `CommandPalette` overlay. */
export interface CommandPaletteProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  enableGlobalShortcut?: boolean;
  shortcutKey?: string;
  closeOnSelect?: boolean;
  placeholder?: string;
  groups?: ReadonlyArray<CommandGroupEntry>;
  empty?: EmptyStateSpec | ReactNode;
  hideFooter?: boolean;
  footer?: ReactNode;
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  onAction?: (value: string) => unknown;
  ariaLabel?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Modal `Mod+K` command palette dialog with fuzzy search, grouped commands, and keyboard navigation hints. */
export function CommandPalette(props: CommandPaletteProps) {
  const {
    open: controlledOpen,
    defaultOpen = false,
    onOpenChange,
    enableGlobalShortcut = false,
    shortcutKey = 'mod+k',
    closeOnSelect = true,
    placeholder = 'Type a command or search…',
    groups,
    empty,
    hideFooter = false,
    footer,
    query,
    defaultQuery,
    onQueryChange,
    onAction,
    ariaLabel,
    className,
    ref,
    children,
  } = props;

  const legacyEmpty = (props as unknown as { emptyMessage?: ReactNode }).emptyMessage;
  const resolvedEmpty = empty ?? legacyEmpty ?? 'No matching commands found.';

  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const contentRef = useRef<HTMLDivElement | null>(null);

  const setOpen = (next: boolean) => {
    if (!isControlled) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  };

  useShortcut(enableGlobalShortcut ? shortcutKey : null, () => setOpen(!isOpen));
  useShortcut(enableGlobalShortcut && isOpen ? shortcutKey : null, () => setOpen(false), { layer: contentRef });

  const wrappedGroups: CommandGroupEntry[] | undefined = groups?.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      onSelect: () => {
        item.onSelect?.();
        if (closeOnSelect) {
          setOpen(false);
        }
      },
    })),
  }));

  const handleAction = (value: string) => {
    const result = onAction?.(value);
    if (closeOnSelect && !(result instanceof Promise)) {
      setOpen(false);
    }
    return result;
  };

  const defaultFooterHints = (
    <div className="nx-command-hints" aria-hidden="true">
      <span className="nx-command-hint">
        <kbd className="nx-kbd">↑↓</kbd>
        <span>Navigate</span>
      </span>
      <span className="nx-command-hint">
        <kbd className="nx-kbd">↵</kbd>
        <span>Run</span>
      </span>
      <span className="nx-command-hint">
        <kbd className="nx-kbd">Esc</kbd>
        <span>Close</span>
      </span>
    </div>
  );

  return (
    <SdkDialog open={isOpen} onOpenChange={(next) => setOpen(next)}>
      <SdkDialogBackdrop />
      <SdkDialogContent
        ref={(node) => {
          contentRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
        }}
        aria-label={ariaLabel}
        className={cx('nx-command-palette-dialog', className)}
      >
        <SdkDialogTitle className="nx-sr-only">{ariaLabel ?? 'Command palette'}</SdkDialogTitle>
        <CommandBox
          placeholder={placeholder}
          groups={wrappedGroups}
          empty={resolvedEmpty}
          query={query}
          defaultQuery={defaultQuery}
          onQueryChange={onQueryChange}
          onAction={onAction ? handleAction : undefined}
          footer={hideFooter ? undefined : (footer ?? defaultFooterHints)}
          className="nx-command-palette-box"
        >
          {children}
        </CommandBox>
      </SdkDialogContent>
    </SdkDialog>
  );
}

export {
  DropGroup,
  DropItem,
  DropMenu,
  DropSeparator,
  type DropGroupProps,
  type DropItemProps,
  type DropMenuProps,
  type DropSeparatorProps,
};
