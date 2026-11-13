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

A caption names a message where its text would go: `labels: { name: msg('people.name') }`, `related(msg('people.directReports'), …)`, `tab: msg('people.overview')`, a list's `tabs: [{ label: msg('people.toDo'), … }]`, a free-form page's `definePage({ label: msg('page.help.label'), description: msg('page.help.description'), … })`. Every caption a reader sees takes one: a view's or a dashboard's label and description, a section's title, a note's words, a headline's small print, a unit, a donut's total, a banner's eyebrow, an image's `alt`, a validation `message`, an action's label, an empty state, a form's labels and steps, a document's name, a nav group, the landing's words. A command's inputs take one too: `field.text({ label: msg('ticket.reason'), help: msg('ticket.reasonHelp') })`, an option's `label`, `help` and `icon`; the App API and MCP read them in the App's own words. The catalog in the App's own language (`ui.locale`) is the source: every key is in it, and another catalog translates some or all of its keys. A key a translation leaves out is said in the source's words.

A resource's `noun` takes a message with a plural, so a translation says it its own way: `noun: msg('people.person')` with `'{count, plural, one {person} other {people}}'`; the same for a fact's word, `{ column: 'reviews', after: msg('car.review') }`. An untitled `history()` says "History" in the reader's language without one.

A custom component or a `definePage` page says a message itself, in the reader's language: `useMessage('help.title')`, `useMessage('help.results', { count })` from `@mistriwork/mistri/ui`. A key the catalog lacks is shown as the key itself rather than failing the page, so `mistri check` refuses a quoted key the source catalog does not have, or any quoted key in an App with no catalog (`component-message`); a key built from an expression is not followed.

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

A kind of tenant may have its own words too: `ui.catalog: 'tenant.kind'` names a shared profile column, and `messages/clinic/en.ts` says the keys a tenant whose `kind` is `clinic` reads differently.

```ts
// messages/clinic/en.ts
export default defineMessages<typeof en>('en', { 'visit.visits': 'Appointments' });
```

A caption is said from the tenant's own rows, then the variant in the reader's language, then the App's catalog in it, then the variant's and the App's source. A value naming no folder reads the App's catalog. A variant says only keys the source has, in a language the App has a catalog for.

## The platform's words

A command's form, a public form and its status check say a few words of their own around the App's: "Step 2 of 3", "Back", "(optional)", "We sent a code by text message." An App's catalog says them in its own words under a `mistri.*` key, in the language it is written in:

```ts
export default defineMessages<typeof en>('es', {
  'mistri.form.step': 'Paso {step} de {count}',
  'mistri.form.back': 'Atrás',
  'mistri.form.optional': '(opcional)',
});
```

| Key | Said as | Reads |
| --- | --- | --- |
| `mistri.form.step` | Step {step} of {count} | `{step}`, `{count}` |
| `mistri.form.stepNamed` | Step {step} of {count}: {label} | `{step}`, `{count}`, `{label}` |
| `mistri.form.back` | Back | |
| `mistri.form.optional` | (optional) | |
| `mistri.form.required` | (required) | |
| `mistri.form.reference` | Your reference | |
| `mistri.form.signAgain` | Sign again | |
| `mistri.form.yes` | Yes | |
| `mistri.form.no` | No | |
| `mistri.form.monthHint` | MM/YYYY | |
| `mistri.form.dateTimeHint` | YYYY-MM-DD HH:MM | |
| `mistri.status.offerEmail` | We can email a code to the address on this application. It opens its details once, for 10 minutes. | |
| `mistri.status.offerText` | We can send a code to the phone number on this application. It opens its details once, for 10 minutes. | |
| `mistri.status.askEmail` | Email me a code | |
| `mistri.status.askText` | Send me a code | |
| `mistri.status.sentEmail` | We sent a code to your email. | |
| `mistri.status.sentText` | We sent a code by text message. | |
| `mistri.status.codeEmail` | Code from the email | |
| `mistri.status.codeText` | Code from the message | |

A key is chosen by the same reader's language as every caption, and said only where the catalog that has it is in that language; elsewhere the platform says its own word, in English or in the language its menus are fetched in. A key is optional and needs no entry in the source catalog, so an App that writes none changes nothing. Each is said as written: no plural, select, number or date, and only the arguments in its row. A tenant's own words may say them too.

## Translating

```sh
mistri messages extract --app . --locale fr   # messages/fr.ts gains each missing key as a comment
mistri messages extract --app .               # captions still written as text, with a key for each
```

With a locale, each key the catalog lacks is appended to `messages/<tag>.ts` as a comment holding the source's text, to translate and uncomment; the file is made if there is none. Without one, the captions the App still writes as literal text are listed with a key each could have. Neither rewrites the App's own source.

## Checks

`mistri check` refuses a catalog that does not parse (`message-syntax`), a key no catalog has or catalogs without the App's own language (`message-missing`), a translation reading an argument its source does not (`message-placeholder`), an argument bound to no column (`message-arg`), a `mistri.*` key that is not one of the platform's words or reads more than its row (`message-word`, naming the nearest key), and a `ui.catalog` that is no shared text column of the profile, or variant folders with no `ui.catalog` (`ui-catalog`). It advises on a catalog that translates only some keys (`message-untranslated`) and a key no `msg()` and no component's `useMessage` names, or that only a translation has (`message-unused`). See [Check codes](/docs/check-codes/).

## Related

- [Navigation and the shell](/docs/nav-and-shell/): captions a menu says.
- [Vocabularies](/docs/vocabularies/): the words a value is drawn with.
- [Check codes](/docs/check-codes/): the `message-*` codes.
- [Tenant Apps](/docs/tenant-apps/): a tenant's own words and locale.
