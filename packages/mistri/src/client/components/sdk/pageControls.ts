/* The house controls a free-form page draws (`@mistriwork/mistri/page`), dressed as the shell dresses its own: the form
   controls' rules and the standalone primitives' ride this chunk, so a page that draws none fetches neither, and one
   that does gets them before its first control paints (page.tsx loads each control through here). */
import '@mistriwork/kit/client/formControls.css';
import './pageControls.css';
import { createElement, type ComponentProps } from 'react';
import { Drawer as UiDrawer } from '@mistriwork/ui/Drawer.js';
import { message } from '@mistriwork/kit/client/messages.js';
import { FileField as UiFileField } from '@mistriwork/ui/FileField.js';
import { say } from '../../copy/components/components/sdk/pageControls.js';

/* By module, as the kit's Button is reached (kit.tsx): the package's index carries every primitive, these only the page's. */
export { Avatar } from '@mistriwork/ui/Avatar.js';
export { CheckCards, Checkbox, ChoiceCards, YesNo } from '@mistriwork/ui/Choices.js';
export { DateField } from '@mistriwork/ui/DateField.js';
/* The primitive says its close control in English unless told; a page's Drawer says it in the reader's language, as
   the shell's own panels do, and a page that names it keeps its word. */
export function Drawer(props: ComponentProps<typeof UiDrawer>) {
  return createElement(UiDrawer, { ...props, closeLabel: props.closeLabel ?? message('common.close') });
}
/* The same for the file field's button and its empty words. */
export function FileField(props: ComponentProps<typeof UiFileField>) {
  return createElement(UiFileField, {
    ...props,
    chooseLabel: props.chooseLabel ?? say(props.multiple ? 'chooseFiles' : 'chooseFile'),
    noneLabel: props.noneLabel ?? say('noFileChosen'),
  } as ComponentProps<typeof UiFileField>);
}
export { Modal } from '@mistriwork/ui/Modal.js';
export { Pagination } from '@mistriwork/ui/Pagination.js';
export { Popover } from '@mistriwork/ui/Popover.js';
export { Select } from '@mistriwork/ui/Select.js';
export { Slider } from '@mistriwork/ui/Slider.js';
export { Switch } from '@mistriwork/ui/Switch.js';
export { TextArea } from '@mistriwork/ui/TextArea.js';
export { TextField } from '@mistriwork/ui/TextField.js';
export { Tooltip } from '@mistriwork/ui/Tooltip.js';
