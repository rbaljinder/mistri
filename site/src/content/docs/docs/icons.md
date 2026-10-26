---
title: Icons
description: The icon names an App may use for a menu entry, a section, a logo or a value, and what happens to one that is not listed.
keywords: [icons, icon, logo, menu, phosphor, names, stethoscope, clinic]
---

The icon names an App may use for a menu entry, a section, a logo or a value, and what happens to one that is not listed.

```ts title="examples/apps/lintel/navigation.ts"
  navGroup('leasing', 'Leasing', ['units', 'leases', 'occupancy', 'residents', 'viewings'], { icon: 'key' }),
  navGroup('books', 'Books', ['ledger', 'payments', 'post-rent'], { icon: 'receipt' }),
```

See it in the sample (`examples/apps/lintel/navigation.ts:15`).

Every `icon` and `ui.logo` is one of these Phosphor names ([phosphoricons.com](https://phosphoricons.com), MIT), and `mistri check` refuses any other, naming the nearest. An App ships only the drawings of the icons it names.

- **Places and structure**: `house`, `tray`, `list`, `list-checks`, `kanban`, `table`, `calendar`, `calendar-check`, `clock`, `chart-bar`, `chart-line`, `chart-pie`, `gauge`, `target`, `flag`
- **People and organizations**: `user`, `users`, `user-circle`, `address-book`, `handshake`, `buildings`, `storefront`, `briefcase`
- **Things and logistics**: `package`, `truck`, `car`, `shopping-cart`
- **Money**: `receipt`, `currency-dollar`, `credit-card`, `wallet`, `bank`
- **Documents**: `file`, `file-text`, `folder`, `clipboard-text`, `note`, `archive`, `tag`, `ticket`, `star`, `bookmark-simple`
- **Communication**: `bell`, `envelope`, `chat-circle`, `phone`, `headset`, `megaphone`, `globe`, `map-pin`
- **Tools and state**: `magnifying-glass`, `gear`, `sliders`, `wrench`, `bug`, `shield-check`, `lock`, `key`, `database`, `stack`, `lightning`, `check-circle`, `warning`, `info`
- **Values**: `cell-signal-low`, `cell-signal-medium`, `cell-signal-high`, `cell-signal-full`, `fire`, `hourglass`, `circle-dashed`, `x-circle`, `plus-circle`, `pencil-simple`, `paper-plane-tilt`, `arrows-left-right`, `arrow-circle-down`, `arrow-circle-up`
- **Devices**: `laptop`, `monitor`, `device-mobile`, `printer`
- **Health and care**: `stethoscope`, `heartbeat`, `heart`, `pill`, `syringe`, `first-aid-kit`, `thermometer`, `flask`, `test-tube`, `microscope`, `bed`, `hospital`, `ambulance`, `tooth`, `eyeglasses`, `wheelchair`, `baby`, `dna`, `brain`, `bandaids`, `hand-heart`
- **Learning, land and buildings**: `graduation-cap`, `book-open`, `student`, `chalkboard-teacher`, `factory`, `warehouse`, `house-line`, `plant`, `leaf`, `sun`, `cloud`, `drop`
- **Travel**: `airplane`, `bicycle`, `bus`, `train`, `boat`
- **Things, tools and records**: `hammer`, `toolbox`, `plug`, `lightbulb`, `cube`, `camera`, `image`, `trophy`, `gift`, `coffee`, `fork-knife`, `shopping-bag`, `basket`, `barcode`, `qr-code`, `scales`, `gavel`, `certificate`, `identification-card`, `fingerprint`, `eye`, `link`, `paperclip`, `scissors`, `palette`, `code`, `terminal`, `users-three`, `user-plus`

## Using one

An `icon` on a view, a nav group, a dashboard section, a display rule or `ui.logo` is one of these names, written as a string: `icon: 'stethoscope'`. The types accept any string and autocomplete these, so a misspelled name does not break the helper it sits in; `mistri check` refuses it at the icon, naming the nearest names and the list once.

## Related

- [Navigation and the shell](/docs/nav-and-shell/): where a menu entry and a logo take an icon.
- [Resources and display](/docs/dsl-resources/): the display rules that take one.
- [Check codes](/docs/check-codes/): the code that refuses an unknown name.
