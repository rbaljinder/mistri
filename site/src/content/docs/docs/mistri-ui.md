---
title: "@mistriwork/ui on its own"
description: Draw a page of your own with the buttons, fields, dialogs and menus an App is drawn with, without a server behind it.
keywords: [ui, primitives, components, react, base ui, button, modal, field, standalone]
---

Draw a page of your own with the buttons, fields, dialogs and menus an App is drawn with, without a server behind it.

```sh
npm install @mistriwork/ui react react-dom @ui-sdk/core @ui-sdk/react
```

```tsx title="Invite.tsx"
import '@mistriwork/ui/style.css';
import { useState } from 'react';
import { Button, Field, Modal } from '@mistriwork/ui';

export function Invite() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>Invite</Button>
      {open && (
        <Modal className="invite" ariaLabel="Invite a teammate" onClose={() => setOpen(false)}>
          <Field label="Email" hint="They get a link to sign in.">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button variant="primary" onClick={() => setOpen(false)}>Send</Button>
        </Modal>
      )}
    </>
  );
}
```

<!-- no picture: the component library draws every primitive, in every look. -->

A primitive reads no data, no address and no message catalog: its words, its icons and its answers are props. A name no one sees is `ariaLabel` on every primitive, and `label` is only text drawn on the page; the primitives that carry a few built-in words (Carousel, Resizable, Pagination, DateField) take a `words` object over English defaults. React, React DOM and UI SDK (`@ui-sdk/core`, `@ui-sdk/react`), which the controls are drawn over, are peers, so your project installs them. An App does not need this package: mistri brings it.

## What you'll see

- The App's own button, field and dialog, in the platform's tokens, light or dark by the reader's setting.
- A field that wires its label, hint and problem into the control (`id`, `aria-describedby`, `aria-invalid`), so no form joins them by hand.
- A dialog that holds focus, closes on Escape and a click on its scrim, and draws a menu or a listbox opened inside it within itself.

## What it holds

| Export | What it is |
| --- | --- |
| `Button` | `variant` (`primary`, `secondary`, `soft`, `outline`, `ghost`, `danger`, `danger-soft`), `size` (`xs`, `sm`, `md`, `lg`), `loading` |
| `Field` | A label over one control, a `hint` under it, then a `problem`; `children` is the control, or a function of its wiring for a control of several parts |
| `Modal` | Open while mounted; `onClose` is told once, however it closed; `closeLabel` draws a cross in the top corner under that name, which steps aside while a button of your own says the same word |
| `DropMenu`, `DropItem`, `DropGroup`, `DropSeparator` | A menu on a button |
| `Dropdown` | A listbox: one choice from a list |
| `Typeahead` | A box with a list that narrows as you type |
| `DateField` | A date and its calendar, in the `words` it is given |
| `Icon`, `registerIcons` | Draws the glyphs you register, by name |
| `Badge`, `PhotoTiles`, `IconRows` | Status and hero badges (`tone`, `pill`, `onRemove`); two to four photos in one 4:3 mosaic; up to four rows of an icon and a line |
| `Switch` | One on/off choice as a switch (`checked`/`onCheckedChange`, or `defaultChecked`), with an optional `label` and `description`; `loading` refuses a press while keeping focus |
| `Tabs` | One panel at a time from a row (`tabs` of `value`, `label`, `children`); arrow keys walk the row, a disabled tab is skipped |
| `Drawer` | A sheet from an edge (`side` `left` or `right`, at most 420px, full width on a phone); controlled with `open`/`onOpenChange`, `closeDisabled` refuses a dismissal |
| `Popover` | A small layer anchored to a `trigger` element; Escape and a click outside dismiss it, focus returns on close |
| `Avatar` | A person's picture, or their initials where there is none (`name` → `AL`, `A`); sizes `xs`, `sm`, `md`, `lg`, `xl` |
| `Pagination` | The pages of a list as buttons (`page`, `pages`, `onPageChange`); the current page is `aria-current`, never a button to itself, steps disable at the ends, long runs shorten with an ellipsis |
| `Carousel` | One slide at a time from a row (`slides` of `label`, `children`); Previous/Next disable at the ends, dots jump to a slide, arrow keys move, Home/End go first/last |
| `Resizable` | Two or more panes on a handle (`panels` of `label`, `defaultSize`, `minSize`); the handle is a separator with `aria-valuenow` in percent, walked by arrows, Home/End, or dragged by pointer |
| `ScrollArea` | A region that scrolls inside itself (`ariaLabel`, `orientation`, `maxHeight`); the viewport is a labeled tab stop with its own thumb |
| `Tooltip` | A short supplementary note on a `trigger` element, said on hover and on focus alike; the note carries `role="tooltip"` and the trigger names it while open |

