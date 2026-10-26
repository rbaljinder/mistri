# Thread · Tenant notes

Opt-in private checked TypeScript DSL fixture, App ID `tenant-thread-notes`.
Load this directory through genuine `loadApp`. The parent tenant proof remains
its own entry point.

It is the parent App with live sync on, and a discussion page that two people
in one tenant both change and write on: `renameDiscussion` sets its name and
status, its comments are a timeline whose composer sends `addNote`, and the
page shows the record's history. The host (`test/support/tenantProofFixture.ts`,
`notes`) provisions live sync's change store and record history, and hands the
App `addNote` and `renameDiscussion` beside `addDiscussion`.
