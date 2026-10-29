```ts
ui: {
  logo: 'buildings',
  shell: { placement: 'side', width: 'wide' },
  theme: { preset: 'sage' },
  editing: { save: 'blur' },
  locale: 'en-US', timezone: 'America/New_York',
  footer: { text: 'Prices exclude tax.', links: [{ label: 'Terms', href: 'https://example.com/terms' }] },
},
```

`logo` is an App icon, never an image URL. `theme.preset` is one of the
built-in looks (`workshop` by default, `lumen`, `mono`, `sage`, `ledger`) or one registered with
`defineTheme`; `accent`, `radius` and `font`
adjust it. `currency` is US dollars unless the App says otherwise, and a money
rule names its own only for a column in another. See [Looks](/docs/looks/)
and [Navigation and shell](/docs/nav-and-shell/).

`timezone` may instead be read per reader: `timezone: { column:
'desk_setting.timezone', default: 'America/New_York' }` counts each reader's
today and windows in the zone the first row of that column they may read
names — their tenant's, their account's. Writes keep `default`.

`locale` is also the App's own language, the one its `messages/` catalogs are
written from, and may be read per reader the same way: `locale: { column:
'person.locale', default: 'en-US' }`. A tenant's tag (`branding.allow:
['locale']`) comes before `default`. `messages: fromRecord('tenant_message',
{ by: 'tenant', tenantField, fields: { key, locale, text } })` keeps a
tenant's own words over the catalogs. See [Languages](/docs/languages/).
