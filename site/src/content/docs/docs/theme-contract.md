---
title: The theme contract
description: The thirteen promises every look an App wears keeps to its reader, and the check and grade codes that measure each.
---

The thirteen promises every look an App wears keeps to its reader, and the check and grade codes that measure each.

A theme may change how an App looks, never whether it can be used.
`mistri check` holds the ones the theme's spec decides; `mistri grade`
measures the ones only a drawn page shows. Every finding of those codes
carries its promise, `"promise": "C2"`, in `check --json` and in grade's JSON,
and `mistri explain C2` prints the row below.

```sh
npx @mistriwork/mistri grade . --config mistri.json --theme all
npx @mistriwork/mistri grade . --config mistri.json --theme all --palette all --as all --json
```

`--theme all` grades every theme the App can wear: its own look, the built-in
looks and each of `ui.customThemes`. Each row is a theme, and each column a
window: 1280, 390, 320 and 390 in the dark. `--palette all` adds each other
palette of a theme at 390 and 390 in the dark, reading only C1, C2, C3 and C6,
because a palette changes colors and moves nothing. `--as all` adds a row for a
signed-out visitor and one for each role a person signs in as. A cell is ✓ or
its count of findings. Under the table, each failing cell's first finding gives
its promise, code, row, window and page, and, where a theme's color caused it,
the token and a value that passes. Any error fails the run with exit code 2.

| Promise | Measured by | What it promises | Fix |
| --- | --- | --- | --- |
| `C1` | <span id="c1"></span>check `theme-contrast`, grade `low-contrast` | Text readable: words at 4.5:1 on every ground they are drawn on, 3:1 when large | The color the finding names, or `mistri check --fix` |
| `C2` | <span id="c2"></span>check `theme-edge`, `theme-shadow`, grade `faint-edge` | Controls visible: a field's, a select's and a picker's edge at 3:1 on the field and on what it sits on, and a lift that is a shadow, not a glow (a theme draws no glow anywhere: its stylesheet's `box-shadow` is one of the look's lifts and takes no `text-shadow` or `filter`) | A darker `lineControl` (`check --fix` writes one that passes); a `shadow` darker than the ground |
| `C3` | <span id="c3"></span>check `theme-focus`, grade `hidden-focus` | Focus visible: the ring at least 2px and 3:1 on every ground a focusable sits on, the menu's included (grade tabs through it) | A `focus` color that reads on the page, a panel and a raised row |
| `C4` | <span id="c4"></span>grade `small-target` | Targets big enough: 44px each way on a phone, 24px at a desk | Padding, not a smaller box; report the platform's own controls |
| `C5` | <span id="c5"></span>grade `overlap`, `clipped-text`, `clipped-number`, `sideways-scroll`, `header-wrap` | Nothing cut or overlapping, down to a phone 320 wide | A smaller corner or density in the theme; the App's own layout fixes are in [design checks](/docs/design-lint/) |
| `C6` | <span id="c6"></span>grade `color-only` | Not by color alone: a toned mark always has its word or a name beside it | Say the value: a status as its dot and word, a mark with an `aria-label` |
| `C7` | <span id="c7"></span>check `theme-chart` | Charts distinguishable: neighboring series 8 apart for color-blind readers, 10 to normal vision | The order `mistri check` suggests |
| `C8` | <span id="c8"></span>check `theme-type`, grade `long-measure` | Type legible: no text below the look's size, no weight a face does not ship, prose no wider than 80 characters a line | Give prose a narrower column; ship the face at the weight a role asks for; a theme cannot shrink text |
| `C9` | <span id="c9"></span>grade `unsafe-motion` | Motion safe: nothing moves under reduced motion, nothing takes past 200ms, nothing loops | The platform's motion only; report a part that moves |
| `C10` | <span id="c10"></span>check `theme-dark`, grade's 390-dark window | Dark complete: every color and picture has a dark answer | The dark color the window's finding names; a logo picture's `dark` |
| `C11` | <span id="c11"></span>check `theme-budget`, grade `layout-shift`, `heavy-theme` | Stays fast: faces 150 KB together, the theme's files light on a cold visit, no shift once drawn | Fewer weights, a variable face, a smaller logo |
| `C12` | <span id="c12"></span>check `theme-print`, grade `print-contrast` | Print reads: the accent, links and words at 4.5:1 on white paper | A light `accent` and `link` that read on white |
| `C13` | <span id="c13"></span>check `theme-part`, `theme-band`, `theme-css`, `theme-contract`, grade `changed-app` | Same App: a theme changes how the App looks, never which controls a reader can reach or where a box stands (a control folded into a "More" menu by larger type is still reachable: grade opens the fold and finds it there; a shortcut hint and a chart's tick labels are decoration); a part it dresses keeps its words legible | Dress a part in roles whose ink reads on its ground; say a part's size or visibility in the App, not its theme |

The C-rules bound an App's theme; the design system's refusal list binds the built-in
looks and what the platform draws ([themes](/docs/themes/)).

## Related

- [Themes and branding](/docs/themes/): write a theme with `defineTheme`.
- [Looks](/docs/looks/): the built-in looks that keep the same promises.
- [Design checks](/docs/design-lint/): the grade's other codes.
