---
title: Choose a building block
description: Pick the block that fits what the reader is doing, from a list's presentation to a command, with a sample line for each.
keywords: [which, choose, chooser, decision, presentation, when to use, primitives, building block, best practice]
---

Pick the block that fits what the reader is doing, from a list's presentation to a command, with a sample line for each.

```ts title="examples/apps/lintel/views.ts"
editable: ['market_rent', 'available_on', 'listed'],
  filters: ['property_id', 'bedrooms', 'status'],
  totals: ['market_rent'],
```

See it in the sample (`examples/apps/lintel/views.ts:51`), Lintel's rent roll: a list people triage in place, so its columns are `editable`, and a figure that adds up, so it has `totals`.

Choose by what the reader is doing, not by what the table holds. Each row is "when X, use Y; not when Z", with a line of Lintel or Tick that does it. The agent skill sends its agent here (`npx @mistriwork/mistri docs choose`).

<!-- no picture: a chooser points at the pages that have them. -->

## Show rows

A [list](/docs/lists/) is a grid unless its `presentation` says otherwise; tabs, filters and sort work under every presentation.

| When | Use | Not when | In a sample |
| --- | --- | --- | --- |
| Rows to scan and compare (most lists) | the grid: `show` of 4–7 columns, the name first, then the state, the parent by name, a figure, a date | a raw id, or every column | `examples/apps/lintel/views.ts:65` |
| Things to look at: homes, people, projects with photos | `presentation: cards(...)` | rows people compare figure by figure | `examples/apps/lintel/views.ts:13` |
| Work that moves through stages, a card at a time | `board: { by: 'status', … }`; lanes follow the resource's `machine` | more than about six lanes, or nobody moves the cards | `examples/apps/lintel/views.ts:134` |
| An inbox someone clears, one decision per row | `queue(...)` with a `badge`, a few `properties` and an `openLabel` naming the verb | browsing | `examples/apps/lintel/views.ts:170` |
| Reading one record after another without leaving the list | `split: { … }` | the record has children to walk | — |
| Records that happen on a day | `calendar(date, title)`, beside the grid as the resource's own view | records need an address of their own under the calendar | `examples/apps/lintel/views.ts:93` |
| The work divides by state or date | `tabs` in the order it is worked, All last | one tab per stored value nobody works by | `examples/apps/lintel/views.ts:151` |
| Narrowed on three or more facets | `filterBar: 'rail'`; fewer, the bar's chips from `filters` | a list read top to bottom | `examples/apps/lintel/views.ts:28` |
| Triage in place: owner, priority, due date | `editable` columns | a column a rule or a command must decide | `examples/apps/lintel/views.ts:51` |
| The record's verbs are the work | `rowActions: true`; the same verb on many rows: `bulk: true` on the action | one atomic change to many rows (a command with `targets: 'many'`) | `examples/apps/lintel/views.ts:104` |
| A figure that adds up | `totals` (over the whole tab); a count or sum of children: a `rollups` entry shown as a column | a figure across tables (a dashboard) | `examples/apps/lintel/views.ts:53`, `examples/apps/lintel/resources.ts:89` |
| A glance without losing the list | `open: 'drawer'` | a record people work on for minutes | — |
| A list that can be empty | an `empty` that says what belongs there | — | `examples/apps/lintel/views.ts:35` |

## Show one record

One skeleton ([Design a record page](/docs/compose-record-page/)): head, figures, children as tabs, an aside. The keys are on [Record pages](/docs/pages/).

| When | Use | Not when | In a sample |
| --- | --- | --- | --- |
| Always: the head | `header({ status, facts })`: the state beside the name, 3–4 facts; a date says what it is first (`{ column: 'ends_on', before: 'Ends' }`) | a custom section repeating the name | `examples/apps/lintel/pages/maintenance_request.ts:15` |
| The record has figures | a `summary` of 3–4 rollups: the first `fields()` under the head | metric cards beside an aside; they wrap | `examples/apps/lintel/pages/lease.ts:16` |
| The state is an ordered pipeline of 3–6 steps | a `machine` on the resource; the summary draws its stepper | side exits (lost, canceled) as steps: they stay tones | `examples/apps/lintel/resources.ts:239` |
| Two or more child lists | `related` lists as tabs, `listTabs: true`, 4 columns each, the status last | a stack of tables | `examples/apps/lintel/pages/lease.ts:17` |
| Children are added from the record | a related list's `create`, whose `prefill` carries what the record knows | — | `examples/apps/lintel/pages/maintenance_request.ts:30` |
| The siblings matter | `related(title, table, { same: ['account_id'] })` | — | `examples/apps/lintel/pages/unit.ts:41` |
| It has a parent | the parent as a `card(title, reference, [...])` first in the aside, with two of its fields | its name alone | `examples/apps/lintel/pages/lease.ts:27` |
| One child row matters now: the next task, the active lease | `current(...)` in the aside, with an `empty` that says what none means | — | — |
| The remaining fields | a `properties` rail in the aside, `fields()` with `region: 'aside'`, edited in place | a block of fields opening the page | — |
| Who changed what | `history()` last in the aside, with the record history store provisioned | — | `examples/apps/lintel/pages/lease.ts:29` |
| A child list that is usually empty | `empty: 'hide'`: left out rather than drawn empty, or `'collapse'`: one line for the empty lists together | — | `examples/apps/lintel/pages/unit.ts:33` |
| A person or a company read as a profile | an [overview page](/docs/compose-overview/): `avatar` and `subtitle`, a summary of five, a `chart` of activity, no aside | an operational record | — |
| A dashboard chart for one record | the same `chart` narrowed with `whose` | — | — |
| A thing a visitor decides on: a listing, a product | a `gallery`, one line of `facts`, a `headline()` offer in the aside, `related(…, { same })` last | — | `examples/apps/lintel/pages/unit.ts:17` |

