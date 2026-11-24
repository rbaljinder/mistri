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
import { createElement, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import type { Avatar } from './Avatar.js';
import type { Button, ButtonLink } from './Button.js';
import type { Carousel } from './Carousel.js';
import type { ChangeDetails } from './changeDetails.js';
import type { CheckCards, Checkbox, ChoiceCards, Consent, YesNo } from './Choices.js';
import type { DateField } from './DateField.js';
import type { Drawer } from './Drawer.js';
import type { Field } from './Field.js';
import type { FileField } from './FileField.js';
import type { ActionBar, Columns, HelpTip, ProgressBar, ReviewList, StepHeader } from './FormParts.js';
import type { Badge, IconRows, PhotoTiles } from './HeroBlocks.js';
import type { DropGroup, DropItem, DropMenu, DropSeparator } from './DropMenu.js';
import type { Dropdown, MultiDropdown } from './Dropdown.js';
import type { Modal } from './Modal.js';
import type { Pagination } from './Pagination.js';
import type { Popover } from './Popover.js';
import type { Resizable } from './Resizable.js';
import type { ScrollArea } from './ScrollArea.js';
import type { MultiSelect, Select } from './Select.js';
import type { SensitiveField } from './SensitiveField.js';
import type { Slider } from './Slider.js';
import type { Switch } from './Switch.js';
import type { Tabs } from './Tabs.js';
import type { TextArea } from './TextArea.js';
import type { MaskedField, MoneyField, TextField, ValidMark } from './TextField.js';
import type { Tooltip } from './Tooltip.js';
import type { TypeaheadProps } from './Typeahead.js';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { UiKitContext, defaultSlots, installUiKit } from './internal/uiKitContext.js';
import { SLOT_NAMES, uiKitProblems, type SlotName } from './uiKitSlots.js';

/* A kit may call a change callback without its details (the value alone); the seam fills them in for every caller
   (internal/uiKitContext.ts), so in a kit's props the details are optional and everywhere else they are not. */
type KitCallback<F> = F extends (...args: [...infer A, infer D extends ChangeDetails<string>]) => infer R
  ? (...args: A | [...A, D]) => R
  : F;
type KitProps<P> = { [K in keyof P]: KitCallback<P[K]> };
type Slot<C> = C extends ComponentType<infer P> ? ComponentType<KitProps<P>> : never;
/* A Typeahead's item callbacks carry no details, and passed through KitCallback while `T` is still open the item itself
   is taken for details (`onPick(item)` then asks for a `T & ChangeDetails`), so they keep their own types. */
type TypeaheadItemProps = 'itemKey' | 'itemLabel' | 'itemClassName' | 'renderItem' | 'onPick' | 'onHighlight';

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
  Typeahead: <T>(props: KitProps<Omit<TypeaheadProps<T>, TypeaheadItemProps>> & Pick<TypeaheadProps<T>, TypeaheadItemProps>) => ReactNode;
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
  /** A label over any control, with its hint and its problem: the wiring between them is the slot's to keep. */
  Field: Slot<typeof Field>;
  TextArea: Slot<typeof TextArea>;
  FileField: Slot<typeof FileField>;
  /** The mark at a box's end. */
  ValidMark: Slot<typeof ValidMark>;
  HelpTip: Slot<typeof HelpTip>;
  ProgressBar: Slot<typeof ProgressBar>;
  StepHeader: Slot<typeof StepHeader>;
  ActionBar: Slot<typeof ActionBar>;
  Columns: Slot<typeof Columns>;
  ReviewList: Slot<typeof ReviewList>;
  /** The landing's blocks. */
  Badge: Slot<typeof Badge>;
  PhotoTiles: Slot<typeof PhotoTiles>;
  IconRows: Slot<typeof IconRows>;
  Carousel: Slot<typeof Carousel>;
  Resizable: Slot<typeof Resizable>;
  ScrollArea: Slot<typeof ScrollArea>;
}

/** The props a slot is drawn with. */
export type SlotProps<Name extends SlotName> = UiKitSlots[Name] extends (props: infer Props) => unknown
  ? Props
  : UiKitSlots[Name] extends ComponentType<infer Props>
    ? Props
    : never;

/** A kit: any of the slots; the rest draw as they always have. */
export type UiKit = Readonly<Partial<UiKitSlots>>;

/** Declares a kit, refusing a slot it does not have in words: `export default defineUiKit({ Button, Modal })`. */
export function defineUiKit(kit: UiKit): UiKit {
  const problems = uiKitProblems(kit);
  if (problems.length) throw new Error(`The UI kit ${problems.join(' It ')}`);
  return Object.freeze({ ...kit });
}

/** The primitives' own drawing, by slot, for a kit that dresses a default rather than replacing it. Filled as the
    page loads each primitive, so read it when drawing, not when the kit is defined (`dress` does). */
export const defaultUiKit = defaultSlots as unknown as Readonly<Partial<UiKitSlots>>;

/**
 * A slot that is the platform's own control with something changed, where a kit wants to dress one and not redraw
 * it: `Button: dress('Button', (Button, props) => <Button {...props} size="lg" />)`. The function is handed the
 * default and the props the slot was drawn with, typed for that slot, and the default is read at each draw, when the
 * page has loaded it.
 */
export function dress<Name extends SlotName>(
  name: Name,
  draw: (Default: UiKitSlots[Name], props: SlotProps<Name>) => ReactNode,
): UiKitSlots[Name] {
  const Dressed = (props: SlotProps<Name>) => draw(defaultSlots[name] as UiKitSlots[Name], props);
  Dressed.displayName = `dress(${name})`;
  return Dressed as unknown as UiKitSlots[Name];
}

/** One kit made of several, a later one's slots over an earlier one's: a design system's kit with two slots of the
    App's own, held to the same rules as a kit written out whole. */
export function extendUiKit(kit: UiKit, ...more: UiKit[]): UiKit {
  return defineUiKit(Object.assign({}, kit, ...more));
}

/**
 * Draws everything inside it with this kit; a page with one kit installs it once instead (`installUiKit`). A slot
 * this kit does not fill is drawn by the kit around it, an outer provider's or the installed one, so a part of a
 * page changes two controls and keeps the rest of the page's. `alone` draws with this kit and nothing else: a slot
 * it does not fill is the platform's own, whatever is around.
 */
export function UiKitProvider({ kit, alone = false, children }: { kit: UiKit; alone?: boolean; children?: ReactNode }) {
  const around = useContext(UiKitContext);
  const layered = useMemo(() => (alone ? kit : { ...around, ...kit }), [alone, around, kit]);
  return createElement(UiKitContext.Provider, { value: layered as never }, children);
}

/**
 * Where a kit draws a popup opened from this element, for a kit whose own popups are portalled: the dialog the
 * element stands in, so the popup shares its focus trap and its stacking, else the container an embedded shell
 * named for every popup, else nothing, which is the body. The platform's own controls are drawn there.
 */
export function usePopupHost(trigger: { current: Element | null }): HTMLElement | undefined {
  return useDialogContainer(trigger) ?? popupContainer();
}

/**
 * The name a layer drawn outside its place in the tree should carry as `data-component`, where there is one: a
 * component's scoped stylesheet reaches what carries its name and nothing else, and a dialog or a popup a kit
 * portals away would otherwise lose the styles of the component that opened it.
 */
export function useComponentScope(): string | undefined {
  return useContext(ComponentStyleScope);
}

export { installUiKit, SLOT_NAMES, uiKitProblems, type SlotName };
