---
title: Languages
description: Say an App's captions in each reader's language from one catalog per language, with plurals, numbers and dates in ICU MessageFormat.
keywords: [language, languages, locale, translation, i18n, messages, msg, defineMessages, icu, messageformat, accept-language]
---

Say an App's captions in each reader's language from one catalog per language, with plurals, numbers and dates in ICU MessageFormat.

```ts title="examples/apps/foundry/messages/en.ts"
const en = defineMessages('en', {
  role: {
    curator: 'Curator',
    admin: 'Admin',
  },
  listing: {
    price: 'Price',
    originalPrice: 'Original price',
  },
});
export default en;
```

```ts
export default defineMessages<typeof en>('es', {
  role: { curator: 'Curador' },
  'listing.price': 'Precio', // nested groups and flat dotted keys can be mixed
});
```

`defineMessages` accepts flat dotted keys (`'people.name'`), nested groups (`{ people: { name: 'Name' } }`), or both; nested groups flatten to canonical dot keys at load time and refuse empty groups or colliding keys. Translations typed with `defineMessages<typeof en>('es', …)` accept either nested or flat keys against the source catalog (`examples/apps/foundry/messages/en.ts:9`).

A caption names a message where its text would go: `labels: { name: msg('people.name') }`, `related(msg('people.directReports'), …)`, `tab: msg('people.overview')`, a list's `tabs: [{ label: msg('people.toDo'), … }]`, `ui.site` (`brand`, `tagline`, `search`, `links`, `footer`), and a free-form page's `definePage({ label: msg('page.help.label'), description: msg('page.help.description'), … })`. Every caption a reader sees takes one: a view's or a dashboard's label and description, a section's title, a note's words, a headline's small print, a unit, a donut's total, a banner's eyebrow, an image's `alt`, a validation `message`, an action's label, an empty state, a form's labels and steps, a document's name, a nav group, the landing's words. A command's inputs take one too: `field.text({ label: msg('ticket.reason'), help: msg('ticket.reasonHelp') })`, an option's `label`, `help` and `icon`; the App API and MCP read them in the App's own words. The catalog in the App's own language (`ui.locale`) is the source: every key is in it, and another catalog translates some or all of its keys. A key a translation leaves out is said in the source's words.

A resource's `noun` takes a message with a plural, so a translation says it its own way: `noun: msg('people.person')` with `'{count, plural, one {person} other {people}}'`; the same for a fact's word, `{ column: 'reviews', after: msg('car.review') }`. An untitled `history()` says "History" in the reader's language without one.

A custom component or a `definePage` page says a message itself, in the reader's language (in both browser hydration and public SSR): `useMessage('help.title')`, `useMessage('help.results', { count })` from `@mistriwork/mistri/ui`. A key the catalog lacks is shown as the key itself rather than failing the page, so `mistri check` refuses a quoted key the source catalog does not have, or any quoted key in an App with no catalog (`component-message`); a key built from an expression is not followed.

## Whose language

The server says each caption before the browser sees it, in the nearest of:

1. the reader's own tag, read from their row: `ui: { locale: { column: 'person.locale', default: 'en-US' } }`;
2. their tenant's, where the App lets a tenant set it: `branding: { allow: ['locale'] }`;
3. on a public page or the sign-in screen, what the browser asks for (`Accept-Language`) among the App's catalogs, or a language picked in this browser or named in the address (`?locale=es`); a tenant App's visitor too, by its address (`?via=`) or its mapped host;
4. the App's own.

The tag is served as `ui.locale`, so numbers, money and dates are written the same way as the words. Addresses stay in the App's own words in every language: a tab is `?tab=overview` in Spanish too.

## Picking a language

Where the App has catalogs in more than one language, Preferences offers them. The pick goes to the reader's row when `ui.locale` names a column of the people table `auth.me` names; otherwise it is kept in this browser, per App, and read by the server as the reader's own choice. The framework's own words (menus, dialogs) follow: English is in the first page, and another language's are fetched only by a reader who reads it.

A public page (a form, a saved form, its status check, a capability link) whose App has catalogs in two languages or more draws a quiet switch at its foot, each language named in itself. A pick reloads the page with `?locale=` and keeps it in this browser, so the next visit opens in it too; a link may name the language itself, as `/<app>/forms/<form>?via=<tenant>&locale=es` does for a tenant's intake form. There is no `?lang=`, and nothing to declare: an App with one catalog draws no switch.

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

