# Contributing to tablewalk

```bash
git clone <this repo> && cd tablewalk
npm install
npm run demo          # builds a sample SQLite database and opens the app
npm test              # tsc, oxlint, the client type/geometry checks, and the test suite
```

Node 24.22.1 or newer. tablewalk uses `node:sqlite`, which is built into Node — there
is no native module to compile and no install step that can fail on your
platform. `.node-version` names that minimum for nvm, fnm, mise and asdf.

---

## The constraints

These are not style preferences. Each one is load-bearing, and a change that
breaks one needs to argue for it rather than work around it.

### The user has no build step

`npx tablewalk mydb.sqlite` runs, and that is the whole deployment. The
maintainer's `npm run build` compiles the server with `tsc` and bundles the
client with Vite (`vite.config.ts`); the published package is that output.
Under `npm run dev` and every test suite the server serves `src/client` from
source through Vite's middleware (`packages/engine/src/server/devclient.ts`): edit a file,
reload, see it. Nothing is built before a test runs.

The client renders through React, with hand-written ES modules for its stores and behaviour, and it imports
`src/shared/*.ts` directly for the rules both sides need — what a row is
called, how a record's columns group, where one condition ends. Those used
to be copies, and the copies drifted; now there is one of each. **If a rule
has to hold on both sides, it lives in `src/shared` and the client imports
it.** What the client still reads on its own — the filter bar's chip splitter,
the composer's path walker, the export rewrite — is compared with the server
by outcome in `test/agreement.test.ts`.

### The query language never becomes SQL text

`parseQuery` produces a `Filter` — a structure — and the adapters turn that into
a parameterised statement. User input is never concatenated into SQL, anywhere,
by anyone. Values are bound; identifiers are quoted by the dialect and checked
against the introspected catalog first.

If you are adding a feature that seems to need string SQL, it does not. Extend
the `Filter` shape instead.

### Every read is bounded

There is no code path to the database without a `LIMIT`, including one that
forgot to ask for one. `clampLimit` is the only way limits are set and it has a
default and a maximum. A new endpoint that queries without going through it is a
bug even if nothing breaks today.

### Writes must prove they affect one row

The browsing connection is read-only for the life of the process; writes use a
separate handle opened lazily. An update takes the exact primary key, refuses to
edit a primary key, refuses views and keyless tables, refuses emptying a NOT NULL
column, and counts matching rows *before* writing to confirm there is exactly
one. Read `sqlite.ts`'s `update()` before changing any of it.

A guard in the browser is not a guard. The server does not trust the client's
write mode.

### Connection strings never leave the server

The browser is sent an id, a name, a dialect and a redacted detail. `redact()` in
`server/connections.ts` is the single function that produces that detail, and
there are tests asserting no password survives it. This is why the connection
editor cannot prefill the URL it is editing — a small awkwardness downstream of a
rule worth keeping.

tablewalk stores no secrets of its own. Passwords come from `${ENV}` expansion,
the OS keychain, or a credentials file at mode 600 that is refused if anyone else
can read it. **Do not add encryption**: a key sitting next to the ciphertext it
protects is obfuscation with extra steps.

### Requests from other pages are refused

Loopback binding keeps tablewalk off the network. It does not keep it away from
the browser — any page you have open can POST to a localhost port. `crossOriginRefusal()`
checks `Origin`, requires `Content-Type: application/json` so a cross-origin
request must preflight, and checks `Host` against loopback or the bound
interface for the DNS-rebinding case. If you add an endpoint that changes
something, it goes through that check.

---

## What good work looks like here

**Comments explain why, and what breaks otherwise.** Never what the line does.
The code says what it does. A comment earns its place by recording a decision, a
constraint, or a failure that motivated the shape:

```js
// The key is fetched whether or not it is shown.
//
// A summary drops the primary key on purpose — a column of ids says nothing
// about what distinguishes the rows. But the key is what a row click navigates
// by, and a row that arrives without one produces a link to
// `~invoice_line:invoice_id=undefined`: a dead end reached by clicking
// something that looked live.
```

**Errors teach.** They name what was wrong, in the user's terms, and say what to
do instead. `parseQuery`'s errors are the model — an unknown field suggests the
`show` clause; a dropped constraint says the section was left in place so it can
be removed or repointed.

**Report honestly.** "Nothing changed" is a real answer to "did my migration
land". A silent fallback that produces a plausible wrong result is worse than a
refusal that says why. When something is an estimate, the interface says so.

**Test the failure, not the feature.** The tests that matter here assert the
thing that actually went wrong: that a nonsense limit becomes the default rather
than `LIMIT NaN`; that a keyword inside a quoted value is not mistaken for a
clause; that a cross-origin POST is refused. When you fix a bug, write the test
that would have caught it, and check it fails before your fix.

---

## Before you open a pull request

```bash
npm test
```

That runs `tsc --noEmit`, then `oxlint` — whose `no-undef` catches a name
used and never imported, which in a client nothing executes until a browser
does is a runtime error nobody sees until that view is opened — then the
client's JSDoc type check and the zoom-ruler check, then the suite, then
the component tests (Vitest, in happy-dom — `src/client/components/*.test.tsx`).

If you changed anything visual, look at it. Several bugs in this repo's history
were invisible in the code and obvious in a screenshot: a literal `null` printed
under a table, two selection styles on one row, a placeholder wider than the
field holding it.

If you added an adapter, say plainly which invariants you could not uphold on
that engine rather than leaving it to be discovered.
