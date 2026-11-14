<img src="mark.svg" alt="mistri" width="48" height="48" />

# @mistriwork/ui

The standalone React primitives both shells, mistri's and tablewalk's, are
drawn with: Modal, DropMenu, Dropdown, Typeahead, Button, Field, Icon and
DateField over [UI SDK](https://ui-sdk.dev), the tokens and stylesheet they
are drawn with, and the zoom-aware ruler a page measures by.

The form controls are built on them (**Preview**: @mistriwork/ui is Preview at 1.0): `TextField`, `TextArea`, `MaskedField`,
`MoneyField`, `SensitiveField`, `FileField`, `Select`, `MultiSelect`, `YesNo`, `ChoiceCards`, `Checkbox`, `Consent`, `Slider`,
`HelpTip`, `ProgressBar`, `StepHeader`, `ActionBar`, `Columns` and `ReviewList`, with the `masks` they take
(`phone`, `date`, `month`, `ssn`, `zip`, `money`). Each takes a value and an `onChange` and draws what it is told. A
typed MM/DD/YYYY date is `MaskedField` with `masks.date` (and `isoDay` to read it); the calendar field is `DateField`.
The landing hero's blocks are in the same Preview: `Badge` (a few words and an optional icon in a pill), `PhotoTiles`
(two to four photos in a mosaic, sized before they arrive) and `IconRows` (up to four rows of an icon and a line);
the icons, the words and the image addresses are props.

A control is a Field, so its label, hint and problem are wired into it, and its problem's line is kept in the flow so
saying it moves nothing. A theme restyles them all together through the palette, the faces, `--field-radius` and
`--field-edge`, and a field label's weight is the theme's label role.

No class names a control. Each part carries a `data-slot` (`button`, `input`, `select-trigger`, `dialog-content`,
`calendar-day`, …) and says its state in attributes (`data-variant`, `data-size`, `data-checked`, `data-invalid`,
`data-open`), and that is what a stylesheet and a test select by. A caller's own `className` lands on the part it
always did and is the caller's to dress.

Every component here is also a slot of the control kit seam (`defineUiKit`): an App can draw any of them itself, or
dress the default with `dress('Button', (Button, props) => …)`.

A primitive reads no data, address or message catalog: its words, its icons,
its answers and its hooks are props, and it renders with no server behind it.
React, React DOM and UI SDK (`@ui-sdk/core`, `@ui-sdk/react`, pinned to the
version this release was tested with) are peers: a project drawing with these
installs them.

```tsx
import '@mistriwork/ui/style.css';
import { Button, Modal } from '@mistriwork/ui';
```

`style.css` is the tokens (`tokens.css`), what the controls wear
(`controls.css`) and the answers to the reader's contrast and transparency
settings (`preferences.css`) in a `mistri-ui` cascade layer, so any rule of the page's
own wins over them. A page with a layered stylesheet of its own can take the
files into a layer it names instead (`@import '@mistriwork/ui/tokens.css'
layer(base);`). `controls.css` nests layers of its own inside whichever layer
takes it, so every rule beside it in that layer stands over a control's default
dress. An Icon draws the glyphs registered with `registerIcons`; a
DateField says the `words` it is given, as do Carousel, Resizable and Pagination (a
`words` object over English defaults). One rule names the rest: a name no one sees is
`ariaLabel` (Modal, Tabs, Popover, Carousel, Resizable, ScrollArea, Pagination, Drawer),
and `label` is only ever text drawn on the page. A Field's `optional` is the word drawn
beside the label of a field that is not required.

## The behaviors

`@mistriwork/ui/behaviors/index.js` is what a component of your own is built on
where a reader moves, walks or edits something in place: a list whose order is
the reader's (`Sortable`), things carried between lists (`Transfer`), a month a
keyboard walks (`Days`), stretches along tracks (`Spans`), a position read
along a line (`Scrub`), one of a list shown beside it (`Pick`), a list worked
one at a time (`Turns`), column widths (`Widths`) and values edited where they
stand (`Editable`). Each is a UI SDK primitive with React parts: roles, keys,
announcements and `data-*` on elements you dress, and nothing drawn. A root's
change callback hears the value and then the reason, the hand and the event, as
every control's does, with `cancel()` to refuse the change. The primitives
themselves (`sortable`, `transfer`, …) and `createParts` are exported beside
the parts, for parts on elements of your choosing.

`behaviors.css` gives the slots only what a behavior needs to work wherever it
stands, and a plain grip. No control imports a behavior, so a page that draws
none never loads either file. In an App, a component imports them from
`@mistriwork/mistri/behaviors`
([guide](https://mistriwork.dev/docs/behaviors/)).

## Exports

Its exports are its public API, and nothing else is: `@mistriwork/ui` (every
primitive), each module by its path (`@mistriwork/ui/Button.js`,
`@mistriwork/ui/behaviors/index.js`,
`@mistriwork/ui/internal/datePickerModel.js`, …), and the five stylesheets.

Part of [mistri](https://mistriwork.dev);
[source](https://github.com/rbaljinder/mistri/tree/main/packages/ui).
