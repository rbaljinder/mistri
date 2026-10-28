# tablewalk component library (Storybook)

The components under `../src/client/components`, drawn one at a time in
each built-in look, light and dark, with no server behind them.

This is a package of its own on purpose. The `tablewalk` package, its
lockfile, and everything `npx tablewalk` installs never mention Storybook.
Storybook's peers (React, react-dom, Vite, TypeScript) are not installed
here either (`.npmrc`: `legacy-peer-deps`). They resolve upward to the
repository root's copies, so a story runs on the same single React as the
App.

```sh
npm install            # in the repository root first, then here
cd storybook && npm install
npm run dev            # http://localhost:6006
npm run build          # writes ../site/dist/components; `npm run build:site` runs it
```

## How a story gets its data

Every import of `packages/kit/src/client/core.js` resolves to `mocks/core.js`, which is
the real module with `api` answered by fixtures. A story registers its
tables and answers in `beforeEach`:

```ts
beforeEach: () => {
  fixture({ tables: [task], answer: { '/api/run': () => ({ rows, columns }) } });
},
```

The module rules (`./thing.js` may name `./thing.ts`) are read from the
root `vite.config.ts`, so a story resolves imports exactly as the App does.

## Reviewing shared components

Use the Look and Mode toolbar controls to review each component in the built-in
themes and light/dark modes. Resize the preview to a phone width as well as a
desktop width; wide tables should scroll inside their container.

`Primitives` holds the Button (every intent, size and state) and the Field
(every control at rest, with a hint, with a problem, disabled and compact) that
the forms below are built from; `Accounts/Sign in` walks the sign-in screen
through its errors, busy state, providers, sign-up, invitation and password
reset. `Forms/Controls` covers inputs, a dropdown, a calendar and a typeahead, including
disabled, invalid and dialog contexts. `Forms/Complete form` exercises the real
submission surface, long copy and a server refusal. `Layouts/Content` composes
the shared cards, table, mobile record summaries and main/context layout, with
empty, loading and unavailable states. `Dashboards/Guidance` checks explanatory
copy at normal and narrow measures.

These stories complement the running sample Apps. A story rendering successfully
does not establish keyboard, screen-reader or complete workflow acceptance.

`Navigation/App menus` renders the actual sidebar and top navigation, including
nested phone menus and a sidebar/main-content composition. `Records/Complete page`
loads the real record renderer through fixture API responses: profile, tabs,
context column, long values and unavailable data. `Forms/Command fields` covers
shared validation and repeating groups. The complete-form stories include a guided
request with preserved drafts and a slow submission.

Run checks from this directory while the development Storybook is running:

```sh
npm run typecheck
npm run review
npm run test:interactions
```

The review script captures every story in Workshop, Lumen and Sage at desktop and phone
widths, each in both light and dark mode. It checks theme application, render errors and document overflow, and
writes screenshots and JSON under the ignored `.artifacts/` directory. Set
`STORYBOOK_LOOKS=workshop,lumen,mono,sage` for every look,
`STORYBOOK_FILTER=records-` for a focused pass, or `STORYBOOK_URL` for another
running preview. Interaction checks exercise keyboard navigation, nested popups,
form validation, Back, submission, refusal and draft retention.

Fixtures reset App state between stories. Query caches persist while a story's
toolbar changes and reset when selecting a different story, so theme review does
not replace the data cache on every render. Menu selections stay inside Storybook.

`Lists/Work collections` covers board lanes, a checklist and split details.
`Dialogs/Questions` exercises text, note, date, range and confirmation dialogs;
`Values/Field display` covers status tones, progress, large identifiers and long names.

`Records/Sections` isolates counting metrics, grouped counts and activity timelines,
including missing references and empty activity.

`Records/Related collections` renders ordinary related lists through the real
page section: desktop tables, phone record summaries, authored empty guidance
and a missing parent reference. Navigation keys stay out of the visible facts.

`Rooms/List` and `Rooms/Record` draw the App's real content pane inside its
frame (`stories/appShell.tsx`): the top bar, the side menu and the one `<main>`,
which under 900px become the bar's Menu and its drawer, as in the App. The list
room shows its crumb-bar title, New and Export, tabs, search, `+` filters,
chips, Sort, the grid with its pager, a selection and a row's menu, and a
refinement nothing matches; the record shows its head's toolbar and More. Both
fail the ways a room fails (403, a stopped server, a record that is gone).
`Lists/Filter rail` is the rail beside a real list, and its sheet on a phone.
`Forms/Open popovers` opens a Select, a typeahead, the date picker, a menu and
the palette; `Dashboards/Stat cards` is the metric strip; `Feedback/Surfaces`
holds the toasts, the photo viewer and Preferences. A story that is about a
state reaches it in its play function (a refusal, a slow submission, an open
dialog or menu), so a capture shows the state and not the page before it. The
fixtures these share are `stories/taskFixture.ts`.

The Accessibility panel (`@storybook/addon-a11y`) runs axe on each story and
reports what it finds without failing the story; the browser gate's axe run over
the App's real rooms is what fails a build.

