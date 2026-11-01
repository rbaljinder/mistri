---
title: "@mistriwork/ui on its own"
description: Draw a page of your own with the buttons, fields, dialogs and menus an App is drawn with, without a server behind it.
keywords: [ui, primitives, components, react, base ui, button, modal, field, standalone]
---

Draw a page of your own with the buttons, fields, dialogs and menus an App is drawn with, without a server behind it.

```sh
npm install @mistriwork/ui react react-dom @base-ui/react
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
      <Button intent="primary" onClick={() => setOpen(true)}>Invite</Button>
      {open && (
        <Modal className="invite" ariaLabel="Invite a teammate" onClose={() => setOpen(false)}>
          <Field label="Email" hint="They get a link to sign in.">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button intent="primary" onClick={() => setOpen(false)}>Send</Button>
        </Modal>
      )}
    </>
  );
}
```

<!-- no picture: the component library draws every primitive, in every look. -->

A primitive reads no data, no address and no message catalog: its words, its icons and its answers are props. A name no one sees is `ariaLabel` on every primitive, and `label` is only text drawn on the page; the primitives that carry a few built-in words (Carousel, Resizable, Pagination, DateField) take a `words` object over English defaults. React, React DOM and Base UI are peers, so your project installs them. An App does not need this package: mistri brings it.

## What you'll see

- The App's own button, field and dialog, in the platform's tokens, light or dark by the reader's setting.
- A field that wires its label, hint and problem into the control (`id`, `aria-describedby`, `aria-invalid`), so no form joins them by hand.
- A dialog that holds focus, closes on Escape and a click on its scrim, and draws a menu or a listbox opened inside it within itself.

## What it holds

| Export | What it is |
| --- | --- |
| `Button` | `intent` (`primary`, `secondary`, `quiet`, `danger`), `size` (`compact`, `default`, `large`), `busy` |
| `Field` | A label over one control, a `hint` under it, then a `problem`; `children` is the control, or a function of its wiring for a control of several parts |
| `Modal` | Open while mounted; `onClose` is told once, however it closed |
| `DropMenu`, `DropItem`, `DropGroup`, `DropSeparator` | A menu on a button |
| `Dropdown` | A listbox: one choice from a list |
| `Typeahead` | A box with a list that narrows as you type |
| `DateField` | A date and its calendar, in the `words` it is given |
| `Icon`, `registerIcons` | Draws the glyphs you register, by name |
| `Badge`, `PhotoTiles`, `IconRows` | A landing hero's parts (Preview): a short pill over a heading; two to four photos in one 4:3 mosaic; up to four rows of an icon and a line |
| `Switch` | One on/off choice as a switch (`checked`/`onCheckedChange`, or `defaultChecked`), with an optional `label` and `description`; `busy` refuses a press while keeping focus |
| `Tabs` | One panel at a time from a row (`tabs` of `value`, `label`, `children`); arrow keys walk the row, a disabled tab is skipped |
| `Drawer` | A sheet from an edge (`side` `left` or `right`, at most 420px, full width on a phone); controlled with `open`/`onOpenChange`, `closeDisabled` refuses a dismissal |
| `Popover` | A small layer anchored to a `trigger` element; Escape and a click outside dismiss it, focus returns on close |
| `Avatar` | A person's picture, or their initials where there is none (`name` → `AL`, `A`); sizes `sm`, `md`, `lg` |
| `Pagination` | The pages of a list as buttons (`page`, `pages`, `onPageChange`); the current page is `aria-current`, never a button to itself, steps disable at the ends, long runs shorten with an ellipsis |
| `Carousel` | One slide at a time from a row (`slides` of `label`, `children`); Previous/Next disable at the ends, dots jump to a slide, arrow keys move, Home/End go first/last |
| `Resizable` | Two or more panes on a handle (`panels` of `label`, `defaultSize`, `minSize`); the handle is a separator with `aria-valuenow` in percent, walked by arrows, Home/End, or dragged by pointer |
| `ScrollArea` | A region that scrolls inside itself (`label`, `orientation`, `maxHeight`); the viewport is a labeled tab stop with its own thumb |
| `Tooltip` | A short supplementary note on a `trigger` element, said on hover and on focus alike; the note carries `role="tooltip"` and the trigger names it while open |

`style.css` is the tokens and the primitives' rules in a `mistri-ui` cascade layer, so any rule of your page's own wins. To place them in a layer of your own, import the two files it joins: `@import '@mistriwork/ui/tokens.css' layer(base);` and `@mistriwork/ui/primitives.css` the same way.

## Common mistakes

- An icon draws nothing → register its glyph first with `registerIcons`; the package ships none.
- A dialog will not close from its own button → unmount it: a `Modal` is open for as long as it is rendered.
- A rule of your own loses to a primitive's → your stylesheet is in a cascade layer declared before `mistri-ui`; import the two files into your layer instead of `style.css`.

## Related

- [Component library](/components/): every primitive and room, in each look, light and dark.
- [Custom components](/docs/custom-components/): the same primitives inside an App.
- [Themes](/docs/themes/): the tokens a look sets, and how to set your own.