## Change a record

From the lightest to the heaviest: Save, a fixed action, a machine, a command. Each heavier one is for what the lighter one cannot hold.

| When | Use | Not when | In a sample |
| --- | --- | --- | --- |
| Create or edit a record's own columns | the resource's [`form`](/docs/forms/) and `access: 'write'` | a rule must hold against stored state as it runs | `examples/apps/lintel/resources.ts:82` |
| Move a record to a fixed state: start, mark done | a fixed [action](/docs/actions/) with `set` and `when` | `when` meant as a permission: it only draws the button | `examples/apps/tick/app.ts:47` |
| A record's states and the only moves between them | a `machine` on the resource: buttons, stepper, board lanes and the server's refusal | the column is edited freely | `examples/apps/lintel/resources.ts:140`, `examples/apps/lintel/resources.ts:171` |
| Two fields must agree | `validation`: `{ must, when?, message }` | the check reads other rows (a command) | `examples/apps/lintel/resources.ts:78`, `examples/apps/lintel/resources.ts:148` |
| A decision checked against stored state, who acts, or several tables in one transaction | a [command](/docs/commands/): `defineCommand` in the server-only commands module, named by an `action` | a plain `set` would do | `examples/apps/lintel/commands/leasing.ts:11` |
| Create records through a guided form, signed in | [`commandForm(...)`](/docs/command-forms/), granted by `commands` | a resource `form` would do | `examples/apps/lintel/views.ts:220` |
| Take a submission from anyone | a `commandForm` with `public: true` | the visitor must read anything back | `examples/apps/lintel/views.ts:38`, `examples/apps/lintel/commands/viewing.ts:12` |
| A long public application, not lost to a closed tab | a public form whose `step()`s each run a command | it fits one sitting | — |

## Show figures

Figures first, then how they move and divide, then what waits ([Design a dashboard](/docs/compose-dashboard/), [Dashboards](/docs/dashboards/)).

| When | Use | Not when | In a sample |
| --- | --- | --- | --- |
| The headline numbers | 3 or 4 `metric` cards of one `width` | more than four in a row | `examples/apps/lintel/dashboards.ts:11` |
| A figure with a before | `over` with `better` (the change and its trend come unasked) | `better` alone: there is no change to color | `examples/apps/lintel/dashboards.ts:17` |
| Movement over time | a `chart` over `auto` (or by month) | `week`: it is a window, not a grouping | `examples/apps/lintel/dashboards.ts:40` |
| A total divided by a vocabulary; two divisions crossed | a `breakdown` at half width; a `matrix` | — | `examples/apps/lintel/dashboards.ts:49` |
| Work waiting | `rows` of it with a `limit`, two to a row | — | `examples/apps/lintel/dashboards.ts:50` |
| Read by period | `windows` on the dashboard, `over` on each section | — | `examples/apps/lintel/dashboards.ts:73` |

## Arrange the App

| When | Use | Not when | In a sample |
| --- | --- | --- | --- |
| The menu has more than six entries | `navGroup` in the order the day runs, each with an icon | — | `examples/apps/lintel/navigation.ts:15` |
| Roles start in different places | `home` as a list of rules | — | `examples/apps/lintel/app.ts:161` |
| A front page for signed-out visitors | a [`landing(...)`](/docs/landing-pages/) with a `hero`, embedded lists and a call to action | an App without sign-in | `examples/apps/lintel/landing.ts:6` |

## Later or elsewhere

| When | Use | Not when |
| --- | --- | --- |
| Something runs on a schedule, or after a command commits | a job or an event's effect: [Events and jobs](/docs/events-and-jobs/) | it must hold in the same transaction (the command itself) |
| A process waits days for something and resumes | a [workflow](/docs/events-and-jobs/) | one job would do |
| Someone is told by email | a `notify` rule with `email: true`, or a command effect: [Email](/docs/email/) | the notice in the App's bell is enough |
| Another system is told, or tells you | webhooks and inbound endpoints: [Events and jobs](/docs/events-and-jobs/) | a person reads it in the App |

## Who sees what

| When | Use | Not when |
| --- | --- | --- |
| People sign in | [Sign-in](/docs/sign-in/): providers and sign-up | — |
| Groups of people do different things | [roles](/docs/roles/): `read`, `write`, `commands`, field access | a menu entry hidden: the menu decides nothing |
| A person sees only their own rows, or a team's | [row access](/docs/row-access/) | every role reads every row |
| Several organizations share one App, apart | a [tenant App](/docs/tenant-apps/) | one organization with teams (row access) |
| Visitors read without an account | `auth.public`: [Public pages](/docs/landing-pages/) | the visitor only sends something (a public form) |

All of these are enforced on the server, whatever the screens draw.

## Draw something new

Use [`component(...)`](/docs/custom-components/) only when no section, presentation, chart or display rule draws it, and when the gap is real: a bug is fixed, a need two Apps share is reported as a platform gap, and only a need one App alone has becomes a component. It still reads through what the App declares and changes data only through commands. Neither Lintel nor Tick needs one.

## Related

- [Lists](/docs/lists/): every presentation, tab, filter and total.
- [Record pages](/docs/pages/): sections, tabs and the side panel.
- [Commands](/docs/commands/): a decision checked on the server, across tables.
- [Composing a record page](/docs/compose-record-page/): the same choices as rules for each kind of page.