A command's form, a public form and its status check say a few words of their own around the App's: "Step 2 of 3", "Back", "(optional)", "Review your answers", "Submit", "Received", a refusal such as "Something with these details already exists.", "We sent a code by text message." An App's catalog says them in its own words under a `mistri.*` key, in the language it is written in:

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
| `mistri.form.continue` | Continue | |
| `mistri.form.optional` | (optional) | |
| `mistri.form.required` | (required) | |
| `mistri.form.reference` | Your reference | |
| `mistri.form.signAgain` | Sign again | |
| `mistri.form.yes` | Yes | |
| `mistri.form.no` | No | |
| `mistri.form.monthHint` | MM/YYYY | |
| `mistri.form.timeHint` | HH:MM | How a time of day is written after the date |
| `mistri.form.review` | Review | |
| `mistri.form.reviewTitle` | Review your answers | |
| `mistri.form.reviewLead` | Check each section. Change anything that is not right. | |
| `mistri.form.change` | Change | |
| `mistri.form.changeNamed` | Change {label} | `{label}` |
| `mistri.form.submit` | Submit | |
| `mistri.form.checkBox` | Check this box to continue. | |
| `mistri.form.notAccepted` | This answer was not accepted. Check it and try again. | |
| `mistri.receipt.received` | Received | |
| `mistri.receipt.keepReference` | Keep this reference. | |
| `mistri.receipt.another` | Fill in another | |
| `mistri.receipt.backTo` | Back to {name} | `{name}` |
| `mistri.refusal.unreachable` | The form could not be sent. Check your connection and try again. | |
| `mistri.refusal.failed` | The form could not be submitted ({status}). | `{status}` |
| `mistri.refusal.tooMany` | Too many submissions from this address. Try again in {retryAfter} seconds. | `{retryAfter}` |
| `mistri.refusal.invalidInput` | Some answers need another look. | |
| `mistri.refusal.version` | This form has changed since the page was opened. Reload the page to continue. | |
| `mistri.refusal.notFound` | What this form was about is no longer here. Reload the page to continue. | |
| `mistri.refusal.ineligible` | This can’t be sent as it stands. Check your answers and try again. | |
| `mistri.refusal.forbidden` | This form can’t be sent from this page. Reload it and try again. | |
| `mistri.refusal.keyReused` | This was already sent with different answers. Reload the page to start again. | |
| `mistri.refusal.duplicate` | Something with these details already exists. | |
| `mistri.refusal.stale` | Something changed while you were filling this in. Reload the page and try again. | |
| `mistri.refusal.cancelled` | It was not sent. | |
| `mistri.refusal.unavailable` | It could not be sent just now. Try again in a moment; it will not be sent twice. | |
| `mistri.refusal.locked` | Someone else is changing this record right now. Nothing was sent; try again in a moment. | |
| `mistri.status.offerEmail` | We can email a code to the address on this application. It opens its details once, for 10 minutes. | |
| `mistri.status.offerText` | We can send a code to the phone number on this application. It opens its details once, for 10 minutes. | |
| `mistri.status.askEmail` | Email me a code | |
| `mistri.status.askText` | Send me a code | |
| `mistri.status.sentEmail` | We sent a code to your email. | |
| `mistri.status.sentText` | We sent a code by text message. | |
| `mistri.status.codeEmail` | Code from the email | |
| `mistri.status.codeText` | Code from the message | |
| `mistri.status.sendAnother` | Send another code | |
| `mistri.status.signIn` | Sign in | |
| `mistri.status.moreDetails` | More details | |
| `mistri.status.showDetails` | Show details | |
| `mistri.status.confirmAccountEmail` | Confirm your account’s email with the link we sent you, and applications submitted with it are found here. | |
| `mistri.status.added` | Added to your account, submitted with your email: {linked}. | `{linked}` |
| `mistri.status.foundOne` | We found 1 application submitted with this email — is this yours? | |
| `mistri.status.foundMany` | We found {openCount} applications submitted with this email — are these yours? | `{openCount}` |
| `mistri.status.sayYesToOne` | Say yes only to one you made: it is added to your account, where its status is shown. | |
| `mistri.status.mine` | Yes, it’s mine | |
| `mistri.status.reference` | Reference | |
| `mistri.status.enter` | Enter your {label}. | `{label}` |
| `mistri.status.nowInAccount` | {reference} is now in your account. | `{reference}` |
| `mistri.status.title` | Check your application | |
| `mistri.status.lead` | {label}: enter the reference you were given and the details below. Only its status is shown. | `{label}` |
| `mistri.status.yours` | Your applications | |
| `mistri.status.check` | Check status | |
| `mistri.status.signInToFollow` | Sign in to add it to your account and follow it there. | |
| `mistri.status.addToAccount` | Add to my account | |
| `mistri.saved.notShown` | Saved — not shown for your privacy | |
| `mistri.saved.restarted` | This application can no longer be continued, so it has been started again from the first step. | |
| `mistri.saved.confirmEmail` | Confirm your email | |
| `mistri.saved.emailConfirmed` | {email} is confirmed. An account with this email will find your application. | `{email}` |
| `mistri.saved.confirmEmailOffer` | Optional. We email a code to your address; confirming it lets an account with this email find the application straight away. | |
| `mistri.saved.confirm` | Confirm | |
| `mistri.saved.saveStepFirst` | Save this step before you submit. | |
| `mistri.saved.follow` | Follow it in an account | |
| `mistri.saved.claimClosed` | This browser can no longer add the application to an account. | |
| `mistri.saved.claimWindow` | For the next 30 minutes, this browser can add the application to an account, where its status is shown. | |
| `mistri.saved.createAccount` | Create an account to track this | |
| `mistri.saved.signInToAdd` | Sign in to add it | |
| `mistri.saved.sharedDevice` | This is a shared device | |
| `mistri.saved.checkStatus` | Check its status | |
| `mistri.saved.anyTime` | any time with your reference. | |
| `mistri.saved.notSaved` | Not saved yet | |
| `mistri.saved.resumed` | Your application is saved. Carry on where you left off; what you saved is not shown again. | |
| `mistri.saved.eachStep` | Each step is saved as you go. We don’t show your details back to you; keep this tab open to review them before you submit. | |
| `mistri.saved.startOver` | Start over | |
| `mistri.saved.notSettled` | Your submission was sent and its result is not known yet. Submit again to find out how it ended. | |
| `mistri.saved.draftShort` | Your draft is saved. | |
| `mistri.saved.draft` | Your draft is saved. Carry on where you left off, or start over. | |
| `mistri.saved.earlier` | Saved earlier | |
| `mistri.saved.changedElsewhere` | This draft changed somewhere else. Review it again before you submit. | |
| `mistri.saved.reviewNotRead` | Your answers could not be read back for review. Submit again in a moment. | |
| `mistri.saved.reviewNotReady` | Your answers are still being read back for review. Submit again in a moment. | |
| `mistri.saved.checking` | Checking for an application in progress… | |
| `mistri.link.miss` | This link opens nothing. | |
| `mistri.link.confirmLead` | To see this, first confirm a detail only you would know. | |
| `mistri.link.continue` | Continue | |
| `mistri.link.offerEmail` | To see this, we email a code to the address on file. | |
| `mistri.link.offerText` | To see this, we send a code to the number on file. | |
| `mistri.link.askEmail` | Email me a code | |
| `mistri.link.askText` | Send me a code | |
| `mistri.link.sentEmail` | If the address on file takes mail, a code is on its way. It works for ten minutes. | |
| `mistri.link.sentText` | If the number on file takes messages, a code is on its way. It works for ten minutes. | |
| `mistri.link.code` | Code | |
| `mistri.link.choose` | Choose… | |
| `mistri.link.failed` | That did not work. Try again. | |
| `mistri.link.notNow` | This cannot be done now. | |
| `mistri.link.loading` | This page is still loading. Try again in a moment. | |
| `mistri.link.done` | Done. | |
| `mistri.language` | Language | |

Every sentence a public page says is one of these keys, the capability link's page (`mistri.link.*`) and the switch's name (`mistri.language`) included, and the platform ships Spanish for all of them: an App with a Spanish catalog shows a Spanish visitor the whole page in Spanish without writing one. The only exceptions are the two counted lines ("2 answers need another look"), which a single sentence cannot carry.

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