Every change callback (`onValueChange` and `onValueCommit`, `onCheckedChange`, `onPressedChange`, `onOpenChange`, `onPageChange`, `onIndexChange`, `onSizesChange`, `onText`) hears the new value, then its details, `{ reason, source, event? }`. `reason` is UI SDK's word where it gives one (`escape-key`, `outside-press`, `item-press`) and one short word otherwise (`toggle`, `select`, `input-change`); each callback's type lists the words it can hear. `source` is `pointer`, `keyboard`, or `program` when the page made the change, and then `event` is absent:

```tsx
<Drawer open={open} onOpenChange={(next, details) => {
  setOpen(next);
  if (!next && details.reason === 'escape-key') discardDraft();
}} />
```

`style.css` is the single stylesheet for `@mistriwork/ui`: the tokens, the primitives' rules and the composite surface styles in `mistri-ui` and `mistri-ui-surfaces` cascade layers, so any unlayered rule of your page's own wins. To place individual sheets in a layer of your own, import the files it joins: `@import '@mistriwork/ui/tokens.css' layer(base);` and `@mistriwork/ui/controls.css` the same way. A control's parts are known by their `data-slot` (`[data-slot='button']`, `[data-slot='dialog-content']`), not by a class, so that is what a rule of your own selects.

What a reader moves, walks or edits in place is not a control but a behavior to build one on: `@mistriwork/ui/behaviors/index.js` holds `Sortable`, `Transfer`, `Days`, `Spans`, `Scrub`, `Pick`, `Turns`, `Widths` and `Editable`, with `behaviors.css` beside it. See [Build a component on the behaviors](/docs/behaviors/).

## App surface modules

Inside an App, composite views, SVG charts and operational controls are imported from `@mistriwork/mistri` (Preview) and share one lazy host module and stylesheet copy across the shell:

| Module | What it holds |
| --- | --- |
| `@mistriwork/mistri/views` | Product views: `AppShell`, `Sidebar`, `TopBar`, `PageHeader`, `DataTable`, `KanbanBoard`, `CalendarView`, `GanttView`, `WaterfallView`, `SplitView`, `FilterBar`, `ActivityTimeline`, `TreeView`, `CardGridView`, `CsvImportWizard`, `ReviewQueueView`, `AccountSettingsView`, `AiAssistantPanel`, `AiPromptComposer`, `AiProposalCard`, `DecisionChip`, `SignInCard`, `InviteAcceptCard`, `OAuthConsentCard`, `FileLightbox`, `AttachmentList`, `PhotoMosaic`, `MediaGallery`, `OnboardingChecklist` and `SpotlightTour` |
| `@mistriwork/mistri/charts` | Responsive SVG charts: `Sparkline`, `AreaChart`, `LineChart`, `BarChart`, `StackedBarChart`, `MiniBars`, `DonutChart`, `BreakdownList`, `FunnelChart`, `FunnelSteps`, `HeatmapMatrix`, `RadarChart` and `RadialGauge` |
| `@mistriwork/mistri/primitives` | Operational controls, pickers (`Combobox`, `EntityPicker`, `TreeSelect`, `DatePicker`, `DateTimePicker`, `ColorPicker`), `CalendarGrid` (inline month grid), `Steps` (step indicator), `CommandPalette`, layout and form primitives (`Grid`, `Stack`, `Row`, `Card`, `FormColumns`) and display primitives (`SegmentedControl`, `StatusDot`, `Badge`, `StatCard`, `EmptyState`, `DescriptionList`, `ItemList`, `ItemRow`, `FormattedValue`, `AiBadge`) |

