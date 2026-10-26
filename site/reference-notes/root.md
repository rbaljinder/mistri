Only `name` and `home` are required. `id` is the App's address and account
store, a slug of `name` by default (`Help Desk` → `help-desk`); set it before
accounts are created. `connection` names one configured connection, never a
URL; [sources](/docs/sources/) bind several instead.

## Home

```ts
home: 'tasks',
home: [{ view: 'welcome', signedOut: true }, { view: 'manager-desk', roles: ['manager', 'admin'] }, { view: 'portfolio' }],
```

A view id, or rules read in order on every request, first match wins:
`signedOut: true` (needs `auth`, names a public view), `roles`, and a last
rule with neither. A rule whose view the visitor cannot open gives way to the
next.

## Nav

```ts
import { navGroup } from '@mistriwork/mistri/app';

export const navigation = [
  navGroup('sales', 'Sales', ['sales-dashboard', 'leads', 'opportunities', 'accounts'], { icon: 'chart-line' }),
  navGroup('activity', 'Activity', ['tasks', { to: 'activities', label: 'Calls & meetings' }]),
];
```

Optional; without it there is no menu. An entry is a view id, `{ to, label }`,
a `navGroup(id, label, children, { icon?, placement?, inline? })` (nesting up to
eight deep) or a feature placement `{ feature: 'id' }`. A top-level group with
`inline: true` draws its items straight in the top bar as links, and stays a
section in the folded menu and the sidebar. Each list, dashboard, signed-in form or
room appears at most once; landings and public forms are refused. A list the
menu does not name is still served at its address and offered by ⌘K. Icons are
Phosphor names from a curated set, and a wrong one is refused with the nearest.
See [Navigation and shell](/docs/nav-and-shell/).

## Addresses

Every record, list, dashboard and form has one canonical address;
`mistri check --app <dir> --routes` prints them all. For a server serving
one App, at the root:

| What | Address |
| --- | --- |
| A list, with a tab, search, filter and sort | `/leads?tab=working&search=stone&source=referral&sort=-created_on` |
| A record, and one of its tabs | `/leads/127`, `/accounts/13/opportunities` |
| The New form | `/leads/new` |
| A dashboard's window, a section's own | `/sales-dashboard?period=last-30-days`, `?period.lines-moved-by-day=last-30-days` |
| A natural key, a public slug | `/label/bug`, `/vehicles/1-2024-toyota-corolla-le` |

A record is addressed through the first list showing its table among the
views the person reading is served: the resource's `view` where they are
served it, else the first plain list over it in menu order. A resident's
repair is `/my-requests/12` and the office's the same record at `/repairs/12`;
a mailed link is the recipient's own, and a signed-in person opening the
other's address is sent on to theirs. Several Apps on one
server each keep their id (`/lintel/leases/12`), and `--base-path /tools`
puts the whole server under a proxy's path. `new`, `api`, `assets`,
`sign-in`, `welcome` and `form` are reserved segments. A query-language
address still opens and is rewritten to the canonical one.

## Live

```ts
live: true,
resources: { audit_event: { live: false } },
```

Off unless the App asks. With `live: true` an open list, record or dashboard
reads again what another person's change touched, as it commits. Without it a
page refreshes on focus and after its own saves, and a dashboard reads every
section again each minute while its tab is shown, so one left on a wall still
moves. A resource's `live: false` keeps a hot or log-like table out: its writes
are not announced and its pages refresh as without live sync. The operator's
`--no-live` turns live sync off for every App whatever they say.

## Retention

```ts
retention: { history: '365 days', attempts: '14 days', commands: 'forever' },
```

How long the runtime keeps what it writes about the App as it runs: `history`
(who changed which record), `commands` (the command journal's receipts, audit
and events) and `attempts` (the finished tries of jobs and webhook
deliveries). Each is a duration in the App's one spelling (`'30 days'`,
`'12 weeks'`; there is no month or year) or `'forever'`. Left out, history and
commands keep `'730 days'` and attempts `'30 days'`. A daily job forgets what is
older, a few thousand rows at a time; a try still pending or waiting for a
redrive is never forgotten, however old.
