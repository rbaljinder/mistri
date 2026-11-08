---
title: Workspaces
description: Give an App that is two products in one a menu for each, picked by tabs in the bar across the window.
keywords: [workspaces, navigation, menu, tabs, products, switcher]
---

Give an App that is two products in one a menu for each, picked by tabs in the bar across the window.

```ts
nav: [
  navGroup('desk', 'Service desk', ['tickets', navGroup('queues', 'Queues', ['my-queue', 'unassigned'])], { workspace: true, icon: 'headset' }),
  navGroup('crm', 'CRM', ['accounts', 'leads'], { workspace: true, icon: 'briefcase' }),
  navGroup('help', 'Help', ['guide'], { placement: 'footer' }),
],
```

- Set `workspace: true` on every top-level group, bar a `placement: 'footer'` group, which stays at the foot of each workspace. A group inside a workspace folds as any group does; `inline` is refused beside `workspace`.
- The tabs stand in the bar after the App's mark, each with its `icon`. What does not fit goes under **More**; a label is never cut and the bar never scrolls sideways. The sidebar lists only the current workspace's entries.
- On a phone the workspaces are a list at the top of the menu drawer, the current one marked; choosing one leaves the drawer open.
- A reader sees only the workspaces they can open. With one there are no tabs to pick.
- A view may stand in two workspaces. The current workspace is the one holding the room; it is never in the address, and ⌘K finds every entry.
- The bar is required: `ui.shell.header: 'sidebar'` is refused beside workspaces. In the top placement a workspace is an ordinary group.

See [Navigation and the shell](/docs/nav-and-shell/) for the rest of the menu.
