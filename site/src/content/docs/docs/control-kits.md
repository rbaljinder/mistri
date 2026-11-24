---
title: Plug in a control kit
description: Draw an App's buttons, fields, dialogs and menus with your own components, slot by slot, while the pages around them stay the platform's.
---

Draw an App's buttons, fields, dialogs and menus with your own components, slot by slot, while the pages around them stay the platform's.

> **Preview.** Control kits work as documented and may change in any 1.x release; `mistri check` reports a use of one as information. See [status](/docs/status/).

```ts
// app.ts
export default defineApp({
  // …
  uiKit: './ui/kit.tsx',
});
```

```tsx
// ui/kit.tsx
import { defineUiKit, type UiKitSlots } from '@mistriwork/mistri/page';
import './kit.css';

const Button: UiKitSlots['Button'] = ({ variant = 'secondary', loading, loadingLabel, type = 'button', className, disabled, children, ref, ...rest }) => (
  <button {...rest} ref={ref} type={type} className={`my-button my-${variant} ${className ?? ''}`} disabled={disabled || loading} aria-busy={loading || undefined}>
    {loading && loadingLabel ? loadingLabel : children}
  </button>
);

export default defineUiKit({ Button });
```
<!-- no sample: no shipped App brings a kit; test/fixtures/apps/kit-desk is the gate's -->

<!-- no picture: a kit's look is its own. -->

## What you'll see

Every button on every page — a record's actions, a form's Save, a dialog's Cancel — is your `Button`. Every other control is still the platform's, because a slot you leave out falls back to the default. The record layout, the list grid, navigation and dashboards stay mistri's and keep following the [look](/docs/looks/).

The kit is named in the page head and installed before the first render, so the first paint already uses your controls and nothing changes once the page is shown. An App with no kit downloads nothing extra. The [database browser](https://tablewalk.dev) never takes a kit.

## When to use it

Use it when an App has to match a design system that already has its own controls. If what you want is a different color, radius or font, use a [look](/docs/looks/) instead. If you want a different page, use a [custom component](/docs/custom-components/).

## Options

The slots are everything [`@mistriwork/ui`](/docs/mistri-ui/) draws. A slot takes the same props as the control it replaces; `UiKitSlots['Modal']` and the others give you the types, and `SlotProps<'Modal'>` the props alone.

| What | Slots |
| --- | --- |
| Buttons | `Button`, `ButtonLink` |
| Text | `TextField`, `MaskedField`, `MoneyField`, `SensitiveField`, `TextArea`, `FileField`, `ValidMark` |
| Lists and dates | `Select`, `MultiSelect`, `Dropdown`, `MultiDropdown`, `Typeahead`, `DateField` |
| Choices | `Checkbox`, `YesNo`, `ChoiceCards`, `CheckCards`, `Consent`, `Switch`, `Slider` |
| Layers | `Modal`, `Drawer`, `Popover`, `Tooltip`, `DropMenu`, `DropGroup`, `DropItem`, `DropSeparator` |
| A form's parts | `Field`, `HelpTip`, `ProgressBar`, `StepHeader`, `ActionBar`, `Columns`, `ReviewList` |
| Display | `Tabs`, `Pagination`, `Avatar`, `Carousel`, `Resizable`, `ScrollArea` |
| The landing's blocks | `Badge`, `PhotoTiles`, `IconRows` |

- **The menu is one family.** `DropMenu`, `DropGroup`, `DropItem` and `DropSeparator` are drawn together or not at all.
- **A slot is a whole component.** `defineUiKit` is what a page imports for a kit; the helpers that wrapped the platform's own control or joined kits (`dress`, `extendUiKit`, `defaultUiKit`) and the popup helpers (`usePopupHost`, `useComponentScope`) are no longer exported from `@mistriwork/mistri/page`, and `mistri upgrade` names each import of one. Write the slot as a component of your own that takes the slot's props, as the `Button` above does.
- **A stylesheet imported by the kit** is served with it and placed in the `app` layer, page-wide, after the kit's control recipes and the looks. Map it onto the look's tokens (`var(--accent)`, `var(--radius)`, …) so a change of look still reaches your controls.
- **A change callback takes its details second** (`onValueChange(value, details)`, `onCheckedChange` for a checkbox or a switch): `{ reason, source, event? }`, as the [primitives](/docs/mistri-ui/) give them. A kit may call it with the value alone; the platform fills the details in. If the kit gives them, they must have that shape.
- **What the platform relies on** — a `Modal`'s handle and its focus return, `onOpenChange`, a change's details, the `words` props, `disabled`, and drawing a popup inside the dialog that opened it — is checked by the conformance suite. Run it from your own tests:

```ts
import { test } from 'vitest';
import { uiKitConformance } from '@mistriwork/ui/conformance.js';
import kit from './kit.tsx';

uiKitConformance(kit, test);
```

## Common mistakes

- **The App refuses to load: `has no slot named "Buton" (did you mean "Button"?)`.** A key of `defineUiKit` is misspelled. Use the name it suggests.
- **`has no default export made by defineUiKit`.** The module exports the components on their own. Export `defineUiKit({ … })` as the default.
- **`draws DropMenu, DropItem but not DropGroup, DropSeparator`.** A menu was drawn in part. Give all four slots, or none of them.
- **A menu opened inside a dialog shows behind it.** The popup was portaled to `document.body`. Draw it in place, inside the element that opened it.

## Related

- [`@mistriwork/ui`](/docs/mistri-ui/): the controls the slots replace
- [Looks](/docs/looks/): colors, type and shape without new components
- [Custom components](/docs/custom-components/): your own sections and pages
- [Build a component on the behaviors](/docs/behaviors/): what a reader moves, walks or edits in place, in a component of your own
