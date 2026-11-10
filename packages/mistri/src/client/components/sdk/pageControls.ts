/* The house controls a free-form page draws (`@mistriwork/mistri/page`), dressed as the shell dresses its own: the form
   controls' rules and the standalone primitives' ride this chunk, so a page that draws none fetches neither, and one
   that does gets them before its first control paints (page.tsx loads each control through here). */
import '@mistriwork/kit/client/formControls.css';
import './pageControls.css';
import { createElement, type ComponentProps } from 'react';
import { Drawer as UiDrawer } from '@mistriwork/ui/Drawer.js';
import { message } from '@mistriwork/kit/client/messages.js';

/* By module, as the kit's Button is reached (kit.tsx): the package's index carries every primitive, these only the page's. */
export { Avatar } from '@mistriwork/ui/Avatar.js';
export { CheckCards, Checkbox, ChoiceCards, YesNo } from '@mistriwork/ui/Choices.js';
export { DateField } from '@mistriwork/ui/DateField.js';
/* The primitive says its close control in English unless told; a page's Drawer says it in the reader's language, as
   the shell's own panels do, and a page that names it keeps its word. */
export function Drawer(props: ComponentProps<typeof UiDrawer>) {
  return createElement(UiDrawer, { ...props, closeLabel: props.closeLabel ?? message('common.close') });
}
export { FileField } from '@mistriwork/ui/FileField.js';
export { Modal } from '@mistriwork/ui/Modal.js';
export { Pagination } from '@mistriwork/ui/Pagination.js';
export { Popover } from '@mistriwork/ui/Popover.js';
export { Select } from '@mistriwork/ui/Select.js';
export { Slider } from '@mistriwork/ui/Slider.js';
export { Switch } from '@mistriwork/ui/Switch.js';
export { TextField } from '@mistriwork/ui/TextField.js';
export { Tooltip } from '@mistriwork/ui/Tooltip.js';
