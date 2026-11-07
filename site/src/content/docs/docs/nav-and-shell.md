---
title: Navigation and the shell
description: Say where each visitor starts, arrange the menu in groups with icons, and place the menu at the side or along the top.
keywords: [navigation, menu, sidebar, nav, home, start page, shell, icons, top bar, layout]
---

Say where each visitor starts, arrange the menu in groups with icons, and place the menu at the side or along the top.

```ts title="examples/apps/lintel/app.ts"
  home: [
    { view: 'welcome', signedOut: true },
    { view: 'portal', roles: ['resident'] },
    // …
    { view: 'today' },
  ],
  nav: navigation,
```

See it in the sample (`examples/apps/lintel/app.ts:161`). The menu itself is arrangement only:

```ts title="examples/apps/lintel/navigation.ts"
export const navigation = [
  // …
  navGroup('leasing', 'Leasing', ['units', 'leases', 'occupancy', 'residents', 'viewings'], { icon: 'key' }),
  // …
] satisfies Navigation;
```

See it in the sample (`examples/apps/lintel/navigation.ts:8`) (the other entries are single views and the Books and Maintenance groups).

![Lintel at a narrow desk, signed in as a manager: Today and Homes to let, then the Leasing, Books and Maintenance groups in the side menu, Repairs current, each entry with its view's icon.](../../../assets/guide/nav.webp)

## The trail over a room

A room opened from the menu names itself in its own heading row, its count, New and Export beside the title, where a bar over it once said `⌂ › Leads 77`; the trail appears once the reader goes deeper and starts at the room they came from, `Leads › Ada Stone`. `ui.shell.breadcrumbs: true` is the whole trail with its home mark over every room, `{ top: true }` or `{ home: true }` one part of it, and `false` none ([when to choose which](/docs/compose-shell/)).

## What you'll see

- At a desk the sidebar runs the window's full height: the App's mark, New and the search (⌘K) at its head, the menu, then the bell and the account at its foot, with no bar across the window. The menu in the groups' order, each entry with its view's `icon`, the current one marked; a group's heading folds its section, remembered per person; ⌘B or « folds the menu to a rail of icons. On a phone the menu folds into the bar, and dialogs fill the screen. A menu that leads a reader to more than twelve places ends in **All pages**, `/{app}/all-pages`: every list, page and link grouped as the menu groups them, then the rooms nav does not name and every New, with a filter box that finds as ⌘K does (arrows and Enter from the box). A menu of twelve or fewer has none, and a view that already answers to `all-pages` keeps the address.
- A visitor lands on `home` (rules, as above, where roles start in different places); the logo leads back to it (and the trail's home mark, with `breadcrumbs: { home: true }`), and ⌘K finds any view, in the menu or not.

## When to use it, and when not

- Use `navGroup` once the menu has more than about six entries, in the order the day runs, with `{ folded: true }` on a section used rarely; fewer, list the view ids.
- Use [access](/docs/access-model/) and [roles](/docs/roles/), never the menu, to decide what a reader may open: a view left out of `nav` is still served at its address.

## Options

| Key | What it does | Default | Status |
| --- | --- | --- | --- |
| `home` | A view id, or rules (`{ view, roles }`, `{ view, signedOut: true }`) ending in one with no condition | required | Stable |
| `nav` | View ids, `{ to, label }` for a menu-only word (`color: 1`–`8` puts a chart color's dot beside it), `navGroup(id, label, children, { icon, placement, inline, folded })` | no menu | Stable |
| a group's `inline: true` | A top-level group's items stand in the top bar as links, not behind a menu | a menu | Stable |
| `ui.logo`, a view's `icon` | One of the curated Phosphor names (`AppIcon` in `schema/app.d.ts`, all listed in [the icons](/docs/icons/)): `house`, `kanban`, `chart-line`, `package`…; `ui.logo` may instead be the App's own picture, `{ src, dark, mark }` ([themes](/docs/themes/#a-logo-of-your-own)) | none | Stable |
| `ui.shell.placement`, `rail`, `header` | `'side'` or `'top'`; a folded sidebar's rail of icons; with the side placement, `header: 'sidebar'` draws no bar across the window: the sidebar runs the full height with the App's mark, New and the search (⌘K) at its head and the bell and the account at its foot, and folding leaves the rail. A signed-in screen at a desk only: a phone, public pages and sign-in keep the bar. `header: 'bar'` puts the bar back across the window, as does `rail: false` with no `header` | `'side'`, a rail, `'sidebar'` | Stable |
| `ui.shell.counts`, `menuSearch` | Live row counts beside lists; a filter box over the menu | off | Stable |
| `ui.shell.breadcrumbs` | The trail: `true` everywhere with the home mark, `false` never, or `{ top, home }` | `{ top: false, home: false }` | Stable |
| `ui.shell.search`, `heading` | `false` leaves each out, for a focused App (an App with no `nav` has no menu); `search: 'everyone'` offers the header's search to a signed-out visitor as well | shown, to members | Stable |
| `ui.shell.width`, `gutter` | `'full'`, `'wide'` or `'narrow'`; the side gutter | `'full'` | Stable |
| `ui.footer` | One footer, drawn by every room and the landing | none | Stable |
| `ui.shell.new` | A "+ New" button beside the bell listing every way to make something: `{ view }` (a list's New form, or a signed-in form) or `{ command }` (the signed-in form that runs it), each with an optional `label` and `icon`. A reader sees only the lines they may use; none, no button. A long menu groups its lines under headings as a nav group does: `{ label: 'Service desk', children: [{ view: 'tickets' }] }` | no button | Stable |

With `notify` rules on a resource, a bell in the bar counts unread notices and `/notifications` lists them (in a tenant App, those of the customer the person is working in) ([resources reference](/docs/dsl-resources/#resourcesnotify)). The look is `ui.theme`: [Looks](/docs/looks/). Every key: [ui reference](/docs/dsl-ui/#uishell).

## Common mistakes

- `[unknown-view]` for a nav entry or a `home` rule, or a refused `ui.shell.new` line → use one of the view ids the message lists; a New line takes a list or a signed-in form, never a dashboard, and a `command` exactly one form runs (if two do, name that form by `{ view }`).
- A dashboard that `nav`, `home` and every embed leave out is refused → put it in the menu, or `embed` it where it is read.
- An icon name outside the list is a type error and a load error → pick one from `AppIcon`; the menu takes no image files.
- `home` rules with no final unconditional rule are refused → end with `{ view: '<id>' }` for everyone else.

## Related

- [Design the navigation and shell](/docs/compose-shell/): how many groups, which placement, and what to leave out.
- [Looks](/docs/looks/): the four built-in looks and your own.
- [Public pages](/docs/landing-pages/): the front door a signed-out visitor's `home` opens.
