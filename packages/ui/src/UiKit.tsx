/**
 * A control kit (Preview): another drawing of the primitives here, slot by slot. Every slotted primitive reads the
 * kit in place (internal/uiKitContext.ts) and draws the kit's component for its slot with the very props it was given,
 * its own otherwise, so a kit that draws only the button leaves every other control as it was and no screen that
 * imports a primitive changes. The page itself (a grid, a record's layout, the navigation) stays the platform's;
 * what a kit replaces is the controls on it.
 *
 * The contract is each slot's props type below, plus the behavior the conformance suite holds a kit to
 * (`@mistriwork/ui/conformance.js`): a value and its change, disabled, the words a slot is handed, a modal's handle and
 * where its focus goes back to, a menu's and a listbox's keys, a popup drawn inside the dialog that opened it.
 *
 * Nothing here imports a primitive's module, only its types: a kit compiled apart from the page reads this file for
 * `defineUiKit`, and the defaults arrive in `defaultUiKit` as the page loads them.
 */
import { createElement, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import type { Avatar } from './Avatar.js';
import type { Button, ButtonLink } from './Button.js';
import type { CheckCards, Checkbox, ChoiceCards, Consent, YesNo } from './Choices.js';
import type { DateField } from './DateField.js';
import type { Drawer } from './Drawer.js';
import type { DropGroup, DropItem, DropMenu, DropSeparator } from './DropMenu.js';
import type { Dropdown, MultiDropdown } from './Dropdown.js';
import type { Modal } from './Modal.js';
import type { Pagination } from './Pagination.js';
import type { Popover } from './Popover.js';
import type { MultiSelect, Select } from './Select.js';
import type { SensitiveField } from './SensitiveField.js';
import type { Slider } from './Slider.js';
import type { Switch } from './Switch.js';
import type { Tabs } from './Tabs.js';
import type { MaskedField, MoneyField, TextField } from './TextField.js';
import type { Tooltip } from './Tooltip.js';
import type { TypeaheadProps } from './Typeahead.js';
import { UiKitContext, defaultSlots, installUiKit } from './internal/uiKitContext.js';
import { SLOT_NAMES, uiKitProblems, type SlotName } from './uiKitSlots.js';

type Slot<C extends ComponentType<any>> = ComponentType<ComponentProps<C>>;

/** Each slot's component, typed by the props the platform draws it with. */
export interface UiKitSlots {
  Button: Slot<typeof Button>;
  /** A link dressed as a button: a download, another page. */
  ButtonLink: Slot<typeof ButtonLink>;
  TextField: Slot<typeof TextField>;
  MaskedField: Slot<typeof MaskedField>;
  MoneyField: Slot<typeof MoneyField>;
  SensitiveField: Slot<typeof SensitiveField>;
  Select: Slot<typeof Select>;
  MultiSelect: Slot<typeof MultiSelect>;
  Dropdown: Slot<typeof Dropdown>;
  MultiDropdown: Slot<typeof MultiDropdown>;
  /** Generic in the item it lists, as the default is. */
  Typeahead: <T>(props: TypeaheadProps<T>) => ReactNode;
  DateField: Slot<typeof DateField>;
  Checkbox: Slot<typeof Checkbox>;
  YesNo: Slot<typeof YesNo>;
  ChoiceCards: Slot<typeof ChoiceCards>;
  CheckCards: Slot<typeof CheckCards>;
  Consent: Slot<typeof Consent>;
  Switch: Slot<typeof Switch>;
  Slider: Slot<typeof Slider>;
  /** Open from mount; `onClose` heard once however it closed; `ref` takes the handle that closes it. */
  Modal: Slot<typeof Modal>;
  Drawer: Slot<typeof Drawer>;
  Popover: Slot<typeof Popover>;
  Tooltip: Slot<typeof Tooltip>;
  /** A menu's four parts share the menu's state, so a kit draws all four or none. */
  DropMenu: Slot<typeof DropMenu>;
  DropGroup: Slot<typeof DropGroup>;
  DropItem: Slot<typeof DropItem>;
  DropSeparator: Slot<typeof DropSeparator>;
  Tabs: Slot<typeof Tabs>;
  Pagination: Slot<typeof Pagination>;
  Avatar: Slot<typeof Avatar>;
}

/** A kit: any of the slots; the rest draw as they always have. */
export type UiKit = Readonly<Partial<UiKitSlots>>;

/** Declares a kit, refusing a slot it does not have in words: `export default defineUiKit({ Button, Modal })`. */
export function defineUiKit(kit: UiKit): UiKit {
  const problems = uiKitProblems(kit);
  if (problems.length) throw new Error(`The UI kit ${problems.join(' It ')}`);
  return Object.freeze({ ...kit });
}

/** The primitives' own drawing, by slot, for a kit that dresses a default rather than replacing it. Filled as the
    page loads each primitive, so read it when drawing, not when the kit is defined. */
export const defaultUiKit = defaultSlots as unknown as Readonly<Partial<UiKitSlots>>;

/** Draws everything inside it with this kit; a page with one kit installs it once instead (`installUiKit`). */
export function UiKitProvider({ kit, children }: { kit: UiKit; children?: ReactNode }) {
  return createElement(UiKitContext.Provider, { value: kit as never }, children);
}

export { installUiKit, SLOT_NAMES, uiKitProblems, type SlotName };
