import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu';
import { useRef } from 'react';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';
import { useDialogContainer } from './container';
import { told } from './told';

/* A button that opens a menu. The four parts share the menu's state through UI SDK's context, so a kit draws all
   four or none (packages/ui/src/uiKitSlots.ts). The open state can be the caller's, for a menu that has to stay
   up while a click inside it fetches. */
export const DropMenu: UiKitSlots['DropMenu'] = ({
  className,
  triggerClassName,
  triggerTitle,
  triggerLabel,
  label,
  popupClassName,
  side = 'bottom',
  align = 'end',
  sideOffset = 4,
  open,
  onOpenChange,
  children,
}) => {
  const root = useRef<HTMLDivElement>(null);
  const container = useDialogContainer(root);
  return (
    <div className={className || undefined} data-slot="drop-menu" ref={root}>
      <Menu open={open} onOpenChange={onOpenChange && ((next, details) => onOpenChange(next, told('implicit', details)))}>
        <MenuTrigger className={triggerClassName} title={triggerTitle} aria-label={triggerLabel}>
          {label}
        </MenuTrigger>
        <MenuContent
          className={popupClassName}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          container={container}
        >
          {children}
        </MenuContent>
      </Menu>
    </div>
  );
};

export const DropGroup: UiKitSlots['DropGroup'] = ({ className, labelClassName, label, children }) => (
  <MenuGroup className={className}>
    <MenuGroupLabel className={labelClassName}>{label}</MenuGroupLabel>
    {children}
  </MenuGroup>
);

export const DropSeparator: UiKitSlots['DropSeparator'] = ({ className }) => <MenuSeparator className={className} />;

export const DropItem: UiKitSlots['DropItem'] = ({ className, disabled, closeOnClick, onClick, title, children, ref }) => (
  <MenuItem
    render={<button type="button" />}
    ref={ref as never}
    className={className}
    title={title}
    disabled={disabled}
    closeOnSelect={closeOnClick}
    onSelect={() => onClick()}
  >
    {children}
  </MenuItem>
);
