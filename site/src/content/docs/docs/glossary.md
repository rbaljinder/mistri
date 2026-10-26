---
title: Glossary
description: The words this documentation uses, one line each, with the page that explains each one.
keywords: [terms, vocabulary, definitions, words]
---

The words this documentation uses, one line each, with the page that explains
each one.

- **[mistri](/docs/getting-started/)**: the App framework, and the `npx @mistriwork/mistri` command that serves, checks and builds an App.
- **[tablewalk](/docs/database-browser/)**: the database browser, a product of its own; it serves no App.
- **[App](/docs/quickstart-app/)**: a database's workspace, written in the TypeScript DSL and run from its source directory.
- **[Workbench](/docs/database-browser/)**: tablewalk's tools for one database (rows, schema, diagram); an App never serves it.
- **[Resource](/docs/access-model/)**: a table an App serves, with its access, display and form rules.
- **[View](/docs/dsl-views/)**: anything a visitor opens by address: a list, a dashboard, a landing, a form or a room.
- **[Page](/docs/pages/)**: a record page: the sections that show one record.
- **[Section](/docs/dsl-pages/)**: one block of a page or dashboard.
- **[Feature](/docs/dsl-features/)**: a bundle of resources, views, pages and grants an App merges in as one unit.
- **[Look](/docs/looks/)**: a built-in visual theme for an App.
- **[Walk](/docs/database-browser/)**: following a link from one record or table to the next; the path taken.
- **[Source](/docs/sources/)**: a connection an App reads, a database or an HTTP service.
- **[Role](/docs/roles/)**: a named set of grants a signed-in account holds.
- **[Grant](/docs/roles/)**: what a role may read, write or run.
- **[Realm](/docs/tenant-apps/)**: whose rows a role works in: tenant, platform or global.
- **[Tenant](/docs/tenant-apps/)**: one customer's slice of the data under `auth.rows: 'tenant'`.
- **[Public](/docs/landing-pages/)**: what a signed-out visitor may read or send.
- **[Action](/docs/actions/)**: a button on a record or row that edits it or runs a command.
- **[Command](/docs/commands/)**: a typed, named server operation that checks, writes and returns a receipt.
- **[Receipt](/docs/commands/)**: the stored outcome of a command run, so a retry returns it again.
- **[Journal](/docs/events-and-jobs/)**: the store that records command runs, receipts and their events.
- **[Event](/docs/events-and-jobs/)**: a fact a committed command publishes for jobs, workflows and webhooks.
- **[Job](/docs/events-and-jobs/)**: background work that reacts to an event or a schedule.
- **[Workflow](/docs/events-and-jobs/)**: a durable, multi-step process with waits and retries.
- **[Envelope](/docs/commands/)**: the standard wrapper around the body a command's webhook posts; `envelope: false` sends your own shape.
- **[Segment](/docs/segments/)**: a query named once on a resource and used by name in tabs, metrics and the API.
- **[Decision](/docs/decisions/)**: one field of a record a model answers, offered as a suggestion until it has earned applying itself.
- **[Live sync](/docs/live-sync/)**: open pages following what other people change, without a reload.
- **[Rollup](/docs/dsl-resources/#rollups)**: a count, sum, min or max over a record's related rows, or a column of the newest of them (`latest`).
- **[Computed column](/docs/dsl-resources/#computed-columns)**: a column worked out from the record's own, never stored.
- **[Machine](/docs/actions/)**: the states and transitions a record moves through.
- **[Presentation](/docs/lists/)**: how a list or section draws its rows: a board, a calendar, cards.
- **[Display rule](/docs/vocabularies/)**: how a column's values are said: money, units, words and tones.
- **[Component](/docs/custom-components/)**: a custom React piece an App adds beside the built-in ones.
- **[Suite](/docs/suites/)**: several Apps served together with one sign-in.
- **[Console](/docs/suites/)**: the opt-in suite App that manages flags and experiments.
- **[Flag](/docs/dsl-flags/#feature-flags)**: a typed switch an App reads to present or gate something.
- **[Experiment](/docs/experiments/)**: a flag with variants, exposures and measured results.
- **[Preview](/docs/status/)**: a feature whose shape may change in any release; the compatibility promise excludes it.
- **[Check](/docs/check-codes/)**: `mistri check`, which types, validates and lints an App against its database.
- **[Authority lock](/docs/dsl-features/#the-authority-lock)**: `authority.lock`, every grant, ceiling and binding the App holds, one line each, which a change must rewrite.
- **[Migration](/docs/change-your-schema/)**: a versioned SQL file `mistri migrate` applies, in Flyway's format.
- **[Store](/docs/change-your-schema/)**: one of mistri's own tables for sign-in, history, journal, flags or jobs.
- **[Epoch](/docs/change-your-schema/)**: a numbered layout of a store; `migrate stores` moves it forward.

## Related

- [The DSL in one App](/docs/dsl-tour/): most of these words, in one sample App.
- [DSL reference](/docs/app-dsl/): every key, generated from the schema.
- [Status & roadmap](/docs/status/): which features are Stable and which are Preview.
