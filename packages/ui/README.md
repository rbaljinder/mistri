<img src="mark.svg" alt="mistri" width="48" height="48" />

# @mistriwork/ui

The standalone React primitives both shells, mistri's and tablewalk's, are
drawn with: Modal, DropMenu, Dropdown, Typeahead, Button, Field, Icon and
DateField over [Base UI](https://base-ui.com), the tokens and stylesheet they
are drawn with, and the zoom-aware ruler their popups are placed by.

The form controls are built on them (**Preview**: @mistriwork/ui is Preview at 1.0): `TextField`, `MaskedField`,
`MoneyField`, `SensitiveField`, `Select`, `MultiSelect`, `YesNo`, `ChoiceCards`, `Checkbox`, `Consent`, `Slider`,
`HelpTip`, `ProgressBar`, `StepHeader`, `ActionBar`, `Columns` and `ReviewList`, with the `masks` they take
(`phone`, `date`, `month`, `ssn`, `zip`, `money`). Each takes a value and an `onChange` and draws what it is told. A
typed MM/DD/YYYY date is `MaskedField` with `masks.date` (and `isoDay` to read it); the calendar field is `DateField`.
The landing hero's blocks are in the same Preview: `Badge` (a few words and an optional icon in a pill), `PhotoTiles`
(two to four photos in a mosaic, sized before they arrive) and `IconRows` (up to four rows of an icon and a line), their
rules in `hero.css`; the icons, the words and the image addresses are props.

A control is a Field, so its label, hint and problem are wired into it, and its problem's line is kept in the flow so
saying it moves nothing. A theme restyles them all together through `--field-fill`, `--control-h`,
`--control-border-w` and `--field-radius`, and a field label's weight is the theme's label role.

A primitive reads no data, address or message catalog: its words, its icons,
its answers and its hooks are props, and it renders with no server behind it.
React, React DOM and Base UI are peers: a project drawing with these installs
them.

```tsx
import '@mistriwork/ui/style.css';
import { Button, Modal } from '@mistriwork/ui';
```

`style.css` is the tokens (`tokens.css`), the primitives' own rules
(`primitives.css`) and the form controls' (`forms.css`) in a `mistri-ui` cascade layer, so any rule of the page's
own wins over them. A page with a layered stylesheet of its own can take the
files into a layer it names instead (`@import '@mistriwork/ui/tokens.css'
layer(base);`). An Icon draws the glyphs registered with `registerIcons`; a
DateField says the `words` it is given, as do Carousel, Resizable and Pagination (a
`words` object over English defaults). One rule names the rest: a name no one sees is
`ariaLabel` (Modal, Tabs, Popover, Carousel, Resizable, ScrollArea, Pagination, Drawer),
and `label` is only ever text drawn on the page. A Field's `optional` is the word drawn
beside the label of a field that is not required.

## Exports

Its exports are its public API, and nothing else is: `@mistriwork/ui` (every
primitive), each module by its path (`@mistriwork/ui/Button.js`,
`@mistriwork/ui/internal/datePickerModel.js`, …), and the four stylesheets.

Part of [mistri](https://mistriwork.dev);
[source](https://github.com/rbaljinder/mistri/tree/main/packages/ui).
