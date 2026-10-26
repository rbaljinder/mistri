---
title: Looks
description: Dress an App in one of three built-in looks, adjust its accent and corners, or register a look of your own.
keywords: [theme, look, style, colors, dark mode, branding, accent, font, palette, design]
---

Dress an App in one of three built-in looks, adjust its accent and corners, or register a look of your own.

```ts title="examples/apps/lintel/app.ts"
  ui: {
    logo: 'buildings',
    theme: { preset: 'lintel' },
    customThemes: [lintel, blueprint, hearth, tidelight],
    shell: {
      placement: 'side',
      rail: true,
```

See it in the sample (`examples/apps/lintel/app.ts:169`): Lintel names a look of its own (Lumen with one recipe changed, `theme.ts`), offers three more in the reader's picker ([Blueprint](/docs/themes/#a-look-of-your-own), Hearth, `hearth.ts`, and [Tidelight](/docs/themes/#a-brand-in-one-block)), and folds its side menu to a rail. `ui: { theme: { preset: 'sage' } }` picks another built-in look; `theme: { accent: '#2258cf', radius: '8px' }` adjusts the accent and corners of the one it names.

![Lintel's leases in Lumen, the default look: a stone menu with the current room in a soft blue pill, the table on white, statuses as a dot and a word, the current tab underlined in blue.](../../../assets/looks/lumen.webp)

## What you'll see

- The same rooms, structure and type scale in every look, light and dark; a look changes color, face and corners, never what is shown or who may change it.
- Readers may pick another look, palette and System, Light or Dark under Preferences, kept in their browser; the App's choice is the default.
- The accent dresses the selected tab, links, the filled button and the first series of every chart; the database browser and the Workbench keep their own look.

## The three, side by side

Lintel's leases in each look. Every component in every look is in the [component showcase](/components/).

<div class="tw-looks">
<figure>

![Lintel's leases in Lumen: a stone menu with the current room in a soft blue pill, the table on white, statuses as a dot and a word, the current tab underlined in blue.](../../../assets/looks/lumen.webp)

<figcaption><strong>Lumen</strong> — the default. A refined workspace: white cards lifted on a warm stone ground, a navy primary, statuses as tinted pills, stat cards with tinted marks and boards headed by tinted lanes; palettes Violet, Teal, Emerald, Rose and Amber.</figcaption>
</figure>
<figure>

![Lintel's leases in Mono: black and white, the current tab and room inverted, monospace tabs and column heads, links underlined.](../../../assets/looks/mono.webp)

<figcaption><strong>Mono</strong> — black and white: square corners, monospace labels, the current tab inverted. Opt in with <code>preset: 'mono'</code>.</figcaption>
</figure>
<figure>

![Lintel's leases in Sage: a warm ground with the menu on it, the list open on it under hairlines, the chosen tab in a soft tint, names in green and statuses as tinted pills.](../../../assets/looks/sage.webp)

<figcaption><strong>Sage</strong> — a soft workspace: a dashboard's panels in white on cream, tables open on the ground, sage-green charts, statuses as tinted pills. Opt in with <code>preset: 'sage'</code>.</figcaption>
</figure>
</div>

## Recipes, look by look

Each part's treatment in each look, as `mistri theme show <look>` prints it. A theme that `extends` a look starts from its column; `mistri theme show . --diff lumen` says what yours changes.

| Part | Lumen | Mono | Sage |
| --- | --- | --- | --- |
| `nav` | `pill` | `inverted` | `quiet` |
| `bar` | `airy` | `ruled` | `soft` |
| `tabs` | `underline` | `inverted` | `chosen` |
| `windows` | `lifted` | `segmented` | `chosen` |
| `stat` | `divided` | `framed` | `panel` |
| `section` | `open` | `open` | `panel` |
| `fields` | `rail` | `open` | `panel` |
| `table` | `quiet` | `open` | `hairline` |
| `status` | `quiet` | `dot` | `pill` |
| `board` | `strip` | `ruled` | `soft` |
| `chart` | `line` | `plain` | `wash` |
| `buttons` | `raised` | `accent` | `accent` |
| `links` | `plain` | `underline` | `plain` |
| `rules` | `hairline` | `ink` | `hairline` |
| `avatar` | `round` | `plain` | `large` |
| `workflow` | `markers` | `markers` | `markers` |
| `banner` | `plain` | `tint` | `tint` |
| `steps` | `strip` | `flat` | `flat` |
| `lanes` | `tint` | `tint` | `tint` |
| `header` | `plain` | `plain` | `band` |
| `required` | `star` | `star` | `star` |
| `checkbox` | `native` | `native` | `native` |
| `formStep` | `plain` | `plain` | `plain` |
| `actionBar` | `plain` | `plain` | `plain` |

## Type, look by look

The type roles each look says (`type.roles`, [Theme recipes](/docs/theme-recipes/#type)); a role it leaves out is drawn as the platform draws it.

| Role | Lumen | Mono | Sage |
| --- | --- | --- | --- |
| `title` | 28px, 600, -0.02em | 30px, 700 | 600 |
| `heading` | 24px, -0.018em | | |
| `section` | 16px, 600, -0.01em | | |
| `label` | | `mono`, `upper` | |
| `figure` | | `mono`, 700 | |
| `nav` | | `mono`, `upper` | |

## When to use it, and when not

- Use a built-in look (`preset`) for almost every App: Lumen for a polished workspace product, Mono for dense daily operations, Sage for a soft workspace.
- Use `accent`, `radius` and `font` to carry a brand's color into a built-in look without leaving it.
- Use [`defineTheme`](/docs/themes/) when a brand needs its own grounds and inks or another look's treatments; [Themes and branding](/docs/themes/#three-themes-to-start-from) has three to copy.

## Options

| Key | What it does | Default | Status |
| --- | --- | --- | --- |
| `ui.theme.preset` | `lumen`, `mono`, `sage`, or a registered look's id | `lumen` | Stable |
| `ui.theme.palette` | A look's named palette: Lumen's `violet`, `teal`, `emerald`, `rose`, `amber` | the look's own | Stable |
| `ui.theme.accent` | One color, or `{ light, dark }`; one color is mixed toward white on dark | the look's | Stable |
| `ui.theme.radius`, `font` | Corners (Mono keeps its square ones) and the interface face | the look's | Stable |
| `ui.customThemes` | Up to 20 themes of the App's own from `defineTheme`, offered in the reader's picker; `ui.theme.preset` names one as the App's look | none | Stable |

`mistri check` refuses a color under 4.5:1 for text or 3:1 for a control, and chart series too close for color-blind readers. Every key: [ui reference](/docs/dsl-ui/#uitheme).

## Common mistakes

- A misspelled `preset` is a type error → use one of the three ids, or register a `defineTheme` result in `ui.customThemes` and name its id.
- A contrast failure in `mistri check` → change the color it names (`accent`, `lineControl`, `chart[2]`) until text reaches 4.5:1 and a control's edge 3:1.
- A font that never shows → `type.font` names installed faces only; mistri fetches none, so list a fallback stack.
- Grounds and inks set through `accent` → `accent` is one color; for grounds, register a look with `defineTheme`.

## Related

- [Navigation and the shell](/docs/nav-and-shell/): the menu and bar each look dresses.
- [Design checks](/docs/design-lint/): `mistri shot --theme all` and what the checks flag in each look.
- [Custom components](/docs/custom-components/): drawing with the looks' tokens, so every look dresses your component.
- [Component showcase](/components/): every block in every look, light and dark.