## Choose a picker

`@mistriwork/ui` and `@mistriwork/mistri/primitives` ship 16 selection and value pickers; pick the narrowest one that matches how the reader chooses:

| Picker | Entry point | Use this when… |
| --- | --- | --- |
| `Select` | `@mistriwork/ui`, `/ui`, `/page`, `/primitives` | One choice from a fixed list in a field frame (`label`, `hint`, `problem`), or standalone without a search box |
| `MultiSelect` | `@mistriwork/ui`, `/primitives` | Several choices from a fixed list in a field frame, keeping the menu open while items toggle on and off |
| `Dropdown` | `@mistriwork/ui`, `/ui`, `/primitives` | One choice on a bare trigger button (a toolbar filter or inline cell), with optional item tones, swatches and footer actions |
| `MultiDropdown` | `@mistriwork/ui`, `/primitives` | Several choices on a bare trigger button, with the same item tones, badges and non-selecting footer actions as `Dropdown` |
| `Combobox` | `@mistriwork/mistri/primitives` | Searching a large or grouped option list (`multiple` for removable chips, `creatable` / `onCreate` to add a new option in place) |
| `Autocomplete` | `@mistriwork/mistri/primitives` | Free text where any typed string is valid and the popup only suggests completions |
| `Typeahead` | `@mistriwork/ui`, `/primitives` | Your code owns fetching, ranking, row markup (`renderItem`) and input text (`text`/`onText`, `onPick`), such as `useOptions` in an App |
| `Listbox` | `@mistriwork/mistri/primitives` | An always-open inline option list inside a panel, popover or split pane (no trigger button), single or `multiple` |
| `EntityPicker` | `@mistriwork/mistri/primitives` | Picking one or several people or domain records (`code`, monogram `Avatar`, `subtitle`, status `badge`) with async `loadEntities` search |
| `TreeSelect` | `@mistriwork/mistri/primitives` | Picking one or several nodes from a nested hierarchy (folders, categories, org units) with branch expand/collapse and search |
| `DateField` | `@mistriwork/ui`, `/page`, `/primitives` | Typing an ISO date (`YYYY-MM-DD`, or `withTime` for wall-clock time) beside a calendar popover, keeping typed drafts as plain text |
| `DatePicker` | `@mistriwork/mistri/primitives` | Picking a single date (`mode="single"`) or a start-and-end span (`mode="range"`) with segmented input and quick presets (`CalendarGrid` draws the month inline) |
| `DateTimePicker` | `@mistriwork/mistri/primitives` | Picking a date, segmented wall-clock time (`TimeInput`) and optional IANA timezone (`showTimezone`) as one timestamp |
| `ColorPicker` | `@mistriwork/mistri/primitives` | Picking a color from a 2D canvas, hue/alpha sliders, swatches or eyedropper (`onValueChange` while dragging, `onValueCommit` on release) |
| `ChoiceCards` | `@mistriwork/ui`, `/ui`, `/primitives` | Two to six choices (`label` and optional `icon`) that should all stay visible as cards; radio group by default, or `multiple` with `exclusive` |
| `CheckCards` | `@mistriwork/ui`, `/page`, `/primitives` | Several independent cards (`key`, `label`, `help`, `icon`, `on`) toggled on and off as one arrow-walked checkbox group |

## Common mistakes

- An icon draws nothing → register its glyph first with `registerIcons`; the package ships none.
- A dialog will not close from its own button → unmount it: a `Modal` is open for as long as it is rendered.
- A rule of your own loses to a primitive's → your stylesheet is in a cascade layer declared before `mistri-ui`; import the files into your layer instead of `style.css`.

## Related

- [Component library](/components/): every primitive and room, in each look, light and dark.
- [Custom components](/docs/custom-components/): the same primitives inside an App.
- [Themes](/docs/themes/): the tokens a look sets, and how to set your own.
