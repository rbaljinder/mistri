---
title: Compatibility
description: What Stable and Preview mean at 1.0, what the promise covers, and what may change in a 1.x release.
keywords: [compatibility, stable, preview, deprecation, 1.0, breaking change]
---

What Stable and Preview mean at 1.0, what the promise covers, and what may change in a 1.x release.

From 1.0.0 an App written against 1.0 keeps working, unchanged, until 2.0. Until
then mistri keeps no compatibility: a 0.x release may rename or remove anything,
and the changelog says what moved.

## Stable

**Stable**: the documented shape holds, and a change is named in the changelog.
A change to any of these is breaking, and does not happen before 2.0:

- The App DSL: every non-preview key, helper and accepted value. A key may be
  added; its meaning, accepted values and default may not change.
- The `@mistriwork/mistri/*` exports and their documented types, except the Preview names listed below.
- The command line: commands, flags and the exit codes `mistri check` and the
  other commands document.
- The HTTP and App API: routes, request and response shapes, error codes and a
  command's contract and receipts.
- MCP tools: name, arguments, result shape and read-only or writing annotation.
- The canonical App addresses.
- The published schemas under `schema/`, including the `check` codes.
- The layouts of mistri's own stores. A new layout is a new version that
  `mistri migrate stores up` moves forward; serving never migrates.

Adding a key, a command, a flag, a tool, a route or an optional field is not
breaking.

## Supported environment

Node 24.22.1 or newer (every package's `engines`; CI runs Node 24). Optional peers
are bounded to the majors mistri supports: TypeScript 7 (`>=7 <8`),
React 19, Next.js 14.1 to 16, React Router 6.4 to 7, and TanStack Router 1.
A new major of a peer is a mistri release's work to support, not a range you
widen yourself.

## Preview

A **Preview** feature works as documented and is enforced on the server, but its
shape may change, or it may go, in any release. It is outside the promise until
a release promotes it, and promotion is one-way. `mistri check` lists the
Preview features an App uses, as information.

At 1.0 these stay Preview:

- Feature flags, audiences and `@mistriwork/mistri/openfeature`.
- Experiments.
- The Suite Console.
- Behavior analytics.
- SCIM provisioning.
- The Gantt presentation.
- A resource's `search` (its packs ship after 1.0).
- An installable PWA (`ui.pwa`).
- `@mistriwork/ui`, the React primitives.
- `mistri deploy` and `@mistriwork/cloudflare`.
- `roundTrips` in `@mistriwork/mistri/testing`.

A feature added in a 1.x release may ship as Preview too. The
[status page](/docs/status/) marks each one in its tables.

## What may change in 1.x

- **Preview features**, above.
- **Internals**: anything a package export does not name, the client's modules,
  CSS class names and the DOM they draw.
- **Behavior no document states**: the order of unordered results, log and error
  wording, the SQL a read issues and timing.
- **The assistant's default model.** A minor release may move it to a successor
  as the provider retires models; an App that must keep one names it in `model`.
- **Tooling around mistri**: the desktop app has its own version, and the sample
  Apps are not starters.

## Deprecation

A feature leaves in two steps. A minor release marks it deprecated: it keeps
working, and `mistri check` and startup print a `deprecated` warning naming its
replacement. It is removed no sooner than the next major version. A security fix
may be the exception, and the changelog says so.

## Related

- [Status & roadmap](/docs/status/): which features are Stable and which are Preview.
- [Changelog](/docs/changelog/): each release's full list.
