---
title: Languages
description: Say an App's captions in each reader's language from one catalog per language, with plurals, numbers and dates in ICU MessageFormat.
keywords: [language, languages, locale, translation, i18n, messages, msg, defineMessages, icu, messageformat, accept-language]
---

Say an App's captions in each reader's language from one catalog per language, with plurals, numbers and dates in ICU MessageFormat.

```ts
const en = defineMessages('en', {
  'people.people': 'People',
  'people.name': 'Name',
  // …
});
export default en;
```
<!-- no sample: no shipped App ships a catalog -->

```ts
export default defineMessages<typeof en>('es', {
  'people.people': 'Personas',
  'people.name': 'Nombre',
  // …
});
```

A caption names a message where its text would go: `labels: { name: msg('people.name') }`, `related(msg('people.directReports'), …)`, `tab: msg('people.overview')`, a list's `tabs: [{ label: msg('people.toDo'), … }]`, a free-form page's `definePage({ label: msg('page.help.label'), description: msg('page.help.description'), … })`. Every caption a reader sees takes one: a view's or a dashboard's label and description, a section's title, a note's words, a headline's small print, a unit, a donut's total, a banner's eyebrow, an image's `alt`, a validation `message`, an action's label, an empty state, a form's labels and steps, a document's name, a nav group, the landing's words. A command's inputs are the exception: their labels are written in `defineCommand`, which the App API and MCP read too. The catalog in the App's own language (`ui.locale`) is the source: every key is in it, and another catalog translates some or all of its keys. A key a translation leaves out is said in the source's words.

A resource's `noun` takes a message with a plural, so a translation says it its own way: `noun: msg('people.person')` with `'{count, plural, one {person} other {people}}'`; the same for a fact's word, `{ column: 'reviews', after: msg('car.review') }`. An untitled `history()` says "History" in the reader's language without one.

A custom component or a `definePage` page says a message itself, in the reader's language: `useMessage('help.title')`, `useMessage('help.results', { count })` from `@mistriwork/mistri/ui`.

## Whose language

The server says each caption before the browser sees it, in the nearest of:

1. the reader's own tag, read from their row: `ui: { locale: { column: 'person.locale', default: 'en-US' } }`;
2. their tenant's, where the App lets a tenant set it: `branding: { allow: ['locale'] }`;
3. on a public page or the sign-in screen, what the browser asks for (`Accept-Language`) among the App's catalogs, or a language picked in this browser; a tenant App's visitor too, by its address (`?via=`) or its mapped host;
4. the App's own.

The tag is served as `ui.locale`, so numbers, money and dates are written the same way as the words. Addresses stay in the App's own words in every language: a tab is `?tab=overview` in Spanish too.

## Picking a language

Where the App has catalogs in more than one language, Preferences offers them. The pick goes to the reader's row when `ui.locale` names a column of the people table `auth.me` names; otherwise it is kept in this browser, per App, and read by the server as the reader's own choice. The framework's own words (menus, dialogs) follow: English is in the first page, and another language's are fetched only by a reader who reads it.

## Arguments

```ts
recordLabel: msg('ticket.name', { number: 'id' }),           // 'Ticket {number}'
notify: [{ on: 'insert', to: 'assignee_id.email', title: msg('ticket.assigned', { title: 'title' }) }],
```

`args` binds each ICU argument to a column path; a bare `{status}` reads the record's own column, and `{count}`, `{message}` and `{to}` are the framework's. A notice is said in each recipient's language, and its email with it. An action's label may count the records it takes: `label: msg('timesheet.approve')` with `'Approve {count, plural, one {# timesheet} other {# timesheets}}'` is said for one record on its page and for the whole selection in a list.

## A tenant's own words

```ts
ui: {
  messages: fromRecord('tenant_message', {
    by: 'tenant',
    tenantField: 'tenant_id',
    fields: { key: 'key', locale: 'locale', text: 'text' },
  }),
},
```

A row says one key in one language over the App's catalog, for that tenant only. A row is checked as it is written (a key the source has, a language tag, ICU text that reads only the source's arguments) and skipped as it is read if it no longer fits.

## Translating

```sh
mistri messages extract --app . --locale fr   # messages/fr.ts gains each missing key as a comment
mistri messages extract --app .               # captions still written as text, with a key for each
```

With a locale, each key the catalog lacks is appended to `messages/<tag>.ts` as a comment holding the source's text, to translate and uncomment; the file is made if there is none. Without one, the captions the App still writes as literal text are listed with a key each could have. Neither rewrites the App's own source.

## Checks

`mistri check` refuses a catalog that does not parse (`message-syntax`), a key no catalog has or catalogs without the App's own language (`message-missing`), a translation reading an argument its source does not (`message-placeholder`) and an argument bound to no column (`message-arg`). It advises on a catalog that translates only some keys (`message-untranslated`) and a key only a translation has (`message-unused`). See [Check codes](/docs/check-codes/).

## Related

- [Navigation and the shell](/docs/nav-and-shell/): captions a menu says.
- [Vocabularies](/docs/vocabularies/): the words a value is drawn with.
- [Check codes](/docs/check-codes/): the `message-*` codes.
- [Tenant Apps](/docs/tenant-apps/): a tenant's own words and locale.
