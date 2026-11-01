# Changelog

Releases are tagged `v<version>`. The App framework is published to npm as
`@mistriwork/mistri` and the database browser as `tablewalk`, with the layers
beneath them as `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui`. The
desktop app has its own version in `desktop/package.json`.

## 1.0.0-rc.9

- **`@mistriwork/ui`'s API is one name per thing.** The `Control`/`Layer`/`Disc`/`Sheet` spellings (`SwitchControl`,
  `TabsControl`, `PopoverLayer`, `AvatarDisc`, `CarouselControl`, `ResizablePanels`, `ScrollAreaControl`,
  `TooltipLayer`, `DrawerSheet`) are gone; use `Switch`, `Tabs`, `Popover`, `Avatar`, `Carousel`, `Resizable`,
  `ScrollArea`, `Tooltip`, `Drawer`. The helpers (`anchor`, `ruler`, `popups`, `datePickerModel`,
  `ComponentStyleScope`) moved under `@mistriwork/ui/internal/` and are not API; `./masks.js` is reached from `@mistriwork/ui`.
  `Modal` and `DropMenu` no longer need CSS class names (`className`, `popupClassName` are optional with the
  package's own defaults). `Field` takes one `optional` prop (the word shown beside the label), replacing
  `optionalMark` and `optionalWord`, and `FieldFrame` uses the same name. A name no one sees is `ariaLabel` on every
  primitive (`Modal`'s `aria-label`, and `label` on Tabs, Popover, Carousel, Resizable, ScrollArea and Pagination,
  changed), and Carousel, Resizable and Pagination take a `words` object instead of hard-coded English.
  `Avatar` initials split by grapheme, `Tooltip` keeps a trigger's own `aria-describedby`, `Drawer` requires a
  `title` or `ariaLabel`, and `Tabs` opens on its first enabled tab.
- **Client fixes from the rc.8 review.** A link with a broken percent escape (`/%zz/leads`) opens the page it names
  instead of throwing. Resizing a column in a `sizing: 'scroll'` grid no longer collapses the others or jumps, and
  cancelling leaves the grid as it was. The carousel's arrow keys act only on the carousel and its own controls, and the
  column-arrange buttons add no tab stops (Alt+Arrow on the head still moves a column). The command palette badge
  says a Page, View, Table, Action and so on from the entry's kind, not from an English group name. A multi-series line
  chart that would drop months at the 20-row cap is refused with the real limit. A signed-in command form shows the
  command's own message after it runs, not a generic "Received". Opening a field for inline edit no longer moves the
  page 4px (8px on the record's name). The sign-in error has its own reserved line above the button, so the card does
  not jump. Tick's New form drops the empty section gap and no longer asks for "Completed" on a new task. The
  Workbench record page has no band of page ground under its panels. A record id that matches nothing says so
  ("No invoice row has the id 99999") and draws no actions or related rail. `total >> 5` reports the stray operator,
  not a missing quote. A select whose label is a question or a sentence reads "Choose one" rather than "Choose what
  would you like to know?". The Workbench `···` menu hides "Undo the last edit" until there is something to undo, and
  its hints keep a gap from the label.
- **A read-only connection can no longer be written through raw SQL.** On PostgreSQL, a statement written to stack
  `COMMIT; BEGIN READ WRITE; DELETE …` behind a name like `x$$` or a string like `E'\''` got past the one-statement
  check, and node-postgres sent it on the simple protocol, which ran every statement: the `sql` and `explain` tools
  and the SQL editor deleted rows on a connection that was not `"writable": true`, wherever the role could write. User
  SQL now goes on the extended protocol, where PostgreSQL itself refuses a second statement, and the check reads
  dollar signs in names, E'' strings and nested comments as PostgreSQL does. On SQLite, `VACUUM INTO` (which wrote a
  full copy of the database to a path of the caller's choosing) and `ATTACH`/`DETACH` are refused on the read-only
  path.
- **A tenant App keeps saving after a thousand people have.** Each writer's history partition was kept for the life of
  the process, and the 1,025th distinct writer (or role or membership change) was refused every save until a restart.
  The partition used longest ago and idle now makes room; a save is refused only while all 1,024 are in use.
- **A workflow whose end cannot be recorded no longer ends the process.** A dropped connection or failover while
  an advance wrote its end was an unhandled rejection, which terminated the server, and the advance never returned.
  The advance is now aborted, and the host retries it.
- **One database hiccup no longer stops background work for good.** A failover or dropped connection while the job
  runner or an event publisher polled for work halted it until a restart, though nothing had been claimed or sent:
  jobs, timers, workflow wake-ups and event delivery stopped while the web side kept serving. That cycle now reports
  unavailable and the next poll tries again; a halt is kept for an outcome in doubt, such as a lost acknowledgement.
- **A big number typed into a form is stored as typed.** A bigint past 2^53 (an id, a foreign key) went through
  `Number()` on every insert and update and was written as its neighbor, pointing at a different row, and a numeric
  wider than fifteen digits was rounded. Only a number a double holds exactly is converted now; the rest goes to the
  database as text, as do `0x1A` and `1e3`, which `Number()` read as 26 and 1000. `interval` and `point` columns are
  no longer treated as numbers.
- **Sign-in and OAuth state can no longer be flushed out by a flood.** The OAuth server's authorize, consent and token
  doors are budgeted per address, and its pending requests live in their own bounded store, so sixty thousand
  unauthenticated `authorize` calls no longer evict a lockout counter or a sign-in in progress.
- **Accounts, embedding and logout fail closed.** The last active administrator cannot be demoted or deactivated (two
  administrators acting at once included). An embed session's roles are stored with its mark and an unreadable record
  ends the session instead of guessing. A back-channel logout whose deletion fails releases its token id so the retry
  is not refused as a replay.
- **A credential file that cannot be read is no longer overwritten.** `writeCredential` refuses a corrupt or
  group-readable file, writes through a temporary file and a rename, and the macOS keychain write no longer passes the
  secret on a command line. `tablewalk` opens the Windows browser without a shell.
- **A search document is removed from the right tenant only.** A tenant App's index removal carries the tenant, so two
  tenants sharing an id no longer lose each other's document; a removal whose tenant is unknown is skipped. The
  PostgreSQL search pack refuses a collection name too long for its table names instead of colliding.
- **The assistant keeps a conversation whose retry is refused**, and the Postgres maintenance and migration clients no
  longer hang on a dead connection or wait forever for the advisory lock.
- **MCP deletes always ask the person.** With an elicitation-capable client, `delete` and `delete_graph` ask every
  time and ignore a `confirm: true` the model supplies; `confirm` is the fallback only when the client cannot ask.
  Graph writes are not journaled: no `undoId`, and `revert` cannot undo them (said in the tool descriptions and docs).
- **Faster under load.** Sitemaps are cached for five minutes (`MISTRI_SITEMAP_CACHE_SECONDS`, 0 disables), forty
  visitors asking one uncached picture size make it once, JSON over 32 KB is compressed off the event loop, the effect
  host backs off when idle, the live hub stops asking the primary for its log position when no replica is named, and a
  live stream re-verifies its authority every 30 seconds, not every 60. A busy tenant context answers `429` with
  `Retry-After`.
- **One body reader, a tidier public surface.** Mail, MCP-over-HTTP, inbound and embed bodies share the engine's
  bounded reader (and the embed exchange sends `nosniff`). `inspectFunnel`, `FunnelResult` and `AnalyticsLocation` are
  marked Preview, the `StoreTarget` alias is gone (`MaintenanceTarget`), `/testing` exports named names rather than
  `export *`, and an experiment epoch with a `segments` key is refused ("name an audience").
- **Docs say what is true.** The Preview list in the compatibility page includes `ui.pwa`, `@mistriwork/ui`, `mistri
  deploy` and `roundTrips`; versions are gone from the status page and the npm README; the Tick Compose section names
  `mistri-tick` and `MISTRI_ALLOWED_HOSTS`; the never-emitted `app-on-mysql` code is removed; `SECURITY.md` states the
  24-hour public picture cache and how to purge it.

## 1.0.0-rc.8

- **The remainder of the showcase review lands as code.** `@mistriwork/ui` gains four more standalone Preview primitives (Carousel, Resizable, ScrollArea, Tooltip) with tests and Storybook stories, and the kit files that lacked dedicated tests gain them; a line chart's points drill like a donut's slices (single-series lines only, gap-filled buckets are not doors, and a drillable point's hit disc is 12px, not 44px, so grade's `small-target` may warn on phone windows); `grade` gains a `double-scroll` error for a room with two vertical scroll containers and the scrollbar policy is stated in docs (one scroll container per room, lists paginate, drawers/modals scroll internally with focus trapped); the signed-out home no longer probes `/api/landing` when whoami already names the landing view, so the 401 on a form home is gone (the signed-in shell's probe and its 404 residual remain); search gains a SQLite FTS5 pack (`@mistriwork/search-sqlite`, private, unpublished until after 1.0) beside the Typesense pack, while a Postgres-backed provider is still not shipped for want of a live-Postgres run; an App opts into being an installable PWA (`ui.pwa`, Preview) with a generated manifest, worker, painted icons and offline page — installable plus shell-offline, not offline data; and the Atelier showcase theme is reworked to one persimmon accent, raised dark-mode sidebar contrast, and multi-colour colour-blind-safe chart palettes, with an icon on every view, Messages out of MONEY, and Studio wall in a footer group.
- **`mistri new --brief` stubs fail closed.** A generated command whose refusals are still TODO lines refuses ("… is not ready: its rules are not written yet.") until the guard beside them is deleted, so a scaffold run before its rules are written cannot make the change they were meant to stop.
- **Smaller faults an assessment found, fixed.** Opening another database in the desktop app no longer quits it (each
  server child is retired on its own, a startup is bound by one deadline that aborts a hung request and stops the
  child, and a link leaves the window only as `http`, `https`, `mailto` or `tel`); a share card whose title and site
  the face cannot draw is not made, so the page keeps its default picture instead of a blank card; compressed JSON
  replies honor `Accept-Encoding` weights; `forwardEmail` rejects or throws on every refusal instead of finishing as
  if the mail were forwarded (a 2xx and a replay are done; 404, 413, 400 and 422 reject; 401, 403, 429 and 5xx throw);
  MCP over HTTP holds at most 32 requests at once like the read and command transports; and the migration baseline
  test passes under a restrictive umask.
- **`mistri test init` seeds a row that satisfies the schema.** A table whose NOT NULL column references a table with no
  rows seeded a row without it, and the generated permissions test failed on the constraint at once. The referenced
  table's row is now seeded first, through any chain of required references, and the row takes its stored key; a
  required cycle is said in the generated file as a seed to write by hand. The suite also says "an invoice record".
- **A client that retries a busy server at once no longer crowds out everyone else.** At `--read-pool 1`, a few
  accounts answering every 503 `server_busy` by asking again, `Retry-After` unread, kept the pool's queue full: other
  accounts' requests were refused on arrival, and the ones let in waited behind the storm until they timed out, so a
  live load test saw useful work collapse. The driver's queue made it worse, because it cannot withdraw a request, so
  every request that gave up still took its turn later. The queue is now the server's own, per pool, shared across
  accounts (the signed-in account, or a signed-out client's address as `--trust-proxy` reads it). Connections go to
  each waiting account in turn, and one person's requests keep their order. One account may hold at most half the
  queue, and past that it is refused at once with `Retry-After`. A full queue gives a quieter account's request the
  place of the busiest account's newest. The two-second and 64-per-connection bounds are unchanged, and a write
  refused here is still `not_applied`.
- **Sorting a list answers inside its budget.** A sort on Compass's list at a desk took 112 ms to paint against a 100 ms
  budget; it now takes 88. Every paint asked the list's tabs for their whole questions again (the list, its crumb, the
  room, the address writer and the top bar each did), and the top bar drew every group's menu again on every walk tick
  though what it lights had not moved. A view's questions are now read once per view while the schema and the App
  stand, and the top bar is drawn again only when what it lights, or the schema under it, changes. A record page at
  1100px and below no longer asks `:has()` of its whole layout to know whether a headline or card leads the aside:
  the page says so from its definition (`data-leads`), so a row added or removed anywhere no longer restyles the page.
  Opening a dialog on a phone went from 64 ms to 40, typing in a list's search from 160 to 144.
- **A file preview reads only what it shows, and a landing is not footed twice.** A text preview read the whole file to
  show its first 256 KiB; it now stops the transfer at that prefix and says so. A recording or a PDF is held to
  64 MiB by the bytes that arrive, so a missing or wrong `Content-Length` no longer gets past the cap, and closing the
  preview cancels the read. An App whose home is a landing drew the configured footer twice, its own and the App's;
  now one. The Keystone fixture's launchers find the repository and the tenant-maintenance entry again, its Apps are
  named Keystone Lending, Keystone Customer Portal and Keystone Marketplace so a chooser can tell them apart, the
  fixture guides name current paths, the load smoke finds its issue through the list's search, and `.node-version`
  names the minimum Node.

## 1.0.0-rc.7

- **The showcase review's UI work lands as code.** A pill no longer spills a dangling ".." past its edge in a narrow grid cell (it truncates inside itself, full text in `title`); every board lane head uses one treatment (word and dot, never a pill background); the sidebar's muted ink is the nav's own, measured against the menu ground, and the current entry on an inverted menu carries an accent edge; `mistri grade` measures a 768px tablet window beside desk, phone and dark; `grade` and `shot` reap their server on every exit path; an App loaded outside the checkout no longer fails its own commands with "must be created with defineCommand" (a command from another copy of the module is adopted); search through the built-in `memory` connection needs no pack plugged in; `@mistriwork/ui` gains standalone Preview primitives (Switch, Tabs, Drawer, Popover, Avatar, Pagination) whose rules live in `standalone.css`, not in the kit's first paint; the assistant gains an OpenAI provider behind `MISTRI_ASSISTANT_PROVIDER`; and a donut slice drills like its legend button — as a group holding buttons, not buttons inside an image, so the accessibility audit stays clean.
- **`mistri --help` says where the pool and lock flags are.** `--read-pool`, `--write-pool` and the lock timeouts are
  in `--help all` only, and the short help's line for it said just "every command and option". It now names them. The
  CLI reference pages are regenerated, which also brings in `--auth-proxy-from` and the assistant's store.
- **A command route that is sent `app` in the body says where it goes.** Resource routes take `app` in the JSON body and
  command routes in the query string, and a command body with `app` in it answered `invalid_input` with nothing to say
  why. It now answers "A command route takes app in the query string (/api/commands/execute?app=<id>), not in the
  body"; any other stray member is still refused without being echoed. The authoring guide notes the difference. The
  startup refusal for a missing command journal names `@mistriwork/mistri/maintenance`, as the docs now do.
- **`mistri migrate stores` takes `--commands`.** A command's journal is a store, and `stores up --app` finds the
  commands module beside the App; an App whose commands live in another file could be started with `--commands <file>`
  but not migrated with it (`"--commands" is not an option of migrate`). It is passed through now, as `--policy` is, and
  the usage line names it.
- **`supportLog` is documented as the parsed form of `operations: ['support']`.** The tenant server reads a role's
  `supportLog` flag, and the validator refuses it as an authored key; both are right, because parsing folds
  `operations: ['support']` into the flag. The Tenant Apps guide and the code now say so, and nothing was removed.
- **A command that returns a value without declaring `output` is told what to declare.** An omitted `output` means the
  handler returns nothing, so a handler that returns an object answers `invalid_result` (503) at run time, and neither
  `mistri check` nor `tsc` can see a return value. The terminal used to say only that the result was not its declared
  output; it now says `returned a value but declares no output. Declare output: shape({ … })`, and the commands guide's
  common mistakes list it.
- **The migrate functions are documented from the entry that exports them.** `migratePostgresAuthStore`,
  `migratePostgresCommandJournal` and `migrateSqliteCommandJournal` are exported by `@mistriwork/mistri/maintenance`
  only, but the auth reference, the `auth.store` schema description, the Tenant Apps guide and a command journal's
  startup refusal sent the reader to `@mistriwork/mistri/commands`, where `import` finds nothing.
  `test/migrate-import-path.test.ts` reads the docs, the schema and the messages for it.
- **A tenant list's search box no longer searches the tenant column, and a suggested page's related lists are headed in
  words.** A table with no name column of its own was named by its first required text column, which in a tenant table
  is the ownership column (`tenant_id`): the list searched who owns the rows, the same on every one. A text column that
  references another table is a pointer, not a name, and no longer names a row. A record page's related list that a
  suggested page titled by the bare table name (`visit_attachment`) is headed "Visit attachment", as an untitled list
  already was. A tenant record's attachment link was checked as well: its click is saved from the lease and never
  followed to the file route, and `AttachmentList.test.tsx` now holds that.
- **An upload's reply no longer carries the file back.** The reply to a file upload (an App's, and a tenant App's) held
  the row as written, so a 2 MB file came back as a JSON `Buffer` of about 6 MB. A written row now shows a file's bytes
  as the `<n bytes>` label every read gives a blob. The upload messages are plainer too: a tenant body past its ceiling
  answers 413 with a size sentence (it said the change was unavailable under the permissions), "is 2 MB; this App takes
  files up to 2 MB" says bytes when the two would print the same, and a control character or bidi override in a file
  name becomes `_` rather than vanishing (`evil.png\0.html` was stored as `evil.png.html`).
- **`mistri migrate stores up --app` now makes the assistant's store.** The assistant keeps its conversations and token
  counts in a store of its own, which serving never creates, but the one command that provisions an App's other stores
  skipped it, so the only way to make it was a script calling `provisionStores`. An App that declares an `assistant`
  now has its store made on its connection (a tenant App's, beside its tenant source, with `--policy`), `status` lists
  it with its peers, and a second `up` leaves it alone. A server that finds it missing refuses naming this command.
  `test/migrate-app-stores.test.ts` holds it.
- **`--trust-proxy` no longer lets a proxy say who is signed in; `--auth-proxy-from` does.** One list used to grant two
  things: believing a proxy's `X-Forwarded-For` for rate limits and logs, and believing its `--auth-proxy-header`
  value as the signed-in person. The documented examples were wide ranges (`10.0.0.0/8`, Docker's `172.17.0.1`), so
  any pod in the range, or any client behind Docker Desktop's gateway, could forge the identity header, be believed,
  and also turn off the "anyone can read" warning. The identity header is now believed only from loopback and from
  the peers a new `--auth-proxy-from <address|CIDR>` (or `MISTRI_AUTH_PROXY_FROM` / `TABLEWALK_AUTH_PROXY_FROM`)
  names, with the same list syntax; `--trust-proxy` keeps only the client address. A server behind an off-box
  signing-in proxy must now name it there, or every request is refused with that flag in the message. Startup warns,
  without refusing, when `--auth-proxy-from` holds a range wider than one host, and the documented `--trust-proxy`
  examples name a single proxy. Tenant serving refuses `--auth-proxy-from` as it already refused
  `--auth-proxy-header`. `test/trust-proxy.test.ts` holds the split.
- **A click in a list or a record answers sooner.** Four costs sat inside the click itself. A form page's width rule
  and one of Lumen's tone rules were written as `:has()` selectors that made Chrome restyle the whole pane each time
  an element came or went anywhere in it, four times in one sort; they are now a container query and a pair of plain
  rules that draw the same. The focus left with the room it stood in, which forced a style update of the whole page
  inside the removal; it is now let go before the room changes. The App's own stylesheet was copied for the held
  picture during the click when it had arrived after the idle moment meant for it; it is copied when it arrives. And
  a filter bar that had to fold several pickers folded one a render, a render and a measure of the row each; it
  folds as many as the row's overflow covers at once. On `test/built-client-vitals.mjs`'s slowed CPU, Compass at a
  desk sorts in 120 ms where it took 216, opens a record in 152 (232), searches in 152 (296); Forecourt opens a
  record in 120 (208). No room-changing interaction is over its 200 ms budget now, at a desk or on a phone.
- **One person's saves sent together in a tenant App all apply.** Two or more `/api/update` or `/api/insert` requests
  on one lease at the same moment — a form's fields saved together, two tabs — found the account's history partition
  held by the first and were refused 403, "unavailable under the current permissions or record state": five of ten
  in a live load test, twenty-three of forty. The partition is held by one save at a time on purpose, so the history's
  order is the order the saves committed in and an Undo reverts the newest with nothing landing in between; that
  holds. A save that finds it held now waits for it, in arrival order, after admission and before its transaction,
  holding no connection. The wait is bounded as the writer pool's own queue is: past 30 seconds, or behind 64 saves of
  the same account, it is refused 503 `server_busy` with `Retry-After`, `not_applied` — the code a tenant write
  refused by a busy pool now also says, where it said `temporarily_unavailable`. An Undo still refuses while a save
  of the same partition is running. `test/tenant-update-history.test.ts` and `test/tenant-history-partitions.test.ts`
  hold it.
- **A tenant write the database refuses for good is a 409 or a 422, not a 503 to retry.** A duplicate key, a
  reference to nothing or a value its column cannot hold was answered as the database not answering — 503
  `temporarily_unavailable` with `Retry-After` — so a client retried a write that could never succeed (a live load
  test). A tenant App now answers as a single-database App does: a key taken or a reference to nothing is 409
  (`duplicate_value`, `reference_conflict`), a required value, a check or a value its column cannot hold is 422, in
  the `rejected` envelope and with no `Retry-After`. It says only the code's fixed sentence, never a column, a
  constraint or a value, because a key is global while rows are a tenant's: an id another tenant holds gets the answer
  an id this tenant holds gets, byte for byte. Only a connection or availability failure is still a 503. A plain
  App's write refused for a value its column cannot hold now says `rejected` where it said `unknown`.
  `test/postgres-tenant-http.test.ts` holds it.
- **A refused write is never a 2xx.** `/api/insert`, `/api/update`, `/api/file/upload` and `/api/delete` answered a
  write the database refused — a reference to nothing, a duplicate key, a delete others still point at — and one the
  App's validation refused with HTTP 200 and `outcome: 'rejected'` in the body, so a client that read only the status
  took the refused write for a saved one (a live load test, on a dangling reference). The same envelope now comes at
  409 for a key taken or a reference (`duplicate_value`, `reference_conflict`) and 422 for the App's validation, a
  required value, a check or a value its column cannot hold — as a line's `consumes` already was, in a single-database
  App, under a row policy, in a tenant App and in the database browser alike. Under a row policy the database's
  refusal is said by its code's fixed sentence, the same for a row the policy shows and one it hides, where it was a
  400 saying the change was unavailable under the current permissions. A delete the adapter refuses is a 400. The
  App's client reads a 409 or 422 rejected envelope as the refused write it is, the field marked and the draft kept,
  as it read the 200. `test/http.test.ts`, `test/resource-http-contract.test.ts` and
  `test/row-policy-refusal-causes.test.ts` hold it.
- **A body refused as too large leaves its connection clean.** A request body past its route's cap was read up to the
  cap and answered 413 with the rest still unread on a keep-alive connection, so the next request on it was read out
  of the leftovers and hung or was reset (a live load test). The rest is now read and dropped before the 413, for an
  App's routes and uploads and a tenant App's alike; past 16 MiB beyond the cap the connection is closed instead.
  `test/http.test.ts` holds it.
- **A save behind a held row is refused after one lock timeout, not two.** A save sends its record's lock behind
  its BEGIN; when that lock waited out the lock timeout, the transaction began again without it and asked for the
  same lock again, so `row_locked` came after ten seconds where five are documented (a live load test). The wait is
  now the transaction's answer, on a plain App's saves and a scoped or tenant App's alike.
  `test/postgres-writers-live.test.ts` holds it.

## 1.0.0-rc.6

- **A record page's actions are one round trip fewer.** Which verbs a record offers is checked in the request's one
  read snapshot, each command reading its target rows and then asserting each target visible by reading it again: a
  second wave of reads after the first, every record page, a round trip on a database a network away. The assertion
  is now answered by the check's own read, which went through the same scoped transaction in the same snapshot; a
  target that read did not find, or whose owner it could not see, is still read. Ignition's record page enters in 18
  flights, the same on any machine, where a loaded one counted 19.
- **A host's sign-in is never a recent one.** An embed exchange on the App's own origin answers with an ordinary
  session cookie, and the cross-origin bearer's refusals did not reach it: a host whose issuer links verified
  addresses could sign its page in as a platform operator and open a support session inside a tenant. Every session
  an exchange opens is now recorded in the sign-in store before its cookie or bearer leaves, and whatever needs a
  sign-in from the last few minutes (opening support, making an API token) asks for one at the App's own page
  instead. `test/embed-tenant.test.ts` holds the same-origin case.
- **Making a tenant API token needs a recent sign-in, and a reset password ends the account's tokens.** A token
  lives up to a year, longer than the session that made it, so a member now makes one only with a sign-in from the
  last five minutes, as opening support asks; an older session is told to sign in again (`sign_in_required`). A
  password reset by its link, a password an administrator sets for someone, and a deactivation now revoke the
  account's API tokens and OAuth grants with its sessions, so a reactivation brings none of them back.
- **A wrong step-up code counts toward the reference's lockout.** Wrong codes were counted only by the process that
  sent the code, five a code and three codes an hour, apart from the lockout every instance shares. They now count
  in the shared one, beside wrong details: five wrong tries of either lock the reference for an hour on every
  instance, and only a right code takes its count away.

## 1.0.0-rc.5

- **A tenant App's start describes each PostgreSQL catalog once.** Startup's two checks, its trial enrollment and the
  host's, each read source, the first scoped transaction and each platform source's snapshots each described the
  catalog afresh: on Ignition, 16 descriptions of its two databases (96 catalog statements, one round trip each)
  before the port opened. A description is now kept for the process under the exact version it was read at — the
  catalog digest read in its own snapshot, or the schema epoch — and any adapter of the same database that reads the
  same version gets a copy; a time-filed version is never shared. Measured on Ignition: 2 descriptions, 318 boot
  statements where there were 388, and the start 2.1 s quicker (12.4 s to 10.3 s) with a 20 ms round trip.
  `test/postgres-tenant-flights.test.ts` holds the start to one description per database and every warm request to
  none. A command's execute already described nothing warm, and still does.
- **A tenant App's start attests each runtime store's catalog once.** Every adapter and snapshot that opened at the
  start — startup's checks, both enrollments, the read and write sources, the administration and support paths —
  attested the tenant, administration, invitation and support stores for itself: on Ignition, 42 layout reads and 32
  ownership checks. What an attestation proves of the catalog (the layout, and that the runtime schema, its tables and
  grants are this role's alone) is now shared in the process under the exact catalog version the transaction read
  before it — the digest or the schema epoch; a transaction without one reads the digest when it first has a store to
  attest — so another adapter of the same database that reads the same version finds it attested, and any DDL, grant,
  owner, role or object in the runtime schema moves the version and attests in full again. The store's meta row, which
  binds it to this App, source and store, is data the version does not see, so each adapter still reads it when it
  opens, as before. The catalog digest now also covers the conversions, operator families, text search objects,
  extended statistics and extensions an attestation counts in the runtime schema. Measured on Ignition with a 20 ms
  round trip: 4 ownership checks, 230 boot statements where there were 318, and the start 10.3 s to 7.8 s.
- **What a write saw of a moving catalog is not kept under a version it did not see.** A write reads committed state
  statement by statement, so DDL that committed between its version read and its describe or attestation was in what
  it then kept under the older version, where a snapshot begun before the DDL would be handed a catalog it cannot see.
  A write now reads its version again after describing or attesting and keeps the result only if it has not moved. A
  kept description is served for five minutes, since comments and the row estimates that decide when a large table's
  count is estimated move without the version (ANALYZE, autovacuum): a table that grows is counted as large minutes
  later rather than never. A DDL statement behind a comment (`/* … */ ALTER`, `-- …` then `ALTER`) now forgets the
  version as a bare one does, and an App's foreign-key violation forgets what its own adapter attested but no longer
  what every adapter of the database shares.
- **A long request reads `now` when it reads, not when it arrived.** A tenant live stream's re-resolutions and probes
  and each read and write of an import are now their own unit of work at their own instant; before, a stream open all
  afternoon judged a computed `now` at the minute it opened. A catalog served outside a request (a notice's mail, a
  public page) no longer leaves its instant in the async context with `enterWith`, where every later timer in that
  flow read it however old: each runs at an instant scoped to its own work, and a statement written where nobody
  scoped one refuses (`StatementInstantMissing`) instead of writing a stale one.
- **A session store that does not answer is a 503 a client retries, not a refusal.** Better Auth's session lookup
  catches whatever its store threw and throws a bare 500 of its own ("Failed to get session"), with nothing of the
  driver's error beneath it, so the tenant host read a store whose pool would not lend a connection, or whose lookup
  timed out, as the session refused: a field deployment at its database's connection limit answered a signed-in
  member's list read `403 tenant_context_unavailable`, and the page showed a refusal instead of retrying. The
  PostgreSQL auth store now notes a refused checkout or a failed statement for the call that asked, and the tenant
  path answers it as it answers the store's own observation failing: `503 tenant_temporarily_unavailable` with
  `Retry-After`, which the tenant transport already retries. The same failure elsewhere is answered the same way: a
  tenant host's `/api/whoami` (503 `auth_temporarily_unavailable`, was 403 `auth_unavailable`), a non-tenant App's
  signed-in requests (503 `server_busy`, as a busy pool's are, was 403), and the platform realm's and a support
  session's reads, whose admission, runtime and lease flattened any failure into a denial where a tenant's read
  already told the database not answering from a refusal. No sign-in, membership or realm refusal changes, and the
  caller is told nothing of the driver's words.
- **A host's bearer never opens a support session.** The embed door takes a host page's `Authorization` header
  away once it has read the bearer as its session, and the support routes refused a bearer by looking for that header,
  so a host whose assertions link verified addresses (`"accounts": "link-verified-email"`) could open a platform
  operator's support session inside any tenant the operator may enter, and read that tenant's rows on its lease. The
  support routes (`/api/tenant/support/…`, the dealer's log and the lender's sessions view included), a tenant's
  branding save and the Suite console now never take a bearer, and a request the door admitted on one is marked, so
  any route that refuses a bearer refuses it whether or not the header is still there. A support session opened at
  the App's own page was never reachable through a bearer, since its lease is bound to that sign-in; a test now
  holds that too.
- **Only the deploy can make a Cloudflare container's Durable Object reset.** `mistriWorker` stamped its version on
  every `GET /__mistri/status`, token or not, and the object reset itself before it checked the token, so any visitor
  could set off the reset an object behind a newer Worker does (at most once in thirty seconds). The Worker now stamps
  only its own once-a-minute tick and a probe that carries the restart token. A project whose container names its own
  token secret (`restartTokenEnv`) names it to `mistriWorker` too.
- **`mistri deploy` sends the restart token only over https.** The status probe and the restart carry
  `MISTRI_RESTART_TOKEN` to `vars.MISTRI_PUBLIC_URL`, which was taken as written; an `http://` address beyond this
  machine is now refused before anything runs (`http://localhost` and `127.0.0.1` still work).
- **An https `MISTRI_PUBLIC_URL` makes every request https.** Behind a front end that ends TLS and forwards plain
  http from an address nobody can list in `--trust-proxy` (Cloudflare Containers, Cloud Run), a form's draft and claim
  cookies and a status sign-in's were set without `Secure`, no answer carried `Strict-Transport-Security`, and
  sitemaps and link previews named `http://`. Sign-in's own cookies already followed the public address. Now one rule
  decides all of them: a TLS socket, an `https://` public address (or a mounting host's https origin), or a trusted
  proxy's `X-Forwarded-Proto: https`.
- **Live sync counts a signed-out visitor by the client the proxy names.** Each account may hold eight live streams,
  and a visitor was counted by the socket's peer, so behind a load balancer or Cloudflare every visitor of a public
  page shared one visitor's eight and the ninth had no live updates. A visitor is now the client the rate limits name
  (`--trust-proxy`, `--trust-proxy-hops`, `--trust-proxy-cloudflare`).

## 1.0.0-rc.4

- **A Cloudflare deploy rolls in under forty seconds, not five to eight minutes.** Under the `durable_object`
  scheduling policy `wrangler deploy` replaces no container, and the platform moved a running Durable Object onto the
  new Worker version only after about five minutes and twenty seconds (the same three times); a restart that reached
  the object before then brought the old image back. `MistriContainer` now records what it started the container
  with and replaces a healthy one that differs from its own Worker version's image, deploy id or instance type (once a
  minute at most, never while starting), and `mistriWorker` stamps its version on the status probe and the tick, so an
  object behind a newer Worker resets itself and starts again on it. `mistri deploy` polls `/readyz` and a token-gated
  `GET /__mistri/status` every 5 seconds, prints a timeline, and restarts only as a fallback; `deploy init` adds the
  `version_metadata` binding. Measured on a field deployment: 37 seconds from upload to the new container answering,
  1 minute 49 for the whole command with the image unchanged.
- **The build type-checks.** `npm run build` no longer emits with `--noCheck` over `tsconfig.build.json`: a build from a tag or a tarball that has not run `npm test` fails on a type error instead of shipping it (about a second on TypeScript 7). Every public export of every package must also have declarations it ships, `types` condition or the `.d.ts` beside its `.js`: the build checks the checkout's `dist/`, `npm run test:exports` checks the installed tarballs, and `test/export-types.test.ts` holds the rule (`scripts/export-types.mjs`).
- **Where the client's plain JavaScript is checked is written down.** The main `tsconfig.json` keeps `checkJs` off because `tsconfig.client.json` checks all 84 `src/client` `.js` modules with it on (`test/check-client-types.mjs`, part of `test:static`); the comment there and `docs/architecture.md` now say so.
- **A store upgrade is rehearsed, kill included.** `test/store-upgrade-rehearsal.test.ts` restores the committed v1 record-history fixture into SQLite (and PostgreSQL when `TABLEWALK_TEST_PG` is set), runs the real `upgradeStores` with a v2 step in a child process, SIGKILLs the child inside the step, and proves the store reads v1 with every row, and that running again finishes the upgrade with the version recorded once. Every shipped store is still at layout version 1, so the v2 is the test's own.

- **`mistri deploy` after its first real run.** A migration history that does not match the directory refuses the plan (it used to apply nothing silently), `--migrations <dir>` overrides the config's directory, `deploy verify` re-checks the newest deploy and repairs its record, `status` is read-only and short, smoke follows same-origin redirects, wrangler's output streams during the image build, and `init` names the Worker after the App and sets no pooler default.

- **Fewer round trips per tenant request.** A read snapshot sends its BEGIN, its settings, the reads and its COMMIT
  as one pipelined flight, and ends itself when the reads are whole. On a PostgreSQL tenant App a list, a record, a
  search or a pool read is 2 round trips, the counts 2, the inbox 3, a record's decisions 1, a command's prepare 2 and
  its execute 4, and a first page about 14 (a test holds 16). A source's store attestations are kept per pool under
  the catalog fingerprint instead of asked on every read; a session is asked outside the snapshot, and a context
  opened inside one is refused. Each request's round trips are counted off its Server-Timing in the tests.
- **One connection manager per database.** A database's holders share one manager per pool shape, so a field App's
  tenant requests, stores and background work fit 16 connections where they held 51 (18 with a sign-in store of 2,
  `MISTRI_AUTH_POOL`). A tenant App's request pool is sized by its connection's `pool`, a replica counts its readers
  alone, and the background writer's line is bounded (`PoolBusy`: `queue_full`, `queue_timeout`).
- **People arriving at once wait their turn.** A burst of first visits to a tenant App on a small container is let in
  a few at a time instead of being answered busy.
- **Live sync lets go.** A subscriber that leaves before its pass is released when it leaves and when the hub stops,
  and a closed pool's Server-Timing gauges are removed. The capacity harness can report the heap and write a heap
  snapshot.
- **A save is timed alone.** Live sync's pass ran in the context of the save whose commit woke it, so its store read,
  authorities and probes were counted in that save's Server-Timing (round trips and database time) whenever the save
  was still answering when the pass began; the hub's timers are the process's now. The tenant flights test holds
  four saves at once to a save's budget, and the capacity harness serves Ignition with keyed writes as the CLI does
  (it ran every save on one writer), live sync on, `--edit-leads` for a repeatable insert-and-update save, and the
  database and server time of each endpoint.
- **Operations documentation.** Backup, the audit key, moving from 0.9, incidents and the sandbox limit are written
  down; the Node floor is 24.22.1 and the framework peers are bounded; Renovate and a production dependency audit run
  in CI.

- **Performance by default.** `mistri check` reports `index-missing` (PostgreSQL): a declared access path with no index leading
  with its columns, with the `CREATE INDEX` line (information under 10,000 estimated rows, a warning above; `--no-index-check`).
  `mistri dev --db-latency <ms>` (or `MISTRI_DEV_DB_LATENCY`) delays each database round trip so the distance shows in
  development; it is refused in production and for a build. `mistri dev` logs each request's round trips, database time and CPU,
  and warns past a budget (read 3, command 6, first page 16); Server-Timing is on in dev, with `proc` still behind its token.
  `roundTrips(response)` in `@mistriwork/mistri/testing` (Preview) lets an App's tests hold a budget. New page: Performance by default.

- **`mistri deploy` for Cloudflare Containers.** `mistri deploy init cloudflare` writes `deploy/cloudflare/`
  (a Worker against the new `@mistriwork/cloudflare`, `wrangler.jsonc`, `package.json` and the build request) and
  names every `${NAME}` the configuration reads as a secret; it creates nothing on Cloudflare. `mistri deploy` prints
  a plan and changes nothing until confirmed (`--yes` in CI, `--dry-run` to stop after the plan), refusing when
  `check --deploy` fails, a secret is missing from the Worker (compared by name, never read), a pending migration is
  a contract step (unless `--allow-contract`) or the working tree is dirty (unless `--allow-dirty`). It then builds,
  runs `--backup-check`, applies the migrations from the operator's machine over `--migrate-url` / `MISTRI_MIGRATE_URL` and the App's
  stores over the store URLs its config names, read from that machine's environment, runs `wrangler deploy` with a new `MISTRI_DEPLOY_ID`, and restarts the
  container until `/readyz` reports that deploy and this build, up to `--roll-timeout` (20 minutes), then smokes the
  public address (and `--smoke <cmd>`). Every deploy is a row in `__mistri_deploys` beside the migration history;
  `status`, `rollback` (refused past a contract migration) and `logs` use it and wrangler.
- **`@mistriwork/cloudflare`**, a new package: `MistriContainer` (always on, waits out mistri's startup checks,
  hands the Worker's named vars and secrets to the container, token-gated restart, optional image and instance-type
  pin), `mistriWorker({ binding, instance, location })` for `fetch` and the once-a-minute `scheduled`, and
  `forwardEmail` for inbound tenant mail. `@cloudflare/containers` is its peer; mistri depends on neither.
  `examples/deploy/cloudflare` is gone: `mistri deploy init cloudflare` is the template.
- **`/readyz` carries `{ deploy, build }`** beside its status: `deploy` is `MISTRI_DEPLOY_ID` (null when unset) and
  `build` the served build's id (null for an App served from source). Status codes are unchanged.
- **Server-Timing's process entry is held behind `MISTRI_SERVER_TIMING_TOKEN`.** With the token set, the `proc`
  entry is added only to a request that sends it as `x-mistri-timing`; the per-request entries stay public. Timing on
  without a token logs one startup warning that `proc` is public.
- **`mistri check --deploy` judges pending migrations against the code still running.** A pending migration that
  drops or renames a table or column, changes a type, sets NOT NULL or adds a NOT NULL column without a default is a
  warning (an error with `--strict-migrations`; a note when marked `-- mistri: contract`), with its expand/contract
  fix, and `MISTRI_SERVER_TIMING=1` without a token is a warning.

## 1.0.0-rc.3

- **MySQL and MariaDB are not supported.** The adapter, the `mysql2` driver and every MySQL branch of the SQL
  generation, the stores and the migration runner are removed; PostgreSQL and SQLite are the databases of 1.0. A
  `mysql://` or `mariadb://` address, or a config that names one, now fails with "MySQL is not supported; use
  PostgreSQL or SQLite." The `{ mysql: url }` target of `provisionStores` is gone with it.
- **`--auth-proxy-header` is believed only from a proxy.** A request that carried the header from a peer that was
  neither loopback nor in `--trust-proxy` was taken at its word, so anyone who could reach the port could name
  themselves. It is now refused, naming the header. Put your proxy's address in `--trust-proxy`.
- **`mistri` and `tablewalk` export only what they name.** The `./*` export pattern, which made every file under
  `src/` importable, is gone.
- **`Retry-After` says how long a full connection limit will hold.** A request refused because the database's
  connection limit was reached now answers `Retry-After: 30`, the time the pool holds back before trying again; a full
  queue still answers 1. The tenant path follows the same rule.
- **Ledger is a built-in look.** Figures, ids, dates and labels in IBM Plex Mono, ruled boxes on a faint graph-paper
  ground, column heads closed with a double rule, and one deep green for the menu, the primary button and links, with
  the twelve shared palettes. A custom theme may no longer take a built-in look's id: an App that declared its own
  `ledger` is refused at load and should drop it for the built-in, which keeps the same id for anyone who picked it.
- **Less work per request on a tenant App.** On a large field App served by half a CPU to 25 people with live streams,
  CPU per request fell from 13.0 to 9.6 ms, memory allocated per request from 3.9 to 1.6 MB, time in garbage
  collection from 9.6% to 5.2%, and entering a tenant from 114 to 84 ms at the median. A computed column's `now` is
  written as the request's instant instead of into a copy of the catalog, so caches keyed by the catalog are found
  again; row scopes, view references and breakdowns are kept by what they say; and after an App reload the
  composition caches hit again where they had never been found (5 to 11 scope checks a request, now none).
- **`mistri check --deploy` counts connections.** It prints, per database, the processes times the connections one
  process may hold, from every pool the App opens (the adapter, live sync, jobs, effects, integrations, decisions,
  the API event feed, the assistant, replicas and the sign-in store), sized for `--cpus <n>` (default: this
  machine's). `--connection-limit <n>` turns a total above it into an error. A served PostgreSQL App also says at
  start, once, when one process could hold more than the role or server allows.
- **Sign-in over plain http beyond loopback is refused.** Session cookies over http are never marked Secure, and the
  password crosses the network in the clear. Set the public address (`MISTRI_PUBLIC_URL`) to a TLS proxy's https
  address, or listen on loopback behind it; `--insecure-http-sign-in` (`MISTRI_INSECURE_HTTP_SIGN_IN=1`) serves it
  anyway, with the warning.
- **A password-reset link is written to the log only under `mistri dev`.** A served App without an email service
  answers a reset request as before, sends nothing, and logs one line without the link; a warning at start says the
  offer cannot be kept.
- **A component the check would refuse is not served.** Raw HTML (`dangerouslySetInnerHTML`, `innerHTML`), `eval`,
  `new Function`, string timers, `javascript:` addresses and a component's reach for the server's environment were
  findings of `mistri check` only; loading the App now refuses them with the same text. The rule is a heuristic, and
  an App author is trusted: it is not a sandbox.
- **Every App subdirectory is checked for world-writability on each load,** not only the App's own directory, and a
  reload that fails it keeps the last good App. The guard does not run on Windows, where directory ACLs are the
  operator's.
- **The theme bench answers 404 unless a dev start mounts it.** Unmounted, its address fell through to the App shell.
- **A driver's error text stays out of the assistant store's 503.** The reply says the store is unavailable; the
  detail goes to the server log.
- **A sidebar with a footer group no longer pushes the App's identity and Collapse below the window.** The nav list
  shrinks and scrolls instead, in every look.
- **`mistri grade` holds a phone target to 44px,** as `docs/design.md` says, where it had said 40.

## 1.0.0-rc.2

The first release candidate, and the first release of mistri: the App framework
is split out of tablewalk, which is now only the standalone database browser.
There is no upgrade path from a tablewalk 0.9 App database; reset and reseed it.
This entry describes the whole first release, and its first entries are what a
field report measured against a remote database.

- **The App framework is `@mistriwork/mistri`, and `tablewalk` is the database browser.** Scaffold with
  `npm create mistri`; the command is `mistri`, its config `mistri.json`, its variables `MISTRI_*` and its working
  directory `.mistri/`. The site is https://mistriwork.dev. The next entries are in the order they matter.
- **A tenant App on a remote database is fast.** A field report on a real deploy, a container and a hosted PostgreSQL
  about 20 ms away, measured a list at 8 to 10 s, a record at 16 to 18 s, a save settling in 15 to 23 s and a start in
  146 to 174 s on half a vCPU. The same deploy, moved to one vCPU (which alone was worth about a fifth), now lists in
  about 0.7 s, opens a record in about 0.8 s and settles a save in about 0.55 s; a new build starts in about 59 s and
  restarts unchanged in about 21 s. Time was in round trips and in work repeated per request, not in the database. The
  entries below are how it was done, and `MISTRI_SERVER_TIMING=1` is how to see it.
- **A busy server says it is busy, and a burst waits.** A field report put 25 people on a tenant App at half a vCPU
  and saw refusals from about twelve: a database pool that would not lend a connection in time answered reads 403
  "The tenant context could not be verified", and a write refused at checkout closed the tenant writer, so every
  write, inbox and live stream answered 503 or "live off" until it reopened. A database that did not answer is now
  503 with `Retry-After` everywhere it was a denial (reads, counts, records, the inbox, discovery, the session
  store), a refused checkout leaves the writer open, the live route answers 503 rather than off while a writer
  reopens, and a pool queues 64 checkouts per connection rather than 8, so a page's burst of reads waits inside the
  two-second bound instead of being turned away. A set of roles' access and a captured catalog's mapping are worked
  out once rather than per request, and the inbox reads its email switch on the reader. Locally at half a CPU and
  20 ms to the database, 25 and 50 people ran with no errors. A database that refuses another connection (53300,
  "too many connections for role") is a limit, not a fault: the pool goes on with the connections it holds, a
  checkout waits for one of them, the log says `connection limit reached: the app write pool holds N of M`, and the
  tenant writer stays open. It used to close the writer and reopen it into the same refusal, which failed two
  commands in three at three users on pools sized past the role's limit.
- **A tenant App's first page is who-am-I and one request.** Someone in a single tenant is entered by
  `POST /api/tenant/enter`, which answers discovery, opens or resumes the lease and reads the page's boot on it, where
  the page asked who-am-I, the person's tenants, a lease and then the boot, each a round trip of its own. The route
  runs the same functions in the same order and adds no proof: a person in several tenants, in the platform realm or
  following a link to another tenant gets discovery's answer alone and the chooser, and it refuses lease headers,
  selectors and support realms. The boot reads the runtime, the App, its pages, schema and the bell's count on that
  lease and plans the room's own reads beside them. A list is two requests, and entering is eight database round
  trips for a list where it was eleven and twelve for a record where it was eighteen. The tenant's flows are preloaded
  beside the entry, so no network round trip stands in front of entering.
- **A save's checks leave together, and reads asked together leave together.** On a pipelining PostgreSQL writer a row's
  lock and the guard read behind it, and every reference's lock and count, go in one flight and are judged in the order
  they were asked; a create reads its references from the row the INSERT returned. A create goes from twenty-three
  flights to eight (523 ms to 224 ms at 10 ms each way), and a handler's `Promise.all` of reads costs one flight
  instead of one apiece. A write still waits for every operation asked before it, a read asked after a write waits for
  it, and the first failure in the order asked is every later operation's. SQLite and MySQL still run one at a time.
- **A tenant's catalog is built once, and a person's grant is resolved once per role set.** A request used to rebuild
  its served catalog, copy and re-check its row scope and filter the role's grant afresh, most of what a large App
  spent a request on. The served catalog is kept per captured catalog, App and zone, and per only as much of the clock
  and the reader as building it read; a computed column that says `now`, `today` or `me` is left as written and each
  request is served a copy with them folded only in the tables that say one. A large App's first page goes from 52 ms
  of CPU to 9, and its request context from about 39 ms to 2. Nothing is kept across a change of catalog, and a grant
  is never keyed by the person or the tenant.
- **A save settles in one batched refresh, and an idle jobs host sleeps.** The reads a write sets off, which were six
  requests each with its own admission and snapshot, go as one `POST /api/boot` with `reads` on the lease, one
  snapshot for all of them; a host that refuses a batch is asked read by read. The jobs host's readiness is one
  aggregate statement per store, and a host that hears every write over PostgreSQL LISTEN sleeps until the next thing
  due, with a five minute fallback; enqueue and redrive NOTIFY at commit. Claim, lease and retry rules are unchanged.
- **`MISTRI_SERVER_TIMING=1` shows where a request's time goes.** Every response carries a `Server-Timing` header and
  one JSON log line: the total to headers, the process's CPU over the request, the session's resolution, per database
  the flights sent (a pipelined batch counts once) and the time awaiting the server, the wait for a connection per
  pool, and a composed first page's planned reads. At startup it logs ten `SELECT 1` round trips to each database on a
  connection of its own, which is the round trip from where the server runs. Nothing it prints names a statement, a row
  or a key. Off, each entry point is one boolean.
- **A production build's restart skips the checks a recorded start already made.** A tenant App's start checked its
  declarations against the catalog twice and dry-ran enrollment, about 520 round trips. The start that checks now
  writes one row per App and source to the `validation-record` store, which `mistri migrate stores up` provisions and
  a start never does. The same build, or another of the same declarations, on the same catalog skips the catalog
  checks; another build on the same catalog reads the catalog once and checks it whole; another catalog, no record or
  an unreadable one is a full check, as are a source App, `--dev` and `mistri check`. A record never stops a start.
  Behind a 20 ms relay Ignition starts in 8.4 s where it took 15.8.
- **Workshop is the default App look, and every look offers the same twelve palettes.** Workshop is warm paper, ink
  type and fills, condensed capitals and square corners; Lumen, Mono and Sage stay. The palettes are Crimson, Safety
  orange, Amber, Moss, Emerald, Teal, Cobalt, Violet, Plum, Rose, Slate and Ink, each its hue at the depths a look
  draws it, light and dark. Workshop wears Safety orange, Lumen Cobalt, and Mono and Sage Ink. Barlow is fetched only
  by a page wearing Workshop and Inter only with Lumen. `test/contrast.test.ts` measures every palette in every look
  and mode.
- **A save is a fixed number of database round trips.** On PostgreSQL a save is one flight for the BEGIN and what it
  reads first, one for each awaited dependent read or write, and a last one that carries the COMMIT, history, notices
  and the receipt. Preparing a command is BEGIN and COMMIT, and a click skips it. The writer pipelines, which works
  through PgBouncer in transaction mode. `test/write-flights.test.ts` holds each sample App to its budget.
- **The runtime forgets what it wrote about an App.** `retention: { history, commands, attempts }` in the App declares
  how long (defaults `'730 days'`, `'730 days'` and `'30 days'`, or `'forever'`); a daily `mistri-retention` job prunes
  in bounded batches. A write that moves only the table's version column records no history.
- **On PostgreSQL the runtime lives in one schema named `mistri`,** with plain table names; SQLite and MySQL keep the
  `__mistri_` prefix. `pg_dump -n public` dumps the App, `-n mistri` the runtime, and the schema is closed with
  `REVOKE ALL ON SCHEMA mistri FROM PUBLIC`.

The rest of this release, in the order it was made:

- **The packages are published under the `@mistriwork` scope.** npm refused the unscoped name `mistri`, so the App
  framework is `@mistriwork/mistri` (its command stays `mistri`, as do `mistri.json`, `.mistri/` and `MISTRI_*`), and
  the layers beneath it are `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui`. An App imports
  `@mistriwork/mistri/app`, `@mistriwork/mistri/commands` and the rest, and `mistri new` writes that name into the
  `package.json` and imports it drafts. `tablewalk` keeps its name. Change the name in an App's `package.json` and
  imports; nothing else moves.

- **On PostgreSQL every runtime table lives in one `mistri` schema, without the `__mistri_` prefix.** The seven
  per-store schemas are gone (sign-in tables become `mistri.auth_*`), a reporting role's grants on `public` no longer
  make the tenant store refuse, and an existing PostgreSQL database must be reset: there is no migration, a pre-1.0
  clean break. SQLite and MySQL are unchanged.

- **A PostgreSQL writer sends statements without waiting for each answer.** Its client pipelines (node-postgres
  `pipeline: true`), so a transaction that asks several statements together pays one round trip for them, and one asked
  at a time is sent and answered as before. Only inside a transaction: a failure aborts every statement behind it, and
  the server never says it is idle while one is still in flight, which is what keeps a pipeline on its one server
  connection behind a transaction-mode pooler (PgBouncer, PlanetScale's port 6432) whatever its version. The SQL
  tool's lease, which brackets each statement in a savepoint, still asks one at a time.
- **A save's opening reads leave with its BEGIN.** A tenant command on PostgreSQL sends its membership fence, its
  receipt lookup, its record's row lock and the record read once in full right behind the BEGIN, in one round trip,
  and every later read of that record by key before the write is answered from that row. Each statement sent ahead
  answers only the identical statement asked later, once; a write, a savepoint, a notification, a row lock asked in
  its turn or a failure drops what is left, and one that fails rolls the transaction back and begins it again without
  them, counted. A warm Qualify lead at 25 ms from its database executes in 14 round trips where it took 28 (0.78 s
  where it took 1.58), its prepare in 7 where it took 10. A save outside a tenant App, and a tenant's intake, service,
  platform and support writes, still ask in their turn.
- **A save's bookkeeping leaves with its COMMIT.** The record read back after a tenant command's write now leaves in
  the write's own round trip, and the receipt, its audit, the live change and its notification leave with the COMMIT
  instead of one by one. One that fails turns the COMMIT into a rollback, and the command is told it was not applied,
  with that write's own error. A warm Qualify lead at 25 ms from its database executes in 6 round trips where it took
  14 (0.38 s where it took 0.78).
- **A record's history, its notices and their channel messages leave with the COMMIT too.** On a PostgreSQL writer that
  pipelines, a save of a table that keeps history no longer waits a round trip for each history row, notice and queued
  channel message: they are sent with the COMMIT, made from the before image the first round trip read under the row's
  lock, and one that is refused rolls the save back.
- **A command is one journal row.** The receipt, its audit and its event batch's manifest were three tables and three
  inserts; they are one row of `__mistri_command_receipt`, written in one statement with the COMMIT, and a retry's
  lookup reads that one row. Events and deliveries reference it. A command keeps at most 4 MiB of changes across its
  targets, and one past that is refused with a request to split it. On PostgreSQL `completed_at` is a `timestamptz`,
  indexed, and the daily retention job now forgets receipts past the App's `commands` window: never one that carries
  events, or one an event destination has taken up. The journal, event and delivery store layouts change, with no
  upgrade before 1.0: a database that has them drops them and runs `mistri migrate stores up` again.
- **A save without a row policy sends its record ahead too.** On PostgreSQL an App's own save and a command that
  runs without a row policy now send the record's row (and its lock, where the save or its history takes one) behind
  their BEGIN, as a tenant or row-scoped command already did, and the reads of that record, including a guard that
  names the state it moves from, are answered from it. Tick's save is three round trips where it was four, Thread's
  three where it was six, Commons' lock four where it was seven. `test/write-flights.test.ts` holds one write of each
  sample App to its budget and fails a write that falls back to one round trip per statement.
- **Preparing a command is two round trips, and a one-click command skips it.** A command's preparation, the read
  that fills its form, sends the record's row behind its BEGIN on PostgreSQL, so the target check and the revision are
  answered from it: BEGIN and COMMIT, where it was four round trips, and no row lock with them. A command that runs on
  one click asks its revision as the pointer or focus reaches its button, so the click sends only the execute; a
  revision the record has moved past is refused before any handler runs, and the click prepares and sends again.
- **Tenant administration and public placement keep one row per operation too.** Each wrote a receipt and an audit
  row and, to attest them, scanned for a receipt without its audit; now the audit columns sit on the receipt, one
  INSERT records an operation and one SELECT finds it again. The administration, invitation and placement store
  layouts change, with no upgrade before 1.0.
- **Runtime stores are attested when they are opened, not in every transaction.** On PostgreSQL the tenant store,
  the administration journal, the support audit, the invitation store, the command journal and the event store are
  compared with their layout, binding and ownership the first time an adapter uses each, and not again until a
  statement fails for a table, column or privilege that is not there, or the server restarts. They take no table
  locks, a fence reads only its rows, and a tenant command's last fence before COMMIT reads nothing, its rows still
  locked. The schema epoch no longer carries the journal's meta row, the event store no longer re-reads a batch it
  just wrote, and the administration journal no longer scans for a receipt without its audit. A GRANT, trigger or
  index made on runtime tables while a server runs is now seen at its next start, not at the next COMMIT: the database
  role is the boundary. A warm Qualify lead at 25 ms from its database executes in 3 round trips where it took 6
  (0.21 s where it took 0.38), its prepare in 4 where it took 7.
- **A tenant write is proven by its transaction, not by snapshots around it.** A save or a command read the membership
  in a snapshot of its own at admission, again after its callback and once more before its answer left, each a round
  trip or two beside the writer's fence, which already locks the tenant and membership rows from BEGIN to COMMIT. Those
  three reads are gone for writes (reads are unchanged): a warm Qualify lead at 25 ms from its database asks 42 round
  trips across prepare and execute where it asked 57, prepare answering in 0.57 s (0.92) and execute in 1.77 s (2.13).
  The guarantee is now stated exactly: the membership holds from BEGIN to COMMIT, a revocation that begins during the
  write waits for its COMMIT, and one committed after it does not change the committed write's answer, which until now
  was withheld as unknown though the write had landed. A revoked or suspended member's command is answered 403
  `forbidden` (outcome `unknown`, as before its receipt is read), where it was a 503 asking for a retry.
- **One write refreshes what it can affect, once.** On a tenant record page 25 ms from its database, qualifying a lead
  set off 11 requests in four waves after the write answered, and settled 8.2 seconds after the click; it now sets off
  two, in one wave (the record page's compose and its list), settling in 6.0 seconds, most of it the command itself
  (a field report gave 65 to 112 requests and 11 to 32 seconds). The page's own write coming back on the live stream is
  measured from the moment it was answered, so it asks again only a read that began before that, and no longer
  discards the composed page's answers; a change pushed to the record on screen no longer asks every list and count on
  the connection again; and a tenant App's reads, batched counts and breakdowns now say the tables they read, so a
  change asks again only the reads it touched.
- **A tenant database is not asked about its catalog on every request.** Each read snapshot of a PostgreSQL tenant
  App read the whole-catalog digest (three quarters of a field report's database time); an attestation, or a digest that
  proved it still stood, now stands for five seconds, in which a snapshot begins with its LOCK alone, and a read that
  fails on a table or column that moved forgets it at once. A tenant writer pins every relation it owns and its
  store in the message that reads the schema epoch, and attests in full only when the epoch has moved since the last
  attestation passed: the attestation's eight catalog round trips a write transaction before, none now (the store's
  fence still reads its layout under its lock, as it must).
- **One primary-action color per look.** Lumen's record and list header primaries, a dashboard note's action, an
  empty list's action and a landing's search now fill in the ink (`colors.primary`) as its forms and dialogs already
  did; the blue accent stays for links, selection and focus. Mono and Sage keep their accent everywhere; a custom
  theme's `colors.primary` now reaches those surfaces too.
- **PlanetScale Postgres starts.** A URL ending `sslrootcert=system` (libpq's "use the system roots") is read as a
  verified connection with Node's default CA store by every Postgres connection mistri makes, not only the pool; it
  failed with `ENOENT: open 'system'` before. `sslmode=disable` still forces no TLS.
- **Extension-owned relations are not the App's.** The catalog description, its digest and the role-privilege count
  leave out relations an extension owns (PlanetScale's preinstalled `hypopg` views, PostGIS's `spatial_ref_sys`), so a
  tenant App no longer refuses to start over tables the policy could never name.
- **A public page's door.** A `public: true` free-form page runs the `public: true` commands it names for a signed-out
  visitor through `/api/pages/<page>/commands/<name>`, with a ticket the page asks for (`/api/pages/<page>/ticket`, at
  least three seconds and at most a day old), from the page's own origin only (an embedding host's is refused), under
  the public form's rate limits, a 64 KB body limit, its submission key and the public principal's grants. The answer
  is `{ reference, receipt }`, never the input. Every instance that opens the door needs the same `MISTRI_FORM_KEY`: a
  start that knows it is one of several refuses without it, a production start warns, and `check --deploy` says so
  (`deploy-form-key`).
- **A human check for public doors.** `auth.challenge` names a check the commands module exports
  (`export const challenges = defineChallenges({ … })`). A public form's submit, each saved step of a form saved on
  every step, a form under a row policy and a public page's command ask it before the body is read and refuse with
  403 `challenge_failed`. A request spends its client's budget first, then the check, and the App-wide budget only
  after it, so a flood of requests without tokens cannot crowd out a person's. A token counts once: the stock form
  resets the widget after every answer and retries with a fresh token under the same submission key. The stock form
  draws the provider's widget, whose origin joins the page's Content-Security-Policy. Every stock public form also
  carries a decoy field that autofill and screen readers skip: a submission that fills it is answered as if it went,
  writes nothing, and is counted as the outcome `decoy`. `packs/challenge-turnstile` makes Cloudflare Turnstile one
  provider, checking the token's host name (the App's own unless `hostnames` lists others) and its `action` when one
  is set, with `turnstileStub()`, which takes each token once, as a local stand-in for tests; core never calls a
  provider. A tenant App's public forms ask the same check in the same order, on its shared host and on a tenant's
  mapped host alike: one check for the App, its secret the deployment's and never in anything a tenant or a visitor is
  sent.
- **A tenant App's public form offers each tenant its own choices.** A `field.choice({ from })` on a tenant App's
  public form is served the rows of the tenant its link places (its `?via=` address, as the submission is placed, or
  the tenant's mapped host), read as that tenant's visitor under `auth.public` and `resolvePublicRows`, and kept per
  tenant: the tenant is in the copy's key, one tenant's copy is never served under another's address, and a change in
  one tenant drops that tenant's copy alone. A choice table is captured whether or not the App asks for live sync. An
  address that places nobody is offered no rows, and the page reads none of its own: served options say so
  (`source.served`), so an empty list offers nothing instead of a read the shared host refuses. A form's read takes `?via=` once and nothing else; the list of forms
  takes no parameters.
- **One rule places a tenant App's public form.** A form's read, its submission and every saved step are placed alike:
  on the tenant's mapped host by the intake address that tenant holds (through the intake's one resolution and fence),
  on the shared host by `?via=`, and an address on a mapped host is `400`, so one tenant's host can neither draw nor
  land another tenant's form. A submission on a mapped host with no address used to go to the platform's triage, and
  a choice read there was then refused as not one of the choices; a tenant that holds no address still goes to triage.
- **A public form's key that names no form costs no one else's budget.** On the ordinary host and a tenant App's host,
  a POST to a key that matches no form is answered `404` from the visitor's own budget, before the human check and the
  App-wide ceiling, so a flood of invented keys never spends what a person's submission needs.
- **A tenant App's host believes `--trust-proxy` on its public doors.** Its public forms and visitor reads keyed every
  visitor behind a proxy as the proxy, and the human check was told the proxy's address; the tenant host now takes the
  proxies `--trust-proxy` names for those doors, as its App API already did.
- **A public form's body is held to 64 KB as it arrives.** The length header was the only check before the human
  check, so a chunked body of any size reached the provider. Both hosts now read the body under the envelope before
  the check and answer `413` (closing the connection) the moment it is passed.
- **A public form's body has ten seconds to arrive.** Holding the body before the check let a visitor with no token
  trickle bytes and keep the socket for the server's whole request timeout. The hold now ends at ten seconds with
  `408`, closing the connection, on both hosts.
- **A public form's flags are placed as the form is.** The flags and experiments a public form's page reads were
  placed by the address header alone, so on a tenant's mapped host a page sent no address and was placed with no
  tenant, and one that sent another tenant's address was placed there. They now take the forms' one rule: the mapped
  host places by its tenant's own intake address, and an address beside it is `400`.
- **A live page keeps drawing under a stream of changes.** A change heard while a read is out no longer cancels it:
  the page waits for that read and reads once more after it, never more, so a table changing faster than a read
  returns cannot keep a page from painting (a 6-second read under a change every half second went from 46 seconds to
  11.5 to paint). A read that began after the change but failed or was cancelled no longer counts as showing it, so
  it is still asked again. A stream flush that stalls is scheduled again.
- **"Session unavailable" waits for a second answer.** A session check that times out, loses its connection or gets a
  gateway's 502, 503 or 504 is asked once more after a short, spread pause before the App is locked as unavailable. A
  401, a 403 or another person's session still locks at once.
- **Choices from a table are kept until a row changes.** A `field.choice({ from })` reads its rows once and keeps them
  until change capture says the table changed (in this process, by `NOTIFY` on PostgreSQL, by the poll on SQLite),
  never for a set time; a choice table's writes are captured whether or not the App asks for live sync. Every reader
  shares the copy except in a row-policy or tenant App, and the copy is kept per source and resource, so two sources
  with a table of one name never share one. A public form's options arrive in its payload under an ETag. The copy
  only offers: a submission reads its chosen key by primary key inside the command's transaction. The first poll of a SQLite or MySQL
  change store now reads instead of taking the head as its baseline, so a commit between the hub's start and its
  first tick is heard.
- **A public form draws the App's own input components.** `inputs` on a public form and a field's `input` load only
  the components that form draws, from where its payload says they are served; the server still reads each value as
  its field's kind. The home and dialog presentations of a public form send its decoy and the widget's token too.
- **Hero blocks.** `hero(…, { badge, tiles, points })`: a short badge above the heading, two to four photo tiles from a
  public file resource in place of one image, and up to four icon rows in place of highlights, all in the look's
  tokens.
- **Command forms, a follow-up.** Several choices `as: 'cards'` are icon cards, one group to the keyboard (Tab
  reaches it once, the arrows move, Space turns one on or off). A draft condition reads an unanswered field as null,
  three-valued as SQL is: `joint = false` and `joint != true` do not hold until someone answers, in the browser, in a
  step's check and in the run; `is empty` reads the null itself. A form's `description` is said once, on its first
  step. The review lists a group's answers as "Label: value" lines. The intake style marks a text, number, amount or
  masked box with a quiet check once it is left holding an answer its own rules take. An amount reads grouped
  (`2,500`) once typed; `field.money({ as: 'slider' })`, which parsed but drew a text box, is a slider read in the
  currency, and every slider says its two ends. A `statement` may stand beside a box that may be left, not only one
  that must be checked, and is drawn once, its label read but not drawn. An optional word stays at the end of a label
  that wraps. `rules` is typed on a command's definition.
- **A storefront's placed form draws the App's own input components**, served from where the App serves them.
- **A public page's commands carry their table choices.** `page.useCommand(name).choices(field)` gives a page's own
  control the rows of a `field.choice({ from })`, served with the App's payload under `auth.public` and kept until a
  row changes; `check` holds a public page's picker to `auth.public` as it does a public form's (`[public-form-picker]`).
- **`@mistri/ui` exports the hero blocks**: `Badge`, `PhotoTiles` and `IconRows`.
- **`settled(page)` in `mistri/testing`.** The wait `mistri grade` and `mistri shot` use, for a Playwright test: no
  request but the event streams in flight for 400 ms.
- **Every command form is quiet until touched.** A command dialog, a form page in the shell, on its own or public, a
  resource's New form and both step styles draw a field at rest as a clean outline on the page's own ground
  (`--field-edge`, derived to hold 3:1 against the ground in every look); the field in focus wears the one ring with
  its border cleared under it, a wrong one its danger edge over a faint wash, and only the primary action is filled.
  A label asks in the ink at 14px in the regular weight with its help at 12px in the muted ink under the field; fields
  are 20px apart and a New form's sections 16px more; every listbox ends in a 16px caret icon; and a drawer's last
  help line no longer sits on its footer's hairline. An optional answer says "(optional)" beside its label instead of a star on every needed one (the New form
  too); Show sits inside a sensitive field; Back is a quiet word; its review is the intake's summaries with a quiet
  Change, and on a phone a stepped page's actions rest at the screen's foot. Each surface keeps its own density. A record's inline edit, a grid's cell, filters,
  the query bar and the Workbench keep their 3:1 edge. The intake style's type is set again: its question runs a
  display size (28px on a phone, 32px at a desk) at a tight leading; a step's help and a section's words under it are
  one size and one muted color, regular weight, with no rule under the section; a checkbox's words are an answer, in the
  regular weight; and a review heading that is a whole sentence wraps in its own column beside Change.
- **One step indicator.** Every form with steps, either style, on a page or in a dialog, says where the reader is
  under one thin bar with "Step n of m" beside it; the stepper's row of numbered tabs is gone, and its primary says
  Continue (the step's `next` word when it has one) rather than Next.
- **A stepped page's steps stand beside it at a desk.** From 1024px, where there is room, a form with steps drawn as a
  page — public, a signed-in command page, a stepped New page — keeps its 40rem column and lists its steps in a sticky
  column to the right: a step done is a link back with what it said in a line, the step in hand says
  `aria-current="step"`, a step ahead is quiet. The review lists names alone; a dialog and a phone draw no list, and the
  list is in the first frame, so nothing moves when it shows. Cards whose words are short stand two or three to a row
  there.
- **The review reads as a list of answers.** One type size, the label muted beside its value (its column at most 208px,
  stacked on a phone), Change a quiet link beside its step's name, 24px between sections. An optional question left
  unanswered is no longer listed.
- **A record form's fields stand in rows.** A resource form's `show` and each group's `fields` take the steps' row
  syntax, `show: [['email', 'phone'], 'company']`: up to three fields read together side by side in the New drawer
  and on the New page, every box one height and level with its neighbor's whatever help or error stands under it, and
  one column once the form is under 30rem (measured on the form, so a phone's drawer stacks and a desk's does not).
  `check`, the schema and the published types accept rows and refuse four to a row, a field named twice, and a step's
  row across two groups. Everything that reads a form's fields still reads one flat list; the rows ride beside it.
  A form read again from its parsed shape keeps its steps' rows rather than refusing them. Compass's New lead pairs
  Email with Phone and Source with Owner; Lintel's delivery form pairs Part with Quantity.
- **A landing hero with icon rows and no photo sets them beside the words at a desk**, where the photo would stand.
- **A public form's receipt ends in a quiet way back to the App** ("Back to {App}"), on a page of its own, not in a
  dialog.
- **An intake page's brand row names the App beside its mark** at every width that has room, as other pages do.
- **`mistri new --template intake` checks clean as written**: the scaffold's staff list has an administrator role, and
  its public form no longer restates what `public: true` implies.
- **A form's fixes.** A bare word in a draft condition is read as the kind its field holds (`battery != no` against a
  choice); a masked text takes a `message`, said when the mask refuses an answer; every control in a row is one height
  (a listbox stood 8px short of the boxes beside it); one answer's cards draw a radio's round mark and several answers'
  keep the square; and the review reads an answer as its field drew it (`$450`, `(303) 555-0142`, a date in words).
- **`colors.primary` and `colors.onPrimary`: a form's primary-action color.** Continue, Submit and Add fill in it.
  Lumen sets it to its ink; Mono and Sage leave it to their accent; a theme that extends nothing takes its accent. A
  theme that changes Lumen's ink takes the primary along; one that names `primary` (its accent or its brand) gets the
  words on it derived to read at 4.5:1 unless it says `onPrimary`, which `check` measures and the compiler refuses
  without `primary` beside it.
- **A New form's field may be drawn as cards, buttons, radios or a listbox.** `form.fields.<column>.as` (`'cards' | 'buttons' | 'radios' | 'select'`) dresses a column with a vocabulary, or a flag, in a record's New and edit forms, as a command's field already could; a card draws its icon.
- **`mistri new --template intake`.** A public multi-step inquiry form on the stock intake block alone, with a staff list of what came in and its own browser test.
- **A form opens in a dialog from a signed-in record.** A headline link with `open: 'modal'` may now name a signed-in form view of the App, not only a public form. Lintel's unit page offers Report a problem this way, and its resident report is a three-step intake with a visit window.
- **A public form's page on a tenant host is titled by its form**, as on the ordinary host, not by the tenant's name.
- **A command that only adds rows can say so, and a note is then not refused for a record it never wrote.** A command
  declares `appendOnly: true` beside a `write` of other tables (a note, a comment, an attachment) and is refused as
  `stale_record` at its first write to the target, from the revision it read, not before its handler, so a record other
  people keep editing takes the note where all three of the form's tries were refused. A command that writes a field of
  its target is still refused when the record moved. Without the declaration nothing changes: the check stays up front.
  A machine's verb and a prefilled form keep it up front either way.
- **Pictures are delivered to be cached.** A picture read by nobody in particular (no sign-in, or a signed-out visitor to
  a public resource without a row policy) is `public, max-age=86400, stale-while-revalidate=604800`, and
  `public, max-age=31536000, immutable` at an address that names its bytes (`&h=`); a picture read by a person or under
  a row policy stays `private, no-cache`, which a test holds for every cell of the matrix. The format is in the address
  (`&f=avif|webp|jpeg|png`) and a page offers AVIF and WebP through `<picture>`, since a CDN ignores `Vary: Accept`; a
  bare `&w=` still answers by `Accept`. A picture behind a sign-in proxy (`--auth-proxy-header`) is a person's too, and only an address that names its
  format is shared (an `<img>` fallback says `&f=fallback`). Variants of a public resource are also kept in the file
  resource's bucket (`<prefix>_variants/<app>/`) so instances share them; the files sweep deletes the copies of a
  removed picture. Pre-made copies start after the commit, are bounded, and yield to a visitor's request. A public picture is made at upload in AVIF and WebP at five widths, and keeps its true size and
  average color, which the server's drawing of a public page uses to hold the room (`&meta=1` returns them), read only
  where `auth.public.fields` lets the visitor read the thumbnail.
- **A public form opened by its view key is the form.** A signed-out visitor who opens `/request-viewing` (a link, a typed
  path) is sent to the form's own page, `/form/request-viewing`; it said "This page is for signed-in members", because
  the key was read as a list. A tab folded into "More" is reachable to `mistri grade`'s C13 (the menu item carries the
  tab's count after its name). A full-screen dialog drops a theme's edge, so a dark phone shows no light 1px line.
- **A breakdown's bars wear the colors of the column they group by, and a clipped line says itself on hover.** A group
  of a column with display `tone` (a severity, a state) is drawn in that tone, as its chip and a chart's bar are. The
  grid gave a title on hover to a cell that overflowed but not to a line the cell cut inside itself (a row's name over
  its detail), which ended in an ellipsis with no way to read it.
- **The read-your-write cookie follows the product.** A write sets `mistri_fresh` under mistri and `tablewalk_fresh` in
  the database browser, as the environment variables already did; an App still reads a browser's old `tablewalk_fresh`
  and no longer writes it.
- **`mistri grade` and `mistri shot` wait for the page, not for `networkidle`.** An App with `live: true` holds
  `/api/live` open for as long as a page is shown, so the network never went idle and grade timed out on its first
  page (Lintel). A page is settled when every request but the live streams is answered and none starts for half a second.
- **`mistri new --brief <BRIEF.md>` drafts an App from an approved brief.** The mistri skill's step 0 is now an
  interview (`references/interview.md`: rounds of at most four questions, each with a default) and a `BRIEF.md` the
  person approves before anything is built; its machine block (`json mistri-brief`: entities and fields, roles,
  commands, look) becomes `db/schema.sql`, the first migration, a SQLite database, and the draft `--scaffold-app` makes
  over it, with the roles, a command stub apiece (a command that moves a status the machine draws takes that verb) and
  the look.
- **Motion has a check.** `test/check-client-motion.mjs` fails `npm test` on `transition: all`, `ease-in`, `scale(0)`,
  a literal duration over 300ms and a `:hover` rule outside `@media (hover: hover)`; the `:hover` rules older than the
  check are counted per file and only shrink. `docs/design.md` gains `--ease-drawer`, press, tooltip, performance,
  mobile and truncation rules.
- **Brand.** The monogram is the site's favicon set, link preview and manifest, and the top of each `@mistri/*` README.
- **`/docs/` opens at getting started** on the site.
- **Security upgrades.** The image and `engines.node` move to Node 24.22.1; `zod` 4.6.7 (through Better Auth),
  `sanitize-html` 2.18.1, Electron 43.8.3, Storybook 10.6.3, happy-dom 21 and Astro 7.4.2. The desktop app's `keyv`
  stays 4.5.4, which is outside the August 2026 Shai-Hulud list (that names keyv 6.0.0). `npm audit --omit=dev` leaves
  `fflate` under `satori`, which needs a breaking `satori` change.
- **The intake style for forms with steps.** `style: 'intake'` on a `commandForm` draws one question at a time under a progress bar with the step's `title` and `lead`, a sticky action bar, Skip and a step's own `next` word, `note` under the title, and an editable review that masks a sensitive value (`review: false` leaves it out). `step()` takes `{ title, lead, next, skip }` and a row of up to three inputs drawn side by side. The stepper shows a step's `label` and keeps the page from scrolling sideways after Next.
- **A public page carries only what its form asks.** The stepper and its parts, the intake sheets, the draft's logic
  (a `when`, a rule), the live lines' expression parser and the server's step check load on demand, and a public form's
  page fetches them before it mounts only when its form has steps, conditions, rules or live lines; the landing,
  sign-in and a one-page form carry none of it. `parseCommandInput` is now `shared/commandInputParse.js` and
  `parseComputed` `@mistri/engine/shared/computedParse.js`, so the browser's modules no longer reach either parser.
- **Field vocabulary.** `field.money` (a symbol prefix, cents, its own type), `field.month` (MM/YYYY, served `YYYY-MM`),
  `field.choice`/`field.choices` from a table (`{ from, label, by }`, checked against its rows by the run), `choices`
  with `min`, `max` and an `exclusive` option, a text `mask` (`'000-00-0000'`), a boolean's `statement` (a consent's
  whole sentence) and `as` (`'buttons'`, `'cards'`, `'slider'`, `'select'`) to draw a field another way.
- **Draft logic.** A field's `when` is a condition over the draft: a bare name is another answer, `record.<column>` the
  target's (`when: 'open_parts > 0'` is now `when: 'record.open_parts > 0'`; the old spelling fails with the rewrite).
  A command's `rules: [{ must, when?, message }]` are said at their field at each step and refused by the run. A step is
  checked by the server before Next (`/api/forms/<key>/check/<step>` for a public form, `/api/commands/check` signed
  in): 60 a minute from one client, 6,000 a minute in all, nothing run or kept.
- **Sensitive answers.** `sensitive: { keep: 'last4' | 'hash' | 'handler' | 'none' }` on a text field: the value is
  drawn masked with Show, never prefilled, never in an address, a `when`, a `live` line or a rule. The journal, the
  audit, events and the fingerprint hold only what `keep` says; `'handler'` hands the whole value to `handle` alone, an
  output that says it back is refused, and an error that quotes it reaches stderr with the value cut. The dev observer
  masks a declared sensitive input by its name, and a public form's failure is now reported on stderr (its reasons,
  never its body).
- **A form with steps answers Enter**: Enter in a typed answer presses the step's primary (an open list, a box of
  lines and a checkbox keep theirs). A public form's page carries its `<title>` from the server, an intake form's
  label alone. A field's `input: 'name'` draws it with the App's own input component in every signed-in form that
  asks it; a public form refuses it. A number's `live` lines are drawn under it, and `check` refuses a line it cannot
  work out.
- **`visual-matrix --smoke` reads every App page at 320px and 2x** (`reflow-320`, the App's own look), so a form or a
  list that scrolls sideways at 200% zoom fails the smoke. Form labels and choice cards wrap rather than clip.
- **Theme reach for forms.** A theme may set `colors.<mode>.field` (`--field-fill`, ink measured on it at 4.5:1),
  `shape.height.control` (32px to 56px, `--control-h`, which a field, a select and a button now share; `--control-height`
  is gone), `shape.border.control: '0px'` (allowed only when the fill stands 1.08:1 off ground and surface in light and
  dark), title and display leading down to 0.85 (`check` warns under 1.0), and four recipes: `required`
  (`star` | `optional-word`), `checkbox` (`native` | `drawn`), `formStep` (`plain` | `ruled`) and `actionBar`
  (`plain` | `raised`). `--rules-control` is now `--control-border-w`. Lintel's Hearth wears the warm fill, no edge and
  the optional word.
- **Mobile.** Every served page's viewport is `viewport-fit=cover, interactive-widget=resizes-content`; the head carries
  `color-scheme` and `theme-color` from the worn theme; buttons and links set `touch-action: manipulation` with our own
  press; inputs are 16px and controls 44px under a coarse pointer; `prefers-contrast: more` and
  `prefers-reduced-transparency: reduce` are honored.
- **`mistri check` removes the generated types under their 0.9 names.** When it writes `mistri-schema.d.ts`,
  `mistri-commands.d.ts` or `mistri-components.d.ts`, the `tablewalk-` file beside it goes too, when its header says a
  generator wrote it; one kept by hand is left alone.
- **A dashboard tile read moments before the minute is not read again at the minute.** On an App without live sync,
  a page opened at :58 asked for every tile again at :00; an answer younger than fifteen seconds now waits for the
  minute after (`minuteTick`, by Query's `dataUpdatedAt`).
- **The App API's event feed on PostgreSQL reads below its own database's horizon.** A transaction held open in
  another database on the same server no longer holds `/$events` back; one in the App's own database still does, as
  live sync's change store already read.
- **`mistri check` says when a resource's `live: false` does nothing** (`live-unused`): on an App that does not say
  `live: true`, no table is followed, so leaving one out changes nothing.
- **A dashboard tile over a `live: false` table keeps the minute refresh on a live App.** Its table's changes are never
  announced, so it re-read only on its two-minute staleness; now only those tiles tick each minute, as every tile does
  on an App without live sync.
- **`useCommand().run()` resolves with the command's output.** An applied run is `{ status: 'applied', output }`,
  `output` being what the handler returned, so a custom component opens the ticket it just raised by its id instead
  of looking it up by a timestamp.
- **A strip of tabs fits its row and never scrolls sideways.** A record's tabs and a list's tabs (saved views with
  them) put what does not fit under a More at the strip's end, on a phone and on a narrow desk alike; the chosen tab
  is always drawn, and the fold is decided before the first paint, so no tab moves after it. A tenant App's strips ran
  648px in a 627px room at a desk, and past a phone's edge on its cases, alerts and quote approvals.
- **One form, one voice, on every surface.** A form of plain boxes says its optional word after a space, as the New
  drawer does; a command form's amount says its currency inside the box, as a New form's money does; a choice card's
  help and a live figure take the muted ink; the sign-in door, a prompt and the account profile fill their one action
  in the primary-action color. A landing grows with a wide desk past 1440px, to 80rem at 1920, instead of standing in
  its middle half. `node scripts/surface-atlas.mjs` sets every kind of surface an App draws beside the others, a
  column per look, in `.visual/atlas.html`. Lintel's picker adds Tidelight, a brand over Mono in one theme block.
- **A tenant App on PostgreSQL survives a lost connection.** A read whose connection the database ended under it (a
  failover, a restart, a pooler recycling its server connections, an idle timeout) could not send its ROLLBACK, and
  that retired the App's private tenant reader for good: every sign-in, read, live stream, job and mail pass after it
  was refused with `tenant_context_unavailable`, and each page that heard it lost its lease, until the process
  restarted (a field report behind PgBouncer: five times in forty-five minutes). That read is still refused, as the
  database's fault (503 `tenant_temporarily_unavailable`); its pool is replaced by a fresh one, attested again, and
  every request after it is answered. A platform-only source does the same.
- **Live sync no longer ends every stream when the last one leaves mid-read.** A hub's pass that went on after its
  last subscriber left read from no position ("Cannot read properties of undefined (reading 'xact')") and ended the
  streams that had joined meanwhile, which under connection loss was often. A pass now stops with the hub.
- **The PostgreSQL authentication store works behind PgBouncer.** Better Auth's unqualified table names reached the
  store's schema through a startup `options` parameter, which a pooler does not carry to the server, so behind
  PgBouncer every sign-in failed with `relation "user" does not exist`; and startup's separation check sent
  `statement_timeout` as a startup parameter, which PgBouncer refuses, so an App with a PostgreSQL store could not
  start behind one. The store now sets its search path and cap on each session it owns, or in each transaction under
  `--pooler transaction`; the check bounds its reads in the driver. Behind a transaction-mode pooler the migration
  tables' readers (the Console, governance, analytics provisioning) no longer leave a `lock_timeout` on the pooler's
  server connection, and a migration or store upgrade, which holds a session lock, refuses there instead of locking
  one server connection and unlocking another.
- **Manage tenants, invitations and support receipts reopen after an unconfirmed write.** An administration
  operation whose COMMIT or ROLLBACK a lost connection could not confirm retired the administration store for good, so
  every tenant, member, invitation and support-history call after it was refused until a restart. That operation
  still answers `unknown`; the store now closes behind what was admitted, reopens where it was, attested again, and
  serves what follows, as the App's writer does (`tenantWriterLifecycle.ts`), with `/readyz` answering 503 while it
  is closed.

### Decisions

- **A model may answer one field of a record: `defineDecision` in the jobs module.** A decision names a question, the
  record's fields it is asked from, and the command and input field its answer lands through, so its type, grants,
  machine and history are that command's. It asks after a command commits (`on`) or on a clock over the records a
  `where` holds (`every`), as a principal the jobs module declares (`runAs`), never inside a handler. Jev and Claude
  are its providers, each from the operator's key; without one nothing is asked and nothing is shown.
- **It suggests until it is measured.** At or above `suggest` (0.6) a person meets the answer on the empty field, its
  confidence in words, with **Accept** (the command, as them), **Change…**, **Dismiss** and **Why this?**; a list marks
  the empty cell. Nothing moves when a suggestion arrives. At or above `apply` the command runs by itself, only for a
  model version `mistri decide eval --pin` pinned in `decisions.lock` after measuring it on records people settled;
  any other version, or a fallback provider, only suggests, and a value a person set since is never overwritten.
- **What is kept is names, not values.** A new reserved store (`__mistri_decision_*`, provisioned by `mistri migrate
  stores up`) keeps each asking's inputs' names, a digest of what was sent, the answer, its probability and how people
  settled it. A tenant App's customer is off until the platform owner turns decisions on for it, per provider, with a
  consent reference.
- **`mistri decide eval`** reports accuracy, calibration and what the thresholds would have done, spends only with
  `--yes` under `--max-cost`, and prints what one record would send with `--dry`. A row-policy App names its policy
  with `--policy`. `startTestApp({ decisions })` and `evaluateDecision` test a decision against a scripted model.
- Lintel suggests a technician for each new repair (`routeRepair`).

- **A connection cut during a save answers 503, not 403.** A write or command that failed because the database did not
  answer (a cut, a terminated backend, a pool that could not lend a connection) says `temporarily_unavailable` with
  outcome `not_applied`, and a writer reopening itself says the same; it used to say "forbidden". A cut after the BEGIN
  still answers outcome `unknown`, as the transaction contract says.
- **A sign-in store is read once every few seconds, not thirteen times a request.** What a PostgreSQL store answers
  about a session is kept for five seconds (`MISTRI_AUTH_SESSION_CACHE`, 0 to 60) and any write through the process
  drops it before the write leaves and when it is answered, so a sign-out or a revoked session is seen at once here; one
  made elsewhere is honored for at most the TTL. Behind a transaction-mode pooler a statement and its transaction leave
  in one round trip where three were awaited. `MISTRI_AUTH_POOL` (1 to 64, default 4) sizes the store's pool.
- **A large tenant App opens its port in seconds.** Startup checked each command and role against the same catalog
  again and again; it now works each answer out once. A synthetic App of 250 tables, 150 commands and 10 roles spends
  1.9 s of CPU in enrollment where it spent 6.4, and 2.7 where it spent 14.9. Every refusal says the same words.
- **A tenant's record page asks half as many round trips.** The membership rides in the message that begins a read
  snapshot, a tenant reader pipelines, and an action's guards are asked at once. A record page goes from 46 messages in
  46 flights to 33 in 22, and a save with what the page reads after it from 60 flights to 32.
- **The assistant says it is working, keeps its turns short and says what went wrong.** A question that matched
  nothing no longer draws "No rows match." and goes looking again; a turn's cached input counts a tenth against
  `tokensPerTurn`, and a result is cut to about 6,000 characters. The panel says "Working..." at once and what each
  tool is doing, says why a refused conversation was refused with New conversation beside it, and reopens its last
  conversation only for the same account and customer. A restart mid-turn, a bare 5xx or a stream that closes early
  says the connection dropped, with Try again. `mistri check` no longer crashes on a tenant App placing the assistant
  as a page.
- **A conversation's top edge no longer cuts a message.** At its foot a conversation stands a little shorter than its
  most so its top falls where a message starts; the height was floored and put the edge up to a pixel inside one, and
  it is now rounded to within half a pixel of a line's start.
- **Workshop's primary actions are the look's primary color under an App accent.** A record's first action drew in the
  App's accent while the list's New and the dashboard's action drew in Safety orange. Every primary verb is the look's
  key now; the App's accent keeps its links and marks.
- **A reloaded record page by a person in two tenants chooses one first,** where it asked for a lease it could not name.
- **`prove-red` runs a checkout's CLI from source,** as the seeds do; with the built bin it failed before any variant
  ran.

## 0.9.9

0.9.9 brings live sync: on an App that asks for it, every write — a Save, a command, a job, an agent's — is filed in a
change store, and an open page reads again in place what another person changed, a list, a count, a dashboard tile or a related list, with no
reload. Beside it, the subsystems that are Stable at 1.0 are hardened: workflows check a call before its first try,
integrations retry what a provider would not take, and the assistant answers one turn at a time and keeps each reply
with its model. The names 1.0 freezes are settled (`ui.csp`, a landing's `description`, `ui.shell.search`, the has
filter's `whose`, the operator's steps in `tablewalk/maintenance`); an embed bearer no longer opens a tenant's tokens or
administration; the installed package carries no scripts and keeps its comments; and the gaps a field report found are closed,
among them a tenant App's first boot from a built image and date phrases read on the App's clock everywhere.

### Live sync

- **Live sync is an App's choice: `live: true`, off unless asked.** An App asks at its top; one that does not serves
  as before, `/api/live` answers it 204 and its writes file nothing. On a connection two Apps share, writes are filed
  when any of them asks, and only the Apps that asked are told. A tenant App asks the same way. A resource stays out
  with `live: false` (a log, a hot counter): its writes file no row, a transaction that also touched a live table
  names only that one, and a page over it refreshes as before; on an App that does not ask it changes nothing.
  `--no-live` still turns it off for every App, and the startup log says per App whether live sync is on, off by the
  App or off by `--no-live`. Lintel asks for it.
- **The server tells open pages which records changed.** Every write of an App that asks — a Save, a command, a job,
  an agent's — writes one row per transaction to a new reserved store (`__tablewalk_live_change`, provisioned by
  `tablewalk migrate stores up`), and `GET /api/live` streams the changed tables and keys to each reader, filtered for
  them: only tables and columns their grants read, under a row policy only rows in their scope before or after the
  change, on a tenant App only their own tenant's, and never a value. PostgreSQL wakes every process with `NOTIFY` at
  commit; SQLite and MySQL poll. Every read answers a `tablewalk-reads` header naming the served tables it answered
  from. `--no-live` turns it off; a database without the store serves on as before, and the startup log says so.
  Writes made outside tablewalk are not seen yet.
- **Open pages follow those changes.** A list, a count, a dashboard tile or a related list is read again in place
  and quietly, and a changed row is tinted for a moment (`--t-changed`, none under reduced motion). A viewed record is
  read again and says "Updated by Ana just now" (or "Updated just now" where the name is not readable). A record or form
  being edited is never changed under the person: a notice says who changed it, with Review changes (their change
  beside the person's own, and Take theirs per field) and Keep editing. A list the person is working in (a row
  selected, a menu open, the pointer over the rows, scrolled or paged on) holds behind "N updates · Show" and shows
  them on click or two seconds after they stop. A hidden tab lets its stream go after 30 seconds and reads once when it
  is shown. Reads are debounced for 150 ms and a query is asked at most once a second. Nothing reloads and no row is
  patched; the Workbench has no live sync.
- **Dashboards no longer take `refresh`; they follow changes live.** Under live sync a dashboard re-reads a tile when a
  change to its tables is announced, and re-reads the reads that depend on the time (a window such as `last 30 days`,
  `today`) each minute while the tab is visible; on an App without live sync it re-reads all its reads each minute
  while the tab is visible. An App that still says `refresh` is refused, naming the key. Remove it.

### Hardening

Durable workflows, the in-App assistant and integrations are Stable at 1.0; each was reviewed for failure, retry,
authority, limits, versioning and what an operator can see, and these are what the review fixed.

- **Workflows.** A `w.call` is checked before its first try: a path that leaves its connection's address, a method no
  request has, or a header the request owns (the host, the connection's credential, cookies, the content type or
  length) fails the instance at once and sends nothing. Such a call was sent again on each of its retries before it
  failed with nothing to say why, and a step could replace the connection's credential, which an effect never could.
  The step's hash is unchanged, so no instance in flight diverges.
- **Workflows.** Retry wakes a running or waiting instance where it is (Console's Wake), with nothing forgotten. A
  crash between a retry's commit and its wake-up's enqueue left the instance running with no wake-up, and Retry
  refused it as not failed, so it never moved again. The wake moves the instance's epoch: a wake-up still pending and
  the new one may both run, and only the newer takes a step or finishes.
- **Workflows.** An instance stopped by an error its own code threw (`workflow_error`) keeps the error's name and
  code, a short token each, and the Console says them beside the problem: "It threw TypeError ERR_INVALID_ARG_TYPE".
  It kept nothing, so an operator had a code and no lead. The message is never kept, since it may quote a payload or
  a credential. It rides in the instance's existing problem column, so the store's layout is unchanged.
- **Integrations.** A message quiet hours held, or a notice a write queued, that the provider will not take is tried
  eight times a minute apart and then recorded failed, as email already was. It was held and sent again every minute
  for good, and read "held" to an operator.
- **Integrations.** A connection's own `auth.header` (an `x-api-key`) is the request's, as `authorization` is: a
  `w.call` that names it is refused (`owned_header`) and an effect that names it is rejected, both before anything is
  sent, and the credential is written after a call's headers. Either could replace the connection's credential.
- **Assistant.** A conversation whose tool calls were kept without their results — a restart between the two writes,
  or a store that refused the results — could never be continued, because the provider refuses a call with no answer.
  The calls stay pending until their results are kept, and the history the model reads answers any call the events do
  not.
- **Assistant.** A conversation answers one turn at a time (409) and a person two at a time (429). Turns in parallel
  interleaved one conversation's events, and each passed the daily cap before any was charged.
- **Assistant.** A model call has five minutes, its stream included; a stream that ends without its end is said to be
  cut off rather than kept as the answer; and what the provider counted before a call stopped or was cut off counts
  against the caps.
- **Assistant.** The open record's title is quoted as JSON in the person's message, so a quote or a line break in a
  record cannot end the context and speak. A store of another layout version says to migrate or upgrade, not to
  provision. A failed answer is logged by its kind, never its text.
- **Assistant.** Each reply is kept with the model that made it, and a conversation continued after the App's `model`
  changed hands the new model the earlier replies without their thinking blocks, which were signed by another model.
  They were replayed to it as they came. A reply kept before 0.9.9 names no model and is read as the current one's.
- **Assistant.** An ordinary App's conversations are purged once untouched for 90 days, every six hours while the
  server runs, by the same purge and default a tenant App's use. Only tenant Apps purged; an ordinary App kept every
  conversation for good. There is no new key; usage rows stay, since the caps read them.

### Security

- A start that serves sign-in beyond this machine at an `http:` public address warns once that its session cookies
  are never marked Secure, and names the fix: a TLS proxy in front, and `TABLEWALK_PUBLIC_URL` set to its https
  address. It still starts. A mounted handler's `fetch` called without a `clientAddress` warns once that every
  visitor shares one sign-in rate limit and lockout; Mount in your server says how to pass it.
- A cross-origin embed bearer no longer opens a tenant member's API-token routes (`/api/tokens`, issue and revoke),
  as it never opened the sign-in and account routes. A script on the host page that read the bearer could trade its
  hour for a token good for up to a year. A member issues tokens from the App's own page.
- Nor does it open a tenant's administration (`/api/tenant/administration`), its invitations
  (`/api/tenant/invitations`) or saving an integration's settings and secrets (`/api/integrations/save`). A script on
  the host page could grant a membership, invite someone who keeps one past the bearer's hour, or replace a
  connection's credential. An embedded App still opens its tenant and reads which integrations are connected.
- A role's `claims` may name the provider they are read from: `claims: { provider: oidc('workforce'), groups:
  ['admins'] }`, and a sign-in through any other provider never reads the rule (0.8.5 I1). A claim of the right name
  from any of an App's providers gave the role, so a contractors' IdP that also sends `groups` could give `admin`.
  A rule without `provider` still reads every provider's, which is the same thing where an App has one; with more,
  `tablewalk check` warns (`claim-any-provider`). A `provider` the App's `providers` does not name is refused
  (`claim-provider-unknown`). authority.lock records it.
- A file's key in a bucket never climbs out of its App's prefix: a tenant id of `.` or `..` is filed with its dots
  escaped, and the platform realm refuses a key whose tenant segment is one. The bucket's address resolved such a
  segment, so a tenant named `..` would have filed its objects one level up.

### Fixes

- A tenant App's writer closed by a write whose outcome could not be confirmed reopens by itself. It stayed closed
  until a restart, so under load one cancelled COMMIT refused every write, the inbox and the outbox of the App's
  tenants, and `/healthz` and `/readyz` both answered 200 (G193). It now reopens where it was, attested again, backing
  off from one second to a minute; reads the uncertain command's receipt to log whether it committed; and logs one line
  at the close and one at the reopen. `/readyz` answers 503 while it is closed, so an orchestrator moves traffic and
  replaces an instance whose writer does not come back. A SQLite file whose path now names another file is still
  never reopened. A command retried with its idempotency key is answered from the journal, never run twice.
- Every date phrase an App reads is read by the request's clock in the App's `ui.timezone`, as a list's is: a rollup's
  `query` (`count('task', { query: 'due_on = today' })`), the App API's and App MCP's view and segment questions, a
  command's `when` and its handler's `db.where`, a lookup's `where`, a fixed action's `when`, a bulk action's targets, a
  row policy's `db`, a public route's and its sitemap's `where`, and an import's list query. They read the server's
  zone, so a team in Chicago saw tomorrow's tasks counted once a server in Tokyo had turned the day. A tenant App's
  computed `today` was zoned twice, and could be a day behind; a catalog is now given the instant and zones it once.
- `tablewalk check` says which Preview features an App uses in its text output, as one `preview:` line after the
  steps, and `--brief` as one `preview-feature (info)` line after `ok` or the problems. The finding is information, so
  only `--json` carried it, and an author using flags or a Gantt never heard it from the command they run.
- A dashboard asks for its chart shapes and its list's export parts beside its own chunk, from the home page and the
  dashboard room alike, instead of once the dashboard had drawn. They came a round trip late, and the first paint waits
  for every part in flight, so a phone's cold Compass dashboard sat near its 1.2 s LCP budget; the parts now land
  about 250 ms sooner. Nothing moved into the first-paint bundle.

- A dashboard matrix folded to fit its section keeps each cell's figure inside the cell. The App's 32px row height
  fixed the folded cells' boxes and cut the figure under its column's name in half (G185). On a tinted cell the
  column's name is in the cell's ink rather than the faintest one, and the heaviest tint stops where the ink would
  read under 4.5:1: 62% of the accent where it reads, less under Mono's black or a dark mode's pale accent (G186).
  `check` measures that pair with the others.

- A list's board fits a desk narrower than its lanes at 15rem. Beside a side menu at 1280, four lanes and two folded
  strips stood 80px wider than the room: the fourth lane's sum was cut behind the fade and the folded strips were out
  of sight (G188). The lanes now give way together down to 12rem, wrapping a card's words, and a narrow lane says its
  sum on a line under its name. A phone still swipes one lane at a time.

- A list's yes-or-no column said in words, such as an SLA's "On track" and "Breached" in tone chips, is as wide as its
  words. It was held to a check mark's 64px and cut to "On trac…" (G187). A row's name set on two lines over its
  folded columns now wraps as its cell does, instead of being cut to "Redgate Analytics Holdi…" above a detail line
  that wrapped whole.

- A record's conversation opens at its newest message and stays there while the rows above it settle, its top edge
  where a message starts. It was scrolled to its foot once, so it opened a few pixels short at a desk and most of a
  message short on a phone, the top line cut (G184). A conversation with sides never scrolled at all, since its box was
  drawn after the scroll. Once the reader scrolls away the box stays where they put it.

- A platform view whose tab reads `owner_id = me` is served to the provider's staff. The served App judged the
  platform realm's tabs with the tenant's `me`, the person, so the tab was an error and the whole view left the
  provider's menu, its address saying it was not available to their role (G192). The platform realm's surface now
  carries its staff's `me`, as its reads already did.

- The reference's `auth.store` says what it takes: a SQLite file, or a `postgres://` URL with its password named by a
  `${NAME}` reference, made once by `migratePostgresAuthStore` before the first start, and never a business database. It
  said only "the SQLite file sessions live in" (G190).

- A tenant App's first boot runs from a built image, with no TypeScript runner: `tablewalk tenant init [<tenant>...]`
  opens the platform realm and puts the first tenants, leaving any already there, and `tablewalk tenant grant <email>
  --roles <role,...> [--tenant <id>]` grants a membership, making the account first when the address has none, its
  password read from `TABLEWALK_ACCOUNT_PASSWORD` (G191). Both were maintenance calls a deployment had to script. A
  `tablewalk tenant` refusal now prints every line it has, the ones that say what to change included.

- A tenant App's production deploy has one page: the policy on every step, the sign-in store in a PostgreSQL
  database of its own, `TABLEWALK_AUDIT_KEY` kept for good, and the first boot, in order (G189). The tenant guide
  still listed production deployment as not included, and the deploy guides named `--commands` and `--jobs` but
  never `--policy`, the tenant stores or the audit key.

### Package

- The site has a changelog page, [/docs/changelog](https://tablewalk.dev/docs/changelog/), built from this file
  each time the site builds, with every release in its table of contents. There was no changelog on the site; this
  file was the only place to read one, in a repository that is not public yet.
- tablewalk refuses to start on a Node older than 24 with one line that says so, the floor `engines` already named.
  An older Node failed on a missing export as the server loaded. The README and the browse quickstart say it, and
  the build page says the App typecheck needs TypeScript 7 or later in the App's project.
- The installed package's `package.json` has no `scripts` or `workspaces`. They were the checkout's, so
  `npm test` in `node_modules/tablewalk` ran a gate over files the package does not ship. `homepage` is
  tablewalk.dev rather than the repository's README.
- The optional `sharp` peer, which draws public pages' share images, asks for 0.35.5 or later. `source-map-js`, which
  `sanitize-html` reaches through `postcss`, is 1.2.2 (a high advisory: an indexed source map's offsets could stall
  the event loop), and the build's Vite is 8.2.4 (its `launch-editor` advisories). No major version moved.
- The server's compiled JavaScript keeps its comments. They say why the code is the way it is, and someone reading
  `dist/` — an operator following a stack trace, an agent reading the installed package — now reads the same reasons
  the repository does. The tarball grows by about 1 MB packed (21.3 MB, 68.0 MB unpacked).

### Ready for 1.0

The App DSL freezes at 1.0, so this release settles the last spellings that disagreed with their siblings. Each old
key is refused with a message naming the new one; the site's upgrade page listed every rename since 0.8 (retired in
1.0.0-rc.1, which has no upgrade path from 0.9).

- A notify rule names the reference whose record its notice opens with `opens`, as a list view does; it was
  `open`, which everywhere else is how a record opens (`'page'`, `'drawer'`, `'modal'`).
- `ui.shell.heading: false` keeps each room's heading for a screen reader only; it was `ui.shell.title`, beside the
  `heading: false` a list or dashboard sets for itself.
- The sentence a `consumes` or `restocks` refusal says is `message`, as a form rule's and a validation's are; it
  was `refuse`. Its type is text, which is all the parse ever took; it was typed as text or a catalog message.
- `useFile(resource)(key, { thumbnail: true })` asks for a file's smaller copy, the copy a file resource names with
  `thumbnail`; the option was `thumb`.
- Two types say what the parse already held: a display rule's `subtitle` is a column name (it was typed as text or
  a catalog message, and a message was refused), and the `tone` a value renderer receives is one of the five tones.
- The operator's one-time steps — `migrateSqliteCommandJournal`, `migratePostgresCommandJournal`,
  `migratePostgresAuthStore`, `migratePostgresTenantStore`, `migratePostgresTenantAdministrationJournal`,
  `migratePostgresTenantInvitations`, `migratePostgresSupportAudit`, `verifySqliteSupportAudit` and
  `verifyPostgresSupportAudit` — are exported from `tablewalk/maintenance`, beside `provisionStores`, and no longer
  from `tablewalk/commands`, which is what an App's server code imports. `TenantStoreBinding` is exported from both.
- `tablewalk/react` no longer exports `STATE_KEY` and `walkOf`, which leaked where the walk is kept. A custom
  `routerNavigator` adapter reads the router's own state and stores the entry it is handed (`push(href, entry)`,
  `replace(href, entry)`); the navigator names the key.
- A dashboard `embed` names its `tab` by the tab's address word (`tab: 'all-open'`, the word its URL carries), not by its
  label, which a `msg()` caption says in the reader's language and a relabel changes. A label is refused with the word
  to write.
- A first-run step's next action is its `label`, as every destination's words are (a funnel stage's, a tab's); it was
  `title`.
- A `{ has }` list filter names the column that points back with `whose`, as a rollup and a related list do; it was
  `via`. The query language keeps `any opportunity via account_id`, its own grammar.
- A landing's hero, call to action and feature or step items say their line with `description`, as every heading's
  sentence is; it was `text` (`hero(heading, description, actions)`, `callToAction(title, description, actions)`,
  `{ title, description }`). A `text` section and the footer keep `text`: that is the prose itself.
- The origins a page opens for custom components are grouped as `ui.csp: { connect, images }`, the policy they open,
  where `ui.images` read as the pictures of every other `images` key. `ui.connect` and `ui.images` are refused with the
  new place. The authority lock's `egress` lines are unchanged.
- `SplitListDetail` in `tablewalk/ui` no longer types `isCurrent`, `listWidth`, `expandList` and `sentenceTitle`, the layout
  props the shell sets for its own rooms; a component's split takes `list`, `detail`, `selected` and their labels.
- A `Dropdown` item's `tone` in `tablewalk/ui` is a `ToneName`, and all five now color the option's word (it was typed
  `string` and only the host's own `error` was styled).
- `ui.shell.search` is `'members' | 'everyone' | false`: `true` is `'members'` (the default) and `{ signedOut: true }` is
  `'everyone'`. Both old spellings are refused with the new one.
- `tablewalk/app` no longer exports `ThemeDefinition`, the compiled form of a theme with its `base`; an App writes a
  `ThemeSpec` (`extends`) through `defineTheme`.
- A stock rule's `message` (`consumes`, `restocks`) takes `msg()` like every other caption: bind each place to its parent
  path, `msg('stock.short', { left: 'part_id.on_hand' })`, and the refusal is said in the reader's language.

## 0.9.8

0.9.8 finishes the package split inside the tree. The four layers — the engine, the kit, the database browser and the
App framework — import only down, with no crossing left on the allowlist; each package has its entry points and a
private workspace, so `mistri/*` and `@tablewalk/engine` import in a checkout today; the page starts one product's main
over the kit's shell, and the Workbench's page no longer downloads the App's chrome. The features that stay Preview at
1.0 are named and labelled, and a third sample App, Ladle, shows the general path: a site of its own embedding an App.
Beside these, the built `tablewalk/react` starts in a browser again, and a page's `today` is the App's day.

### Preview at 1.0

- These features stay **Preview** at 1.0: they work as documented and may change in any 1.x release. Feature flags,
  audiences, `useFlags` and `tablewalk/openfeature`; experiments; the Suite Console (targeting, rollouts, Governance);
  behavior analytics, with the `analytics` operations grant; SCIM; and the Gantt presentation. The inventory marks their
  keys, exports and commands `preview`, their root keys carry `@preview`, and `src/shared/preview.ts` is the one list.
- `tablewalk check` reports the Preview features an App uses as one `preview-feature` finding at information severity;
  the check still passes.
- Durable workflows (`tablewalk/workflows`) are Stable, with the assistant and integrations.

### Package split

- The shared rules no longer reach up into the App framework: the command and link vocabulary moved to
  `schema/model.d.ts` and the served App's shapes to `src/shared/servedApp.ts`, so the boundary allowlist fell from 69
  crossings to 23. Every public type name is still exported where it was.
- The page's entry starts one product: the database browser's page carries a `tablewalk-shell` meta and preloads its
  own main beside the kit's shell (`index.workbench.html`), and every other page starts the App framework's, which rides
  in the entry's chunk, so no first page gains a round trip. The kit's shell names neither product: each main hands it
  a chrome (and the Workbench its tools), the Workbench's page no longer loads the App chrome to peek, dress or speak,
  and `check-boundary` holds the entry as a declared bin with two mains, as the server's is.
- The packages have entry points in the tree: `scripts/boundary/entries.json` names each `mistri/*` entry beside the
  `tablewalk/*` name it mirrors, plus `@tablewalk/engine` (connect, the catalog, the query language, keyset pages),
  `@tablewalk/kit` (the shell API and the UI tokens) and the `tablewalk` bin. Each package is a private npm workspace
  under `packages/` whose stubs are generated from the table, so `import 'mistri/commands'` works in a checkout today;
  `check-boundary --entries` holds each entry's whole import closure to its layer, its published twin and its stubs. A
  component may import `mistri/ui` and `mistri/page` beside the old names. The package still ships, and every doc
  still writes, `tablewalk/*`.
- The kit's lists, record page and menu no longer call the App framework: a selection's bulk commands, a tag's own
  commands, a call to action into another App of the suite, a headline's form dialog, the nav's targets and a New
  form's lines are slots the App shell names (`shellMode.ts`), and a shell that names none, the Workbench's, draws
  none of them. A New form's lines grid is now fetched the first time a form has lines, not with every New form.
- The boundary allowlist is empty, and a test holds it so: the page rules write a page back in the authored spelling
  through `AuthoredSection` and `AuthoredPage` (`schema/model.d.ts`), which `schema/app.d.ts` fills in with the App's
  authored types, so a rule that writes a section those types refuse still fails to compile. No module is a `split`
  any more, and `check-boundary` fails on a split entry whose module crosses nothing.
- The App's chrome (`appnav.js` and what only it reaches) is a chunk of its own, which an App's page preloads beside
  the kit's shell, so the Workbench's page no longer downloads it: its first paint fell from 379.2 to 356.9 KB in
  brotli. An App's page downloads the same code in one more file, which compresses about 5 KB worse.

### The general path

- A third shipped sample App, Ladle (`examples/apps/ladle`), a cooking school: a free-form check-in page beside two
  declared lists, the school's own Node server mounting `tablewalk/handler` beside a JSON route of its own, and the
  school's own React site, in its own plain-CSS design, embedding the staff App under its header with
  `tablewalk/react`. Its seed (`examples/databases/ladle/seed.mjs`) ships too. A new guide,
  [The general path](https://tablewalk.dev/docs/general-path/), and the agent skill now say when to take it.
- An embedded App draws its free-form pages and custom components: their compiled files are fetched from the
  Provider's endpoint (`/api/tw/_components/…`), not from under the host's address, where the host's page answered.

### Fixes

- A date phrase in a view's query — what a free-form page's `useRows` sends, `starts_at >= today` — is read by the
  request's clock in the App's `ui.timezone`, as a list's is. It read the server's wall clock in the server's zone, so
  Ladle's check-in page lost tonight's class once the server's day had turned and Chicago's had not.
- The database browser's landing at `/` is sent the database browser's page. The file `index.html`, an App's page,
  was sent for it, so it preloaded the App's chunks rather than its own main.
- The built `tablewalk/react` starts in a browser. Since 0.9.0 the published library bundled Base UI's CommonJS helper
  (`use-sync-external-store`) with its `require("react")` intact, and every embed showed "could not start. Calling
  `require` for "react" in an environment that doesn't expose the `require` function." The build now turns those
  calls into imports of the host's React, `npm run build` fails if any `require()` is left in `dist/embed`, and a
  browser spec starts the built library in the Ladle host's page.
- An embedded App's theme files — its fonts (`_fonts/`), its stylesheet and its logo pictures (`_brand/`) — are
  fetched from the Provider's endpoint, as its component files are, not from under the host's address.

## 0.9.7

0.9.7 is the release that makes deployments and tenant Apps ready to rely on. A container start reads its cloud
credentials, drains before it stops and builds from a generated Dockerfile, with a Cloudflare template beside it. Tenant
Apps gain a test kit, `test init` isolation tests, sign-ins per role in `dev` and a checked policy reference. A suite's
sign-in and grants run on PostgreSQL. Themes keep every key they accept, `check` measures the colors components really
draw, and the site shows a custom theme on a sample App. Beside these, the fixes from three field reports and a large
App's build: a custom section re-reads after an action again, `now` is the clock on SQLite, quarters in the query
language and a `me` for platform staff.

### Deploying

- Bucket credentials from the platform: without `TABLEWALK_S3_*` keys, an ECS task role (and EKS Pod Identity) is read
  from the container credentials endpoint, and an EC2 instance role over IMDSv2 with `TABLEWALK_S3_INSTANCE_ROLE=1`,
  renewed five minutes before expiry; static keys still win. Google Cloud Storage is documented through HMAC keys.
- A connection's `"listen"`: a direct PostgreSQL URL a jobs host holds its `LISTEN` on when `url` goes through a
  transaction-mode pooler, so cross-instance facts wake it at once instead of at its idle ceiling.
- `--drain-delay <s>` (`TABLEWALK_DRAIN_DELAY`) keeps the listener open after `/readyz` fails on SIGTERM, and
  `--shutdown-grace <s>` (`TABLEWALK_SHUTDOWN_GRACE`) sets the 10-second cut for a response that never finishes.
- `tablewalk check --pending-on <url>` runs the pending migrations on a scratch database you name (a branch or
  restore, any engine) instead of `CREATE DATABASE … TEMPLATE`, for roles without `CREATEDB`.
- `tablewalk build --app <dir> … --dockerfile <file>` writes the Dockerfile that builds and serves that App: a build
  stage running the same `tablewalk build`, then tini, uid 1000, `--host 0.0.0.0`, `PORT` and a `/healthz` health check.
- A tenant App's job hosts read the connection's `"listen"` URL as an App's do, so they wake at once behind a
  transaction-mode pooler.
- `examples/deploy/cloudflare`: a Worker, `wrangler.jsonc` and keep-awake cron template for an App on Cloudflare
  Containers (a template; it has not been deployed). The release image is published for `linux/amd64` and `linux/arm64`.

- A suite can run stateless: `identity.store` and `identity.grants` take `postgres://` URLs (and `${NAME}`), both or
  neither. The grants, account preferences and authority history are schemas of the grants database, kept apart from
  the identity and business databases; such a suite serves only Apps on PostgreSQL. A SQLite suite is unchanged.

### Reliability

- A server that cannot reach its database while opening the job, event-delivery or command stores now says so, with the
  driver's own words ("sorry, too many clients already", `ECONNREFUSED`), instead of telling the operator to provision
  stores that exist. The provisioning advice stays for a store that is missing or the wrong layout.
- Every third-party GitHub Action in the workflows is pinned to a full commit SHA, with its release in a trailing
  comment.
- The browser suite reaps any fixture server a hook abandoned (a `beforeAll` that timed out), and each hook that starts one
  sets its own timeout; a describe-level timeout does not cover a hook.
- Flaky tests made deterministic: the Payday language spec (a cold first paint and an address pattern the tab already
  matched), and the form components' focus assertions (focus is set in an effect that runs after the text appears).

### Accessibility

- `test/contrast.test.ts` holds WCAG 2.2 AA for every built-in look, palette and mode (and the database browser's own
  look): text 4.5:1 on the page, panels, raised panels and the accent's tint, the words on an accent fill, the menu,
  the placeholder, and a field's edge and the focus ring 3:1. Every pair already passed; no token changed.
- A dialog with no label of its own is named by its first heading (`Modal`), so a screen reader announces "Delete invoice
  7, dialog" for the confirmations that had no name.
- Errors that appear after an action (the agent console, the view composer's preview, the connect form, a nested query,
  a page flow, the enter-a-tenant checks) are `role="alert"`, so they are announced as they appear.
- The help examples and the help dialog's close button keep the house focus ring on keyboard focus (they dropped it for a
  border tint); the record's related-panel scroll and the composer's scroll-to-new-field no longer scroll smoothly under
  reduced motion.
- Prose uses one term per concept: "App" (the framework's unit, capitalised; "app" stays for a host or desktop app),
  "PostgreSQL" in prose, "tablewalk" lowercase, "Workbench" for the database browser's tools. About twenty stray
  variants in `docs/` and the README were brought in line.

### Building an App

Fixes from an 18-table clinic App built on 0.9.6.

- `--scaffold-app` over a database with a staff table to sign in by no longer drafts `access: 'read'` on every
  read-only resource, which the validator refuses (a resource reads by default; only `'write'` is a word): the draft
  failed its own check once per table. A read-only table now says nothing.
- `tablewalk check --brief` groups repeated warnings by code and resource, with a count and one example each, and
  points at `--warnings` for the full list; errors stay one line each.
- A load names every conflicting role grant at once (a role's `create`, `write`, `export`, `operations` and `fields`
  across all roles), and the command authorizer names every `[command-and-edit]` conflict (each role that edits a
  table a command writes, each role that has the target's `version` in its `fields`) in one refusal instead of one a
  run. The roles and commands docs state the matrix in a paragraph.
- Icons: `AppIcon` accepts any lowercase word in the types, so a misspelled icon no longer fails
  every overload of the helper around it with an error about some other option; `check` refuses it at the icon, with the
  nearest names, and prints the list of icons once per run instead of after each. The set grows by 63 domain icons
  (stethoscope, flask, pill, bed, heartbeat, graduation-cap, airplane, …), and `tablewalk docs icons` lists them all. An
  App ships only the drawings of the icons it names, so the larger set adds nothing to a page.
- `tablewalk schema --brief` leaves out the platform's own store tables (`__tablewalk_*` and the sign-in, flag,
  experiment and analytics schemas) and counts them on its first line. `tablewalk schema --help` prints the command's
  own flags instead of the root help.
- The reference-picker refusal (`unresolved reference resource or label column`) says the likely cause, a table
  missing from the command's `read`, and the commands docs give `field.reference`'s options as `{ by, labelColumn,
  query }`.
- A segment named like a column, state or query word is refused with a replacement in the `{ query, label }` form
  (`today_only: { query: …, label: 'Today' }`), and the segments docs state the collision rule up front.
- `tablewalk shot --matrix` shoots the App's own `defineTheme` looks after the built-in ones.
- `tablewalk docs <topic> --brief` prints a page's headings with the first sentence under each, one screen for a
  topic that is 48k characters whole.

- `tablewalk seed` reads the domain off the schema (clinical, retail, logistics, finance, HR, education, property, repair,
  else neutral) and chooses words by table and column meaning: a department is Cardiology in a clinic and Grocery in a
  shop, a staff title is a job, a lab test is a test. Lookup tables (departments, categories, roles, payment methods) get
  four to eight unique named rows; people are not named twice in a table; nullable text is filled about 96% of the time
  (notes excepted); money declared `minor: true` is stored in cents; every parent gets children, a few more than the
  rest; and schedule columns (`scheduled_at`, `starts_at`, due dates) span the last 90 days, today and the next three
  weeks, so a "today" queue is not empty on first run. Child tables now get at least 1.5 times their parents' rows.
- A view's or page's `roles` open to a role that `extends` one they name, through any depth: an `admin` that extends
  `manager` now sees the views that name `manager`, where it saw none. Only upward (the role extended does not open a
  view naming its extender), only `roles` on views and pages (a row policy's `principal.roles`, a `home` rule and a
  theme's `for.roles` still match by name), and table, column and command grants are the same as ever. The
  `[extends-not-named]` warning is gone.
- A queue's or a board's `primary` may be a reference (the card says the record it names) or a one-hop label path
  (`primary: 'patient_id.name'`), as a list's `show` takes label paths; a queue's reference column was refused as "not a
  text column", and a board's path was refused as not local. The path must land on a text column.

### Apps

- `tablewalk grade` credits the ring a focused stop's box wears while it holds focus (a picker's box round its input, a
  board card round the button that opens it): the board-card and reference-picker `hidden-focus` errors on the
  platform's own controls are gone. A picker's input is 40px tall on a touch screen, and the command form's line
  pickers too (the grade's `small-target` read the 25px input, not its 44px box).
- A theme that extends a look and names an `accent` but no `colors.chart` wears the accent as its first chart series and
  its metric sparklines (they stayed the look's blue or green); the built-in looks are unchanged.
- A bar or donut chart "by" a column whose values have tones (a state, a status) wears each value's tone, the ink the
  status dot wears (a donut only where every slice has its own).
- A `format: 'relative'` date column says one way: from today only where every visible value is near, else every value
  is its date ("Sep 21, 2026" no longer stands beside "6 days ago"); the phrase stays its tooltip.
- A board card that can be dragged has a grab cursor and, where a pointer hovers, a small grip on hover; Alt and an
  arrow and the card's menu are unchanged.
- A custom section that reads with `useRecord`, `useRows` or `useBreakdown` draws what an action on its page just
  changed: those reads are asked again with the page's sections after a command. Since 0.9.6 they kept the old value
  until a reload.
- `now` beside a date or timestamp column is the instant in the query language: `resolution_due_at < now` binds the
  current time on every engine, in a segment, a list's query and a metric's typed `query` alike. The typed query
  refused it while a segment passed it as the word, which only PostgreSQL read as the clock; SQLite compared the
  text and counted every row as late.
- `this quarter`, `last quarter` and `next quarter` in the query language, wherever `this month` reads: a segment, a
  list's query, a metric's typed `query` and a dashboard's `windows`. They are calendar quarters (January, April, July,
  October); an App declares no fiscal year. A filter chip says them in words, and the completer offers them.

### Tenant Apps

- `tablewalk check` warns of two refusals it used to let through: `[tenant-delete-unauthorized]`, a tenant policy with
  no `authorizeDeletedRecord` while a role writes a tenant table (Delete answers 403 `forbidden`), and
  `[command-unoffered]`, a command that names a record and that no action, form, import or API exposure offers
  (preparing it answers 403 `forbidden`). A support visit stays read-only; the comment that said otherwise is corrected.
- The tenant docs' `seedDesk` example runs as written: it names its `source` and reads `customer`, the table its
  inserted row's ownership column points at. `tablewalk check` now refuses a platform command acting in a named tenant
  whose footprint lacks that parent, and says the `read` to add; before, it passed check and every run was refused as
  "not available to this account". A command without `source` says so instead of "not an identifier".
- `tablewalk dev` serves a tenant App: the deployment watcher no longer takes the dev folder's own `.tablewalk/dev.json`,
  rewritten on every start, for an edit and restarts forever. `tablewalk serve --app …` says there is no serve command
  (a start serves) instead of opening a database called `serve`, and so does a bare `tablewalk serve`.
- A tenant policy's refusal says which key and which limit: `invitations.maxRedemptionLifetimeMs is 864000000; it is a
  whole number from 1 to 7 days`, a missing key with the keys it takes, an empty `operators`, a duplicate grant, in
  invitations, administration and support alike. A policy module whose `defineAppTenantPolicy` refused while it loaded
  keeps that reason beneath "did not load" instead of the fixed sentence alone.
- `tablewalk migrate stores up --app <dir> --policy <file>` provisions a tenant App's stores. It makes the tenant
  store and the journals the policy declares, the command journal, the event, effect and job stores, the sandbox store
  and the record history, and leaves any already there alone. Without `--policy` it says the flag is needed. A start or
  `tablewalk check` that finds one of them absent names it and prints that command, `--policy` included; before, it
  said only "The tenant context could not be verified." The missing-`resultReferences` refusal says why an extractor is
  needed and shows one. The support audit key refusal says that check needs `TABLEWALK_AUDIT_KEY` too, because it
  verifies the audit store against it.
- A tenant-owned table's key refusal states the rule and the fix: the primary key includes the ownership column, as
  `PRIMARY KEY ("tenant_id", id)`, or is one opaque text id declared `id text not null primary key`. It also says why
  this key fails: a SQLite `text primary key` without NOT NULL is read as nullable, and an integer id counts across
  every tenant. A unique index refusal shows `UNIQUE ("tenant_id", …)`. The tenant docs have a "Keys in a tenant App"
  section, and the quickstart and `--scaffold-app`'s next steps say multi-tenant adoption needs text ids or
  ownership-inclusive keys.
- `tablewalk/testing` makes a tenant App's people: `host.tenant(id, { roles })` is a new member of that tenant, signed
  in and working in its lease, and `host.platform({ roles })` a member of the platform realm. The test names tenants
  and roles; the lease, its headers and the operator steps are the kit's. A member's `record(table, key)` says whether
  it reaches a record (`not_found` for another tenant's, exactly as for none), `enter(id)` asks for another tenant's
  lease, and `support(id, { role, reason })` opens a platform member's support visit, with `exit()`. The test host's
  setup routes now answer a tenant App too, under the same token, loopback and `NODE_ENV=test` gate.
- `tablewalk test init` writes a tenant App's suite instead of declining it: `tests/tenants.test.ts` checks, for two
  tenants of the database, that a member works in its own tenant only, that each tenant-owned resource lists its own
  rows and never opens another tenant's records, that each command a tenant role runs is refused on another tenant's
  record at prepare and at execute, and that each platform role's reads are answered. The start serves the policy
  (`policy.ts` or `server/tenant-policy.ts`) and `commands.ts` beside `app.ts`.
- `tablewalk dev` on a tenant App prints a sign-in per role, as it does for any App: each account is a member of the
  first two tenants of the profile table (made active if the tenant store has none yet), or of the platform realm for
  a platform role, made with the maintenance steps on this machine's database. A restart signs the same people in.
- `tablewalk migrate stores up` reported the sandbox store as "vundefined"; it says its version.
- The Tenant Apps page shows a whole tenant policy with every part it can declare, and a reference of each key's
  type, default and limit, held to the validator by a test. It says what a converting author met: a member's Delete
  of a tenant row needs `authorizeDeletedRecord`, and a record's command runs only where an action or form offers it.
- A command on an integer-keyed record prepares and runs however its page was reached: a page opened by its address
  sends the key as its digits (`{"id":"3"}`), and the tenant and platform realms' target check compared it with the
  row as spelled and refused it 403 (`forbidden`). Both now read the key as its column's type, as a plain App does.
- The platform realm has a `me` of its own: `auth.tenancy.platform.me: { from: 'staff', column: 'account_id' }` names
  the platform's staff table, so a provider's queue can say `mine: 'owner_id = me'`. Before, a platform lease's `me`
  was the session's email and a staff reference beside it was refused. Each lease resolves its own realm's row: a
  tenant member is never a staff row, staff are never a tenant's person. `tablewalk check` judges the mapping in the
  platform realm's catalog, and refuses one over a table a tenant owns.

### Themes

- `shape.radius.panel` is said by `tablewalk theme show` (text, `--json` and `--diff`), with every `shape.border` width,
  `motion` and `rhythm`, and a board's card wears it beside the stat cards and panels; a theme that names no panel corner
  keeps its board cards at the control's. A test walks every key the theme schema accepts and fails on one the compiler
  drops (none is).
- A board card's category chip draws its series 45% into the ink (it was 72%), as an avatar's initials do: Mono's
  eighth series read 3.0:1 there and a custom theme's amber 4.3:1. `tablewalk check` now measures each series as a
  category chip, as an avatar's initials and, under `stat: 'icon'`, as a stat card's mark, and refuses a series that
  fails with the nearest one that passes. `tablewalk grade` names such a reading by the token it is mixed from and the
  part (`care.colors.light.chart[4] as a board card's category chip`), placed at the theme, also when the App wears its
  own theme without `--theme`.
- A `link`, `focus`, `nav.accent` or `chart[0]` written the same as the accent is drawn in the accent's text ink, so a
  link written as an amber accent passed `tablewalk check` at 2.0:1. Check now measures such a color as written, on
  every ground its role is read on, light and dark and in each palette, and says it is worn as the accent's ink: leave
  it out to wear that, or write the color it suggests. `accentInk` and `onAccent` were and are measured as written.
- The themes chapter says how a chart's series take the theme's colors (one series `chart[0]`, several largest first or
  in their column's order, a scale in one hue, status values in the status colors), what a palette is and how
  `shot --palette` shoots one, and, under "When to use it", what `type.faces` ships: WOFF2 cut to Latin, at most 150 KB
  together, the heading's face preloaded. The theme bench is named at `/_tablewalk/theme/`, where `/_theme` leads.
- The `paper` pattern is drawn at 20%, 45% or 70% of the line color (it was 40%, 70% and all of it, as the other
  patterns are): its two families of fibers crossing read as a mesh at strength 1. `tablewalk check` measures words over
  it at the same strength, and a test holds the sheet and the check to one number for every kind and strength.
- `stat: 'icon'` cards stand in equal columns, four to a row, and fold into pairs (an odd run's first taking the row)
  where four do not fit: four metrics at 1280-1440px wrapped three over one, the last stretched the strip's width.
- `tablewalk shot --out <dir>` writes every file in that directory, whatever the mode: `--matrix`, `--compare` and
  `--recipes` wrote under `<dir>/matrix/`, `<dir>/compare/` and `<dir>/recipes/`. Only the default directory keeps each
  mode in a folder of its own.

### Site

- The home has a header with Docs, Sample Apps (Status and GitHub on a desk) and a small footer. It says two sample
  Apps (Tick, Lintel) as the Sample Apps page does, not nine. The quickstarts are "an App from scratch" and "an App
  from your database", the sidebar's "What tablewalk is" is "Home", the first picture on a docs page loads with the
  page (no empty box on the browse quickstart), and the component library's tab says "Component library".
- "Same app. Your brand." on the home and "A look of your own" in Themes: Lintel's Today in Lumen beside Blueprint,
  a 61-line theme written from scratch (`examples/apps/lintel/blueprint.ts`: blue ink on gridded vellum, a blueprint
  in dark mode), walked in order, with its light and dark on a phone. Lintel offers it in `customThemes` and still
  wears its own look. `scripts/docs-shots.mjs` takes `compare` and `scale` for a `shot --compare` sheet.

## 0.9.6

0.9.6 is the release where the database browser and the App framework come apart inside one package: the source is drawn
in the four layers the 1.0 packages become, a `tablewalk <db>` start serves through its own dispatcher without loading
sign-in or the App runtime, and the client boots an App's shell or the Workbench's over one kit. Beside the cut, the
security review's fixes (webhook consent kept newest-wins, per-account sign-in limits, Better Auth 1.7.10), phones that
fit their lists, record pages laid out from their own sections, and the stumbles a coding agent met building an App from
the shipped skill alone. A handful of names changed; each old spelling is refused with the new one named.

### Upgrading from 0.9.5

Each old spelling is refused where it is read, with the new one named; nothing reads both.

- `--trust-proxy-header` → `--auth-proxy-header`, and `TABLEWALK_TRUST_PROXY_HEADER` → `TABLEWALK_AUTH_PROXY_HEADER`
  (startup stops on the old one, so a server never runs without the identity header it was told to require).
- A dashboard's `layout: [...]` → `areas: [...]` (a page's `layout` is its archetype; the grid is the areas its sections
  name).
- A custom section's `totals: { … }` → `figures: { … }`, and its component reads `figures.<name>` (was `totals.<name>`);
  the types are `CustomFigure`, `CustomDashFigure`, `FigureValue` and `FigureGroup` (were `CustomTotal`,
  `CustomDashTotal`, `TotalValue` and `TotalGroup`). A list's `totals: [columns]` is unchanged.
- A display rule's `face: 'sans'` → `face: 'ui'`.
- `provisionSqliteTenantStore`, `provisionSqliteTenantAdministrationJournal`, `provisionSqliteTenantInvitations` and
  `provisionSqliteSupportAudit` are no longer exported from `tablewalk/commands`; `provisionStores` from
  `tablewalk/maintenance` makes the tenant stores, on SQLite and PostgreSQL, in dependency order whatever order `only`
  lists them: `await provisionStores({ sqlite: file }, { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration'] })`
  (ids `tenant-store`, `tenant-administration`, `tenant-invitations`, `tenant-support-audit`). With only those ids,
  `app` is the binding alone and the App's command stores are not made. The `migratePostgres…` exports stay.
- A type role's `face: 'mono'` → `face: 'code'`, which is now the theme's own monospace (`fonts.code`, or the
  platform's when the theme names none), so a theme's code stack reaches the Mono look's labels, menu and figures.
- A theme's `recipes.head` → `recipes.header` (a list's `head` is its column heads), and the page's
  `data-look-head` attribute is `data-look-header`.
- A theme's `nav.currentInk` → `nav.onCurrent`, and the token `--nav-current-ink` → `--nav-on-current` (words on a
  fill are `on<Fill>`; `<x>Ink` is a color used as text on the page).
- A funnel stage's `title` → `label`, which now takes `msg()` like a step's or a tab's (`title` heads a section).
- A page's `layout: 'listing'` → `layout: 'showcase'` (a listing is a list view everywhere else), its check code
  `layout-listing` → `layout-showcase`, and the drawn `data-layout="listing"` → `data-layout="showcase"`.
- A record page that names no `layout` is drawn in the one its sections make (below), so `layout: 'record'` is a word
  again: the record's own skeleton, for a page that would be chosen as another (the `check --design` warning that
  called it the default, `default-layout`, is gone).
- `--trust-proxy-hops` with `--trust-proxy-cloudflare` (or their environment variables) stops startup: they are two
  rules for one client address, and the hop count used to decide quietly wherever Cloudflare's header was missing.
- A metric's `to: false` makes its card a figure that opens nothing, as a breakdown's `to: false` makes its groups
  text; and `spark: false` now draws no trend on a windowed metric, which drew one whatever it said.
- A `"kind": "search"` connection (Typesense) is refused where `tablewalk.json` is read, with a sentence saying
  search providers are packs: Typesense moved out of core to `packs/search-typesense` (`@tablewalk/search-typesense`),
  unpublished until after 1.0. Remove the entry; an App's text filters run on the database. An App that declares a
  resource's `search` is refused at start until a provider is plugged in, as it was without a search connection, and
  the example compose file no longer starts a Typesense container.
- `tablewalk/maintenance` provisions every store through one call, `provisionStores(<the database>, options)`, which
  reads the store list `tablewalk migrate stores` reads: `{ only: ['inbox', 'record-history', …] }` for a store that
  needs no binding, `{ app: { id, source } }` (or `{ app: { tenant: binding } }`) for an App's event store,
  `{ app: { …, commands } }` for its effects' deliveries, and `{ app, jobs }` for its jobs, workflows, mail and
  integrations stores. The 31 `provisionSqlite*`, `provisionPostgres*`, `provisionMysql*` and
  `migratePostgresJobStore` exports are gone, and the messages that named them name `provisionStores` or
  `tablewalk migrate stores up`. An unknown store id, or a store the target's engine does not keep, is refused before
  anything is made.
- An integration's webhooks are an inbound endpoint: `POST /api/inbound/<name>` (`/api/inbound/<name>/<tenant>` on a
  tenant App), not `/api/integrations/<name>/webhook`; point the provider at the new address, which the settings screen
  shows. A `defineInbound` named like an integration that sends webhooks is refused.
- An integration's webhook answers the same delivery sent again (its id and signed time, inside the window) with the
  first one's receipt (`204`, or the `202` of an event the App does not map), not `409`: a provider resending
  identical bytes after a timeout read `409` as a failed delivery, retried and alerted. Nothing runs or records twice,
  as for a `defineInbound`, whose replay already answered its receipt. Inbound deliveries are remembered in the integrations store, so a jobs module with inbound endpoints provisions it
  (`provisionStores` with `{ app, jobs }`, or `tablewalk migrate stores up`), and serving refuses to start without it.
- A `defineInbound` principal holds `service: true` roles alone, as an integration webhook's did.
- The sign-in store is at layout version 4, on SQLite and PostgreSQL: stop the server and run
  `tablewalk migrate stores up`, which drops the account's `issuer` column and its index (Better Auth 1.7.0–1.7.2
  required them, 1.7.3 took them back and never writes the column, so its `NOT NULL` refused every new account). No other
  column or row changes. A store with two accounts that only their issuer told apart is refused, unchanged, with the
  pairs named: give each issuer its own provider id first. Serving refuses a version 3 store until it is brought forward.
- The database MCP (`tablewalk --mcp`) serves no App, and no longer offers `validate_app`, `scaffold_app` or the
  App reference as resources: it has twenty-three tools, seventeen that only read. An agent building an App checks it
  with `tablewalk observe --mcp`'s `check` (the same JSON as `tablewalk check --json`), reads the reference there as
  `tablewalk://docs/topic/<topic>` resources, and drafts a first directory with `tablewalk --scaffold-app <dir>`.

### Changes

- The database browser serves through its own dispatcher and server, apart from an App's: a `tablewalk <db>` start loads about 240 modules where it loaded about 700, and none of sign-in, the App runtime or the embed door. An App-only address (`/api/accounts`, a command, a form, `/api/embed/boot`) asked of the database browser is a plain `404`. A start with no App and an App-only flag (`--jobs`, `--mounts`, `--embedded`) serves as an App server; without one it is the database browser, which now opens `--openapi` itself, so `--openapi` with `--mcp` lists that API's connection to the agent too.
- The client boots through two shells over one kit: an App's (its menu, account and tenancy) and the Workbench's (the query bar, the connection manager, Undo). A working App never downloads the Workbench's tools.
- The source is drawn in four layers — the engine (adapters, data paths, shared rules, the looks), the kit (the shared React client), the database browser and the App framework — the packages they become at 1.0 (`docs/boundary.md`). `scripts/check-boundary.mjs` runs in `npm run test:static` and fails on an import across the line that is not in its allowlist, which only shrinks: 757 crossings when it was written, 69 now, each with the fix it waits on.
- Better Auth 1.7.10 (was 1.7.2), with `@better-auth/core`, `@better-auth/sso` and `@better-auth/scim`: accounts are
  found by provider and account id again, a password over the maximum length is refused before it is hashed, and the
  SAML, OIDC and SCIM fixes since 1.7.2 (certificate rotation on a provider with linked accounts, an OIDC issuer that
  does not match its discovery refused at registration, SCIM `null` attributes and a `409` for a claimed value).
  An OIDC or SAML account is the provider's (its configured name) and the subject, no longer the issuer and the subject:
  the issuer stays pinned per provider, so the same subject from two providers is still two people. Pointing an existing provider name at a different issuer keeps its accounts, so a subject the new issuer reuses signs in as that account: give a new identity provider a new name. Better Auth now
  checks the store's tables at start, and serving waits for that check, so a store it refuses stops the start; the file
  store is migrated before Better Auth is made, so a first start logs no mismatch for tables about to be created. The `overrides` block in `package.json` is gone: Better
  Auth's peer range includes Vitest 5.

- `defineIntegration({ webhooks })` compiles to the endpoint `defineInbound` does and is served by the one inbound host:
  one size limit, signed-time window, replay record, principal rule and status-only answer for every signed callback.
  An integration's webhook gains the span, `Retry-After` on a refusal and the load-time footprint check a
  `defineInbound` had; a `defineInbound` gains the replay record (a resent consent event is not recorded again) and the service-role rule an integration's had; and
  a delivery first answered with a status that asks for a retry (5xx, 429) may be sent again as it was.
- A database browser start (`tablewalk <db>`, `--mcp`, `--lint`, `--diff`, `--export md | mermaid | json`) runs the
  browser's own main and loads nothing of the App framework; anything that names or serves an App, and a config file
  that lists Apps, runs the App framework's, on the same command line. `--mcp` loads 159 modules (was 187). A
  command's failure (`tablewalk tenant`, `tablewalk build`, …) is one line and exit 1 for every command; some printed a
  stack trace. A browser start over a config file that names the App framework's services (an email service, an
  identity provider) keeps those entries as written when its connection manager saves the file.
- A list's search box over a number column sends no words: it holds them, marked, and says it takes a number; and a value the engine cannot read as its column's type (PostgreSQL 22P02, 22003, 22007, 22008; MySQL 1292, 1366, 1367) answers 400 with a plain sentence, not a 500.
- The quickstart runs end to end: `migrate diff` with no versioned migration writes `schema.sql` itself as `V1`, with no Atlas download; `migrate up` with no migrations and none ever applied, and `migrate status` before anything was applied, exit 2 and say which command comes next; serving an App whose connection lacks tables it declares is refused at start, naming them and `tablewalk migrate up --app <dir>`; the install line adds `typescript`, and the typecheck runs only the project's own TypeScript, never the one beside tablewalk.
- The first-start admin variables say on the log when they made no account and why: half of the pair set, an App that declares no auth, or the account already in the store (named by its path) with another password, which is not applied.
- `tablewalk check` names every refusal across views in one run (navigation, home, empty and note actions, landings, orphan forms and dashboards) rather than the first, and `--help` is one screen, with `--help all` for the whole usage; an unknown option, or a bare word one slip off a command, is answered in one line with a did-you-mean.
- The database browser's SQL editor runs a read as the MCP `sql` tool does: stoppable, under the same 30-second cap,
  and on a SQLite file in a process of its own, so a statement that takes minutes no longer holds every other request
  the server answers, and leaving the page stops it. A statement that starts with a parenthesis
  (`(select …) union (select …)`) is bounded by the row limit like any other SELECT, and on SQLite a statement the
  limit cannot be wrapped around is read one row past the limit and stopped, never read whole and sliced.
- A write an App's database refuses names the field in plain words, beside it and by its caption above the form:
  "Email is required.", "Another record already has this email.", "The customer chosen is not a record that exists.",
  "Priority is not an allowed value." — for a NOT NULL, unique, foreign key or CHECK rule on PostgreSQL, SQLite and
  MySQL, where the engine names the column (SQLite's bare `FOREIGN KEY constraint failed` keeps the general
  sentence). Only a column's name is taken from what the engine said, never a value. A command marks the field when
  its input carries that column, and an import says the reason on the row. The engine's own words are printed on the
  server's stderr for every refused App write, which used to be answered with nothing logged.
- A server bound beyond loopback with no sign-in says so with the three ways out (bind `127.0.0.1`, an auth proxy's
  `--auth-proxy-header`, or the App's sign-in), since the Docker image binds `0.0.0.0` for whoever starts it; behind
  `--auth-proxy-header` the warning is no longer printed, because a request from beyond loopback must carry the
  proxy's identity and the "anyone can read" it said was not true.
- The site and README no longer link to the GitHub repository, which is private and answered every one with a 404: the
  DSL reference names the sample file a key is used in instead of linking it, prose links to repository files name the
  file, and the footer names the MIT license and the `LICENSE` file in the npm package.
- A banded table stripes lists and grids only, never the calendar's weeks, and `tablewalk check` warns
  (`theme-band`, C13) when a banded theme gives `parts.status` or `parts.tag` an opaque ground: a part's rule sits in
  the `theme` cascade layer above the look's band, so that chip stays its own color on every other row and shows as a
  pale column. The author's color is left alone; a translucent ground, or none, takes the band.
- A record page that names no `layout` is drawn in the one its sections already make: a gallery first is a showcase,
  a timeline that ends the main column with no list there a conversation, and the record's long text with at most 12
  facts and nothing else an article. The choice is made when the App is read, never from a row, so a page keeps one
  shape for every record and from its first frame; each is taken only where the layout's own rule takes the page as
  written. `tablewalk check --defaults` says each page's layout and why. Forecourt's vehicles became showcases, its
  inquiries conversations, and the service desk's knowledge articles articles.
- A large App's typecheck does about 11% less work: a page's sections no longer re-walk a reference for each table a
  path passes through, and a metric's, chart's and breakdown's `from` and `whose` are read from the section itself.
  The same mistakes give the same errors; a 150-table App's checker has 11% of its budget left again, Ignition 5%.
- An App's lists no longer scroll sideways inside their card: heads wrap, then words wrap to two lines, then the
  columns that still do not fit fold under the row's name as a detail line.
- A dashboard's matrix folds each row into labelled cells on a phone; its windows and a board's groups wrap.
- A phone's list controls wrap to a second line instead of running past the edge.
- On a phone a record's facts stand beside their captions, one row each, instead of taking two lines apiece; a wide
  field still puts its caption over it.
- A phone list's Records/Table switch sits at the end of its tab row instead of on a row of its own, and tabs that
  run past the edge fade there.
- A record's tags are chips wherever a value is drawn: a phone's row cards showed Thread's as raw JSON.
- On a phone a New form's or peek's drawer takes the whole width and keeps its actions at its foot while the fields
  scroll; Import in a list's bar is its upload mark, so the list's verbs keep one line.
- A related list's rows on a phone sit on their section's edge, a dashboard's odd count of divided metrics keeps
  its rules between pairs, and a metric's comparison wraps whole under its figure.
- In Mono and Sage a metric's fixed window ("Last 90 days") stands on the card's edge instead of 9px in, and a list's
  tab fade on a banded head (Sage) is drawn in the band's color instead of a dark block.
- A dark bar (`bar: 'dark'`) draws its New button and customer chooser in the bar's own colors.
- On a phone, the bar's menu, search and + icons follow the menu's ink on a dark menu; `check` reads the new pair.
- `type.data.reach: 'figures'` sets only figures, keys and dates in the data face, and the data face now reaches a
  record header's facts.
- `check` counts the 150 KB font budget per theme, and a page never downloads the faces of themes it is not wearing.
- Space values snap to the scale (two new steps: `--space-1h` and `--field-gap`); a sort head is a 24px target.
- A PostgreSQL URL ending `sslrootcert=system`, as PlanetScale writes it, connects: it is read as "verify against the public CAs" instead of a file that does not exist.
- Behind Cloud Run or another managed front end, `--trust-proxy-hops <n>` (`TABLEWALK_TRUST_PROXY_HOPS`) names the visitor from `X-Forwarded-For` by counting proxies, and `--trust-proxy-cloudflare` (`TABLEWALK_TRUST_PROXY_CLOUDFLARE=1`) reads `CF-Connecting-IP`. Before, every visitor shared one rate-limit budget and one sign-in lockout. Both are off by default and never read otherwise.
- The server reads `PORT` when no `--port` is given (Cloud Run sets it), the image's entrypoint maps it, and the image's health check probes `/healthz`. The deploy guide now says every replica runs `--jobs`, not one.
- `tablewalk check --deploy` refuses what would not survive a replaced container: an App source or `auth.store` on a SQLite file, the default `auth.store`, a missing `BETTER_AUTH_SECRET`, a `${NAME}` the environment lacks (exit 7). `--replicas <n>` above one warns that rate limits and lockouts are per process without a `cache` service.
- A list tab with nothing under it says "No homes in On notice right now." A tab that carries its own sort was read as
  a search that missed: "No matches", its own condition named as what narrowed it, and a Clear that left the tab. "No
  matches" now names the records by their noun, not the list's caption.
- A list that cannot be read says so with the warn mark and Try again, as a section does, instead of a grey line with
  no way out; Try again stands under the sentence, as an empty place's one action does.
- A record whose row is still out past the navigation hold draws its page's anatomy in placeholders (the head, the
  main column's and the aside's sections) instead of an empty pane, replaced whole so nothing under it moves.
- While a dashboard is read, a metric's figure is a bar at its size instead of "…", a chart holds its plot's room and
  a breakdown a row per group it expects, so the sections under them no longer jump down when they answer.
- An App says a date within two weeks from today ("2 days ago", "in 3 days", "yesterday, 2:05 PM") and the date
  past that, in its lists and on its records, with the full day and time on hover instead of the stored ISO text. The
  Workbench still shows the data as written.
- A dashboard's steps in the strip dress set their figure under the title's first letter, in tabular figures, where
  it stood indented by the gap kept for a mark the strip does not draw; a chart legend's values are tabular in every
  look.
- Sage's chart series are four distinct hues in their first four, where a second green and a teal made a five-way
  donut read as three; the dark series follow the same order, so a series keeps its color across modes.
- A line chart of up to three lines names each line where it ends instead of in a key above the plot.
- Every transition takes its time and its curve from the motion tokens: hover reveals that took 90ms, a new
  composer group's 400ms fade, and thirteen transitions on the browser's own `ease` now share the one hover, press,
  popover or panel time and the one ease-out curve.
- A theme's stylesheet refuses `text-shadow` and `filter` as a glow, naming C2, and the theming docs say a theme draws
  no glow: a lift is one of the look's, in the theme's `shadow`, never lighter than the ground.
- An App that validation refuses is still typed from what it declares: a segment refused for its name or its
  conditions keeps its word in `tablewalk-schema.d.ts`, and tags whose rule does not resolve still type `tags`, so a
  segment named `today` no longer costs every tab that names it a typecheck error before the one real problem.
- A row-policy App that does not start because of its own definition or a connection says `App error:`, its cause, and
  the file and line that wrote it, as every App error is; `Policy startup error:` is left for the policy module's own
  faults, and the refusal is said once instead of again as a server startup error.
- A changed `authority.lock` is one `authority-lock` finding that carries its changed facts and names
  `--write-authority`; each fact was its own `invalid-app` error saying "Correct the declaration".
- `tablewalk build` agrees with the `tablewalk-schema.d.ts` that `check` just wrote: it compared the types with a
  newline of its own after them, so every build said the file differed. Check, build and `--export types` write one text.
- `tablewalk grade` opens a theme's folded "More" disclosure and looks for a missing control there before it
  excuses it under C13; a new disclosure excused every control missing beside it, unopened. A disclosure whose name
  has a colon (the filter bar's "More filters: …") is read as one; the snapshot quotes such a name and C13 skipped it.
- A suite answers `/healthz` and `/readyz` itself, under its base path. They went to the App at its root, and a suite
  whose Apps are all mounted under a path has none, so `/readyz` answered 404 and an orchestrator, or
  `startTestSuite`, waited out its timeout for a suite that was serving.

### Fixes

- A list's filter bar folds its pickers again when a look's font arrives after the first measure, so the controls row no
  longer scrolls sideways on a desk where the face loads late.
- On SQLite, a row-policy App whose resource declares a TEXT column a date (`types: { created_at: 'datetime' }`, as the
  docs recommend) and grants a write or a command now starts. The declaration counted against the proof that each
  writer sees the App's catalog, and the App was refused with "The scoped catalog could not be verified" alone; that
  refusal, when another difference earns it, now names the table and column where the two catalogs part.
- `tablewalk check --policy` says the policy's refusal beside the App's own problems, after them, rather than instead
  of them, and `tablewalk explain invalid-app` says what such a refusal is and where its cause is written.
- A form's narrowed picker (`form.fields.tenant_id.where`, which the scaffold writes) is judged on a write that sets
  the reference or what narrows it, not on every write. A command that moved a request and took only a vendor was
  refused `400 invalid_input` on tenant_id, a field it never touched, because the check read tenants inside a command
  that does not read them. A write that does break the narrowing is refused with the pairing said.
- A journey's `person.act()` answers an email, link or phone question with one of that kind, and a required question it
  cannot answer (a pattern, lines or rows it must have, a reference to a table with no record) comes back `no_input`,
  naming it: the step `test init` wrote is skipped and said, where it was sent and failed `invalid_input`.
- A scaffolded App's `tsconfig.json` names `"types": ["node"]` and its `package.json` installs `@types/node`, and
  `test init` adds the first to a plain tsconfig that lacks it and says when the install is still to do. TypeScript 7
  loads no `@types` package unnamed, so the suite `test init` wrote failed `tsc` and check's typecheck with about
  thirty errors (`Cannot find module 'node:test'`).
- `tablewalk check` warns `[extends-not-named]` where a role extends one that a view's or page's `roles`
  names and is not named there itself. `extends` passes grants down and nothing else; `roles` and a row policy's
  `principal.roles` match a role by its own name, so an `admin` that extends `staff` saw no `staff` view and no row.
  The roles and row-access pages say so.

### Security

- A webhook's opt-out or opt-in is kept at the time its sender signed, and the newest wins: a provider's late resend of an old opt-out no longer undoes a newer opt-in. A consent write that fails answers `503` and lets the delivery go, so the provider's retry is kept rather than taken for a replay.

- On PostgreSQL, the flag, experiment and analytics stores' schemas (`tablewalk_flags`, `tablewalk_experiments`,
  `tablewalk_analytics`) are runtime state the way `tablewalk_auth` is: never listed, and refused to raw SQL and as a
  write target. Their tables are named plainly inside them, so the `__tablewalk_` prefix did not hide them.
- On a database browser reachable beyond this machine, a connection typed in the browser (Add or Test) is dialled
  sealed: its user and password are exactly the URL's (a missing password is empty, never `PGPASSWORD`, `PGUSER` or
  `~/.pgpass`), it may not carry a parameter that reads the server (`host=`, `sslcert=`, `socketPath=`), and its host
  is resolved to public addresses only — loopback, private and link-local (cloud metadata) addresses are refused.
- A password sign-in is counted per account as well as per client: past five attempts in fifteen minutes the address
  is locked for 30 seconds, doubling with each lock up to 15 minutes, and a sign-in that succeeds clears it. An
  address with no account is counted and refused in the same words. Better Auth's budgets and a session's recorded
  address now take the client from the server's own reading (`--trust-proxy`, `--trust-proxy-hops`,
  `--trust-proxy-cloudflare`, else the socket), where a client's own `X-Forwarded-For` was a new budget per guess.
- Better Auth's per-address limits (three password sign-ins in ten seconds from one client, and its other budgets) are
  on wherever tablewalk serves; they were on only where `NODE_ENV=production`. The test suites lift them with
  `TABLEWALK_TEST_AUTH_LIMITS=off`, honoured only by a server that listens on loopback and ignored, with a line
  saying so, on any wider bind. `tablewalk/testing`'s host, which listens on loopback, lifts them for an App's own
  suite, so a generated or hand-written suite that signs in per case is not refused with 429.
- Markdown sent to a rich text field is read up to 20,000 characters, a value with more than 256 runs of `*`, `_` or
  `~` keeps them as written, and a quote or list nested 32 deep is refused: 30 KB of `*_a` from an anonymous public
  form held the server for over a minute.
- A state machine's clocks — its `since` and a state's own stamp (`ready_at`) — are written only by the server as the
  state moves (or by a verb that sets one): a write that said one, through any role that writes the table, is refused,
  and a move restamps `since` even when the write repeated it. A backdated `since` fired an `after` timer early.
- An export that shows or filters by a rollup or a computed column needs the export grant for every table those read,
  as one through a reference already did; and `/api/run` answers at most 2,000 rows of a table its reader may not
  export, where it served 100,000 to anyone who could read the list.
- An uploaded file that is not a raster picture is served as `application/octet-stream`, always as an attachment with
  `nosniff`, and a file asked for as a script, stylesheet or worker (`Sec-Fetch-Dest`) is refused: the type the
  uploader claimed was sent back as the response's type.
- `tablewalk check` fails an App whose `signUp` is `'open'` with the `email` provider when the config names no email
  service (`open-sign-up-unproven`): anyone could make an account under anyone's address, and nothing could prove one.
  It was a warning; a server still starts and says it.
- Better Auth's own admin endpoints that change an account — `set-role`, `ban-user`, `unban-user`, `set-user-password`,
  `update-user`, `remove-user` — and `impersonate-user` answer 404 however the path is spelled: they changed an account
  around the accounts screen, its last-administrator guard and its trail. The screen makes every one of those changes.
- Every answer carries `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy` denying the camera,
  microphone, location, payment and device APIs, and one that arrived over https (TLS, or a trusted proxy's
  `X-Forwarded-Proto`) carries `Strict-Transport-Security`. A record's address left the origin whole in a referrer.
- The pinned Atlas binary in `.tablewalk/bin` is checked against its sha256 on every run, not only when fetched: one
  replaced since is removed and fetched again, never run.
- Two `createTablewalkHandler`s in one process each keep their own proxy trust (`TABLEWALK_TRUST_PROXY_HOPS`,
  `TABLEWALK_TRUST_PROXY_CLOUDFLARE`) and pool settings: a handler started second set them for the process, so the
  first keyed its rate limits, and recorded its sessions' addresses, by the second's front end.
- An App's sign-in routes (`/api/auth/…`) are held to the door a tenant App's already were: a write from another
  page, or one a browser marks cross-site, is refused before Better Auth reads it, rather than left to Better Auth's
  trusted origins alone. A provider's callback, a SAML response, a back-channel logout, an OAuth client's token
  calls and a host's embed exchange hold their own proof and are not asked their Origin; a SCIM directory sends
  none. A page on `localhost` posting to `127.0.0.1` is another origin and is refused, as every other write is.
- `SECURITY.md` and the docs say where `"writable": true` is enforced: in every route and tool that writes, before
  the adapter, which runs what it is handed. They said the adapter enforced it.

## 0.9.5

0.9.5 is the release where a page is laid out as well as filled: a dashboard places its sections in named areas, counts a
funnel in one statement, buckets time by what the window calls for and shows each figure's change and trend, and a
record page groups its related rows and wears a head the theme chooses. Space and text size come from two scales,
themes say their accent inks, scheme and rhythm, and `check` reads errors first. It also closes a security pass: the
export grant, the egress guard, the embed token and the image cache.

### Upgrading from 0.9.4

- **TypeScript 7 first.** tablewalk's optional `typescript` peer is `>=7`, so a project still on `typescript@^5.9`
  stops `npm install` with `ERESOLVE`. Run `npm i -D typescript@7` (or remove `typescript` where you do not typecheck
  the App) before upgrading tablewalk, then regenerate `tablewalk-schema.d.ts`.
- A composer's note mode sends with **Add note** (the button said the mode's name, Internal note); a test that posts a
  note finds the button by that name.
- A chart's `funnel` shape is gone: use the `funnel()` section, which counts rows reaching each ordered stage.
- `empty: false` on a related list or dashboard section is `empty: 'hide'`; `'collapse'` and a guidance text are the
  other words.
- A segment named like a query word (`today`) or a column (`enabled`) is refused with the words the language reads,
  a safe name to use (`today_only`), and every colliding segment at once; tabs that write their own `query` are all
  listed in one refusal rather than one per load.
- Loading an App now lists every import from `tablewalk/app` that no longer exists, each with what replaces it
  (`money()`, `number()`, `percent()`, `relative()`, `items()` and `tones()` are the data they always returned:
  `{ format: 'money', currency }`, `{ tone: { … } }`), instead of stopping at the first.
- `page('Title', 'resource', [...])` says that `page()` no longer takes a title and shows
  `page('resource', [...])`; `document()` likewise.
- A removed form says what replaces it, in one place: a dashboard `metric({ view })` is `to`; a fields
  `presentation: 'card' | 'headline' | 'accordion'`, `collapsed`, `actions`, `subfigure`, `was` and `note` are refused
  with one table of what each is now (also in the Pages reference); `ui.shell.workbench` says an App serves no
  Workbench (the standalone browser keeps it); `sizing` on an App page's related list says nothing there replaces
  it and points to a list view of its own, where `sizing: 'scroll'` is taken.
- A display rule with a `component` is refused a `face`, which the component sets itself; a masked prefix still takes
  one.
- Exporting a file needs the grant for every table it reaches, through a reference, aggregate or filter, not only the
  base table; `ui.export: false` now refuses the file on the server as well as hiding the menu.
- A breakdown, chart or matrix opens its groups in the list `to` names or the one list over its table, never the
  database browser; one with two candidate lists and no `to` draws plain text and `check` says so (`drill-ambiguous`).
  Name the list, or say `to: false`.
- A table in an App is 32px a row at compact density (Lumen's default; it was 37), 40px at comfortable and 44px at
  spacious and under a finger. A metric over a window now draws its change from the period before and its trend
  unasked.
- Mono and Sage start an App at compact density, as Lumen does (they started comfortable). A person's own choice in
  Preferences still wins.
- Text set at 11.5, 12.5 or 13.5px now draws at 11, 12 or 13px (`--text-xs`, `--text-sm`, `--text-base`): an App
  stylesheet that matched the old sizes by eye may want a look.
- A cross-origin embed bearer is a token of its own over a session that lapses with it in an hour, no longer the
  session cookie.
- `tablewalk check` prints a step's errors first and its warnings as one line a kind (`45 warnings (restated 40,
  index 5); --warnings lists them.`); `--warnings` lists every one after the errors. `--json` and `--brief` are
  unchanged and carry every finding.

### Security

- An export needs the grant for every table the file reaches, and `ui.export: false` refuses the file on the server,
  because the grant covered only the base table and the switch only hid the menu.
- The egress guard reads the IPv4 address inside an IPv6 spelling (NAT64, 6to4, IPv4-compatible) before it checks the
  range, so `64:ff9b::a9fe:a9fe` no longer reaches cloud metadata.
- A cross-origin embed bearer is a token of its own, over a session that lapses with it in an hour, because a script
  on the host page could replay the cookie for the full seven days on every route.
- The image-variant cache defaults to a private folder the process makes, not a shared name in the temp directory,
  where another local user could plant a picture.
- The integrations docs say a webhook signature must cover the event time, and a stale delivery re-timed to now is
  refused.

### Dashboards and charts

- A dashboard's `layout` places its sections in the named areas of a grid, so one section can stand beside a column of
  others; a four-column layout stays four columns at a 1280px desk.
- `funnel()` counts how many rows reach each of its ordered stages in one statement; a stage may be a condition, and
  the stage and lost-rows links are 24px targets at least.
- A breakdown, chart or matrix opens its groups in the list `to` names, or the one list over its table.
- A chart can say `auto` for its date column and is cut into the unit its window and data call for, saying which, so
  three days of data no longer draw 31 empty bars. `check` judges it.
- A metric over a window shows its change from the equal period before and its trend across the window from the first
  paint. A metric whose target counts the same thing says its share as "118 of 159 (74%)" and follows the window.
- A step strip wraps eight steps to two rows of four, lets a title run to two lines and draws no mark where the value
  has no icon.
- A gantt names each home on its row under a sticky group band, draws years over months thinned to what fits and
  marks today in the accent.
- A calendar in a section names its month as a quiet label, is not boxed again on an open page and keeps a 64px day;
  a card's title gives way at a word.
- A board's lanes are at least 15rem, its category is a muted word beside the stripe, and an empty final lane folds to
  a strip from the first paint.
- Stacked bars wear the tones of their column's display map, with the legend above them on one line in one number
  format.
- A value component's exported `label(value)` says its column's vocabulary as words in breakdowns, chips, selects and
  the CSV.
- A rows section's `empty` says what it takes, words or `'hide'`, and a custom section may declare eight named reads
  where four stopped a real section short.
- A custom section may declare `totals` (count, sum, avg, min, max over a table's rows, with an optional group), run on
  the server under the reader's grants like a metric, so it no longer counts only the 500 rows it may read.

### Record pages and lists

- A related list can be read as groups: a header for each record its rows share, the group's rows under it, a page of
  groups at a time.
- A theme dresses a record's head and a list's with `recipes.head` (`plain`, `band` or `hero`).
- A record page chooses its archetype with `page(…, { layout })`: `'conversation'` keeps its one timeline last in the
  main column at a reading measure with the record beside it, `'listing'` puts a gallery beside a panel of one to three
  sections (the price) and the rest under both, so a phone reads the price after the photos, and `'article'` is one
  column at `--page-measure` (70ch). What a layout cannot place is refused with its fix (`page-layout`,
  `layout-conversation`, `layout-listing`, `layout-article`), and `check --design` says a written `'record'` is the
  default. Lintel's repairs are conversations (and its Repairs list a `split`), its homes and buildings listings, and
  Tick's task an article.
- A reference is drawn as the record's name and link, including a `latest()` of one, a board card's person and a card's
  or queue's enum title by its display rule; a record summary leaves out a reference already drawn as the title.
- A list table fits its room at 1280px and fades at the edge where it cannot, its heads keep the room their labels
  need, and a table in a column of its own gives the row's name way.
- An App's list heads wrap to two lines at a word break before a column widens for them, and only when the heads
  set on one line would run past the room; a head's menu caret stays clickable however full its label.
- An App's list and related rows stand at the density's row height: 32px at compact, 40px at comfortable, 44px at
  spacious and under a finger.
- One `empty` vocabulary on related lists and dashboard sections (`'hide'`, `'collapse'`, guidance): empty runs fold
  into one line with their Add buttons, and `check` warns of a run of three quiet lists.
- A signed-out visitor of an App with public pages gets the top-bar shell (brand, public entries, Sign in) in place of
  the staff sidebar.
- A boot failure and the shell's unavailable screen are one page in the App's name, mark and look tokens; a refused
  room is one state block (a lock, one line, the sign-in as its action); an App's record crumb gives its table a step
  of its own.
- Date fields show the locale's format, a due date is said relatively only within two weeks, a due date past on an
  open row is drawn in the warning ink, and required is said once by the star.
- Menus share one grammar: an ending verb last in the critical ink, a repeated heading dropped, New listing make before
  run, and icons on all lines or none. The Records/Table switch on a phone is a pair of marks.
- A schema-prefixed table is said as words alone (breadcrumb, eyebrow, default list title), and `check` advises a label
  written as an identifier.
- A column's own filter popover lists a name column's few values with their counts, and a text a section is only about
  is set as a paragraph that says "No description yet" when empty.
- The theme picker marks the App's own theme and offers Reset to the App's theme while a reader's pick is worn.
- A custom section can draw `Table` from `tablewalk/ui`: rows a component read, in the look's own table, each cell a
  `Value`, the first cell the row's link.

### Theming

- A theme's accent is a fill with its own inks: `onAccent` for the words on it and `accentInk` for the accent as text,
  each derived to read when a theme names neither, so a bright brand orange is no longer refused as text.
- A theme says `scheme: 'dark'` (worn dark until the reader picks a mode) or `'dark-only'` (one set of colors judged as
  dark, not as printed paper); the first page is sent dark, Preferences shows the mode as Dark under `dark-only`, and a
  tenant's or host's saved theme takes `scheme`.
- A theme chooses a rhythm, `rhythm: 'tight' | 'house' | 'airy'`, that moves the layout steps of the space scale and
  the section seam a quarter closer or wider.
- Space and text size come from two scales (`--space-1…8` with the control steps `--space-2h`, `--space-3h` and
  `--space-4h` at 6, 10 and 14px, `--text-xs…xl`, `--section-seam`); `tablewalk/ui` exports
  the design tokens as a typed list, and `check` warns of a `var(--…)` no look defines, naming the token
  (`--negative` is `--status-critical`).
- A display rule takes a `face` (`data`, `sans` or `code`), and an App keeps the data face for keys, references and
  codes only.
- A chart suggestion is proved by the check it answers, and where no order of the series passes, `check` moves a
  series one shade along its hue before saying none does.
- A focused grid cell's ring is a true 2px under the density zoom; Mono's focus ring is the ink and Sage's its link
  green.
- The `nav` type role dresses the side menu's entries as it does the bar's where a theme sets it; a tenant may add a
  dark logo beside its logo.
- A status chip is sized by what the look wearing it draws beyond its words, and a toned figure is its tone's ink
  alone. Lintel tones a vacant home and a late fee as warnings.

### Commands and permissions

- A role granted a verb by `actions` can run a move that stamps a column; the stamp is the server's and not read as the
  caller's write.
- A refused command says which rule refused it, and the value, where it said only "not eligible" or "not available to
  this account".
- A page's id over a record still opens it once a list view takes the table's records, and a refusal names a role only
  in an App that has roles.

### Developer loop and `check`

- `check` prints errors first and warnings as one line a kind; `--warnings` lists them all.
- Loading an App reports every removed import, and every colliding segment and query tab, in one pass.
- The dev server reloads an App only for the files it loaded, so a log redirected into the App folder no longer
  reloads it in a loop; a build proves its bundle against the App.
- `check` writes `tablewalk-components.d.ts`, a props type for each custom component named from its id
  (`SalesSummaryProps`), and treats every header tablewalk has written on the schema types as its own. Add it to
  your formatter's ignore list beside `tablewalk-schema.d.ts`: `check` rewrites it.
- `grade` reads C13 as the controls a reader can reach, so larger type folding a filter into "More filters" no longer
  fails it, and prints its progress to stderr.
- `tablewalk shot` performs `--click`, `--type`, `--press` and `--wait-for` steps in order before the picture, wears
  `--dark` or `--light` as the reader's own pick, and `--matrix` shoots every built-in look, light and dark, desk and
  phone, with an index page. `--as <role>` signs in as the account the App's people table names first.
- The scaffolded Overview names the list its groups open where a table has two.

### Fixes

- A scripted reader's first visit to a public list no longer fetches the server-drawn document's pictures behind the
  startup veil.
- A sign-in's password Show is a trailing adornment inside the field, and quick add stands on the room's inset.
- A header that names its verbs still fills the first that takes nothing away, and a list's Add is the verbs' size at
  a desk.
- A section's table reaches out 14px on its start side only; platform field styles stop at the field's own caption and
  value, so a custom component's own list is not restyled.
- A record page opened as its table's suggested page is remembered under Where you were.
- Lumen's facet spacing is scoped to the filter rail, and Mono's menu entries keep one face whether current or not.

## 0.9.4

0.9.4 is the release where a theme can say what a brand says: how each kind of text is drawn, its shadows and
lifts, its pace, round controls, border widths and the App's own logo, one theme for each audience, with `check` and
`grade` naming the promise a finding breaks. It also closes the gaps a field report found under row policies, tenant
Apps and stores (clear refusals, generated columns, stores that move forward in place), adds Export as a grant,
computed-column functions and column-to-column guards, makes the tools agree on one way to spell things. Themes can also band
rows, lay patterns behind the page, style each part, choose an icon weight, carry their own checked stylesheet and
ship as packages.

### Upgrading from 0.9.3

> Since this entry: 0.9.8 moved feature flags, audiences and `@mistriwork/mistri/openfeature`, experiments, the Suite
> Console, behavior analytics, SCIM, the Gantt presentation and a resource's `search` to Preview at 1.0, outside the
> compatibility promise. [Status & roadmap](site/src/content/docs/docs/status.md) is the list.

- `--check-app` is gone: use `tablewalk check`. `--look` on `shot` is gone: use `--theme <id|all>`.
  `--preview-features` and the `preview:` line are gone, since nothing is in Preview.
- A theme's `type.scale` becomes `type.roles.title.size` (or `type.base`), `type.headingWeight` becomes
  `type.roles.title.weight`, and `recipes.labels`, `recipes.figures` and `recipes.headings` become `type.roles.label`,
  `type.roles.figure` and `type.roles.section`. The old keys are refused, naming the new path.
- `colors.*.rules.weight` and `colors.*.rules.control` become `shape.border.rule` and `shape.border.control`; a shot
  recipe's `rules.control` becomes `border.control`.
- `shape.radius` is the object `{ control, field, pill }` alone; a bare length is refused. `ThemeDefinition` names it
  `radius`.
- A `notify` rule sends with `send: { channel, to, consent, timezone? }` where it said `via`, and its check codes are
  `notify-send-*` (were `contact-email-*`). Rename `via` to `send` and any suppression of the old codes.
- A role exports the tables it writes and those named in `auth.roles.<role>.export`. A role that only reads a table
  loses Export of it until the table is listed there; a signed-out visitor never may, and `/api/export` answers 401 or
  403.
- The App API selects a view's tab with `?segment=`, as a resource list does. `?tab=` is for an App's page addresses.
- A job store with no run of a job starts at its next slot: a first start no longer runs a missed slot.
- A sandbox store made by 0.9.3 or earlier is refused at start until `tablewalk migrate stores up --app <dir>` gives
  it a version row; a hand-altered one is refused and named. A tenant store made before 0.8.11 stays refused: reseed it.
- A refused insert, update or delete answers with a top-level `code` and `message`, as a command's answer does. A
  signed-out read of a table past `auth.public` answers 401 `members_only` with the sign-in card (it was 200 "No table
  called"). A `consumes` refusal on a line saved with its parent, and under a row policy, answers 422
  `consumes_refused` (it was 200).
- A `${DATABASE_URL}`-style url whose value is a relative path is read from the current directory, not the config's
  folder; a literal relative SQLite path in `tablewalk.json` is the config folder's in every command.
- An App whose connection is MySQL or MariaDB is refused at `check` (`app-on-mysql`) and at startup. Browsing them in
  the Workbench and MCP is unchanged.
- `--jobs` for an App with no commands is refused at startup, as a tenant start already refused it.
- The startup refusal `[footprint-reference]` is gone: a command that names no record and only updates rows starts
  under a row policy, and a reference it sets outside its footprint is refused by name when it is written.
- A theme that passed `check` may now fail, because each color is measured on every ground it is drawn on; the
  finding names the path and a passing value, and `check --fix` writes it. `grade --theme` now gates on findings the
  theme caused. `check` and `grade` codes `faint-edge`, `hidden-focus`, `color-only`, `long-measure`, `unsafe-motion`,
  `print-contrast`, `heavy-theme` and `changed-app` and the `theme-*` codes carry a `promise` (C1 to C13).
- Sage's chart series are reordered and its pale green deepened; Lumen's authoring chip, list rail facet boxes and
  navigation pills are drawn a little differently (see Fixes).
- Lintel's `cancelRequest` is the desk's command, so only the roles that may perform it are offered it, and its test
  accounts are the seed's own people. Regenerate a copy's `authority.lock`.
- Nothing changes for existing themes from the part styles, patterns, icon weights, theme stylesheet and theme packages.

### Features

- A theme draws each kind of text in `type.roles` (display, title, heading, section, body, label, data, figure, nav:
  face, size, leading, tracking, weight, case, features, with a `mono` face) over a `type.base` of 13px to 16px that
  every stylesheet size scales with.
- A theme says the ink its shadows are mixed from, `colors.<mode>.shadow`, and its lifts, `shape.elevation { card,
  float }` from none, hairline, low, mid and high. `check` warns of a shadow lighter than its ground (`theme-shadow`).
- A theme moves at a pace, `motion` house, brisk or still; still skips a navigation's and a record's enter, as reduced
  motion does.
- A theme's controls may be round or up to 16px and a panel up to 20px, and reach the controls a look corners itself,
  the dashboard's window, filters and periods, and a list's search and toggles. `shape.border` sets the rule, control,
  panel and focus widths once for both modes.
- An App's own logo is a picture: `ui.logo { src, dark, mark }`, read from the App directory and served by content
  name. `check` says a picture with no dark answer as `theme-dark`.
- An App dresses each audience in a theme of its own, `ui.theme.for { public, roles }`. One resolver ranks them: the
  public theme, the reader's pick, the role's, the tenant's, the App's, then Lumen. The first paint, the role
  projection, tenant branding and `grade` all read it.
- The theme contract is thirteen named promises, C1 to C13; `tablewalk explain C5` says one. `grade --theme all
  --palette all --as all` grades every look, palette and role in one run.
- `shot --theme`, `grade --theme` and the theme bench stand the menu where the theme's `shell.placement` suggests, and
  say in one line when the App's `ui.shell` overrides it. `grade --theme` blames the theme by token path, or by type
  scale and density, and gates on what the theme caused.
- Every recipe value is said in a sentence, in the schema and under its picture on the gallery page, and `shot
  --recipes` names the values that draw a page nearly alike.
- `shot` and `grade` take `--as <role>`: they sign in as the earliest account of that role in the App's local store,
  inside a copy where its password is reset, so pages show that person's own rows. With no such account a fresh one
  signs in and the run says it owns no rows. A service role is never offered; `--as` names one with a sentence saying
  that a job or a policy acts as it.
- `tablewalk jobs run <name>` runs one of an App's jobs at times now, as a manual run in its job store that the server
  started with `--jobs` runs and journals beside the slots. An unknown name is refused with the names there are.
- A role can be granted Export of a table with `export`, and the server refuses the file to anyone not granted it.
- A tenant App's stores move forward in place: `tablewalk migrate stores status | up --app <dir>` reads and upgrades
  them without creating any, takes the maintenance lock on PostgreSQL, and accepts a `tablewalk build` as `--app`,
  reading its bundled commands and jobs. A tenant start refused for a store behind its layout prints the command.
- Computed columns call `coalesce`, `round`, `min`, `max` and `abs`, written alike on SQLite and PostgreSQL and worked
  out alike in the browser, so a balance can say `max(owed - paid, 0)`.
- A command's `when` and a fixed action's `when` compare two columns (`qty < reorder_at`), judged in the transaction
  once the row is read, and a command's `when` reads a rollup of its rows' computed column.
- A validation and a form's `{ from }` default read a computed column, the record's own or the referenced record's.
- A machine verb that runs a command takes `confirm: true` and asks before it runs, as an action already could.
- A refused insert, update or delete names the rule that refused it, in the answer and on the server's terminal.
- Startup says why: a job store that cannot be opened (a missing path, a directory, foreign keys off), a refusal's
  recorded reason, a row-policy failure that is the App's own, and a tenant start whose `TABLEWALK_AUDIT_KEY` is not
  the support audit store's key (without printing the key).
- Startup refusals about commands under a row policy name what to write: the commands `resultReferences` covers, the
  public ones it leaves out, and any it names that are none.
- A server bound beyond loopback warns that anyone can read the database only where that is so, and says of an App
  that signs people in what a signed-out visitor reads.
- `tablewalk check` lists jobs, workflows and endpoints as information, not errors, under `--brief`.
- The test kit's `act` runs a command only on records the server offers it on. Each of a machine verb's `set`,
  `reason`, `when`, `confirm` and `bulk` says what it does where an editor shows it. The help names
  `TABLEWALK_TEST_CONFIG`.
- Lintel, a repairs and property-management sample App, with a permissions test, joins the examples. The README's
  natural-key and slug addresses are Thread's and Forecourt's, and the docs say when to write `now` and `today` and
  when `ctx.now()`.
- A table can band every other row (`colors.<mode>.band`, `recipes.table: 'banded'`), and the page and menu can wear a
  pattern (`surface: { ground, nav }`: paper, grain, grid, dots, lines or scanlines); `check` measures text over it.
- A theme styles each of 35 published parts by color role, never a raw color, and chooses an icon weight
  (`type.icons`: regular, light, bold or fill).
- A theme can carry its own stylesheet (`stylesheet`, up to 8 KB of `[data-part]` rules, read against an allowlist and
  scoped to that theme), and a look can be published as a package (`contract: 1`, `from: import.meta.url`) that an App
  wears or extends. New check codes: `theme-part`, `theme-css`, `theme-contract`.
- A record's actions on a phone take a second row instead of leaving the screen, and the logo picks its light or dark
  picture by the bar it is drawn on.

### Fixes

- An App, or a tenant App, with sign-in whose look ships font files starts again.
- A relative SQLite path in `tablewalk.json` is the config folder's in every command, including `migrate`, suites,
  token commands and the command journal and jobs a start puts beside the database.
- A build serves from anywhere, beside the App or copied away from the project; its `tablewalk/…` imports are the
  serving tablewalk's own.
- A job at times never runs two of its runs at once: a slot or manual run waits while another holds its lease.
- A table with a generated column is read and written under a row policy, in SQLite and in a tenant App, the column
  itself never written. The pinned PostgreSQL read is proven against one.
- An account an administrator makes on the accounts screen is verified when it is made, so staff added under open
  sign-up match their rows and get notifications.
- A granted action that stamps `me` says why it is refused when the account's address is not proven; a change that is
  no granted action says so.
- A signed-out visitor at a public table's record address reads the record, and a table past `auth.public` asks to sign
  in. A visitor on a tenant's public address is told a members' list is for signed-in members.
- A segment whose condition reads a computed column or a rollup passes `check` in a tenant App with the platform
  realm, and a refused App's types keep their rollups and computed columns, so `check` says one problem.
- `check` places a finding at the key that declares a role, or nowhere, only in modules the App loads (never a backup
  copy), and one about a command at its definition. It measures each color on every ground it is drawn on.
- `grade` does not count a control drawn in a text field's padding (Depot's date field), or content scrolling under a
  phone's pinned bar, as an overlap. `shot` and `grade` wait for a page that reloads or redraws itself.
- The stacked-lists warning passes over a document. A record's related tabs take a 44px touch target on a phone, and a
  workflow step's label takes two lines.
- The authoring chip's words read 4.5:1 on their tint in every look. Lumen's list rail facet boxes draw a control's
  edge. Sage's chart series stay apart for color-blind readers, and the Harbor example in the theming docs passes
  `check` in dark.
- A filter over money in minor units names its values and reads its range in the major unit. A phone's list does not
  say a row's title twice, and offers Records and Table only where the table says more.
- A calendar in a narrow place gives a card's title two lines. A record's headline no longer offers a public form to
  a signed-in reader. The list's New button follows the create grant, so a role is not offered a form the server
  would refuse.
- Lintel: a studio reads as Studio, a resident reads their repair on a page of their own, a technician's visits open
  on what is still to come, soonest first, and its test accounts are the seed's own people.
- The docs say a refused restock answers `consumes_refused` too; the README and mount comments use Lintel's addresses
  and the client's `addressMount.js`.

## 0.9.3

0.9.3 makes links and record addresses follow the person: a technician is mailed `/repairs/12`, not the residents'
`/my-requests/12`, and a person who opens an address they are not served is sent on to their own. It closes the gaps
Lintel found: a parent and its children in one row-scoped write, a reference on a public form, and mail to a record's
address in tenant Apps and suites. Tests get `host.seed`, `host.runJob` and a scripted assistant, `test init` writes a
suite for a row-policy App, and `shot` and `grade` can sign in as an account that exists. It also fixes a security
hole in `tablewalk serve` (see Security).

### Upgrading from 0.9.2

- A link to a record in an email, a suite link, a tenant's notice mail, the Governance audit and the console is the
  address that person is served: the first view showing the record's table among the views their roles are served, not
  the whole App's first. A person with no address of their own is sent to their notifications. Links that you saved
  or tested by their old form may change for anyone not served the App's first list; the old address still opens, and a
  signed-in person is redirected to the same record at theirs.
- MySQL and MariaDB are supported for browsing, through the Workbench and MCP. Apps run on PostgreSQL and SQLite. This
  is now said in the README, the site and the status page.
- A required dropdown, record picker or listbox in a form is named by its caption, so its accessible name now includes
  "(required)", as a text box's does. A test that finds one by its exact bare name (`getByRole('combobox', { name:
  'Priority' })`) needs the new name or a pattern.
- Sage's menu, and a top bar that holds it, are a warm white panel on the cream page again, not the page itself.
- The unsubscribe links of a `tablewalk serve` started before this release stop working (see Security).
- A relative `--policy`, `--commands` or `--jobs` given to `startTestApp` is read from the App's folder, not from the
  workspace the process runs in.
- A server under `NODE_ENV=production` no longer reads `TABLEWALK_ASSISTANT_SCRIPT`.

### Security

- `tablewalk serve` signed unsubscribe links with the text of the secret's reference (`${…}`) in place of its value,
  so anyone who could read the config file could forge an opt-out for any address. Links are now signed with the
  secret's value. The secret's value was never exposed, so there is nothing to rotate. A link mailed before
  the upgrade was signed the old way and no longer verifies; the person can use the link in a later message.

### Features

- A row-scoped write may make a parent and its children at once, in one transaction, under the policy's scope.
- A public form may ask a reference it can read (`field.reference`); `[public-form-picker]` refuses one it cannot.
- Mail to a record's address (`notify.via` with `channel: 'email'`) works in tenant Apps and suites, with unsubscribe
  links signed with the secret's value.
- Addresses follow the person, with no new words to write: `tablewalk check --routes` prints one line for each role
  whose address for a record differs from the whole App's. A signed-in person opening a record at an
  address they are not served is sent on to the same record at theirs (`/my-requests/12` becomes `/repairs/12` for a
  manager); whether they may read the row is asked after, as for any address.
- A signed-out visitor at a member's address is offered the sign-in there, and comes back to it.
- A test arranges rows with `host.seed`, runs a timed job with `host.runJob`, and scripts the assistant with
  `startTestApp({ assistant })`. A permissions matrix reads a refused read as the server gives it, a table the role
  cannot see is not there, and a refused write needs no record.
- `tablewalk test init` writes a suite for a row-policy App: its policy and jobs served, a journey per person and each
  timed job run now. It writes a cross-table verb on the record its command runs on, and seeds a record a matrix row
  needs.
- `shot` and `grade` sign in as an account already made with `--as <email>`, the password from
  `TABLEWALK_AS_PASSWORD`, over a copy of its store that the run never writes back.
- A suite App entry names its `commands` module (`apps[].commands`), and a suite serves a `tablewalk build` as `serve`
  does.
- A test host that cannot load the App's commands, jobs or policy module says that module's own error first, and the
  server's App error line says its cause.
- `npm run test:ci-parity` checks in seconds what only CI used to catch: the Dockerfile's inputs, stale references and
  the bundle measures at their ceilings.
- Twelve CLI flags that no test exercised are each tested now. The examples/testing README names the new helpers.

### Fixes

- A tab's count compares two columns as its list does, counted through the view, so Lintel's low parts are low by
  their own reorder point.
- A dashboard's rows carry the record's name, so a card on a phone is titled by it and not by its key.
- The startup page says to check the server only when it is not answering, not at fifteen seconds of any slow start.
- An App never draws the Workbench: an administrator whose grants give no view sees the App with nothing in it, and
  `shot` says why.
- An App embedded in a host's page leaves the main landmark to the host.
- One rule for relative paths, said once: the command line's are from the current directory, a file's from its folder,
  `build --out` included.
- Lintel's manager and admin can cancel a repair; the reason goes to `resolution`, which the desk could not write.
  Lintel's technician is mailed `/repairs/{id}`.
- The docs say replicas are not preview, the roadmap is the road to 1.0, and the page and menu pictures are Lintel's;
  Sage's picture shows its menu as it is now.

## 0.9.2

0.9.2 ships Lintel, a flagship example: property operations in Lumen, a staff desk and a resident portal in one App
under a row policy. To build it, a row-policy App now runs its jobs, timers, inbound endpoints, integrations and
effects, and a notify rule can email someone who has no account. A theme has one color vocabulary from `defineTheme`
to a component's CSS, and a field report on a bike shop's App, built by an agent from the shipped skill, is answered
with `restocks`, role `extends`, state groups, a validation through a reference and a default aside.

### Upgrading from 0.9.1

- The public examples are two: Tick, the starter, and Lintel, the flagship. Compass, Thread, Keystone, Forecourt,
  Payday, Depot, Commons, Atelier and Loaner Desk leave `examples/apps` and the package; each is a regression fixture
  under `test/fixtures/apps` now, its seed under `test/fixtures/databases`, kept because it holds a feature Lintel
  does not (languages, row-defined fields, flows, a CSV import, a free-form page, a lines grid, a scan). Copy one from
  the repository if you started from it. The docs, the skill and the DSL reference's "Used in" links point at Lintel
  and Tick. The Docker image serves Tick.
- The Keystone and Loaner Desk acceptance suites move with their Apps, to `test/keystone-acceptance` and
  `test/loaner-desk-acceptance`; `examples/testing` and Lintel's own `tests/` are the layered reference for testing an
  App.
- A machine's group is asked with `is`, as `is open` is: `status is onBench`, `status is not onBench`. Inside `in`
  a group's name is refused with that fix (`status in onBench` read its states before).
- The integrations store moves to layout 2, which adds who made the write behind each channel message and an index for
  counting a recipient's mail. Run `tablewalk migrate stores up`; a server whose store is behind does not start.
- `PolicyPrincipal.visitor: 'public'` is `kind: 'public'`, the field a form's and a job's principal already use. A
  `resolveRows` that tested `principal.visitor` tests `principal.kind === 'public'`.
- A theme says each color by one name, the compiled palette's and the custom properties' too: the palette keys are
  the spec's paths in camel case (`navGround`, `statusCritical`, `chart1`) and each custom property is the path
  hyphenated (`--nav-ground`, `--status-critical`, `--chart-1`). The old names (`background`, `text`, `borderControl`,
  `navSurface`, `negative` and the rest) are refused in `defineTheme` with the name that replaced them, and a custom
  component's stylesheet that reads `--text` or `--nav-surface` reads the new one. There is no alias.
- `shape.radii` is `shape.radius`, one object: `{ control, field, pill }`.
- A `consumes` refusal on Save (`/api/insert`, `/api/update`) answers HTTP 422 `consumes_refused`, as a command and
  the App API do; the body and the form's message are unchanged. A client that treated the 200 as the refusal reads
  the 422.
- A refusal that holds for good answers 403, not 503: a row scope's, a form a deployment cannot take, and an App with
  no one connection. A probe that retried a 503 stops retrying.
- A query with no signed-in person (the database browser, MCP, the App API) refuses `me` instead of comparing with the
  text "me"; quote it (`"me"`) to mean the word.
- An App's record page that declares no `aside` gets one of the record's remaining readable fields, titled by its
  noun, as the generated page's is. `page('lead', [ … ], { aside: false })` leaves it out. A page that wrote
  `fields([ … ], { region: 'aside' })` by hand keeps what it wrote.
- A fixed action's `when` over a computed column or rollup is refused at load and in `check` (a form field's `when`
  may name one, and works from the draft), and a `validation` that reads a computed column or rollup is refused with
  the stored columns to use.
- `tablewalk build` run from an App's own directory writes `<app>-build` beside it, not inside where it refused itself.
  With `--base-path`, the health probes move under the base path too, and `TABLEWALK_PUBLIC_URL` may include it.

### Features

- A row-policy App runs its jobs, timers, inbound endpoints, integrations and effects. Each principal is a service the
  policy's `services` names, and reads and writes only the rows `resolveRows` gives that service.
  `[policy-service-unnamed]` refuses a principal the policy does not name; `[policy-service-unused]` and
  `[policy-service-rows]` warn.
- A row-policy App's commands may declare events. They are recorded in the command's transaction, under its scope, and
  its effects, jobs and workflows consume them. The App API's event feed stays refused under a policy
  (`[policy-events-feed]`).
- A row-policy App's notify rules may say `email: true`. Each recipient is mailed only while the policy gives them the
  record, read as a session of theirs would read it. While the policy reloads, mail is held rather than read unscoped.
- `notify.via: { channel: 'email', to, consent }` mails an address a record holds, such as a customer without an
  account.
  - The message is queued in the write's transaction and sent after it commits.
  - It is suppressed when the address unsubscribed, when the record holds no consent, or when a visitor's write names
    an address no form proved. Each address gets at most 5 a day, and each App sends at most 500 an hour.
  - Each message is plain text with a line saying why it was sent, and carries RFC 8058 one-click `List-Unsubscribe`
    headers. The unsubscribe link is HMAC-signed with the email service's `links.secret`; its page asks before
    changing anything.
  - Check codes: `[contact-email-transport]`, `[contact-email-links-secret]`, `[contact-email-timezone]` and
    `[contact-email-source]` refuse; `[contact-email-unproven]` and `[contact-email-consent]` warn.
- `tablewalk migrate stores up --app <dir>` creates every store the App uses: the inbox, the record history, the
  command journal, the event store and the effects store. `--jobs <file>` adds the jobs module's stores and delivery
  destinations.
- `restocks`, the declarative inverse of `consumes`, on a line that brings stock in: `stock_receipt: { restocks:
  { column: 'part_id.on_hand', by: 'quantity' } }`. An insert adds to the balance, an edit moves the difference, and
  a delete takes it back out, refused with `refuse` where what it brought in has been used since. Receive stock is a
  New form on the receipt, on every door, with no command. `consumes-written` names a command only where it writes
  both a line and the balance the rule moves for it.
- A machine's `groups` read wherever `status is open` does: `status is onBench` in a view's query, a segment, a tab,
  a metric and a rows section; a nav count counts a list whose group holds only open states; and a board whose query
  names a group draws only that group's lanes. A word that is not one of the machine's groups is refused with the
  groups it has.
- A role `extends` another: `manager: { extends: 'mechanic', commands: ['approveQuote'] }` holds every grant of the
  mechanic and its own, each the union of both (reads, writes, creates, commands, actions, operations, flags and
  column narrowing), through a chain. `label`, `claims` and `service` stay the role's own. A loop, an undeclared role
  or one of another realm or kind of principal is refused (`[role-extends]`); authority.lock says `role manager
  extends mechanic` above the grants it lists in full, and the Console's Governance room says it in words.
- A `validation` reads through one reference: `work_order_part: { validation: [{ must: 'order_id.status = bench',
  message: 'Parts go on only while the order is on the bench.' }] }`. The server reads the order in the write's own
  transaction and refuses at `order_id` with the rule's message; an empty reference reads as empty. `tablewalk check`
  follows the path through the catalog and refuses one that is not a reference, names no column of the record, goes
  past one hop, or reads the parent's computed column or rollup.
- A record page is found by its file: `pages/lead.ts` with `export default page('lead', [ … ])` is the page `lead`,
  as `pages/lead.json` was, with no `pages` list in `app.ts`. A `pages/` module with no default export is one the
  pages import. `tablewalk check` has a `files` step that lists every record page, free-form page and catalog it
  found by its file.
- A record page with no `aside` shows the record's remaining readable fields beside it (see Upgrading).
- An App theme can ship its own fonts (`type.faces`): served from the App's own origin, the heading face preloaded,
  copied by `tablewalk build`. Each face is cut to Latin as it loads (`subset: false` ships one whole, for an App in
  another script). `check` refuses a missing file or one outside the App, fails faces past 150 KB together as served,
  warns on one past 80 KB, and says "2 faces, 61 KB, heading preloaded".
- `check` gives each theme contrast failure the nearest passing color of its hue and each color-blind chart failure a
  passing order, on the line that sets it, with a summary line per theme and mode; `check --fix` writes them.
  `tablewalk theme show <look|id|.>` prints a theme's values with the inherited ones marked; `--diff <look>` says the
  distance from a base and `--json` prints it for a tool.
- `shot` and `grade` wear an App's own theme and palette (`--theme`, `--palette`, `--look all`); `shot --compare <look>`
  puts two side by side. `shot --recipes <part>` shoots every value of one recipe on the App, and the recipe gallery in
  the docs pictures every value of every part. `tablewalk dev` serves a theme bench at `/_theme`: the App's pages,
  light and dark, with every contrast check read as the theme changes and the `defineTheme` line to paste back; it is
  answered only in a `--dev` start, on a loopback listener.
- A theme says more: `recipes.headings` (plain, caps or small-caps), `recipes.lanes` (a board lane's value as a tint,
  a solid tag or plain ink), `shape.radius.pill` (a status pill's, a tag's, a chip's and a count's corner) and
  `rules.control` (a field's and a select's edge, 1px or 2px). `shell: { placement }` suggests where the menu goes;
  `ui.shell` overrides it.
- The navigation's colors dress the menu under every bar recipe: every entry, group heading, count and icon draws in
  `nav.ink` or `nav.muted` on `nav.ground`, whatever the bar, and `check` names the element each nav pair is for.
  `npm run test:tokens` serves every sample App page under canary themes and fails on a color drawn that is not a
  token.
- `tablewalk seed` fills a lookup table (a short priced or timed list others pick from) with a handful of named rows,
  not 40 of generic text. `tablewalk dev` prints each sign-in as one line of role, address and password, and its
  accounts are rows of `auth.me`'s table, so a view of `me` has records. `tablewalk grade` signs in as the role that
  reads the most and says so.
- `startTestApp({ database })` serves the database writable when the App writes, over a copy of a file from outside
  the workspace. `tablewalk test init` names a command action by its id, not its index.
- A command handler has `today()` in the App's zone beside `now()`, and `now` stamps a zone-less column with the App's
  wall clock. A New form's `today`, `now` and `me` defaults are written by the server on a create, and a column the
  form does not show cannot be said by the browser.
- A SQLite generated column is listed and read like any column, and never written. A write refused for a table's
  triggers names them, on SQLite and PostgreSQL.
- A computed expression says `in (…)` and `not in (…)`, as the query language does. A sum rollup over no rows is 0, as
  a count is, in the statement, a `when` and a form's lines alike. The rollup helpers (`count`, `sum`, `min`, `max`,
  `latest`) take `segment`.
- A command's `when` that says `me` (a "my records" verb and its bulk action) is judged for the acting person when a
  selection is prepared, when availability is checked and when the command runs; before, such a verb never matched
  anyone.
- On a touch screen an App form's fields stand at the 44px of its own actions.
- `test/coverage-map.json` maps every public DSL name, CLI command and flag and package entry point to the tests that
  exercise it, and `test/coverage-map.test.ts` fails on a name no row owns, a test that is not there, or a row that
  leans on an example that does not ship. Sixteen CLI flags have no test yet and are listed where the list can only
  shrink.
- Lintel's own suite, `examples/apps/lintel/tests`, is on `tablewalk/testing`: every grant in `authority.lock` as a
  matrix, rent posted once, the late-fee workflow on a test clock, the signed payment callback, and the public, staff
  and phone journeys in a browser. It ships in the package.

### Fixes

- `check` compiles what a request compiles, so an App that passes it no longer answers `/api/app` with a 500. It
  places a finding in the App module that writes it, never in a test or seed file beside the App, and regenerates the
  App's schema types even when its resources or grants are refused.
- `tablewalk check --design --fix` deletes first and then reports only what is left, and deletes a restated rule even
  when a test or seed repeats it. It no longer leaves an empty rule behind: a column whose `values` all went goes with
  its key, and a `display` it empties goes too. A rule with a comment before its comma takes the comment with it, and
  a rewrite that would not parse is not written; its deletions are listed as the person's. It no longer deletes the
  `display` values that order a free-text column's `steps`.
- `[machine-command-outside]` reads a write as the table's it is written to: a command over an order that sets a
  payment's `status` (`db.payment.update(row, { status: 'paid' })`), or reads its own (`db.order.find({ status })`),
  is no longer said to move the order's machine.
- `tablewalk explain` and `check --brief` give a fix of its own for every code (`invalid-app`, `schema-types`,
  `could-not-check`, `page-file`, `message-syntax`, `theme-font` and `api-write-unsupported` said "What the message
  names"), or none, never a placeholder. A refused startup's headline states the recorded cause, and says it once.
- A list or board whose query names a segment draws the same lanes, menu count and dashboard window as the same
  conditions inline.
- A required `{ from: 'reference.column' }` default no longer has to be shown in the form for the server to fill it.
- A parse handed no person refuses `me`, so a path that forgets the person fails loudly.
- A role that cannot read a table with a fixed machine verb is served its App again, where the payload answered 500.
  A role that extends one reading a resource whole and never writing it keeps its own narrowing of what it writes
  there. `check` loads a row-policy App whose commands declare events, binding the event source as serving does.
- A reference card captions its record's fields by their own names ("Serial number", not "Bike"), and a record's money
  says one form: "$89.00" beside "$145.45", never "$89".
- A metric card says money compact from $1,000 up ("$27.3K" beside "$414.1K"), as its axis and its change do, so a
  strip no longer says one figure compact beside another written out, which `tablewalk grade` named `mixed-format`.
  The exact figure is the card's title and what a screen reader hears.
- A signed-out visitor to an App whose public grant shows no view of its own starts on the landing, not the Workbench.
  Sign-in under a base path no longer answers under the base twice.
- On a phone, a gallery's previous and next no longer lie under the button that opens the photo, and a list's
  Filters, a dashboard's windows, a folding section's heading and a gantt's bars take a 44px touch; a desk draws them
  as before. A card's ⋯ sits beside its button, a sort's edge reaches 3:1, Show sits beside the password, and a
  Workbench key column keeps its name beside the KEY badge.

## 0.9.1

### Upgrading from 0.9.0

0.9.1 answers a field report: an agent building a new App from the shipped skill, in one pass. Two spellings change:

- A list tab names a segment. `tabs: [{ label, query }]` is refused; declare the query once under
  `resources.<table>.segments` and name it (`tabs: ['open', 'overdue', { segment: 'open', sort: 'due_on' }]`).
  `tablewalk check --design --fix` lifts a query written in more than one place into a segment.
- A refused write says `code: 'forbidden'`, as a refused command already did (it said `access_denied`).

`tablewalk check --defaults` prints what the platform now draws untold; `check --design --fix` deletes a rule that
only restates it.

### Documentation

- Two new topics: Segments (a query named once, used in tabs, metrics, rollups, the query bar and the App API) and Stock that can't be oversold (`consumes`).

### Features

- A list's `filters` reach across related tables. A path filters by a parent's column (`'account_id.industry_id'`),
  called by the record it reaches ("Industry", or "Account industry" where that is taken), its values the parents'
  labels, its address word the path. `{ has: 'opportunity', filter: 'stage' }` filters by the rows that point at the
  record, `via` naming the reference where there are two; `filter` may be a path up from them, so a link table lists
  its tags by name, and `{ has, segment }` is a yes-or-no facet ("Has open opportunities"). Counts are records, never
  rows. Two `has` filters may each be held by a different row; one row holding both is a segment. A path through a
  stitched reference, an unknown table or segment, or two references without `via` is one problem at load; a reader
  without the other table, or a column a hop reads, is served the list without that filter, and the rows asked about
  are the reader's own.
- The query language asks about the rows that point at a record: `customer any invoice where status = void`,
  `customer no invoice`, `via` for the reference meant. It compiles to `EXISTS` on SQLite, PostgreSQL and MySQL, over
  the rows a reader's row policy and tenant leave them, and is said the same in a tab, a segment and the query bar,
  whose completer offers the tables that point here and then their columns.

- `tablewalk grade [<app-dir>]` measures the rubric instead of looking at it: it serves the App as `shot` does, opens
  every view and a record of each page at 1280, 390 and 320 wide and at 390 in the dark, and reports sideways scroll,
  cut figures and words, overlapping controls, targets under 40px on a phone, contrast, layout shift, page errors and
  failed requests, empty sections, mixed number formats, unround chart ticks and a record's name past two lines. One
  line per finding with its fix at the declaring file and line, then a score; `--json`; exit 2 on an error. The
  browser suite's contrast reading is now the grader's, so both hold a page to one rule.
- `tablewalk test init [<app-dir>]` writes a starter suite on `tablewalk/testing`, run with `node --test`: a journey
  per role (its views, a record, a command it is granted, each machine verb it holds) and a permissions matrix of every
  role × resource and command from `authority.lock`. It refuses to overwrite without `--force`.
- `tablewalk/testing`: `host.as(role)` signs in an account for that role; the client's `.update`, `.command`, `.act`,
  `.rows`, `.open` and `.views` send the requests the server's own routes read and return results, a refusal as a
  value with its status and code; `assertPermissions` checks a role table. `startTestApp` resolves once `/readyz` answers.
- `tablewalk dev [<app-dir>]` serves an App with a throwaway session secret and an account per role, each sign-in
  printed, kept in `.tablewalk/` (in the scaffold's `.gitignore`). Local and dev only; refused under `NODE_ENV=production`.
- On a touch screen the chrome's own controls (the brand, the header's icon buttons, a view's tabs, buttons, a
  checklist title, an inline field) take a 44px hit area without drawing any bigger, and the grader reads that area.
- An App's page says its look's density, so boot zooms once: a compact look (Lumen, the default) drew its loading
  outline at the comfortable zoom and pulled it back, a layout shift of 0.12 on a phone. The outline's classes no
  longer share `.sk-row` with the shell's placeholders.
- The `board-reference` design check names only a board's `category`: its `lines` and `footer` say a reference by name.
- Conventions apply at runtime when an App says nothing: a column named or typed like money is money, as is a figure
  computed or summed from money, which keeps its inputs' `minor` and shared `currency`. The same goes for a percentage,
  a due date said from today, a unit, a 0/1 flag said as words, a vocabulary's tones and words, and a person's
  initials and email. A machine's states take tones by where they stand. A declared rule wins concern by concern.
- `check --defaults` prints what each column is drawn by. `check --design --fix` deletes every rule, label, record
  label and form default that restates a convention (the `restated` warnings), editing the App's source minimally.
- A machine's column reads `status is open` (not final) and its `groups` (`status in onBench`) in tabs, metrics and
  queries. A state-named stamp (`ready_at` beside `ready`) is written as the record enters that state, through every
  door.
- `now` and `me` follow one rule everywhere they are written: a text column named for a moment (`_on`, `_at`) on
  SQLite, `me` on a reference to auth.me's table as the person's row. A command handler may write them:
  `db.ticket.update(row, { closed_at: now, owner_id: me })`.
- A form default may come from the record a reference names: `defaults: { labor_charge: { from: 'service_id.price' } }`.
  The New form follows the chosen record until the person edits the field. A create that leaves the field out gets the
  value from the server. The path is typed and checked.
- `latest` reaches through two references (`latest('work_order', 'status', { whose: 'bike_id.customer_id' })`): the
  newest of all the rows, on SQLite, PostgreSQL and MySQL.
- An App list with no `empty` says "No {things} yet." by its noun, and offers New where the list does.
- Payday's time off tells the teammate the decision through `notify` on the status a machine moves; the actions page
  documents notify on a machine's edges.
- `--scaffold-app` writes a complete draft over a writable connection. A status vocabulary becomes a `machine`: a path
  forward, a cancel, reject or lost verb from every open state that asks first, final states last. Stamps such as
  `completed_on` are set by the verb that means them. A staff table with an email becomes the sign-in (`auth.me`) with
  a role per kind of person, and a "My work orders" queue (`mechanic_id = me and status is open`). A record with no
  name is named through its parents (`{customer_id.name} · {bike_id.make} {bike_id.model}`). A line gets a computed
  total, summed on its parent, and its price comes from its part. The README names the nearest recipe and why. The
  draft still passes `check` and `check --design` with nothing to say.
- `tablewalk seed [--app <dir>] [--rows <n>] [--seed <n>] [--append]` fills an App's database with rows that look real,
  on SQLite, PostgreSQL and MySQL, so no seed script needs writing. It respects vocabularies, keys, foreign-key order,
  NOT NULL and unique columns. Each status is spread the way the App's machine moves it, with the stamps of the states
  it passed through. Dates fall across the last 90 days, and some open work is due today or overdue. Names and emails
  come from a built-in word list. The same `--seed` writes the same rows on the same day. It refuses a table that
  already holds rows unless `--append`, and writes only to a connection the config marks `"writable": true`.
- Segments name a resource's queries once: `segments: { open: 'status is open', overdue: { query, label } }`. The name
  is a word of the query language (`overdue and mine`), compiled inline. A tab names one (`tabs: ['open']`), and so do
  a section's source (`metric('Late', 'work_order.overdue')`, `related(…, { segment })`) and a rollup (`count(…,
  { segment })`). A segment only narrows; a reader who may not read a column it names is served none of it. The App
  API and MCP offer `?segment=` on a list, read-only. `check --design` lists each segment's cost and warns
  `repeated-query` where one query is written twice; `--fix` names it as a segment. Schema types list each table's
  segments, so a misspelled one is a type error. A list tab's id in the App API and its OpenAPI `tab` enum is its
  address word, a segment's name (`?tab=on_hold`), as the App's own address says it. The scaffold declares its
  drafts' queries as segments: a status's words its list tabs by, the open work the Overview counts, and `mine`.
- `consumes` on a line keeps a stored balance in step:
  `consumes: { column: 'part_id.on_hand', by: 'quantity', refuse: 'Only {part_id.on_hand} of {part_id.name} left' }`.
  A new line takes from its part, a removed one gives back, an edit moves the difference or switches parts, on every
  door. A take past zero refuses the whole write with `422 consumes_refused` and the rule's sentence, filled only with
  what the reader may read (inside a command, the person it runs for, whatever its footprint reads); `floor: false`
  allows a backorder. `check` refuses a path of more than one reference, a
  balance or amount that is not a number, and a whole-number balance moved by a decimal, and warns about a command that
  also writes the balance.

### Changes

- A tab no longer writes its own `query`: it names a segment of its resource (`tabs: ['open', { segment: 'overdue',
  sort: 'due_on' }]`), and `{ label, query }` is a load error that says where to declare it. A tab's address word is
  the segment's name. The sample Apps and fixtures are migrated.

- Lumen, the default App look, is flat, calm and modern. Sections, metric strips, tables and record fields stand open on
  a faintly tinted shell, divided by hairlines; only menus, dialogs and drawers are lifted. One accent marks the primary
  action, the current room, selection, focus, the main chart series and the current step. Metrics are a divided strip,
  record fields a property rail, charts a 1.5px line in one hue's steps (two small charts side by side), and every
  dashboard control is one 30px family. A list's toolbar is one quiet row: search, chips, a faint count and a flat
  facet rail. A table anchors each row on the record's name, says a neutral status with a grey dot, and its head sticks
  under the trail where the table fits its width. New recipe values: `stat: 'divided'`, `fields: 'rail'`,
  `table: 'quiet'`, `status: 'quiet'`, `chart: 'line'`, `banner: 'plain'` and `steps: 'strip'`; Lumen's previous values
  remain for an App's own theme.
- A workflow strip is a track of thin segments in every look: walked steps in a tint of the accent, the current one in
  the accent with its label, a reachable step outlined, the rest grey.
- `ui.shell.counts: true` counts only a menu's lists of work: a list whose condition picks its machine's unfinished
  states, a date at or before today, or the reader (`me`). A list's own `count: true | false` says otherwise.
- A calendar's narrow cells say an entry's status as a toned dot before its title, the full word on hover.
- Captions drop `_at`/`_on` (`ready_at` reads "Ready"). A board, queue or calendar with no `primary` uses the
  record's name. The design checks `undressed-money` and `flag-as-number` are gone, because the conventions now cover
  them.

- An update a role's fixed-action grant does not admit (`roles.<role>.actions`) is refused `403` with the code
  `access_denied`, as every other write the role is not granted, instead of `400 validation_failed`: a caller tells a
  refusal from a bad request by its status. The App API answers it `forbidden`, not `ineligible_state`.
- A command action whose command asks nothing runs on one click, with a notice that it ran; `confirm: true` on it
  asks first. `confirm` is refused on a command with inputs, whose form is already the confirmation.
- A list view's `opens: '<reference column>'` opens the record each row names instead of the row: a list of a join
  table (`ticket_watcher`) opens the ticket. A grid only; refused on anything but a reference column.

### Fixes

- A refused write says `forbidden`, as a refused command does (was `access_denied`).
- A tenant App's bell counts its notices from the start. It asked before the tenant was open, was refused unsent, and
  showed nothing until its next ask a minute later.
- `tablewalk agent init` re-aims the skill's example links at `node_modules/tablewalk/examples/apps/`, so they resolve from the copy.
- Swapping a list's tabs no longer empties their counts for the trip, which shifted every tab after them, and a
  table's placeholder rows are its real rows' height in every look.
- A collapsed side rail with a menu longer than the window no longer stretches the page: the hidden labels are
  placed against the menu list, which scrolls, instead of an ancestor outside it.
- `--check-app` no longer reports a label as restating its default when the label is said with `msg()` inside a
  feature; its words differ in every other language.
- A refused Postgres API-token store setup keeps the database's error as its `cause`.
- An App asks before a verb with `confirm: true` writes, as the Workbench does: a record's header actions, its More and
  phone menus and a split view's keys all wrote on one click, a rule left from when Apps had Undo.
- The scaffold's rollup no longer sums a 0/1 flag named like money (`paid integer check (paid in (0,1))`) as an amount.
- `check` warns `[admin-grants-nothing]` when `auth.roles` names no `admin`, the role the first account holds; and an
  App whose role grants no tables says so in plain words instead of "This database has no tables".
- A relative SQLite path or `file:` URL in a config file is read against the config file's folder, not the directory
  the server started in; a file that cannot be opened is named by the absolute path tried.
- `startTestApp({ database })` names the database after the App's own `connection` (or its one source's), and a name
  that still differs is refused naming both.
- `check` on an App that does not load says the load and validation errors first, and no longer reports typecheck
  errors against schema types it could not refresh.
- `tablewalk shot --browser <path>` (or `CHROME`) shoots with that Chromium, and without it shot falls back to any
  Chromium another Playwright version installed on the machine.
- A yes/no column whose `values`, `tone` or `icons` are keyed `true` and `false` (a header `status` too, and a computed
  boolean) reads its words on SQLite instead of a bare `1`; a toned flag with no words keeps ✓ and ✗. `check` warns
  `[boolean-keys]` when such a rule is keyed by anything else.
- A `unit` is said in the singular for one: `unit: 'bikes'` reads "1 bike", not "1 bikes".
- `format: 'money'` says its cents by the set it stands in: a grid column, a card list, a metric strip or a breakdown
  of whole amounts reads "$24,495" down its length, and one figure with cents puts the whole set to the cent, so "$24"
  never stands beside "$0.50". A lone figure keeps its cents only if it has some; a whole bound in a filter chip or a
  price step keeps its round figure.
- A `current()` card with nothing in it reads "No lease right now.", not its title restated around "right now".
- A dashboard's `rows(...)` takes `empty`, what it says when no row matches, as a list's does.
- The shell guide no longer calls Mono the default look (an App wears Lumen), and the agent skill says the sample
  Apps its guides link live on GitHub and do not ship with the package.
- A calendar line that is a reference draws the referenced record's name, not its key, and a status pill on a
  narrow card keeps its colour and shortens with an ellipsis instead of spilling out of the card.
- A board over a machine draws no lane its view's (or its section's) standing query can never hold.
- A `related(...)` list offers no "+ Add" of its own when the new row would need another parent the page cannot
  give it; a `create` on the section still offers one.
- The browser tab names the record also where its name is edited in place.
- On a phone a record's reference cards follow the main work; its headline and `current()` card still lead.
- An odd strip of dashboard metrics leads with its first card across the row and pairs the rest, so no lone
  metric trails at the end.
- A tenant table's composite foreign key (`(tenant_id, incident_id)`) is a reference: its list shows the record's name
  instead of the raw id, `incident_id.number` is a path, and generated types name the table, also where the column
  has a single-column key of its own.
- A list tab whose `sort` is the view's own lights on arrival instead of showing its query as a chip.
- An `after` word counts with the shared plural rules: "0 tickets logged", not "0 tickets loggeds".
- Multi-line text keeps its line breaks wherever it is shown read-only, also when it is short.
- A tenant App over a database with a table its ownership policy does not name fails at startup naming the table and
  what to do, instead of a bare ownership refusal.
- A reference input given its value after it first draws (a command form's initial value) shows that record.
- On a phone a list's tabs take a row of their own and scroll sideways, so none is cut off.
- A fields section's `columns: 1` holds on a phone too.
- A record's history leaves out the revision column (`version`), which every write advances, and on the record's
  creation the columns the reader cannot read.
- A related list's verbs stand in its heading's row, and go under the heading from its start edge in a narrow aside
  instead of a row of their own pushed to the far side.

## 0.9.0

### Upgrading from 0.8 to 0.9

0.9.0 is the line 1.0.0 will be cut from. Every rename, removal and store layout below is in effect now: an old
spelling is refused with the new one named, and a store behind its layout is refused. The compatibility promise
itself (`docs/compatibility.md`) takes effect at 1.0.0.

> Since this entry: 0.9.8 moved feature flags, audiences and `@mistriwork/mistri/openfeature`, experiments, the Suite
> Console, behavior analytics, SCIM, the Gantt presentation and a resource's `search` to Preview at 1.0, outside the
> compatibility promise. [Status & roadmap](site/src/content/docs/docs/status.md) is the list.

- **What 1.0 promises.** An App written against 1.0 keeps working through every 1.x release: its DSL keys and
  values, the `tablewalk/*` exports, the CLI's commands, flags and exit codes, the HTTP and App API, the MCP tools, the
  canonical addresses, the published schemas and `check` codes, and the layouts of tablewalk's own stores. A minor
  release may add a name; none renames or removes one before 2.0.
- **Nothing is preview.** The App API and App MCP, integrations, experiments, free-form pages, mounting
  (`tablewalk/handler`), sign-in from a host app, `tablewalk/react` and read replicas are all inside the promise. A
  feature a 1.x release adds may ship as preview, outside it until promoted; `tablewalk check --preview-features`
  names any an App uses.
- **Deprecated, then removed in a major.** A key on its way out keeps working for at least one minor release, and
  `tablewalk check` and startup print a `deprecated` warning naming what to write instead. The spellings 0.x renamed
  are not deprecated but refused, as they are today: a section's `path`, `of`, `paths` or `orderBy` names the word that
  replaced it.
- **`flagSegments` became `audiences`.** A segment was a list of values nothing filled in, so a rule naming one
  matched nobody; an audience says who (`roles`, `tenants`, `attributes.emailDomain`, `rollout`, `allow`, `deny`). A
  flag rule's or an experiment's `segments: { region: ['east'] }` becomes `audiences: ['east']`, naming an audience
  declared at the root. An experiment a 0.8 release registered stays readable, with its evidence; one still running
  takes a new `version` under 1.0, since its eligibility is now written differently.
- **Flag rules and experiment eligibility say who only through audiences.** Their own `roles` and `tenants` are
  gone: `eligibility: { roles: ['member'], tenants: ['north'] }` becomes an audience
  (`audiences: { northMembers: { roles: ['member'], tenants: ['north'] } }`) named as
  `eligibility: { audiences: ['northMembers'] }`; `tablewalk check` reports the old keys as
  `experiment-eligibility-audiences-only`. A Console rule names audiences the same way; a stored rule that lists roles
  or tenants no longer reads, so remove such rules under 0.8 before upgrading and add them back with audiences.
- **`useExperimentVisitor` is `useVisitor`.** Same hook, same `start()`; the old name is gone.
- **The display type is gone.** `?craft=bold`, its stylesheet and its `craft` cascade layer are removed.
- **`useAddressState` moved to `tablewalk/page`.** A component that imports it from `tablewalk/ui` imports it from
  `tablewalk/page` instead; nothing else about it changed.
- **The sign-in store moves to layout 3.** It gains the identity-provider session index (`idpSession`, which
  back-channel logout reads) and the SCIM directory tables, on SQLite and PostgreSQL; nothing existing changes.
  `tablewalk migrate stores up` adds them, and this release refuses a sign-in store still at layout 2.
- **An App's words live in `messages/<locale>.ts`.** `messages(namespace, { key: { en, es } })` and
  `copy(catalog, key)` are gone, with the `{ message, fallback, translations }` reference they made. Each language is
  one catalog file, `export default defineMessages('es', { 'people.salary': 'Salario' })`, its text ICU
  MessageFormat; a caption names a message with `msg('people.salary')`. Move each entry's `en` text into
  `messages/en.ts` (the App's own language, `ui.locale`) and each other language into its own file, keys spelled
  `namespace.key`. The server says every caption in the reader's language before the browser sees it, so the payload
  no longer carries translations beside a caption. Payday is the worked example.
- **The API token store moves to layout 3.** It gains the OAuth tables (`oauth_client`, `oauth_grant`, `oauth_code`,
  `oauth_refresh`, `oauth_access`), on SQLite and PostgreSQL; nothing existing changes. `tablewalk migrate stores up`
  adds them, and this release refuses an API token store still at layout 2, whether or not it serves OAuth.
- **A theme's colors are `colors`.** `defineTheme({ colors: { light, dark } })`, renamed from `palette` so that
  `palette` names only a variation, as `palettes`, `defaultPalette` and `ui.theme.palette` do. The old key is refused
  with the new one named; the built-in looks, the sample Apps and the docs say `colors`.
- **The assistant's `confirm` is gone.** It took one value, `'writes'`, which said what is always so: every write the
  assistant proposes waits for the person. Writing it is refused with that reason; delete it. The assistant's
  default model is outside the compatibility promise, since a minor release may move it to a successor as models
  are retired; an App that must keep one names it in `model`.
- **The DSL says one word for one thing.** Before the freeze every key that had two names, or one name for two
  things, was settled. Nothing keeps the old spelling: `tablewalk check` and startup refuse it and name the new key.

  | Area | Before | After |
  | --- | --- | --- |
  | Sources | a list view's, a dashboard's and a metric or breakdown `target`'s `table` | `from` |
  | Sources | a block's, a calendar `backdrop`'s and a field `reference`'s `resource` | `from` |
  | Sources | `auth.me.table` | `auth.me.from` |
  | Sources | a field `reference`'s `value` | `by` |
  | Sources | a `link` key value `{ from }` | `{ column }` |
  | Sources | a rollup `latest`'s `by` | `sort` |
  | Sign-in | a role's `from` (claims it reads) | `claims` |
  | Sign-in | a role's `supportLog: true` / `supportAudit: true` | `operations: ['support']` (the realm picks the half) |
  | Display | a timeline's and a stream's `tint` | `tone` |
  | Display | a display `icon`'s and `tags`' column-valued `tone` | `toneOf` |
  | Display | a column-valued `label` on mentions, mention groups, templates and a `backdrop` | `labelColumn` |
  | Display | a calendar `backdrop`'s `from` / `to` | `start` / `end` |
  | Display | captioned values: `lines` on `cards`, `facts` on a `queue` and a split `row` | `properties` |
  | Display | a timeline's `order: 'asc' \| 'desc'` | `newest: 'last' \| 'first'` |
  | Display | `<Value display>` typed as the client's model (`bar`, `max`, `avatar`) | the authored display rule |
  | Pages | a fields or list section's `edit` | `editable` |
  | Pages | `definePage({ title, nav: { icon, order } })` | `definePage({ label, icon, nav: { position } })` |
  | Pages | a config page's `onlyOn` | `connection` |
  | Pages | `fields(..., { presentation: 'card' })` | `card(title, 'dealer_id', ['rating', 'city'])` |
  | Pages | `fields(..., { presentation: 'headline', actions, subfigure, was, note })` | `headline('price', { links, subfigure, was, note })` |
  | Pages | `presentation: 'accordion'` and `collapsed` | removed; none was used |
  | Pages | a fact `{ column, label: 'Born', position: 'before' }` and `{ column, label: 'bed' }` | `{ column, before: 'Born' }` and `{ column, after: 'bed' }` |
  | Pages | `related(…, whose, { about })`, `related(…, { same })` beside `whose`, and `similar(title, from, match)` | `related(title, from, { same, near? })`, the record left out over the page's own table |
  | Pages | `related(…, { editable: true, order })` | removed; a New form's `form.lines` stays |
  | Pages | `definePage({ path, … })` | the file name is the path: `pages/pick-walk.page.tsx` is `/pick-walk` |
  | Pages | `hidden`, `offsetLeft`, `sizing` and `names: false` on an App page's section | removed; a tablewalk.json page keeps them |
  | Pages | `callToAction()` and a headline action's `kind: 'primary' \| 'secondary'` | `intent` |
  | Pages | a `callToAction` block's JSON `kind: 'cta'` | `kind: 'callToAction'` |
  | Pages | the `<List>` block | `<Rows>` |
  | Lists | a list's `filterBar: true \| false \| 'rail'` | `'bar' \| 'rail' \| 'none'` |
  | Lists | a list's and the New form's `open: 'peek'` | `open: 'drawer'` |
  | Lists | a list's `keys` | `shortcuts` |
  | Forms | a New form line's `title` | `label` |
  | Copy | an `empty` or `done` state's `message`, `firstRun`'s `text` | `description` |
  | Copy | `<Empty text detail>` | `<Empty title description>` |
  | Analytics | a funnel step's `action`, `collect: ['actions']` | `command`, `collect: ['commands']` |
  | Branding | `fromRecord`'s `base` and `brandColor` | `preset` and `accent` |
  | Branding | `branding.allow: ['theme']` | `branding.allow: ['preset']` |
  | Removed | `ui.shell.menu` | an App with no `nav` |
  | Removed | `ui.theme: defineTheme(...)` | `ui.customThemes` and a `preset` |
- **Record pages: defaults by section kind, and words for every caption.** `card()` and `headline()` are helpers of
  their own, and `fields()` keeps its four ways of showing fields (`summary`, `properties`, `facts`, `table`);
  `card()`, `current()` and `history()` stand in the aside unasked, and `history()` shows eight changes under a title in
  the reader's language (Spanish ships with the shell), so `history('History', { region: 'aside', limit: 8 })` is
  `history()` and `region: 'main'` keeps the rare one under the record. `tablewalk check --design` reports a
  `presentation` that repeats the default (`default-presentation`). A `noun`, a headline's `note`, a fact's `after`, a
  `unit`, a donut's `total`, a banner's `eyebrow`, an image's `alt` and a validation `message` take `msg()`; a `noun`
  or `after` message may carry an ICU plural. On a phone the aside's card, headline and current row follow the summary,
  ahead of the related lists.
- **A timer at an instant is the resource's `at`.** A machine state's `at`, in builds before this release, is
  refused with the spelling that replaces it: `open: { at: { due_at: 'breach' } }` becomes the resource's
  `at: { due_at: { command: 'breach', when: "status = 'open'" } }` beside `machine`. A state's `after` is unchanged.
- **To upgrade.** On 0.8.x, run `tablewalk check` and fix every problem. Stop the server, back up the stores, then with
  0.9.0 run `tablewalk migrate stores status` and `tablewalk migrate stores up` for the App (or the suite): serving never
  migrates, and refuses a store behind its layout.

### Stable, and inside the 1.0 promise

- **The core of App authoring is stable.** Promoted from preview, and inside the 1.0 promise: command forms and public
  forms (saved steps, `statusCheck`, `keyed` inputs, `link`), multi-step forms (`form.steps`), machines and an action's
  `reason`, files, tags, the search engine (`search`, `--reindex`), `validation`, CSV import, a look's named palettes,
  the newer display formats and inputs (`duration`, `avatars`, `rating`, `color`, `time`, `month`, `year`, `json`,
  `qr`, `icon`, `colors`, `ring`, `slider`, `scan`, `signature`), landing pages, signed-out reads (`auth.public`),
  `ui.footer`, the header's New menu (`ui.shell.new`), custom components (`component()`, sections, value renderers,
  inputs, `customList()`, `useCommand`), the calendar, cards, tree and gantt presentations, the filter rail and
  `suggest`, a board's `category`, `footer`, `sum` and `folded`, a nav entry's `color`, the newer chart shapes,
  `target` and `find()`, the Lumen dashboard blocks, and the record-page sections (gallery, `headline()` and
  its `was`, `card()`, facts, sheet, property rail, section `tab`, the ordered workflow strip, related cards, `related(…, { same, near })`).
  `tablewalk check` no longer prints a `preview:` line for any of the promoted ones.
- **The rest of the platform is stable.** Promoted from preview, and inside the 1.0 promise: the assistant (its panel,
  page, `starters` and the assistant in tenant Apps); durable workflows (`tablewalk/workflows`, `createWorkflowDriver`,
  the maintenance functions for runs); row-defined fields (`defined`) and flows from rows (`flows`, `flowRunner`,
  `flows()`); tenant Apps (`auth.rows: 'tenant'`, the platform realm, invitations, public intake, delegated
  administration, support access), a form's `realm` and tenant branding (`branding`, `brandingForm()`); mail (email
  sources and notices, `statusCheck.stepUp`, `link.email`, tenant App mail, `tablewalk mail-dns`); events and jobs
  (`tablewalk/jobs`, `--jobs`) and a machine's timers (`after`); `lookup`, `effects` and webhooks, and the App's
  default `track`; HTTP sources (`--openapi`, `--from-openapi`, `--api-url`, `--api-token-env`, `"kind": "http"`);
  flags (`flags`, `useFlags`, `enabledBy`, flag capabilities, `tablewalk flags`, `tablewalk/openfeature`) and
  behavior analytics (`analytics`, `useAnalytics`, `tablewalk analytics`); the Console and its Operations and
  Analytics rooms (the `jobs`, `deliveries`, `stores`, `analytics` and `workflows` operations grants);
  `tablewalk build`; and `tablewalk/testing`, `tablewalk/ui/testing` and `tablewalk virtual`. The assistant's panel
  no longer wears a Preview chip, and `tablewalk check` prints no `preview:` line for any of them.
- **The App API and App MCP are stable, and can serve beyond loopback.** `api`, `--api-reads`, `--app-mcp`,
  `--api-integers`, `--api-requests-per-minute`, `tablewalk api-token`, `tablewalk new --api`, the OpenAPI and AsyncAPI
  exports and `compare-openapi` are inside the 1.0 promise, and `ApiConfig` and its kin lose their preview mark.
  - `api.network: true` (recorded in `authority.lock`) lets the API answer beyond loopback when the operator listens
    there (`--host`, `--allowed-host`, `--trust-proxy`); either half alone refuses at startup, and startup says where
    the API answers and at what budget. The `Host` must still be allowed, only scoped bearer tokens are accepted,
    `--trust-proxy-header` is refused beside it, and TLS is terminated in front.
  - `POST …/$mcp` serves every App's API as MCP tools over Streamable HTTP, not only a tenant App's, under the same
    tokens and budgets; a missing or refused token is 401 with `WWW-Authenticate: Bearer`, the handshake included.
  - Rate limits: `--api-requests-per-minute` is each token's own budget, keyed by the whole credential; requests
    without a token and refused tokens spend a per-address budget (at most 60 a minute), which a valid token never
    does, so a shared NAT or proxy cannot lock an integration out. Over either is 429 with `Retry-After`. Counted in
    the process.
  - `api.publicSpec: true` serves the whole OpenAPI document to a request with no `Authorization`, without roles or
    standing questions; a presented credential is always checked.
  - The documents name themselves `x-tablewalk-document: app-api-reads` or `app-api` instead of a preview stage, and
    the cursor text says what a cursor is bound to. `--export openapi` publishes composite keys (one `key` parameter,
    simple/explode).
  - Row-policy Apps are served under their `--policy` (`--api-reads`, `…/$mcp`, `--app-mcp`): each token reads and runs
    commands as its own account, through the policy deployment the App's pages use, so a hidden row is not found and
    a command on it is refused. Their event feed and generic writes are refused, as before. Several sources stay
    refused, now with check code `api-multi-source`.
- **Experiments and audiences are stable.** `experiments`, `experiment()`, a role's `experiments`,
  `defineExperimentConversion`, `useVisitor`, `tablewalk experiments` and the new root `audiences` are inside the 1.0
  promise. An audience is defined once and named by flag rules (the Console lists the App's audiences beside each
  rule) and by experiment eligibility; its `rollout` is a stable share salted by its name, so every flag and
  experiment naming it reaches the same people, and an email domain is read only from an address its account
  proved. An experiment freezes the definitions it names into its version. A visitor on a tenant's public intake
  is evaluated in that tenant, and a conversion it submits is attributed to the variant it saw; platform triage
  still has no conversion source.
- **The last previews are stable.** Mounting an App in your server (`tablewalk/handler`: `createTablewalkHandler`,
  `mintEmbedAssertion`), sign-in from a host app (`"kind": "embed"`, `/api/auth/embed/exchange` and `sign-out`),
  embedding in a React app (`tablewalk/react` and its Next, React Router and TanStack Router adapters), free-form pages
  (`definePage` from `tablewalk/page`, `pages/*.page.tsx`, `defineLoaders`/`defineLoader`, the blocks, `renderPage`,
  a role's `service`) and read replicas (a connection's `"replicas"`) are inside the 1.0 promise. No App names a
  preview feature any more, and the status page has no Preview row.
- **`tablewalk check` can say a key is deprecated.** The `deprecated` warning names the place an App writes a key that
  still works and goes at the next major, and what to write instead (`src/shared/deprecations.ts`, empty for now).
- **The public-surface inventory holds removals once 1.0 ships.** From a 1.0.0 `package.json`, removing, renaming or
  demoting a public name fails `test/public-surface.test.ts` with that said, and `scripts/public-surface.mjs --write`
  refuses to regenerate it away without `--major`; an addition is still one `--write`. A name still in preview is
  marked so in it, as the status page has it, and an App's root keys that are preview say `@preview` in
  `schema/app.d.ts`.
- **A release tag needs its store fixtures.** The release workflow refuses a version with no
  `test/fixtures/stores/<version>/` on both engines, which every later release upgrades from.

### Pages, documents and records

- **A matched related list keeps its empty state, and a document can have one.** `related(title, from, { same })`
  takes `empty` (guidance, or `false`) again, so Payday's time-off balance and Keystone's funding page say what no rows
  mean in their own words; `create` stays refused beside `same` (a matched row is not the record's child, and a `near`
  column has no value to fill), now with that reason. A document's lines accept the same match, read by the page's own
  parser, so Atelier's packing slip lists "In this parcel" again. `tablewalk check` names the section when a related list
  sets both `whose` and `same`.
- **A dashboard opens on the window it declares, and a phone lays its figures two to a row.** `dashboard(…, {
  windows: ['last 7 days', 'last 30 days'], window: 'last 30 days' })` opens on Last 30 days instead of All time; the
  window must be one it offers, `?period=` still wins, and a reader's All time is said `?period=all-time`. On a phone a
  run of metrics sits two to a row with a compact figure, a lone last one taking the row, instead of one per row.
- **Free-form pages replace `room()`.** A page drawn whole by the App's own code is one file, `pages/<path>.page.tsx`,
  that says what it is with `definePage({ path, title, nav, roles, reads, commands, params, public, loader, component })`
  from the new `tablewalk/page`. The path is the file's name and the page's address, and it places itself in nav. The
  server reads the definition without drawing it, so a role is offered the page when granted all it reads (a
  command it is not granted is refused one by one, and its `useCommand(…).granted` is false, so Depot's purchasers
  walk the pick lists without a Pick button), `authority.lock` records its reads, commands and loader, and
  `check --routes` lists it. A role only jobs and integrations hold says so with `service: true`: it is
  offered no page the page does not name in `roles`, and cannot be `defaultRole`, so Keystone's integration and
  automation roles no longer open its Workflows page. `home` may name a page by its path, typed from
  `tablewalk-commands.d.ts`. The hooks bound to the page (`page.useRows`, `useRecord`, `useBreakdown`, `useFile`, `useCommand`, `useParam`) are typed from its
  declarations and refuse anything else, `check` scans the module for an undeclared read or command
  (`[page-undeclared]`), and a request the page sends outside them is refused (`page_undeclared`). A `loader`, declared
  with `defineLoader` beside the commands (`export const loaders = defineLoaders({ … })`), runs on the server for the
  reader through the same scoped reader as every read (grants, field projection, row policy, tenant), read-only, within
  its timeout (5 seconds, at most 10) and 256 KiB, on a tenant App's host as on a single App's (the lease's reader,
  under its tenant and membership); its result is the component's `data`, typed by the generated
  `tablewalk-commands.d.ts`. `<CommandForm command>` puts a command's own dialog behind a button, and the platform's
  sections are blocks of `tablewalk/page` with their DSL words as props, each loaded when first drawn: `<List>`,
  `<Metric>`, `<Chart>`, `<RecordCard>`, `<Timeline>`, `<Tree>`, `<Gantt>`, `<Assistant>`, laid out with `<Grid>`,
  `<Panel>` and `<Tabs>`. `useAddressState` moved from `tablewalk/ui` to `tablewalk/page`: import it from there.
  Ten `page-*` check codes name each refusal. `room()`, `RoomProps` and `renderRoom` are gone (`renderPage` draws a page in a test):
  Depot's pick walk and Keystone's Workflows moved to `pages/`, and the pick walk's lists now arrive from its loader.
- **Printable documents.** `document(base, sections, { label, number, size, description })` in `pages` puts a record
  on paper — an invoice, a packing slip, a payslip — reached from the record's More menu at
  `/{app}/{route}/{id}/{key}`. Its sections are fields (a summary, `properties`, `facts` as an address, `table` as the
  totals, `headline`), related lists (every line, up to 500, under a header that repeats on each sheet) and notes, under
  a letterhead of the App's mark and name; A4 or Letter by `size` or the App's locale. The browser prints it and saves
  the PDF; it is read through the record page's routes, so its grants, row scope and tenant are the record's. Atelier
  prints an order's invoice and a parcel's packing slip, Payday a payslip. `tablewalk check` refuses what paper cannot
  draw under the new `document` code. On paper a part the total takes off (a discount) is said negated, `−$297.00`,
  as the New form's summary says it, and a status is its plain word, without the chip's tint.
- **A page counts its sections per screen.** The cap of 24 is now what one screen draws: the sections
  in no tab, plus the largest tab's, per region. A page may hold up to 96 in all, so a record page with tabs is no
  longer split to fit.
- **A page keeps its layout for a role that reads fewer fields.** A `fields` section is drawn with the
  paths the reader may read rather than dropped, and `tablewalk check --design` still warns when a role's view is
  narrowed.
- **A section's `when` reads paths and computed columns.** `when: 'company_id.major_incident_open =
  true'` and `when: 'service_alert = true'` are judged as a list's filter judges them, at validation as at run time.
- **A footer group folds.** A `placement: 'footer'` nav group folds like any other; its heading stays
  at the foot and its rows open above it.
- **The New menu takes headings.** `ui.shell.new` entries may be grouped as nav entries are,
  `{ label: 'Service desk', children: [{ view: 'tickets' }, ...] }`: each group is a labelled group of the menu with a
  quiet heading, a hairline between runs, and the arrows walking the lines straight through. Groups do not nest, a
  heading is used once, and a line is still listed once across all of them.
- **A fact says its word before its value everywhere.** `position: 'before'` on a `{ column, label }` fact (now `{ column, before }`) was
  accepted by cards, related cards and `header()` but missing from the `AppCardFact` type and from the page schema;
  both say it now, and `FactEntry` is that one shape.
- **A related list's cards take every key a list's cards do.** `icon`, `media` and a title through a reference
  (`primary: 'owner_id.name'`) were in the type but refused by the page parser; they parse now, and the page's cards
  are checked against the catalog as a list view's are, so an icon with no display rule is named at load.
- **A card leads with an icon tile and ends on a foot.** `cards: { icon: 'kind', media: 'icon' }` draws
  the icon column's mark large on a tinted square, in its tone, where a picture would stand; `footer: ['price', …]`
  says up to four values along the card's last line under a hairline, at the bottom of every card in the row. A
  display rule's `values` now names a figure too: `{ format: 'money', values: { 0: 'No charge' } }` says a stored
  `0.00` as the words. Four device icons join the set: `laptop`, `monitor`, `device-mobile`, `printer`.
- **A board's card is titled by a reference.** A board's `primary` may be a reference column, and a reference in a
  card's lines or footer says the referenced record's label rather than its key.
- **A board's line may be a rollup or a computed column**, as a queue's may: a problem's open tickets on
  its card.
- **A board moves a card through any machine verb.** A command verb that leads a different state from
  each one ("Move to {to}") offers each card the lane its own state leads to, and a verb with several ends whose
  command asks for the machine's column (`moveDeal` with `{ stage }`) offers every end and is told the lane dropped on.
  The action's derived `move` is now `{ column, edges: [{ from, to }] }`.
- **A timeline's `tint` and `compact` are said per stream.** `stream('email', …, { tint: 'accent',
  compact: true })` dresses every row of that stream; a section's column rule needs only the streams that have the
  column, and a stream that says its own is not asked for it.
- **A Templates menu offers the rows a `query` names.** `composer.templates.query: 'active = true'` keeps
  retired replies out of the menu; `tablewalk check` reads it against the template resource.
- **Team mentions narrowed by membership.** A rich text field's `mentions.groups.through` names the
  link table that puts a person in a team; the editor offers only teams someone is in.
- **One list over several tables.** `unions: [union('my_requests', [{ from: 'incident', as: { title:
  'short_description', opened: 'opened_at' } }, { from: 'requested_item', as: { title: 'name', opened: 'created_at' }
  }])]` is a read-only resource a list view and `useRows` name as they name a table: one order, one page, and a row's
  `from` and `key` open its own record. Each branch is read under the reader's own grants and row policy, and a branch
  they cannot read is none of their rows.
- **A related list adds to itself.** Where the reader may add a row of the child table, a related list offers
  "+ Add {thing}", the child's own New form bound to the record, as a list view offers New; `create: false` offers
  none. `actions: ['sendProposal']` draws the record's own verbs in the list's head, quiet, and takes them out of the
  record's (unless its `header` names them); `check` refuses an id that is not the record's action, one whose
  resource says `header: false`, and `actions` beside `empty: false`. A row's ⋯ has its own column at the row's end
  and no longer sits over the last chip.

### Forms and commands

- **A record's lines, saved with it.** `form.lines: [{ title, from, whose, show, order?, min?, max? }]` asks child rows
  as a grid under the New form's fields and the server inserts them with the record in one transaction, each row
  judged as its own insert would be; a refused line marks its field and saves nothing. On a record page,
  `related(..., { edit: true, order })` is the same grid over the saved lines, with Save. In a tenant App and under
  a row policy each line goes through that writer as the reader's own insert, update or delete, and the lines are
  search-indexed with the record.
- **Live values in forms.** `form.live: ['subtotal', 'total']` says the resource's computed columns and rollups as the
  form is filled in, worked out in the browser by the evaluator the server's statement agrees with
  (`shared/computedValue.ts`); the saved figures are still the server's. `check` names a live value the form cannot work
  out (`form-live`), lines it cannot save (`form-lines`) and minor units over a decimal column (`money-minor`).
- **A command field starts from a `default`.** A literal, `{ auto: 'today' | 'now' | 'me' }`, or `{ record: 'column' }`
  (the command's own record, served by prepare). `initial()` still wins where it says a field, and stays for what is
  computed. `check` refuses a literal the field itself refuses, and the record or the reader on a command that names
  no one record.
- **A picker narrowed by the record.** A reference field's `query` may say `record.<column>`
  (`query: 'sales_order_id = record.id'`): prepare serves the query bound to the record's values, so a return offers
  only its order's lines. `check` refuses a column the record lacks, and the word on a command without one record.
- **`refuse()` points at an input.** `refuse('Every carrier but a pickup needs its tracking number.', { field:
  'tracking_number' })` is said under that field, and the form stays open to change the answer and send again.
- **A related list runs its rows' verbs.** `related(…, { rowActions: true })` puts a ⋯ at the end of each row with that
  row's own actions and machine verbs, as a list view's `rowActions` does; the page is read again after one runs.
- **A command's `when` reads rollups and computed columns.** `when: 'fulfillment_status = pending'`
  over a rollup is judged in the command's own transaction and row scope, at availability, prepare and run alike.
  `check` refuses a rollup the transaction cannot read exactly — through two references, narrowed through a
  reference, or over rows the command does not `read` — and says which. An action's `when` may name one too.
- **An input asked only while the record says so.** `reason: field.text({ when: 'open_parts > 0' })`:
  prepare names the inputs the record does not ask, the form draws the rest and requires them, and the run refuses an
  input sent for a record that does not ask it and requires one it does. A top-level field of a command that targets
  one record takes `when`, over the target's columns, rollups and computed columns as a command's own `when` reads them.
- **A command may remove its own target.** Unrelate and Remove ran their handler and were then refused,
  the target missing from the final check. A removed target is judged against the reader's rows as it is removed,
  under a row policy and in a tenant, and is not looked for after; the tenant audit keeps its owner.
- **Commands that name no record start, and run, like any other.** A form command's `initial({ db })`
  and `default: me` fill its form; it is served on the App API at `POST …/{resource}/commands/{command}/v{n}`; and a
  granted one no form runs is served by name, so `useCommand('markAllRead').run({}, {})` sends it with an empty key.
- **Questions kept as rows.** `field.defined('catalog_question', { whose: 'item_id' })` asks the rows of a
  definitions table (`key`, `label`, `type`, `options`, `required`, `help`, `position`) as one section of the
  command's form, each record its own; the answers arrive as an object by key and are judged again, in the command's
  transaction, against the rows as they stand.
- **A record moves with another record's command.** A machine verb that names a command on another resource
  (`payment: pending: { on: { cancelOrder: 'voided' } }`) moves each row that references the command's record, in the
  same transaction and through the same graph, `since` and audit as a handler's writes: a final row stays, and a row
  in a state that does not list the command refuses the whole command. One cancel on the order replaces a cancel on
  each of its parts. The binding refuses such a verb unless the command writes the table, its rows reach the record by
  one reference, and the verb goes to one state with no `when`. A record that does not point at the command's, such
  as a purchase order named by its line's `receiveLine`, is still the handler's to move.
- **A handler knows its door.** `context.door` is `'ui'`, `'api'`, `'mcp'`, `'job'` or `'workflow'`, as the host
  received the request, in a tenant App as in any other; a request cannot name it.
- **Smaller things from adopting 0.8.8.** A tag picker's `add` and `remove` commands are served to a
  reader granted them without also being the resource's actions. A related list of files uploads where the reader may
  add a row, with or without a `create`. `field.richText({ min: 20 })` counts characters of text, not of markup.
- **A form a component opens keeps its Done.** `useCommand().open` marks its operation as its own, so
  the record's action bar no longer draws a second form over it and blanks the first when its Done is pressed.
- **A component's form opens again after a refusal.** A form `useCommand().open` drew, refused and closed no
  longer asks the record's revision once more on its way out, an answer that settled as an error after the form was
  gone and was handed to the form opened next: "The record could not be prepared".
- **A command only a component runs sits in no menu.** An action with `header: false` stays the resource's, granted
  and audited as before, and is what `useCommand` runs; the record's bar, its More menu and its rows' menus leave it
  out. The commands and custom-components guides now say so.
- **A sequence numbers past the rows a seed wrote.** `nextNumber(name, { after })` takes the highest number rows
  already hold, rows a seed or an import wrote without taking numbers, and the number taken is past it and past
  the count, in the same locked upsert on SQLite and PostgreSQL, so two commands that read the same highest still
  take two numbers. The store still reads no rows; `after: null` (a max over no rows) numbers from `start`.

### Money, rollups, time and queries

- **A SQLite decimal column keeps its scale.** A column declared `numeric(12,2)` or `decimal(10,2)` reads as the text "38.00", as `pg` returns it, so money shows its cents on both engines; an integer column, a column with no declared scale and an expression are unchanged. Depot and Atelier declare their scales on SQLite, and their commands and Commons' stamp moments on the App's own clock (Los Angeles, New York) rather than UTC's. A reference picker in a command's lines sets `aria-invalid` and `aria-describedby` like every other input.
- **Money in minor units.** `display: { total: { format: 'money', minor: true } }` says an integer column of cents
  as the figure it is, in the currency's own decimals (1999 is $19.99, ¥1,999, 1.999 KWD), and a form, a cell and a CSV
  import take the figure and store the cents; `19.999` dollars is refused rather than rounded. `currency: { column:
  'currency' }` reads each row's own code, falling back to the rule's or the App's; a CSV import reads that column for
  each row's decimals. Sums, rollups, dashboard figures and a CSV export (a tenant App's too) say the major figure; JSON
  and the API keep the stored integer. Where rows differ in currency, a metric, a record's figures and a board's lanes
  sum each currency apart (`$1,200 · €300`), and a chart or breakdown that adds them up is warned to group by the
  currency column or keep to one. Decimal money is unchanged.
- **Rollups through references, as filters and as totals.** A rollup's `query` may walk its rows' references
  (`'sales_order_id.status != cancelled'`), a list's `filters` may name a rollup, and a related list's `totals` may sum
  rollups and computed numbers, measured over every matching row.
- **A `latest` rollup reads a column of the newest row.** `financial_status: latest('payment', 'status')` is the
  order's payment's own word, newest by key or by `by` (a date or a number), typed and filtered with the column's
  vocabulary. A state another record holds is read where it is written, not copied onto the record and kept in step.
- **A computed column that reads a rollup is served in an App's list.** `total: computed.number('subtotal +
  shipping')` was refused as access denied when a list asked for it: the reader check looked for the rollup on the
  catalog rather than beside the expression, where the view pins it. A tenant's record read of one said "The tenant
  context could not be verified"; two rollups, one through a reference, now read too.
- **A rollup's `query` reads computed columns.** `breaching: count('incident', { query: 'breaching =
  true' })` narrows by a computed column of the counted rows that reads only their own row; its `now` and `today` are
  the request's.
- **A breakdown, a chart and a matrix say their figures as a metric does.** `format: 'percent' | 'number'
  | 'money'` and `unit` now apply to a dashboard's breakdown rows, chart axis and tooltips, and matrix cells, so a win
  rate measured as `avg won * 100` reads "86.4%" on the bars as on the tile.
- **A breakdown measures each group against its goal.** `target: { table: 'quota', by: 'owner_id',
  measure: 'sum amount', over: 'period' }` reads one goal per group from another table, windowed by its own date
  column, and says each bar as "120% of 25,000 target", the bar filled to the goal; a goal with no rows yet reads 0%.
  A record page's breakdown and chart take `format` and `unit` as a dashboard's do.
- **Hours and minutes in dates.** `due_at = next 2 hours` and `updated_at = last 30 minutes` are windows
  from the instant, resolved on every read; `computed.date('due_at - 2 hours')` and `updated_at > now - 30 minutes`
  move an instant on each engine and in the browser alike. `today + 18 hours` is refused: a day has no hours.
- **Zone-less timestamps hold the App's wall clock.** A `timestamp` (Postgres), `DATETIME` (MySQL) or SQLite datetime
  now holds the clock in the App's `ui.timezone`, UTC when the App names none, whichever way it was written: an
  action's `now`, a machine's `since` (and the sweep that reads it for a timer), a `Date` a command writes, and a New
  form's `now`. Before, these disagreed (a stamp wrote UTC, a `Date` went through the driver in the server's own zone,
  a form used the reader's). A column with a zone (`timestamptz`) is unchanged, and rows already stored are not
  migrated.
- **Each tenant or account reads its days on its own clock.** `ui.timezone: { column:
  'desk_setting.timezone', default: 'America/New_York' }` counts a reader's today, windows, activity periods and
  served zone in the zone the first row of that column they may read names, resolved per request under their own
  grants and row policy, so no tenant's zone reaches another's response. Writes, stamps, machines and jobs keep
  `default`, which also stands in where the row names none or a zone this runtime does not know.
- **The reader's memberships in a query.** `team_id in (me.team_member.team_id)` is the rows of the
  teams the signed-in person is in, read on every request through their own rows and tenant — in a list or tab, a
  view, a count or rollup, an export and a machine's transitions. The membership table's one column pointing at
  `auth.me`'s table says whose; a role that cannot read the table is refused, a person with none matches nothing, and
  `tablewalk check` refuses a table with no such column, two of them, or a column of another kind. More than 1,000
  memberships is refused. The App API and MCP have no signed-in person, so `me` there is refused as before.

### Flows, machines and jobs

- **Flow steps run side by side.** Steps of a row-driven flow that share a `position` start together,
  and the run goes on once each is done, in whatever order they finish. A branch decides alone, and is refused in a
  group.
- **Approvals wait for any or all, and remind.** A step of a kind that waits may say `mode: 'all'` (its
  command answers `{ asked: 3 }`, and the step waits for three events), `condition` (ends the wait early, such as on
  one rejection), `duration` (gives up and goes on) and `remind: '1 day'`, which runs the kind's new `remind` command
  on the record while it waits. A record's runs name each reminder.
- **A flow tells people.** A `notify` step (`audience`, `message`) tells the
  audience a resource's notify rule names with `on: { flow: 'requester' }`: the rule says who (`to`), on which channel
  (`via`, `email`) and how (`title`, which may say `{message}`), so a row never names an address. The notice is
  written in the step's own transaction beside its receipt, so a replay tells nobody twice; only a flow's own command
  can tell, and only about its own record. On a tenant App the notice is kept in the record's tenant's inbox.
- **Flows on records already there.** `tablewalk flows start <resource> --app <dir> --jobs <file>
  [--where <query>] [--flow <id>]` hands each chosen record to the resource's flows runner as though it had just been
  created, read a page at a time, and the server started with `--jobs` starts each `created` flow whose condition
  holds. Each dispatch is keyed by the record and the flow, so a second run starts nothing new. A tenant App runs one
  `--tenant <id>` at a time, under that tenant's service, with `--policy` naming its owner column.
- **A flow, drawn.** A `diagram()` section on a flow's own page draws its step rows: each position a
  column in order, the steps sharing one as lanes, and a branch's other way to its `goto` or to the end of the run.
  It reads the steps as the reader's rows, and loads with the section, so no first page carries it.
- **A timer at an instant the record keeps.** A resource's `at: { due_at: 'markSla', warn_at: { command:
  'warnSla', when: "state = 'running'" } }` runs the command through the jobs once the date or timestamp column's
  instant has passed and the record matches `when` (query-language conditions over its own columns), once for each
  instant the column holds: a new time arms it again, and an empty one arms nothing. It is the resource's, not a
  machine state's, because what decides it (an SLA clock running) is often written by many commands; a state says
  itself with `when: "status = 'open'"`. `tablewalk check` refuses a column that is not a date or timestamp, a
  command the App does not have, and a `when` that does not read as the record's own conditions. The minute's sweep
  reads past a hundred due records that a timer left where they were, newest instant first, so a mark that just
  fell due is not behind every one already fired.
- **A move only the jobs make.** A machine state's `by: { automation: 'escalated' }` is a move no verb
  makes and no button offers: a command takes it only when it runs as a service principal holding that role, which
  `tablewalk check` holds is `service: true`.
- **Timers run in tenant Apps.** A machine state's `after` and a resource's `at` on a tenant-owned table are found across
  every active tenant each minute, and each run is in the tenant its row's owner column names, as that tenant's
  service principal, admitted again on the tenant row; a suspended tenant's records wait. Each sweep takes at most
  twenty due rows of one tenant, so one tenant's backlog cannot hold up another's. A timer on a platform-owned table
  runs a platform command once. Startup refuses a timer on a global table, a tenant command's timer on a
  platform-owned table, and a timer whose command only principals of the other realm are granted. Provisioning a
  tenant's jobs (`provisionSqliteTenantJobs`, `provisionPostgresTenantJobs`) takes the `app`, so its timers are in the policy it records.
  `docs/tenant-apps.md` shows a calendar-aware SLA clock: stored `due_at`/`warn_at` and `at` timers.

### Tenant Apps

- **Tenant sandboxes: clone, import and a dev clock.** A tenant-owned resource may say `clone: 'config'` or
  `clone: 'sample'`. A tenant's owner clones their tenant into a sandbox in Manage tenants (configuration, and samples
  on request), with ids rewritten so the copy names only its own rows, and approves importing its configuration back:
  conflicts are found per row against the version copied, and any conflict refuses the whole import. A sandbox is
  marked as one beside its name. `tablewalk tenant clone|import|clock` runs the steps from the shell, and a sandbox's
  dev clock runs its machine timers ahead of real time; a live tenant has none. Startup refuses marks a copy could not
  keep intact. Provision the store with `provisionSqliteTenantSandboxes` or `provisionPostgresTenantSandboxes`.
- **Platform edit in tenant Apps.** A platform role may name the platform's own `access: 'write'` resources in
  `write`, `create` and `fields`, and the platform lease offers Save, New and Delete over them. The profile's key, the
  columns a key names on it and its address columns are held; New never makes a profile row, and Delete is offered
  only on a table nothing refers to. Startup refuses `write: true` and a grant naming a tenant-owned, global or
  platform-only resource; the writer refuses any non-platform table, a key column and a profile insert or remove on
  its own, fenced on the platform membership, and refuses while an account is inside a tenant on support. Edits land
  in record history. A tenant's own lease now carries its `addresses` (intake and public) on `/api/app`, served only
  when each resolves back to that tenant alone, and `useNavigate().publicLink(view)` builds a link to hand out.
- **Public reads in tenant Apps.** A tenant App may declare `auth.public`: a visitor browses one tenant's public
  rows by that tenant's public address (`?via=`, a profile column the policy names in `public: { address }`) or on
  its mapped host. The policy's `resolvePublicRows(visitor)` chooses the rows; the server adds the tenant, denies
  platform-owned tables and every table the callback does not name, and re-checks the address before each read. An
  unknown address, a suspended tenant, another tenant's record and an unlisted resource all answer one `404`.
  `auth.public.read` naming a platform-owned resource is refused at startup.
- **Unlisted rows stay unlisted.** A row `resolvePublicRows` hides is absent from every public read, label,
  reference count, page head and sitemap, in policy Apps and tenant Apps alike, and missing by its key.
- **A platform command acts in one named tenant.** `defineCommand({ realm: 'platform', tenant:
  'customer_id', ... })` names the input field that says which tenant; the handler then inserts, updates and removes
  that tenant's rows as a member's command would, owner placed for it, beside the platform's own rows, and no other
  tenant's row is in its scope. The tenant must be active: its row is read before the transaction and fenced inside
  it with `@platform` and the membership, so a suspension in between refuses the write. The receipt is the platform
  member's and every audit row names the tenant. Opening a tenant is still store maintenance; a job's command cannot
  name its tenant this way.
- **Composite tenant keys keep their links.** A foreign key `(tenant_id, team_id) → team (tenant_id,
  id)` leaves a tenant's catalog with `tenant_id`, and its other leg is now a link there (a ticket's team, by name)
  when the target column is unique alone and the other legs are `NOT NULL`; the platform realm keeps the whole key.
  A reference into another tenant's row is refused by every door: a record write, an import, a command, an API token
  and a public form.
- **A tenant command reaches its own footprint, not just its reader's rows.** Within its tenant and the tables it
  declares, a command may insert a row its reader will not read (told its key, not the row), and delete a row once
  nothing references it, where the reader reads every referencing row; references are counted across every tenant
  after the row is locked, so a hidden or another tenant's row pointing at it still refuses. Ordinary writes, the
  platform realm and support sessions keep the stricter rule.
- **A public form placed with a tenant may update that tenant's declared rows** (a routing rule's tally). It still
  never removes one, triage still only inserts, and a refused write is named in the server log, never to the visitor.
- **A service role is a job's.** No tenant or platform membership may hold a role marked `service: true`:
  provisioning, maintenance, delegated administration and the policy's role ceiling refuse it.
- **Tenant Apps draw their support audit and API tokens.** On the platform context, a role granted `supportAudit` has
  **Support sessions** beside the tenant switch: every tenant's visits with the operator's email, read on its platform
  lease. On a tenant's context, a member of an App with an `api` block has **API tokens** in the account menu: their
  tokens (and, for a tenant administrator, the ones the routes already show them), a new one's secret shown once, and
  revoke. Both read the routes that were already there, under the lease they already required, and load when opened.
- **Who sees a tenant API token.** A token is listed and revoked by the person who made it and by the tenant's
  administrators (a role or operator that may revoke memberships under the App's `administration` policy).
- **A tenant App's notices are emailed too.** `notify` with `email: true` is served on a tenant App: the
  outbox row is written with the notice, in the inbox of the tenant whose record it is, and the host sends it after
  the commit through the config's email service. Each message is read as the recipient's own membership of that
  tenant, at send time: an address that is no member there, a member removed since, or a record their grants there
  do not read is dropped unsent, and the words are the inbox's words for them. The link opens the record in that
  tenant (`?tenant=`), and the message names the tenant. The Notifications switch (`/api/inbox/email`) is per tenant,
  on the lease. A tenant App that emails needs an email service in its config, or it does not start.

### Sign-in and identity

- **A sign-in that answers 500 is in the log.** Any 5xx from an auth route is one line on stderr, `tablewalk: auth POST
  /api/auth/sign-in/email answered 500 for App "<id>": <error name>: <message>`, written once from Better Auth's
  `onAPIError.onError` (the route is read where the request is). The route drops tokens and ids, the message drops
  addresses and long opaque runs, and the body, query, headers and cookies are never read. A refusal (a wrong password,
  a 401) is not logged.
- **SAML 2.0 sign-in.** An App names `saml('<name>')` beside `oidc('<name>')`, and `tablewalk.json` an entry of
  `"kind": "saml"` (`entityId`, `ssoUrl`, one or two `certificates`, and `label`, `verifiedEmails`, `mfa`, `attributes`,
  `tenant`/`domains`, `insecure`); `saml.tenants()` is each tenant's own, found by the work email. Better Auth's SSO
  plugin runs the protocol with its providers taken only from the config file: its own provider table is never made,
  and every route but sign-in, the service provider's metadata and the assertion consumer service answers 404. A
  response is screened before it is read (128 KiB, no DOCTYPE, comment, CDATA or encrypted element, signatures and
  digests SHA-256 or stronger, exactly one assertion); it must answer this App's own request, once, and a transient
  NameID is refused. Startup prints the entity ID and ACS URL to register. A name is one provider's across both kinds,
  an entity ID one entry's, and the new check code `identity-provider-kind` says when an App names an entry as the
  other kind. A support session through an App-wide SAML provider is confirmed there, through its own route.
- **OpenID Connect back-channel logout.** An `oidc` entry with `"backchannelLogout": true` takes signed logout tokens
  at `<App>/api/auth/backchannel-logout/<name>` and ends the sessions that provider's session opened, by `sid` or by
  subject. Tokens are verified against the provider's keys (asymmetric algorithms only), each `jti` is spent once,
  and every federated sign-in now records which provider session it came from.
- **SCIM 2.0 provisioning.** A `tablewalk.json` entry of `"kind": "scim"` (`name`, `provider`, one or two `tokens`
  as `${VAR}` references of at least 32 characters, and `roles`, `apps`) lets Entra, Okta or any SCIM client create,
  update, deactivate and delete an App's people at `<App>/api/auth/scim/v2`, through @better-auth/scim 1.7.2 (an
  optional dependency). The directory reaches only addresses in its provider's `domains` (now allowed on an App-wide
  provider; anything else is a 409), links a verified account, takes an unverified one's earlier sign-in methods, and
  sets and clears only the roles its `roles` map gives from its groups, each change in the account trail as
  `scim:<name>`. A deactivated or deleted person is banned, their sessions end and their API tokens and OAuth grants
  are revoked; a reactivation lifts only the directory's own ban and revokes again first, so nothing issued before
  comes back. A tenant's own provider's directory makes and ends that tenant's memberships instead, never the global
  account. Entra's classic group schema is accepted; each directory has 600 requests a minute; new check codes
  `scim-no-auth`, `scim-provider-unused`, `scim-role-unknown`, `scim-role-service`, `scim-role-claims` and
  `scim-tenant-roles`.
- **The work-email question at a suite App's door.** `/api/auth/work-email`, which finds a tenant's own provider by
  the address, now answers at a suite App's door as it does at a single App's.
- **Suite login lands each account where it works.** A suite's `identity.landing` is an ordered list of rules — an
  App, and the `roles` or tenant membership (`member: true`) the account must hold there — and the suite's address
  takes a signed-in account to the first that holds. A saved default App still comes first; without a rule that
  holds, the root App if the account has it, then the only App it has, then the chooser. A page of a private App
  opened by a signed-in account that App does not admit goes to the chooser, which says which App it cannot open
  and keeps the address: signing in there as an account that has it opens it. A deep link is followed only to a
  page of a suite App the account may open, never another origin, an API or the suite's own routes. An account with
  no App says so, beside Sign out. The chooser wears the tool's quiet tokens and each App's own accent; signing in or
  out there tells every open App tab. Sharing the sign-in still grants nothing: each App's grant, row policy and
  tenant membership are checked as before. Keystone's launcher writes its landing rules.
- **Open sign-up waits for a confirmed address.** Where anyone may sign up, an account is matched to `me` and given
  notifications once its email address is confirmed; until then it is signed in and reads what everyone may.
  `tablewalk check` and the server warn when an App opens sign-up with no email service to confirm addresses.
  Commons' seeded configuration now carries a development mail service, so its sign-up sends the link to the log.

### The App API, integrations and analytics

- **An OAuth 2.1 authorization server for the App API.** A `tablewalk.json` entry of `"kind": "oauth"` (`name`,
  `apps`, `roles`, optional `redirectHosts`) lets an MCP client connect to an App's API without a token pasted by
  hand: it finds the server from the protected-resource and authorization-server metadata the `401`'s
  `WWW-Authenticate` names, registers itself (dynamic client registration, ten an hour per address, a thousand
  unconsented clients at most, pruned after a day), and sends the person to the App's sign-in, where, signed in, they
  pick which of their roles it may act with, never more than the entry's `roles`. PKCE (S256) is required, a redirect
  must match exactly (loopback on any port), a code lasts a minute and is good once, and the `resource` must be the
  App's own API. The client gets an ordinary API token good for an hour, narrowed on every request to the roles the
  person still holds, and a refresh token that rotates on each use; a reused code or refresh token revokes the grant,
  which otherwise ends after 30 days or when the person disconnects the application from their profile. The consent
  page cannot be framed and answers with a form good once. It needs `--api-reads`, an App with `auth`, and a
  provisioned API token store, and is refused at startup for a suite; stdio `--app-mcp` takes pasted tokens only.
  A tenant App takes it too: the consent page offers the person's active memberships, and the token is that one
  membership's, as `api-token issue --tenant` makes one — its roles the membership's, never a platform-realm role,
  its rows that tenant's only. The membership is read again at the exchange and at every refresh, so one revoked,
  changed or deactivated by its directory ends the access token at once and the grant at its next refresh.
- **The App API and App MCP serve Apps of several sources.** Each request reads, or commits on, the one connection its
  operation's source names (one `REPEATABLE READ` snapshot on PostgreSQL); every other connection refuses inside it,
  and nothing is promised across requests. Such an App's documents say so: `x-tablewalk-source` on every operation,
  `x-tablewalk-consistency: single-source-per-request`, and a sentence in each App MCP tool. `api-multi-source` now
  names only a path, or a command's lookup, that would reach another connection; a resource on an HTTP source is
  refused with the new `api-source-unsupported`. Each exposed connection must be on the auth store's engine; the event
  feed reads the store beside the emitting source. A one-source App's documents and answers are unchanged, byte for
  byte.
- **Integrations.** A vendor package exports one `defineIntegration` from `tablewalk/integration`: the
  secrets it needs, a client built from them, typed actions, the webhook events it verifies, and an optional channel.
  An App lists its integrations in the jobs module, maps each webhook event to a command run as a `service: true`
  principal, and calls actions from a command's lookup (`integrations: { fakepay: ['charge'] }`), typed by the
  package's shapes and narrowed to the actions it declares. A `notify` rule tells on a channel too (`via: { channel:
  'sms', to: 'customer.phone', consent: 'customer.sms_ok' }`), queued in the write's own transaction. Core keeps the rest:
  each tenant's secrets sealed under `TABLEWALK_SECRETS_KEY`, entered on an `integrationsForm()` screen that loads on
  demand; every call journaled under an idempotency key and retried; signed webhooks at
  `/api/integrations/<name>/webhook` (per tenant on a tenant App), with stale and replayed deliveries refused; and a
  channel's `send(...)` effect held to consent, opt-out and quiet hours, each message logged. `tablewalk check`
  names an unknown integration, action, event or channel by its code. Effects, webhook and channel alike, now run on a
  tenant App, each delivered as the tenant it was written for. The integrations store and a tenant App's mail store
  are versioned layouts that `tablewalk migrate stores` manages (the mail store gains its version row), and a jobs
  module that lists only integrations, mail or inbound endpoints provisions no job store.
- **Analytics sinks speak to vendors directly.** A sink's `preset` (`segment`, `posthog`, `amplitude`, `ga4` or
  `warehouse`) maps the stream to that vendor's batch request over the same delivery, retry and `Idempotency-Key`; no
  SDK is loaded. The key is a `${VARIABLE}` read at startup, never written in the file, and no IP is sent.

### Languages

- **Every caption a reader sees takes `msg()`.** A dashboard's label, heading and description, a dashboard
  section's title and a note's words, a form's labels, steps, groups and submit button, an action's label, a
  document's name, a nav group or link, the shell's New menu, the sidebar footer, a sort menu, a column's caption in
  a related list, the landing's words and a role's name now type `msg()` as a view's label did; the loader said them
  already. One rule names a caption (`CAPTION_KEYS`): `tablewalk messages extract` lists by it, and a test holds the
  authored types to it, with the few left as text named and why: a command's inputs, read by the App API and MCP
  too, and an API's OpenAPI words. A step labelled with `msg()` takes its id from the key.
- **A visitor reads the shell in their language.** The top bar's Sign in, the settings gear and its menu
  (Preferences, Dark mode and its "match the system"), the skip link, the wordmark's title, the trail and the App
  menu's name are said in Spanish for a Spanish reader, and said again when a visitor's language arrives with the App
  after the shell has drawn; they stayed English on an otherwise Spanish public page.
- **An App in several languages.** An App directory's `messages/` folder holds one catalog per language
  (`defineMessages`, ICU MessageFormat: plurals, selects, numbers and dates), and `msg('key', { arg: 'column.path' })`
  names one wherever a caption goes, a record name, a machine's labels, a landing's words and a notify rule's title
  among them. Each reader is said their own: the tag on their person row (`ui.locale: { column, default }`), else their
  tenant's (`branding.allow: ['locale']`), else, on a public page or the sign-in screen, what the browser asks for
  among the App's catalogs (answered with `Vary: Accept-Language`), else the App's. The resolved tag is served as
  `ui.locale`, so figures follow the words. A notice is said in each recipient's language, its email subject too; a
  tenant may keep its own words in a record (`ui.messages: fromRecord(...)`), each row checked as it is written and a
  row that no longer fits skipped as it is read, never another tenant's. Addresses stay in the App's own words in
  every language. `tablewalk check` reports `message-missing`, `message-syntax`, `message-placeholder`, `message-arg`,
  `message-untranslated` and `message-unused`. The formatter loads only for an App with catalogs, never for `--mcp`
  or the CLI, and a build keeps the catalogs in app.json.
- **Picking a language, and the chrome's other languages loaded only by their readers.** Preferences offers the
  App's languages where it has several: a pick is written to the reader's person row where `ui.locale` names a
  column of it, else kept in a per-App cookie the server reads as their own choice; the App's words are asked for
  again in place. The framework's Spanish left the entry for a chunk of its own (`copy.es`, 2,453 B raw / 881 B br,
  with its own ceiling in `bundle-budget.mjs`), preloaded beside the entry only for a reader the server resolves to
  Spanish, so an English first page carries none of it. An action label whose message counts (`{count}`) travels
  parsed and is said for a selection by a formatter loaded the first time one is needed. `tablewalk messages
  extract [--app <dir>] [--locale <tag>]` appends a catalog's missing keys as comments holding the source's text, or
  lists the captions still written as literal text with a key for each; it never rewrites the App's source. A share
  card is drawn in the locale its address names, not the fetcher's `Accept-Language`; a windowed dashboard section
  whose title has no letters an address can carry is named by its place (`section-2`) rather than refused; a record's
  tabs keep one address in every language; and a notice email's own lines are said in the recipient's language.
- **A component says the App's messages.** `useMessage('key', args?)` in `tablewalk/ui` says one of the App's
  messages in the reader's language, from a custom section, list, renderer or `definePage` page: the catalog rides
  the App payload parsed, only beside the components a reader is drawn, and a tenant's own words are in it.
  `renderSection(..., { messages })` hands a component's test its catalog. A list's `tabs[].label` takes `msg(...)`
  too (Payday's Onboarding tabs do).
- **A free-form page's label and description take `msg()`.** `definePage({ label: msg('page.help.label'),
  description: msg('page.help.description') })` is said in the reader's language in the menu, the heading and the
  breadcrumb, as a view's caption is; it was a type error and `check` said the page `has no "label"`.

### Mounting, embedding and public pages

- **Mount an App in your own server.** `tablewalk/handler` exports `createTablewalkHandler({ config,
  basePath, publicOrigin })`, which serves an App — a tenant App too — under a path of a Node, Express, Next or Hono
  server: `tw.node` is a Node listener, `tw.fetch` answers a Fetch `Request`, and `tw.close()` stops the jobs and
  closes the pools. It runs the same startup and the same request pipeline as `npx tablewalk --base-path`, so cookies,
  links in mail and canonical addresses are said under the path. A config that serves no App is refused: the database
  browser is not mountable. See "Mount tablewalk in your server".
- **Embed an App in a React app.** `tablewalk/react` draws an App inside a host React app's own route:
  `<TablewalkProvider endpoint="/api/tw">` names the server (the handler mounted in the host, or a rewrite to a
  tablewalk process), and `<TablewalkApp app="compass" basePath="/crm">` shows the whole App under the host's
  router, so Back, Forward and the host's links move it. `tablewalk/react/react-router`, `/tanstack-router` and
  `/next` are the adapters; `routerNavigator` makes one for any other router. `<TablewalkList>`, `<TablewalkRecord>`,
  `<TablewalkDashboard>`, `<TablewalkPage>` and `<TablewalkAssistant>` show one surface without the App's chrome, on
  an address of their own, and a list hands an opened record to the host with `onOpenRecord`. A host imports no CSS:
  the shell's sheets are scoped to its own elements, in one `@layer tablewalk`, adopted while an element is on the
  page, and the host's layered rules do not reach it. The elements render an empty slot on the server, the shell
  loads in a chunk of its own the first time one is on screen, and a package and a server more than one minor
  release apart refuse each other with a sentence (`/api/embed/boot`). One App, and one element at a time, per page.
  React and the routers are the host's (optional peers). See "Embed in a React app".
- **A mounted App takes pages of other origins, and a React embed starts on one request.**
  `createTablewalkHandler({ embed: { origins } })` lists the browser origins a mounted App answers CORS for, beside its
  issuers' `origins`: the answer names the one origin that asked, says `Vary: Origin`, and never allows credentials,
  because cookies never cross origins and a listed page writes only with the bearer its exchange gave it. The same
  list may frame the App on a page asked as `?embed=frame` (`frame-ancestors`); every other page keeps refusing one. A
  `basePath` that says one of tablewalk's own paths (`/api`, `/assets`, `/_tablewalk`, `/healthz`, `/readyz`) is
  refused when the handler is made; `/api/tw` is fine. `jobs` is the path of a `defineJobs` module, run in the host's
  process and stopped on `close()`. `/api/embed/boot?app=&path=&search=` now answers, after the sign-in, whether the
  request is signed in and the first page's data (who is here, the App, its schema and the first room's reads), and
  `<TablewalkProvider>` asks it once per App, after the exchange, so the shell draws without asking for each again.
  `theme` on the Provider takes a `defineTheme(...)` result as well as a look's name, and `<TablewalkAssistant>`
  takes `placement="page"` and a `conversation` to open. See "Mount tablewalk in your server" and "Embed in a React
  app".
- **Sign in from your app.** A host application that already signs its people in names itself in the config
  file (`"kind": "embed"`: its `issuer`, an HS256 `secret` as a `${VAR}` or its `jwks` URL, the `origins` its pages use,
  and optionally `apps`, `accounts`, `createAccounts` and a `roles` map), signs a short assertion of who is there, and
  its page posts it to `/api/auth/embed/exchange`. On the App's own origin the answer is the App's ordinary session
  cookie, with the same grants as a password sign-in; from another listed origin it is an hour's bearer token, honored
  only from that origin and only on the App's browser routes, with CORS answered from the same list. The account is
  found by the host's subject, made at its first sign-in unless `createAccounts` is `false`, and linked to an existing
  account by email only with `"accounts": "link-verified-email"` and both sides verified. Each assertion is checked for
  its signature, issuer, audience, origin, a lifetime of five minutes at most and thirty seconds of skew, and is taken
  once, its id kept in the App's auth store so every instance on it refuses a replay; each issuer has a budget of
  thirty exchanges a minute per client address. A tenant App takes both forms, from its own origin and from a listed
  one, under the same rules. Its `roles` count only through the issuer's map, a tenant App's exchange gives no
  membership, `mintEmbedAssertion` from `tablewalk/handler` signs an assertion in Node, and
  `/api/auth/embed/sign-out` ends the session when the host's ends. `tablewalk check` reports a host for an App that
  signs no one in (`embed-issuer-no-auth`) and a mapped role the App does not declare (`embed-issuer-role-unknown`).
- **Custom components load without an import map.** A component's imports of `react` and `tablewalk/ui` are written
  as paths to the page's own copies when its file is served, and the shell no longer carries an import map, so a
  host page that mounts an App needs none. `tablewalk build` output keeps the bare imports.
- **Public pages for search engines and link previews.** An App's public list, record, landing and public form now
  arrive with their content in the HTML, drawn on the server with React from the same public read the browser makes.
  The landing and a form are taken over in place; a list or record is replaced by the App's own room behind the
  startup hold, so nothing moves (Forecourt's listing and car page measure the same layout shift, effectively zero,
  as before). A public page carries Open Graph and Twitter tags (title, description, first photo) beside its title
  and canonical link, and `/sitemap.xml` (an index of key-ranged parts past 10,000 addresses) and `/robots.txt` answer
  on whichever host was asked. `check --routes` also prints where a signed-out visitor's records are addressed, when
  that differs. `TABLEWALK_SSR=0` turns the drawing off.
- **Share cards.** A public list, a record without a photo of its own and the landing preview with a 1200×630 card
  the server draws at `/api/og`: the page's title, description and site name in the App's look (ground, ink, accent,
  `ui.logo`), set in Inter. The route reads the page as a signed-out visitor whoever asks, so a card says nothing the
  page does not; on a white-label or tenant host it wears that host's published branding. A card is named by the hash
  of what it draws and cached for a year; the last 256 are kept in memory and two are drawn at once. Without `satori`
  and `@resvg/resvg-js` a page previews with its first photo as before, or with no picture. The landing now has a
  head of its own (title, canonical address, preview tags), and robots.txt allows `/api/og`.
- **Pictures at the size they are drawn.** `/api/file?…&w=` makes a picture at one of seven widths, as AVIF, WebP or
  the original's format by `Accept`, after the same authorized read as without it, and keeps the copies on disk
  within 256 MB (`TABLEWALK_IMAGE_CACHE`). Cards, galleries, record photos and a landing's hero give the browser a
  `srcset` over those widths. Resizing uses sharp where it is installed; without it the original is sent.

### Files

- **Files in an S3-compatible bucket.** A file resource's `storage: 'bucket'` keeps new files' bytes in a `bucket`
  (`name`, `region`, `endpoint`, `pathStyle`, `prefix`, `presign`): AWS S3, Cloudflare R2, MinIO, Backblaze B2 or
  Tigris, signed with AWS Signature V4 and no SDK. The row names the object in its `object` column and keeps the
  file's SHA-256 in `hash`; the credentials are the server's `TABLEWALK_S3_ACCESS_KEY_ID` and
  `TABLEWALK_S3_SECRET_ACCESS_KEY` (and `TABLEWALK_S3_SESSION_TOKEN`), never App source. An object is stored before
  its row and deleted when the row is refused, so a committed row never names a missing object. `/api/file` keeps its
  access check and reads from wherever the row says: through the server with ranges and ETags (and `?w=` thumbnails),
  or with `presign: true` a redirect to a URL signed for a minute. Keys are `<prefix><app>/<tenant>/<resource>/<id>`,
  and a row naming another App's, tenant's or resource's object reads as no file. `tablewalk migrate files status |
  up | sweep` moves files to the bucket and back, resumably and with `--dry-run`, and deletes objects no row names
  (deleted records', refused uploads') once an hour old. Served with `--jobs`, an App is swept daily by a built-in job
  (`tablewalk-files-sweep`, at a minute its id picks, once per day across servers sharing a job store); a tenant App's
  runs once per active tenant, listing only that tenant's keys and reading only its rows, so no tenant's sweep deletes
  another's object. Otherwise startup says to run the sweep from cron. A server whose App names a bucket refuses to start
  without the two keys, and warns at startup of a bucket that does not answer. `object` and `hash` need no grant: a
  role reading `content` reads the file, and they are the server's alone — never sent to the browser, and a select,
  filter, sort, query, export, insert or update naming one is refused, as is an App API exposing one. `maxBytes` stays at most
  25 MB, since an upload is one request; multipart upload is not supported.
  [File storage](https://tablewalk.dev/docs/file-storage/).
- **File uploads under a row policy.** In an App with `auth.rows: 'policy'` a file upload is an insert like any
  other: the policy that lets a person add a row to the file table lets them upload, the scoped writer judges the
  stored row and its parents, and anyone else is refused by the server (`/api/file/upload` was refused for every
  row-policy App, and every file resource was served with `upload: false`). The flag is gone: the catalog's
  `insertable` draws the Add, as for any New. Removing a file stays a delete under `authorizeDeletedRecord`. The
  reply names the new row and does not carry the bytes back.
- **An upload from a related list starts its row as the list's New would.** The file's row carries the create's
  `defaults` and the list's equalities as well as the binding to the record, so a file table with required columns
  of its own can take an upload. Forecourt's desk gets its **Add photo**: a photo goes after the lot's own and is
  captioned later.

### Authoring, operations and the assistant

- **The browser follows a save.** While the server watches an App's source, a page open on it asks for the App again
  after each save and draws it where the reader stands: the same address, the same open record, the same scroll, no
  reload (`/api/app/live`, a server-sent event stream). A save that does not load keeps the last good App served and
  is said over the page — the file and line, the `tablewalk check` code, the message and the lines around it — and on
  the terminal under `App error:`; the next good save takes it away. A custom component or a `pages/*.page.tsx` file
  that changed is fetched again from its new address. A `tablewalk build` output, a tenant platform and a mounted
  handler are not followed, and only the author's page is: a reader the App's problems are kept from (roles, hidden
  fields) gets no stream and sees the new App on their next page. See "Reload and restart".
- **An App's tests have a supported path, end to end.** `examples/testing` now holds a five-layer acceptance suite
  over the real Loaner Desk sample on SQLite — unit, API, a virtual return kiosk calling a signed callback, the browser
  on a desk and a phone, and the authorization matrix — through `tablewalk/testing` alone (a test holds that no example
  imports tablewalk's internals), and `prove-red.mjs`, which breaks one policy and one integration in copies of the App
  and expects the owning test to go red, by name; CI runs both. A suite spec covers `identity.landing`, the chooser and
  one sign-in across two Apps. `scan-target.ts` serves a disposable seeded deployment on loopback and prints the URL and
  session header for an HTTP scanner such as the OWASP ZAP baseline, whose pass is not proof of security. The
  **Testing workflow** page gathers the commands, fixture lifecycle, secrets, test selection, GitHub Actions recipes
  for SQLite and PostgreSQL, durations and traces without retries, and the agent skill gained `testing.md`. Loaner
  Desk has an optional `jobs.ts`: the kiosk's HMAC-signed callback runs `returnEquipment`, keyed by the scan.
- **Read replicas.** A PostgreSQL or MySQL connection may name `"replicas": ["${REPLICA_URL}", …]`, up to
  eight, each resolved like `url` and given a reader pool the size of the primary's. Lists and their counts, the
  Workbench grid, dashboards' charts and breakdowns, search and exports read them in turn — a tenant App's too, under
  the same membership check and row scope, and handed to the primary when the replica has not seen the member yet. A
  record's own row, a record page, writes, commands, imports, raw SQL, the catalog, tablewalk's stores, the App API
  and the MCP tools stay on the primary. A write sets a ten-second `tablewalk_fresh` cookie (HttpOnly, SameSite=Lax,
  on the App's base path), and a request carrying it reads the primary, so the save shows on whichever pod answers
  next; a bearer-token caller is remembered by its token in the process instead. A replica that refuses or drops a
  connection is skipped for thirty seconds and the read runs on the primary. Replica sessions are read-only.
  SQLite refuses `replicas`. The capacity section lists each replica's pool, and traces mark which pool served a read.
- **The Console has a Governance room.** For an App whose `admin` role the account holds: the audit log read from
  the App's command journal (who, when, the record linked, which fields changed — never their values) beside every
  role change, searchable by who, what and date; the App's authority.lock in plain sentences, grouped by role, with
  what changed since the App last started with a different one (a suite with shared identity keeps each start's
  authority in a new store beside the identity store, `<store>.authority`); and who holds which role, with every
  grant change. It changes nothing: roles are still changed on the suite's access page. A tenant App opens there for
  an account its own tenant `administration` grants, and only to Accounts: the tenants that grant names and one
  tenant's members, read with the App's own administration and no suite role.
- **Assistant starters by place.** A starter may say where it is offered: `{ text: 'Summarize this ticket',
  records: ['incident'] }` on a record of those tables, `{ text, views: ['pipeline'] }` in those views' rooms, or both;
  a bare line is still offered everywhere. At most six are offered in any one place, however many the App declares.
  `tablewalk check` refuses a view or table the App does not have, and `records` without the `'record'` placement. A
  reader is served only the views they may open.
- **The assistant has a daily cap per person by default.** An App that names no `limits.tokensPerPersonPerDay` now
  gets 200,000 tokens per person per UTC day; naming a figure replaces it.
- **Dependencies.** Better Auth's SSO, SCIM and OAuth-provider plugins join it as optional dependencies, at the
  same 1.7.2 the local store's layout requires, and `intl-messageformat` is a dependency. `sharp`, `satori` and
  `@resvg/resvg-js` are optional peers: an App that resizes images or draws share cards installs them, and
  `npx tablewalk` downloads none of them.

### Sample Apps

- **Atelier, a tenth sample App: a fashion shop's back office.** Products in colors and sizes, stock in two stores
  and a warehouse, customers, discounts, and orders whose payment and fulfillment each have a machine, with returns and
  refunds. Every step is a command; a refund is never more than what was paid, and the stock ledger never goes below
  zero, even when two fulfillments race for the last unit (`test/atelier.test.ts`). A fulfillment board, a lookbook,
  CSV import, two dashboards, staff, warehouse and owner roles, and Lumen. PostgreSQL first
  (`examples/databases/atelier/seed-postgres.mjs`), with a SQLite seed of the same six months for a quick try.
- **Atelier adopts the command and rollup work above.** One `cancelOrder` voids the payment and cancels the parcel (the separate void and
  cancel commands are gone); stock counts start at what is on hand, an order's channel and shipping at their usual
  values; a return's picker offers its order's lines; Ship says beside the field when the tracking number is missing;
  the order page moves its payment, parcel and returns from each row's ⋯; a customer list filters by spend; the
  fulfillment board is titled by its order, with copied columns dropped from the schema. The order's
  `financial_status` and `fulfillment_status` are `latest` rollups now, not columns the commands kept in step, and
  `cancelOrder` and `requestReturn` judge them in their `when`.

### Fixes

- **A tenant App's address with a trailing slash opens the App.** `/desk/` answered the page, whose start then
  refused the empty segment ("Invalid tenant link"); it is now a 308 to `/desk`, its query kept.
- **A hyphen in Lumen reads as a hyphen.** Inter's tabular figures also set its hyphen, comma, period, colon,
  brackets, operators and space a figure wide, so text under tabular figures (a document, a record's values) read
  "Sign - ins", "Wi - Fi" and "SR - 1". The shipped face's tabular figures are cut to the ten digits, as the system
  faces the other looks wear already have them.
- **Long text on a document reads as a paragraph.** In a `properties` section a sentence or more squeezed its own
  caption to a few letters ("Summ / ary") and drew in a narrow box; in a summary it stood in one 128px column. It now
  sits under its caption across the section's width, left-aligned and unboxed, while a short value stays beside its
  caption. Atelier's invoice shows an order's note this way.
- **A percent reads "100%".** A figure whose unit is `%` (`{ format: 'number', unit: '%' }`) was "100 %" in every
  locale, on a document and a record alike; the sign now sits where the reader's locale puts a percent's, as
  `format: 'percent'` does: "100%" in en-US, "100 %" in Paris.
- **A typed related list says `create: false`.** The generated page types refused `related(…, { create: false })`,
  which the untyped section takes, and an Add's `defaults` and `prefill`; they take them now, its `show` still typed
  to the list's own columns.
- **A strip of metric cards reads from one inset and one line.** A card with a mark put its words at 80px and one
  without at 20px (16px against 20px on a phone), and a mark standing over its label then set that card's figure
  25-50px below its neighbour's. The mark now sits at the card's right, level with the label, in every look, so every
  card's words start at its own padding and every figure of a row stands on one line; on a phone each label keeps two
  lines, so a wrapped one moves no figure. The drill arrow follows the label's last word, a change's "vs prior 30
  days" never breaks inside the period, and an unchanged figure reads "Same as prior 30 days" instead of "· level vs
  prior 30 days".
- **A record's figures sit two to a row on a phone.** The figures under a record's name stood one per row on a phone
  and in a narrow record pane, three figures a screen tall; they sit two to a row in every look now, as a dashboard's
  do, a lone last one taking the row.
- **A tenant App's bar fits a phone.** At 320-430px the bar held the menu, brand, search, "+ New", the bell, the
  account and the tenant's name, and the last was cut at the edge. On a phone the context is the account menu's first
  item ("Tenant: north"), which opens the context dialog; the bar's New is its plus, the account its avatar, and the
  brand gives way to its mark when its name has no room.
- **A metric's figure is its own query.** A metric with `to:` and no `query` counted the target list's first tab
  (29 open tickets where 73 were raised); it counts every row the list shows now, and its card opens the list on those
  rows (its "All" tab where it has one). The list's standing `query` still scopes the figure, since the drill cannot
  show a row outside it; a tab never does.
- **A tenant App adds records again.** A New form sent an empty `lines` field with every record, which a tenant App's
  transport refuses ("Invalid mutation data."), so no record could be added there; the field goes only when the form
  has lines, and a tenant App's insert and save carry a record's lines to its row policy.
- **A tenant App at the root serves its custom components.** Asked for `/_components/…`, the tenant host
  looked under the outward address and answered 404; it asks by the inside address now.
- **"Enter dealer" says the App's own word.** The support entry, its dialog and banner name the tenancy
  by `auth.tenancy.label` ("Enter customer", "Enter an agency"), and "tenant" when none is set.
- **Printing leaves the trail off.** The breadcrumb trail and record trail are not printed; a list keeps
  its title.
- **Inbound mail's address is where the docs say.** The tenant-mail page placed the webhook under
  `/<mount>/api` for every App; it lives where the App's other `/api` routes do — at the root for an App served
  alone, `--mount` or not, under `--base`, and under the mount only in a suite. The docs now say so; the route is
  unchanged.
- **A platform form runs its command.** A platform-realm command that names no record (`targets: 'none'`) was refused
  as invalid input before it ran; its envelope now names no key, as a tenant form's does.
- **A public submission that names no record says so to the operator.** The refusal's recorded cause reads "a public
  submission names no record" rather than nothing.
- **A tenant API token acts under its own roles.** Reads and commands made with a token hold to the roles it was
  issued with, not every role its owner has.
- **A tenant App's ordinary record writes keep a machine's rules.** A column a `machine` declares moves only through
  its actions in a tenant App too, as it already did in a single-database App; a record write that sets it directly is
  refused.
- **A tenant role that declares `create` can write again.** A role with its own `create` list no longer has every
  record write in a tenant App refused.
- **A timer on a timestamp falls due on the minute.** An `at` timer on a `timestamp`, `timestamptz` or `datetime`
  column was swept as if the column held a day, so a mark fell due only after the App's midnight; only a `date` column
  is read as a day now, in tenant and single-database Apps alike.
- **A tenant clone leaves generated columns to the database.** `tablewalk tenant clone`, a sandbox import and the
  clone in Manage tenants no longer name a `GENERATED ALWAYS AS (…)` column in their inserts and updates, and a
  statement the database refuses during a clone or an import is reported in the database's own words.
- **A tenant App's visitor draws its public components.** A signed-out visitor of a tenant App (`?via=` or a
  mapped host) is served the custom components its public pages draw — a free-form page whose reads `auth.public`
  opens, a section on a public page, a custom list or value renderer over a public resource — and no other: the
  visitor's `/api/app` names them and the host serves their code, never a source map.
- **An address that names no workspace says so.** A tenant App's public address that names no tenant draws "No
  workspace here" in the App's own look, with its sign-in, instead of saying the App could not reach its database.
- **A board names a lane as its heading does.** A card's Move to menu and a swimlane's name say the column's
  `display.values` word ("Negotiation"), not the stored value made words ("Negotiate").
- **A tenant App's API that will not start says why.** `--api-reads` on a tenant App printed only "The API item read
  is unavailable." whatever the cause; the startup now names it — most often an API token store never provisioned
  (`tablewalk api-token provision`), or `--commands` missing for an `api` that exposes commands.
- **A tenant App registers up to 4096 commands.** The enrollment stopped at 256 with "Tenant startup could not
  validate the host declarations"; one bound now holds for the registry, a tenant policy's and a row policy's
  `resultReferences` and the capabilities a member is shown, and startup and `tablewalk check` name it with the
  App's count.
- **A true/false field is edited in its own words.** A column whose display says Off and On (`values: { true: 'On',
  false: 'Off' }`) offered Yes and No once its editor opened, in place and in a form; the editor says the rule's
  words now, keyed as the display keys them (`true`/`false`, or SQLite's `1`/`0`), and Yes or No for a side the rule
  does not name.
- **A measure of seconds is said as a time taken.** A metric, breakdown, chart or matrix takes `format: 'duration'`
  beside `percent`, `number` and `money`: `measure: 'avg first_response_seconds', format: 'duration'` reads "10h 2m"
  on a bar, an axis and a card, as a `duration` column says it, rather than a title that says "(minutes)" over a
  division. A measure over a `duration` column says it so without the word. Compass's dashboard says time with
  customers by month and pipeline confidence by rep this way.
- **A computed measure with two operators is checked whole.** `sum weighted / sum amount * 100` was read by the
  editor's types as a column named "weighted / sum amount"; each term now ends at the next operator.
- **The App MCP lists a command whatever its inputs ask.** A command input with a length, a format, a pattern or a
  case, a reference, a group, lines, a date or number bound, a sibling (`below`/`above`) or a `when` stopped the
  whole MCP session with `auth_unavailable`, and the API document with it. Each is described now: a length as
  `minLength`/`maxLength`, a group as a nested object (an array when it repeats), a reference as the key it stores
  with a description naming the resource it picks from, and what JSON Schema cannot say — a pattern after trimming,
  a sibling, the record a `when` reads — in the input's `description`. The command reader still judges every value.
  A command whose tools still cannot be made is left out of `tools/list` alone, with its cause on the log.
- **A large App's API lists page.** Every `GET /v1/<resource>` and App MCP `list_*` call of an App whose catalog
  (its tables, their columns and its resources) passed 1 MiB was refused as `invalid_request`, while reads by key
  worked: the cursor's catalog fingerprint was written out in full under the cap untrusted input is held to. The
  catalog is hashed as it is walked now, whole, so a change to any table still refuses a cursor sealed before it.
- **A free-form page's charts say their figures as a metric does.** `<Chart>` takes `format` and `unit`, and a new
  `<Breakdown>` block (`title from by query measure limit format unit`) draws a dashboard's `breakdown()`; both say
  their figures by the dashboard's own rule, so `format="duration"` reads seconds as "10h 2m".
- **A signed-out visitor is not shown a search with nothing to find.** The header's search (its box, its button and
  the phone drawer's) is a member's: a visitor on a public page, who has no rows of their own to search, is not shown
  it. `ui.shell.search: { signedOut: true }` offers it to a visitor too, for an App whose public pages are worth
  searching; `false` still hides it from everyone.
- **A tenant App's visitor reads the App in their browser's language.** A signed-out visitor placed by a public
  address (`?via=`) or a mapped host was said everything in the App's own language, though the docs promised
  `Accept-Language`; the menu, a view's and a page's words, the custom components' messages and the shell now follow
  the browser among the App's catalogs (or a language picked in that browser), as a single App's visitor already did.
- **A mounted tenant App's OAuth consent opens.** With `--mount <app>=/<path>`, the authorization server sent a
  signed-in person to `/sign-in?authorize=…` at the root, which is no App's, and the page said "Could not start the
  application". It sends them to the App's own sign-in under its mount (`/desk/sign-in?authorize=…`), as a
  single App's already did, and under `--base` too.
- **A related list's names are not cut while there is room.** A fit grid filled the columns cut shortest first only
  after sizing a relative date and a number's chip for their longest possible form, so a contact's name was cut beside
  a date column holding slack. Those columns are as wide as their words now, and the spare goes to the shortest-cut
  column first.
- **A run of figures that wraps starts its line flush.** Three metrics in a two-column area put the third on a new line
  with its divider and its indent; the hairline sits in the gap now and the row clips it at its edge, in every look,
  light and dark, and on a phone.

## 0.8.14

### Changes

- **Charts group by week.** `week <column>` buckets by the week's first day — a Monday by the ISO rule, or the first
  day of the week in the App's `ui.locale` (Sunday for `en-US`) — and the axis says it like "Oct 6". The bucket is the
  same on SQLite and PostgreSQL, read from the stored wall time.
- **A headline leaves out an empty fact and can say what a price was (preview).** A fact with no value is not drawn.
  A fields section's `was` names a numeric column; when it is set and higher than the headline's figure it is drawn
  struck through beside it, with "Was:" for a screen reader. A reader who cannot read the column does not get it.
- **A text filter suggests (preview).** A list's `suggest: { <filter>: [columns] }` offers up to eight distinct values
  of those text columns as the person types, read through their own grants and debounced. It works in the filter rail,
  the filter bar's search and the landing page's hero search. Enter still searches what was typed; an arrowed or
  clicked suggestion is picked. The box loads on demand.
- **Cards through a reference (preview).** A cards presentation's `primary`, `value`, facts and image may reach one
  hop through a reference (`vehicle_id.title`), and an image's `about` may name the reference whose record's files it shows. `tablewalk check`
  validates the paths, and the far table is read through the reader's grants.
- **Create per role on a related section.** A related section whose `create` a role may not use stays on the page for
  that role, without its New; `tablewalk check` no longer warns about it.
- **Forecourt adopts all five:** inquiries by week on the desk, the price a car was, suggestions for make and model,
  the saved shortlist as cards, and a photos gallery whose Add photo is the desk's alone. A file upload under a row
  policy is still read-only, so that Add photo is not drawn yet; the README keeps it as a gap.
- **Forecourt's desk dashboard is the desk's.** A buyer reads cars and their own inquiries, which was enough to put
  Desk in their menu; the dashboard now names its roles.

- **`me` in tenant Apps.** `auth.me` works in a tenant App: its column holds the account's id, and `me` is the
  person's row in the tenant they are working in — a row per membership, so entering another tenant changes who `me`
  is. It is resolved on every request from the admitted session, never from the browser. A membership without a row
  matches nothing, and a support visit is no one. List tabs and standing queries, computed columns, form defaults and
  `{me.name}` headings all read it; the name is the account's display name.
- **A sole membership goes straight in.** A person with one active tenant membership enters it after sign-in without
  the chooser, unless the address names another tenant. A tenant joined later, by an invitation, is offered, not
  entered, and a sole platform membership still asks.
- **The header's New menu (preview).** `ui.shell.new: [{ view }, { command, label?, icon? }]` draws one "+ New" button
  beside the bell listing every way to make something: a list's New form, or a signed-in form by its view or the
  command it runs. Each reader sees the lines they may use — a table they may add to, a command they are granted —
  and no button when there are none; the palette lists the same lines ("New supplier"). It works in tenant and
  non-tenant Apps, a form only the menu opens counts as referenced, and `tablewalk check` refuses a name that is not a
  list, a signed-in form, or a command exactly one such form runs. Depot adopts it.
- **Mentions and recipients in a tenant App reach the person.** A notice's `to` through the people table and an
  @mention hold the account id that `auth.me` names; each is now told at the account's email, only while that account
  is an active member of the record's tenant, so a notice never crosses tenants. `tablewalk check` warns when the `me`
  column looks like an email in a tenant App (or like an id in another), where every recipient would be dropped.
- **A timeline's `side` applies per stream.** A section's `side` applies to each stream that has its columns, and a
  stream without them stays on the near edge; a stream may name its own `side`. `tablewalk check` still refuses a
  `side` no stream can read.
- **A table's name addresses its records.** `/<app>/<table>/<id>` opens the record at its view's canonical address
  instead of missing.
- **No chooser flash.** A tenant App draws no chooser until discovery answers, so a sole member goes straight in
  without seeing one.
- **The bell in a tenant App** counts the inbox of the tenant the person is working in; notices have been kept per
  tenant since 0.8.1, and a browser test now holds the bar to it.

## 0.8.13

### Changes

- **The assistant's page reads like a conversation.** Words, the person's messages, tables, charts, record cards and
  proposals stand in one centred column, their edges lined up, and a wide table scrolls inside it. An empty
  conversation opens with its intro, a grid of starters and the composer together in the middle of the pane. The
  composer is a light one-line field that grows with its words, with Send filled only when there is something to send;
  while a proposal waits, the field says so over itself and in its description. The rail says each conversation's
  day — Today, Yesterday, a weekday, then the date — under Waiting for you, Today, Yesterday, Earlier this week and
  Older, in the App's timezone and against the clock as it is now; the current row is a quiet tint, a cut title is
  whole on hover, and the search is a small "Filter conversations" field. The page is headed by the open
  conversation's title with its Rename and Delete. On a phone a record card is a two-column grid and the conversations
  open as a sheet beside the conversation from an icon button. Done and declined proposals keep a visible edge by
  night. The side panel takes the same card and composer.
- **The assistant works in tenant Apps (preview).** A conversation belongs to one customer: it is kept with that
  tenant, listed and resumed only there, and switching customer switches the panel's history. Every read the
  assistant makes is a request on the tab's own lease, with the membership check and read scope a page gets, so a
  person removed mid-conversation is refused at the next call and an id from another tenant is not found. Each tenant
  has a switch, off until the platform owner turns it on in Account → Manage tenants (`setTenantAssistant`, a sixth
  administration operation) with a consent reference; every change is journaled, and a tenant's own admin may turn it
  off, never on. Off, the panel is not drawn and the routes answer 403; a support session never has one. The tenant
  policy's `assistant` sets a per-tenant daily token cap and how long conversations are kept (90 days by default,
  purged on a schedule and with a closed tenant). Manage tenants gains an Assistant usage tab: tokens by tenant, by day
  or by month, with a CSV download. What leaves the platform is the person's messages and the rows their own reads
  return, under the server's `ANTHROPIC_API_KEY`. The assistant store moves to version 2 (`__tablewalk_assistant_tenant`);
  an existing one moves with `tablewalk migrate stores up`.
- **An Apps-first site.** The home leads with building an App — a few lines of TypeScript beside the record page they
  make — then a new App from an empty database (a two-table `schema.sql`, twenty-one lines of `app.ts`, `migrate diff`,
  `migrate up` and serve), a showcase of lists, pages, dashboards and the assistant, what is yours to change, and the
  agent loop. The site wears Lumen in its Stone neutrals with Inter, and the sidebar's Start group is Apps first.
  Compass's pipeline folds its closed stages (board `folded`).
- **Quickstart: a new App.** A new guide walks the home page's path step by step, each with what a real run printed:
  `npm install tablewalk`, `createdb`, the schema, a writable `tablewalk.json`, the App, the first migration written
  and applied, and the App served. It opens the sidebar and the home's first button points at it.
- **A conversation's other side (preview).** A timeline's new `side` is a condition, in the query language, that picks
  the rows drawn against the far edge: `side: 'author_id = record.caller_id'`, where `record.` names the page's record
  through each stream's own way back to it. Those rows sit on a soft surface, at most four fifths of the width, the
  author's avatar on their side; the section's rows stay along this one. The author's name is said once per run of
  their rows (same author, same side, same tint), while every row keeps its time. One-line rows (`compact`) stay lines
  across the width, a tint and day headings read as before, and on a phone every row takes the whole width. The
  condition is judged against every stream by `tablewalk check`, in the words it was written in; a stream `about`
  another table cannot name the record. Square, with no tails.
- **A calendar's shaded spans (preview).** `calendar(..., { backdrop: { resource, from, to, label, tone? } })`, or a
  list of up to four, shades the days another table's rows cover behind the calendar's own: a change freeze, a holiday,
  an on-call week. Each span is named where it starts (and on a week's first day when it runs into one), in its tone,
  and opens its record where the App has a list of its table the reader can open; elsewhere it is words. A phone's
  agenda says it on the day it starts, with its days. The spans are read as the reader reads: a reader who cannot read
  the table, or its dates or label, gets the calendar without them. `tablewalk check` refuses a resource the App does
  not declare, a `from` or `to` that is not a date column, and a label that is not a column.
- **A custom section on a dashboard is placed as on a record page (preview).** `custom(title, component, { rows,
  width })` in a dashboard's `sections` or `aside` loads and fails in the page's frame (its skeleton bar under the
  title, then the problem with a retry), takes the same width keys, is told its `region`, and gets the reader's window
  as `period` (`'last 30 days'`) beside its rows. A dashboard section whose component draws nothing takes no place.
  `custom('Title', ...)` now types as a dashboard section: its title was widened to a message reference, which a
  dashboard's sections do not take.
- **Forecourt returns as a modern Lumen marketplace.** The ninth sample App (`examples/apps/forecourt`) is a used-car
  marketplace on SQLite or PostgreSQL: a front page with a photograph behind its heading and one search box, photo
  cards with the price large and a rail of refinements kept in the address, a car's page with its gallery first and a
  sticky price card, and an inquiry form anyone may send. Buyers save cars and follow their own inquiries; the desk
  works a pipeline board, an inquiry as a conversation and the stock in place. Its photographs are 24 CC0 and
  public-domain pictures from Wikimedia Commons, credited in `photos/CREDITS.md`, and the seed builds the catalog
  from them so every listing looks like its car. It wears Midnight, its own theme on Lumen (`defineTheme`): an
  ink-navy bar and one amber for the next move, a deep amber-brown by day and a bright one by night on navy. The
  README ends with the platform gaps it found.

### Fixes

- **`tablewalk check` places a finding on the App's own line.** A validation finding is placed by walking its
  definition path in the module that defines the App (`views.invoices.show`) to the string that names the mistake,
  or to the key's own line; the text search behind it reads only modules. A `check.json` left in the App's folder was
  read as a source and named as the place, a `show` array on a line of its own lost its line, and a misspelled column
  went to the line holding its table's name and the column "Did you mean" suggested.
- **A flag's switch in the New form is a switch again.** The looks' control and field rules (a field's 36px height
  and corners) reached the switch's input and squashed its track into a rounded square; the switch keeps its 34 by 20
  round track.
- **`tablewalk migrate diff` on SQLite numbers a `serial primary key`.** SQLite takes any word as a type, so the
  quickstart's `id serial primary key` was written as `` `id` serial NULL ``, every new row's id was NULL, and the App
  opened `/@customer~null` to "This customer no longer exists". On SQLite, `diff`, `check` and `squash` now read a
  `serial`, `bigserial` or `smallserial` primary key as `integer primary key`, which SQLite numbers, so one
  `schema.sql` serves both databases; a `serial` column that is not the primary key is refused by name before Atlas
  runs.
- **An average of a yes-or-no works on PostgreSQL.** A dashboard or list measure (`avg is_won * 100`), a rollup or a
  list aggregate over a computed or stored boolean failed with "function avg(boolean) does not exist". On PostgreSQL
  a boolean is now read as an integer before `sum`, `avg`, `min`, `max` or `median`, so a won rate is the same number
  as on SQLite and MySQL, which hold one as 0 and 1; a sum of one is a count, not a yes.
- **"Today" is the day beside it.** A relative day (`format: 'relative'`) read a timestamp's first ten characters,
  so an instant that carries its zone, 02:00 UTC on the 9th, said "tomorrow" in a New York evening whose own line
  said Oct 8, 10:00 PM. It now takes the day the date and time are said on: an instant's in the App's `ui.timezone`,
  a wall clock with no zone as written. Forecourt writes its stamps in its own zone's wall clock, as its seed does.

## 0.8.12

### Changes

- **A record's conversation and timeline read by day, and by who said what.** Each day is said once, as a heading
  over its rows ("Today", "Yesterday", "Oct 2", in the App's locale and `ui.timezone`), in place of a date beside every
  row. A message leads with its header (the author's initials, their name, the row's kind and its time at the line's
  end, the whole moment on hover) over its words, and messages stand 14px apart where the lines inside one stand 3px. A
  row the section's `compact` rule marks is one quiet line, smaller and in the quieter ink, and two or more in a row fold
  to their count ("3 updates"), a button that opens them in place. A tinted row (an internal note) is a card in the
  messages' column with an edge in its tone, no longer a band across the section. A message names the stream it came
  from only where the messages come from more than one: a conversation whose second stream is all quiet lines (time
  logged) said "Activity" over every message. The section's options are unchanged.
- **Charts keep the order their values have.** A breakdown, a chart's bars and a donut over a column with a declared
  order follow it rather than their counts: an enum's or a CHECK list's options, and now also the values a display
  rule names, in the order it names them — a priority stored 1 to 5 and said Urgent to Planning reads Urgent, High,
  Medium, Low, Planning. A scale — a number that is neither a key nor a reference (an age in days, a score) or a bucket
  of time — runs in its own order: "Backlog by age (days)" read 0, 1, 6, 3, 2 and reads 0, 1, 2, 3, 6. Biggest first
  stays the order of plain text. A donut's slices and stacked bars' series over a scale are steps of one hue — the
  first series deepened toward the ink, then washed toward the surface, mixed from the theme's tokens, light and dark —
  where categorical hues drew Medium and High in two greens. A record page's breakdown and chart read the same way.
- **A board says what its lanes are worth, and folds what is closed.** A lane's head adds up its cards beside its
  count, "Discovery · 3 · $92.8K", over everything the list's conditions match: the board's new `sum` column (Preview),
  else the first money column its card shows. A card and a lane say money short in the App's locale and currency,
  $240K and $1.25M, with the whole amount in the title, read exactly from the text the database sent, so an amount past
  2^53 keeps every digit. A board's new `folded` lanes (Preview), `folded: ['won', 'lost']`, are drawn as a narrow strip
  with the name down its side, the count and the sum, until a reader opens one; the strip is still a place to drop a
  card, a folded lane's cards are not read until it opens, and the reader's choice is kept per board in their browser.
  Both are in `schema/app.d.ts`, the JSON schema and the views reference.

### Fixes

- **The SQLite sign-in store and the command-sequence store keep a version row.** Neither could say which way a store
  from another tablewalk differed: the sign-in file on SQLite was read as version 1 by its layout alone, and the
  sequences were read as present or absent. Each now has a meta table (`__tablewalk_auth_meta`,
  `__tablewalk_sequence_meta`, and on PostgreSQL the sequences' in `public`) at version 2, written when the store is
  created, and opening one at another version names the version found and the one expected, as the other stores do. A
  store from 0.8.11 is refused as older, unchanged, until `tablewalk migrate stores up` adds the row; serving does not.
  The release fixtures of the stores (`test/fixtures/stores/<release>/`) now hold PostgreSQL as well as SQLite: with
  `TABLEWALK_TEST_PG` set, `scripts/store-fixtures.mjs` writes each store's rows, through its API, into a database of
  its own and dumps it, and the upgrade test brings them forward on a live server, reads the rows back, and refuses a
  store forged one version newer, unchanged. A release writes both; 0.8.11's were written from
  its own tag (`--source`) and 0.8.12's from this build.
- **A PostgreSQL database restored from a plain `pg_dump` opens again** for the API token, command event and event
  delivery stores, where it used to be refused as "could not be verified". PostgreSQL stores a CHECK such as
  `x BETWEEN 1 AND 9 AND y` as `(x >= 1 AND x <= 9) AND y` but reads a dump's text back with the AND folded into one
  list; attestation compared the two as text. It now folds a left operand of the same operator on both sides, and
  nothing else, so the stores keep their layout versions. The upgrade test provisions every PostgreSQL store, dumps it
  with `pg_dump`, restores it with `psql` and opens it. A tenant administration journal, invitation store or support
  audit on PostgreSQL that is at another layout version now records that version as the cause of its refusal, as on SQLite.

## 0.8.11

### Changes

- **Lumen's neutrals are Stone.** The grounds, ink, lines and menu move from a navy-leaning grey to a warm one (an
  off-white ground by day, a warm near-black by night); the accent, link, status and chart colours, and the five
  palettes, are unchanged.
- **The Console is rebuilt (preview).** Each room opens on one head: its name, the App, a ⌘K palette for flags, jobs,
  Apps and rooms, and the live clock; j and k walk a list. Feature flags list state per scope and their rollout, open in
  a sheet that says who is served what, and stage edits for review before they apply; an App with one scope opens it
  without asking. An experiment leads with its verdict, each variant's rate and interval on one scale, and its
  blockers as steps. Operations opens on four figures and one stream of jobs and deliveries, on what needs attention;
  a row opens a drawer with its attempts and Redrive, and stores are a health grid. Analytics has Overview, Events
  and Funnels views, with the figures as one strip and each funnel as steps. On a phone, lists are cards.
- **A command asks for a date and a time together**. `field.datetime()` draws the date field with its
  clock; a person types the wall time in the App's `ui.timezone`, and the handler receives the UTC instant
  (`2026-10-12T13:30:00.000Z`). The API, MCP and agents send ISO 8601 with its `Z` or offset (Postgres's
  `2026-10-12 19:16:00-04` too); a time with no zone is refused, since it names a different moment in every zone.
  `min`, `max` and `below`/`above` a sibling compare moments. The zone arithmetic loads with the first such field,
  never with a public form's first page.

### Fixes

- **The public-surface inventory marks the 0.8.9 previews as previews.** The assistant (`assistant()`, `placement`,
  `starters`), tenant branding (`branding`, `brandingForm()` and its provisioners), a look's palettes, the component pack
  (tree and gantt lists; scatter, funnel, heatmap, waterfall and treemap charts; the banner, steps, donut `total` and
  smooth-line blocks; the avatars, icon, colors, rating, ring, qr and json displays; the json, scan, signature and
  slider inputs) and the `operations` grants of Console's rooms were listed `public` in
  `test/fixtures/public-surface.json` while the Status page called them Preview. The marking follows the Status page
  now, and the generated DSL reference shows it; nothing is gated by it.
- **A store from another tablewalk says which way it differs.** Opening a store whose layout is not the one this build
  expects used to say only "missing or not the layout this version expects", while `tablewalk migrate stores status`
  already knew "newer than this tablewalk". Every store that keeps a version row (on SQLite and PostgreSQL, where it has
  one: the authentication and API token stores, the command journal and its event and delivery stores, public placement,
  jobs, workflows, the tenant store, administration journal, invitations and support audit, suite grants and
  preferences, branding, notices, record history, the assistant, flags, experiments and analytics) now names itself, the
  version found and the one expected on opening: upgrade tablewalk for a newer store, or stop the server and run
  `tablewalk migrate stores up` for an older one. A tenant store still tells a caller only that the tenant context could
  not be verified; the reason is the one the operator reads at startup.
- **Every write moves the record page's epoch.** A file upload, a record flow's start, an agent's call and an HTTP
  operation now discard a composed page's answers as a command does; the list of writes is shared with the tenant
  transport (`src/client/writePaths.ts`) instead of kept by hand beside it.
- **A tenant request reuses its read scope and capabilities.** Every request, and every read in it, re-copied and
  re-checked the ownership snapshot and catalog, pruned the catalog for the role again and projected the capabilities
  again; a page's refresh after a write held the server for seconds and a command's prepare queued behind it, so the
  next submit was refused as stale. What was captured is now reused by identity, and pruning and capabilities are kept
  per App, catalog and role grant (never per tenant or person; the row scope is still composed for each request). An
  open command form whose record another command changes prepares again and holds its submit until it has.
- **An @ name may have a space in it.** The mention list closed at the first space, so "@Morgan Tr" could not tell
  Morgan Tran from Morgan Hughes. It now stays open across a space while what is typed names someone, and closes at a
  second space in a row, at a space after the two words the lookup reads, once nobody matches, or on Escape.
- **A large tenant App starts in seconds again.** Binding the command authorizers re-checked the App's whole policy for
  every command and role (and again for every command a request ran): an App of ~900 commands spent about 18 s on each
  of the authorizers a tenant server builds. Each role's grants are now read once per authorizer, from the App it has
  already captured and checked, and every refusal at startup and every decision is the same
  (`test/command-authorizer-scale.test.ts`).

## 0.8.10

### Fixes

- **The Branding form fits.** With no logo, "No logo: the name stands alone." wraps inside a logo box that grows to
  hold it, rather than spilling onto the label above; and in the live preview, the record card wraps its pill and
  Assign button beneath the name instead of running under the figure card, at any panel width.
- **A list's ⋯ row menu is drawn only for a reader who may run one of its verbs.** A read-only reader no longer sees
  a ⋯ that opens nothing, nor the column reserved for it; the decision is read from the App payload's grants when
  the list first draws, so the column never appears and then vanishes. The assistant's chat tables and a dashboard's
  rows sections follow the same rule.
- **The component library's interaction script runs every story.** `storybook/scripts/interactions.mjs` opens each
  story in Storybook's own index, so a story added later is covered the day it lands; the journeys it already held
  were brought up to date, and the Palette story registers its surface as the shell does.
- **A record page shows the record as stored after a command, a post or a tag.** Where a page composes slowly — a
  tenant's, on PostgreSQL — the refresh one write asked for could still be out when the next was sent; it had read
  the record before that write landed, and its answers were kept, so the page went back to the old status, fields
  and chips, and the next change could be refused as made to a changed record. A record page's composed answers
  are now kept only when no write was sent or answered while their compose was out, and a read no longer waits for
  one that was.
- **An @ says who a person is, however they are keyed.** A rich text column's or input's `mentions.label` may be a
  template of the people's own columns, `'{first_name} {last_name}'`, so the list tells "Morgan Hughes" from "Morgan
  Tran"; a column the template names that the people lack is named in the warning. Typing after the @ matches the
  start of any word of the label, and of the handle. A people resource whose handle is an email (`by: 'email'`) was
  offered nobody: an email's `@` was not a handle, so every row was dropped, and a mention of one was stripped on save
  and never told. It is now kept, shown by its label, and told.

## 0.8.9

### Additions

- **A theme of your own, written by purpose.** `defineTheme({ id, label, extends?, palette, palettes, shape, type,
  density, recipes })` names colors for what they are for (`ground`, `surface`, `ink`, `accent`, `line`, `status`,
  `nav`, `chart`, `rules`), starts from a built-in look with `extends` or from nothing, and picks each part's
  treatment from a closed menu: the menu, the bar, tabs, a dashboard's windows, labels, figures, stat cards,
  sections, fields, tables, status values, boards, charts, buttons, links, rules, avatars and workflow steps.
  Give it to `ui.theme` or `ui.customThemes`. The built-in looks are now written this way.
  See [Themes and branding](https://tablewalk.dev/docs/themes/).
- **An assistant in the App (preview).** `assistant({ instructions, roles, exclude, tools, blocks, placement,
  limits, model, effort })` puts a button in the App bar that opens a panel beside the page. People ask about their
  records; answers stream in as text and as tables, figures, charts and records drawn by the App's own components
  from validated block data, never model-written markup. It reads through the same typed surface as the page, under
  the person's roles, field access and tenant rows, and on a record page it reads that record and the verbs open to
  it now. A change is a proposal card: Confirm runs it through the record's own button, command form or New form,
  and nothing is written before; words in a record cannot write. Conversations are kept per person, a pending
  proposal survives a reload, long ones are summarized, and tokens are capped per answer, per person and per App
  per day. Claude is reached with `ANTHROPIC_API_KEY` from the server's environment, the stable prefix cached; the
  panel is loaded only when opened. A deployment provisions the store once with `provisionSqliteAssistant` or
  `provisionPostgresAssistant`. Compass offers it. See [Add an assistant](https://tablewalk.dev/docs/assistant/).
  The panel goes full screen over the content area and back (remembered per person; Escape returns it), and
  `placement: ['panel', 'page']` gives the assistant a page of its own at `/<app>/assistant`, a conversation at
  `/<app>/assistant/<id>`, with the conversations in a rail (a drawer on a phone): the ones waiting for the
  person first, then by day, each renamed or deleted from its own menu, and searched by title as one types and
  by what was said (the person's words and the model's, never a tool's) a moment later; nav places it by the word
  `'assistant'`, else it closes the menu. `starters` offers up to six questions on an empty conversation. A record
  card carries the record's own verbs and Edit, and a table's rows their own menu where a view of that table has
  `rowActions`: the same buttons, forms and checks as the record page, shown only to a person who may run them.
  What one did is noted in the conversation for the model's next turn; the note runs nothing. A card names a
  reference by its record's label. A command's form is now fetched when it is first opened, not with the first
  page.
- **One validator for every theme.** `tablewalk check`, `tablewalk build` and a tenant's branding save hold a
  theme to the same rules: text, links, the accent, the meaning colors and the menu at 4.5:1 on every ground they
  sit on (a selected item's tint and a tone chip included), controls, the focus ring and the first four chart
  series at 3:1, in light and dark and every palette, and adjacent chart series far enough apart for protanopia,
  deuteranopia and normal vision. A failure names the color by its key and says the measure.
- **Each tenant can brand the App (preview).** `branding: { allow, editors, themes? }` lets a tenant App's
  tenants change their logo, name, accent, palette, corners, density or theme, never its grounds, ink or
  recipes. The `brandingForm()` dashboard section is the editor, beside a live preview of the bar, a record, a
  stat card and an email; only the roles in `editors` save it, never a support operator or the platform realm.
  A save is validated field by field and then as a whole theme, and refused in a sentence beside the field. A
  logo is checked by its bytes (raster up to 256 KB; an SVG is rewritten from an allowlist) and served from the
  App's own origin. The brand reaches the shell before it is revealed, a mapped host's sign-in page and public
  forms in their head, the tab title and icon, and the mail link page; a message may say `{brand.name}`,
  `{brand.logo}` and `{brand.accent}`. A save reaches every instance on its next page through the shared cache.
  A deployment provisions the store once with `provisionSqliteBranding` or `provisionPostgresBranding`.
- **A support operator sees the tenant's brand under a "viewing as the provider" marker.**
- **Every menu section folds.** A top-level group's heading folds its section as a nested group's did, by the
  group's id, remembered per person; a section still opens itself while it holds the current room, while the
  menu is filtered, and in the rail. `navGroup(id, label, children, { folded: true })` starts a section used
  rarely as its heading until someone opens it, and their own choice is kept over it. A footer group's heading
  stays plain: the gap above it would move it as it folded. Folding moves nothing above the heading.
- **A record page's metric says its figure as the dashboard's does.** `metric(..., { format, unit })` on a page
  takes `'percent'`, `'number'` or `'money'` and a unit word, and an average or ratio is said to one decimal
  place at or past 1 ("3.3", not "3.333"): 0.8.8's rounding reached only the dashboard. `format: 'percent'`
  reads the figure as 0–100, so `avg won_flag * 100` of 53.846 is "53.8%".
- **A command's rich text names teams.** `field.richText({ mentions: { from, by, label, groups } })` offers a
  team after the people, as a column's display rule does, so a reply or work note can @ a team.
- **Dashboard blocks the Lumen references drew (preview).** `note(text, { variant: 'banner', title, eyebrow,
  action, image })` is a wide banner with one action and an optional picture from a file row; `breakdown(...,
  { shape: 'steps', notes })` draws a pipeline as steps in the vocabulary's order, each with its count and a
  short line; a donut takes `total: 'Leads'` for its middle and says each slice's share; a line chart takes
  `curve: 'smooth'`, and a series keeps its color from one chart to the next; `windowControl: 'button'` shows
  the window picker as one date-range button. The theme menu gains `banner` and `steps` recipes, which Lumen
  picks. Compass and Depot use them.
- **Board cards, menu dots and new display rules (preview).** A board takes `category` (a colored tag) and
  `footer` (up to four facts, each with an optional icon) on each card, and its lanes add a card with "+"; a
  nav entry takes `color: 1`–`8` for a dot. A display rule takes `format: 'avatars'` (overlapping initials for
  a list of names), `icon: { mark, tone }` (a lead mark in a small toned square), and `colors` (a value's chart
  color).
- **Values drawn their own way, and edited in their own control (preview).** A display rule takes `format:
  'rating'` (stars, `outOf` 3 to 10, edited as stars), `'color'` (a swatch, edited in the color picker),
  `'time'`, `'month'` and `'year'` (each edited in the browser's own picker), `'json'` (a tree on the record,
  an excerpt in a list) and `'qr'` (a code to scan with its text under it); `ring: true` on a percent draws a
  progress circle, and `slider: { min, max, step }` edits a number along its range. A file field previews
  video and audio, checked by their bytes, up to 64 MB. The QR encoder, the JSON tree and the inputs are
  fetched the first time a page needs them, so no first page carries them. Thread rates a project's health,
  Compass sets a deal's probability on a slider, and Ignition's dealer profile uses the rest.
- **Five more chart shapes (preview).** A dashboard chart takes `shape: 'scatter'` (a dot per group placed by
  two figures: `x` names the across one, `measure` the up), `'funnel'` (steps in the vocabulary's order, each
  counting the rows at it and every later step, as a share of the first), `'heatmap'` (two keys as a grid of
  shaded cells, such as `weekday moved_at, hour moved_at`; an hour with nothing keeps its column), `'waterfall'`
  (each period's rise or fall from where the last ended, then the total) and `'treemap'` (tiles in proportion,
  past eight one "Others" tile). Each says its figures in a table a screen reader reads, and is fetched only when
  a dashboard draws one. A breakdown groups by `weekday <date>` and `hour <timestamp>`. Compass draws its pipeline
  as a funnel and its reps as a scatter; Depot its moves as a heat map, its stock value as a treemap and its net
  units as a waterfall.
- **A tree and a gantt chart as a list's presentation (preview).** `tree(parent, primary, { lines })` folds each
  record under the one its self-reference names (up to 2,000 records, read whole), walked with the tree's keys;
  `gantt(start, end, primary, { by, progress })` draws records as spans between two dates against a ruler of
  weeks or months, a row per value of `by` with overlapping spans stacked, a share done filled in, and a line at today
  (up to 500). Both ask the list's own question, so its tabs, search and filters narrow them. Compass has an
  account hierarchy and a campaign schedule.
- **A JSON editor, a code scanner and a signature pad as inputs (preview).** A column with `format: 'json'` is
  edited in a monospaced box that says where the text stops being JSON and formats it on request, and the server
  refuses a write that is not JSON ("This is not valid JSON."). `scan: true` on a text column adds a Scan button
  that reads a barcode or QR code from the camera where the browser can (the box stays for a scanner gun or the
  keyboard). `signature: true` on a reference to a file resource is a pad to draw or type a signature, kept as a
  PNG in that resource and drawn as the picture wherever the value is shown. Depot reads a product's UPC with the
  camera and takes proof of delivery on a pick list.
- **The schema you want, in one schema.sql.** `tablewalk migrate diff <name>` writes the next `V<n>__<name>.sql`
  holding what the migrations still lack to build `schema.sql` (beside the migrations directory, or
  `--schema-file`), for review; `migrate check` exits 2 when the migrations, applied to a scratch database by
  tablewalk's own runner, do not build it, fast enough for `npm test`; `migrate squash` folds the chain into one
  `V1__baseline.sql` before go-live. tablewalk's `__tablewalk_*` tables are left out. The comparison is Atlas's
  community build v1.3.0, pinned by sha256 and fetched on first use into `.tablewalk/bin` with its update check
  off (`TABLEWALK_ATLAS` names your own; serving never fetches it). PostgreSQL (`--dev-url` names the server for
  the scratch databases) and SQLite. A diff cannot tell a rename from a drop and an add: the page says how to
  rewrite one. Nothing is generated from the App's DSL. See
  [Change the schema from schema.sql](https://tablewalk.dev/docs/schema-sql/).
- **`tablewalk new --api` starts with a schema.sql.** The project has `db/schema.sql`, `db/migrations/V1__task.sql`
  (its database is that file applied, so the history starts at V1) and `npm run schema:diff`, `schema:check` and
  `migrate`.

### Changes

- **Lumen is set in Inter on every machine.** Lumen named Inter but shipped none, so most machines drew the
  system's sans in its place (DejaVu Sans, wider, on most Linux). Inter's variable face (its Latin subset, 48 KB)
  now ships with Lumen's stylesheet and is preloaded beside it: only a page wearing Lumen fetches it, no first
  page carries it, and until it arrives Arial cut to Inter's measure stands in, so nothing moves when it does.
  Its license, the SIL Open Font License, ships beside it.
- **Three built-in looks: Lumen, Mono and Sage.** Lumen is now the look an App wears when neither it nor its
  reader names one, and Mono and Sage stay, each with its palettes. Canvas, Iris (and Coral), Ink, Signal and
  Tray are no longer built in: [Themes and branding](https://tablewalk.dev/docs/themes/) gives a Canvas, an Ink
  and an Iris as `defineTheme` examples to copy. The sample Apps that wore them now wear Lumen, Mono or a theme
  of their own (Commons a printed page, written with `defineTheme`).

### Fixes

- A Lumen menu's nested section heading stood 4px out of line with its parent's, and a top-level heading drew as
  a 36px pill: the fold now keeps its heading's inset in every look.
- A board under the strip treatment (Lumen) showed no edge where a dragged card would land; the lane now takes the
  accent edge as the other boards' do.
- A record page could stop scrolling short of its end when the wheel turned over a section's table that overflowed
  by a pixel; a section's table now scrolls sideways only.
- A dashboard's activity periods cut "Yesterday" to "Yeste…" in a narrow aside; a button that cannot fit wraps
  whole.
- A first visit to an App asked for its look's stylesheet only after the entry had run, a second round trip
  before the reveal; the page now preloads the sheets of the App's own look.
- A tenant's accent now colors its charts' first series too, as the branding form says it does: under Lumen, whose
  first series is not its accent, a tenant's teal reached the bar but its charts stayed blue.
- The branding editor no longer says "Branding" twice, once as the section's title and again as the form's.
- A command input named `title` took the id of the form's own heading, which left the form unnamed and the
  field without a label. A field's id is now in its own namespace.
- A custom component received a Postgres timestamp as the database's text (`2026-10-12 19:16:00-04`), which
  `Date.parse` cannot read. A column declared a timestamp now reaches it as ISO 8601 with a full offset; a
  timestamp without a zone keeps none.
- A tenant App could name at most 256 commands that return records; the bound is 1024. Nothing per request
  grows with it.
- A reader with 32 tabs of a tenant App was locked out of the next page until a context expired. The 33rd page
  now takes the place of the account's oldest context with no request in flight, a released one first; only an
  account whose every context is busy is refused, with its own 429 (`too_many_contexts`) in the log rather than
  the session-ending refusal. The deployment's ceiling and the rule that an unverified caller reserves nothing
  are unchanged.
- A record page went blank for several seconds after a command or a Save on a page with no host: the write
  started the room over, dropping its reads, and the page waited on all of them. It now refreshes in place, as a
  dialog or a split pane does, and stays drawn.
- Starting values a command's `prepare` answered after the person had begun typing replaced what they typed;
  they now fill only the fields the person has not touched.
- A row-defined field read through a reference (`request_id.answers`) was drawn as raw JSON; it is drawn as
  its fields.
- A timeline stream's `about` (`stream('incident', …, { about: 'company_id' })`) stopped a tenant App from
  starting; the tenant's page now reads it, within the tenant, and a stream option the tenant does not take is
  named in the refusal.
- `header({ factLabels })`, documented in the page types, was refused with no hint. It is not an authored key:
  the refusal now says to write a fact's word in `facts: [{ column, label }]`, and the type says so.
- The @ list showed a person's stored key ("Morgan @3f2a9c1e-…") beside their name. A handle is shown only when
  it is a word a person would say; a primary key, a number or a UUID is not.

## 0.8.8

### Rich text and @mentions

- **Rich text.** `display: { body: { format: 'richText' } }` makes a column formatted text, and
  `field.richText()` a command input: bold, italic, strike, headings, bulleted, numbered and check lists,
  links, quotes, code, simple tables, Markdown shortcuts, a paste from Word, Outlook or Google Docs cleaned,
  `mentions: { from, by, label? }` for an @, and `images: '<file resource>'` for a picture kept as an
  attachment of the record. A record draws it whole, a list as an excerpt; a timeline whose `create` command
  takes rich text composes in it. The server stores sanitized HTML (`sanitize-html` over one allowlist: no
  style, script or handler; links `http`, `https` and `mailto`; pictures only the App's own attachments) on
  every write, and the API and MCP may send Markdown or `{ format, text }`. The editor (Tiptap) is a chunk
  of its own, fetched the first time a rich text field is edited, so no first page grows. Adds `marked` and
  `sanitize-html` as the package's runtime dependencies. Thread's issue description and updates use it.
- **@mentions that reach people.** A rich text column's display rule takes `mentions.groups: { from, by, label?,
  through? }`, so an @ names a team as well as a person. A `notify` rule's `mentions: { in }` over a rich text
  column tells whom its stored mentions name (`by` comes from the display rule), a team as its members. An update
  tells only whom the write newly mentions, and only those who may read the record, at most twenty per write.
  Thread and Commons mention people in their descriptions and posts.
- **A timeline composer a custom section can fill.** `useComposer().fill(text, { mode })` from `tablewalk/ui` puts
  a template's words in the page's conversation box and chooses Reply or Internal note. It never sends, and it
  answers `false` where the page draws no composer. In `tablewalk/ui/testing` a fill is recorded as a
  `{ kind: 'composer' }` navigation.
- **Canned replies in a composer.** `composer: { reply, note?, templates: { from, label, text } }` puts a
  Templates menu beside Send: the rows of `from`, picked by `label`, fill the box with `text` (as
  `useComposer().fill` does) and send nothing.

### Tenant Apps: email, API, search and files

- **Email for tenant Apps, in and out (preview).** A tenant App's jobs module declares `mail: { receive, send,
  links }`. `POST /api/mail/inbound` takes one message as provider-neutral JSON signed with the email service's
  `inbound.secret` (`x-tablewalk-signature: v1=<hex HMAC of "<timestamp>.<body>">`): `<mailbox>+<tenant>@<domain>`
  or a tenant's own domain (`domains`) routes it, the Message-ID is the receipt's idempotency key, a replayed
  delivery is 409, and auto-replies, lists, bounces, our own mail and a sender past 30 an hour are dropped into
  the platform's mail log. `send` claims each active tenant's held messages every `every`, sends them over SMTP
  with their Message-ID, In-Reply-To and References, signs them with DKIM (relaxed/relaxed, rsa-sha256,
  `node:crypto`), and records `sent`, `failed` or `bounced`; only a domain `domains` gives the tenant is sent as
  itself. `links` puts a signed, expiring, revocable link to a record where a message says `{link}`, opened at
  `/api/mail/link` through the App's own command (`revokeTenantMailLinks` in `tablewalk/maintenance`).
  Inbound HTML is sanitized and quoted history cut. `tablewalk mail-dns` makes the DKIM key and prints the SPF,
  DKIM and DMARC records. The email docs map Cloudflare Email Workers, Postmark, SendGrid and Mailgun to the
  webhook. An attachment is checked against the App's file resource and handed to the command, which cannot
  yet store its bytes.
- **A mail link opens a page, and may take a reply (preview).** `/api/mail/link?token=` answers a browser with a
  page drawn on the server from the `links` command's answer: no script, nothing loaded from elsewhere,
  `Referrer-Policy: no-referrer` and a CSP of `default-src 'none'`, so the token in its address goes nowhere, and
  it costs no first page a byte. `links: { runAs, command, reply: '<command>' }` adds a reply box; the reply runs
  that command on the same record with `{ body }`. `Accept: application/json` still answers JSON.
- **Mail in a suite.** A tenant App mounted in a suite receives mail under its mount as `tablewalk tenant` does:
  the suite opens the App's email and search services from its config, with the App's environment.
- **A command writes a file.** `db.<table>.insertFile({ name, type, data }, values)` stores bytes through the
  resource's `file` rule (its name, type and size columns filled, its `maxBytes` held; 10 MB on a tenant App),
  and a mail receive handler gets the message's attachments as `files`. The command's audit keeps the file's
  name, type and size, never its bytes; bytes in a column that is no file's content are refused.
- **Attachments on a tenant App.** A tenant App's file resource lists, reads and uploads its files on the
  tenant's lease: the row is the tenant's write, under its grants and row scope, another tenant's file is not
  found, and an upload is at most 10 MB.
- **The App API and MCP for a tenant App on PostgreSQL with local sign-ins.** A tenant App whose data is on
  PostgreSQL and whose sign-ins are in the default local store now serves `--api-reads` and `--app-mcp`, and
  its connection may name the database by reference (`"url": "${DATABASE_URL}"`); both were refused at startup.
  A member makes their own tokens on their tenant's context (`/api/tokens`, `/api/tokens/issue`,
  `/api/tokens/revoke`): each binds that membership, with roles no wider than theirs, and a member sees and
  ends only the tokens of their tenant whose roles they hold. `POST …/v<n>/$mcp` speaks the App's MCP tools
  over HTTP with the same bearer token, checked on every request. `better-auth` is pinned to 1.7.2: a newer
  1.7 writes no `account.issuer`, which the local store's layout requires.
- **Search on a tenant App.** A tenant App's `search` is one Typesense collection per resource for every
  tenant, each document with its tenant; a member's search asks only within their tenant, and its keys are
  read back under that tenant's rows and grants. The index follows every write to the tenant's source (an
  edit, a command, a job), and `--reindex` takes `--policy`.
- **Instances behind a load balancer spend one sign-in budget.** Better Auth's own request limits on its
  sign-in routes are counted in the deployment's cache when one is named, as lockouts already were; before,
  each instance counted its own. Two tenant instances on one database and one cache are tested to read each
  other's writes on their next list and record.
- **Tenant Apps: a record page for some roles, at its own address.** A tenant App's page takes `roles` and
  `path` as any App's does: it is offered to the roles it names and absent to the rest. A key a tenant page does
  not take is refused by name (`pages "<id>" has "<key>", which a tenant App's page does not take.`) instead of
  an unexplained refusal.

### Row-defined fields and row-driven workflows (preview)

- **Row-defined fields (preview).** `defined: { specs: { from: 'attribute', per: 'category_id' } }` binds a JSON
  column to the rows of another resource (`key`, `label`, `type`, `options`, `required`, `help`, `position`), so
  people add a record's fields at runtime. They are drawn on the record page and the New form as its own fields
  and edited in place; every write — form, inline edit, command, import, API — is judged at the server in its
  own transaction, against definitions read in the tenant's scope, and a refusal names the field
  (`specs.capacity`) with a fixed sentence. A list filters, sorts and counts by `specs.capacity` (PostgreSQL
  jsonb, SQLite json1), a view's `filters` naming the column offers a facet per field, and the App API says the
  column as an object. Depot keeps each category's product specifications this way. A tenant write the App's
  rules refuse now names its fields too, and a command whose write breaks them is `invalid_input`.
- **Flows from rows (preview).** A resource's `flows: { from, steps, set?, events?, kinds? }` binds a table
  of flows and a table of their steps, both with fixed column names, and `flowRunner(resource, { runAs, listens })`
  in a jobs module runs them on the resource's records as durable workflows. A flow starts when a record is
  created or updated (with an optional `condition` and `changes`), or by hand. Its steps are `set`, `wait`,
  `until`, `branch` and `waitFor`, plus the App's own kinds, each of which runs one of the App's commands as the
  runner's principal and may then wait for an event about the record. That event resumes the run; nothing
  polls. A step row is checked when it is written and refused as a `422`. A stored row that breaks later fails
  its run at `load` with a sentence that names it. A record page's `flows()` section shows its runs, read only
  when the section opens, and lets a workflows operator start a manual flow. Depot's purchase orders over
  $5,000 wait for a manager's approval before they go to the supplier. On a tenant App each run is one tenant's:
  the record, its flows and their steps are tenant-owned, a change starts only its own tenant's flows, under that
  tenant's service principal, and another tenant's event never resumes it.

### Lumen, an eighth look

- **Lumen, an eighth look (preview).** `ui: { theme: { preset: 'lumen' } }` dresses an App as a refined workspace with
  no extra authoring. Dashboard sections, stat cards, list tables, record field groups, forms and board cards are
  white cards lifted by a soft shadow on a cool ground. The menu marks the current room with a soft blue pill and
  shows counts as blue pills. The primary action and a selected tab's underline are deep navy. A stat card shows
  the author's mark in a tinted circle, in its place's chart color, and trends are washed in a gradient. Statuses
  and workflow steps are tinted pills with their dot. A board's lanes are headed by a strip in their state's tint,
  and each card carries its meaning's stripe and an uppercase chip. Dark mode is included, and Inter is used
  where installed. The palettes Violet, Teal, Emerald, Rose and Amber change only the accent. Its sheet is
  fetched only when the look is worn. Its departures from the refusal list are recorded in `docs/design.md`.

### Boards, timelines and commands: the CRM gaps (G58 to G68)

- **A board moves a card through a machine's command verb.** A command verb that leads to one state is a lane
  move on a board by the machine's column, for a reader granted the command: the drop runs the command as its
  button would. While a card is dragged, a lane none of its verbs leads to is dimmed (color and cursor only;
  nothing moves), and the card's ⋯ "Move to" and Alt+←/→ offer the same lanes. Compass gains a Pipeline board.
- **A timeline stream about a referenced row.** `stream(from, whose, at, show, { about: 'company_id' })` reads
  the rows that lead to the row the record's reference names, as a list's `about` does: a deal's timeline holds
  its company's tickets.
- **A timeline author that is a reference is said by its name.** `author: 'agent_id'` draws the agent's label,
  not the key.
- **A machine verb said in its destination's words.** `label: 'Move to {to}'` says the state the verb leads to
  in the column's words, and a command verb may say itself differently from different states.
- **A machine's `entry` states.** `machine('stage', { … }, { entry: ['qualification'] })` lets a command insert
  a record in a state besides the first; any other state is refused (`ineligible_state`).
- **A command reads what its references point at.** Under a tenant or a row policy, a command that creates
  its target with a required reference to a table it does not read is refused when it is defined (`Add "<table>"
  to the command's read`); a row it inserts elsewhere whose reference cannot be proved is the handler's mistake
  (`invalid_result`, the table named for the operator), never an unexplained retry.
- **Totals over computed numbers.** A list's `totals` may name a computed number column; Compass totals its
  weighted pipeline (`amount * probability / 100`).
- **Search follows a reference.** A search's `fields` may name one step along a reference (`'requester.name'`):
  each document copies the referenced row's value, a text search of the record asks it too, and a write to the
  referenced row re-indexes the records that copy it, on single-App and tenant Apps alike.
- **Tags through commands.** `tags: { through, to, add: '<command>', remove: '<command>' }` runs two commands on
  the record, each told the tag's key as its `tag` input, instead of writing link rows, for a reader granted them.

### Authoring and everyday polish

- **An App split into features typechecks without casts.** `find()` names a section another feature
  contributed, `navGroup` takes `{ icon, placement, inline }`, a resources map built with `Object.fromEntries`
  keeps its view names, and `import './Widget.css'` needs no declaration of the App's own: `tablewalk/ui` and
  `tablewalk/app` declare `*.css`.
- **A navigation group can stand in the top bar.** `navGroup(id, label, children, { inline: true })` on a
  top-level group draws its items straight in the top bar as links (a portal's few rooms); the folded menu and
  the sidebar keep it a section.
- **An empty list can open a form.** `empty.action.to` may name a signed-in form view as well as a list or a
  dashboard: "No canned responses: write one" opens the form that writes one. A public form is still refused.
- **A section the reader cannot read is left out, not the page.** A record page with an Email list or a tags strip
  a role has no grant to is drawn without that section. Before, it fell back to the raw record, with every column
  and no conversation. `tablewalk check` says the page leaves the section out for that role.
- **Cards wear an icon.** A cards presentation's `icon: '<column>'` draws the icon its display rule maps the
  value to before the title. A column with no `icons` mapping is refused at load.
- **A dashboard figure says what it is.** A metric's `format: 'percent' | 'number' | 'money'` and `unit: 'days'`
  say a computed measure's figure ("78.3%", "4.2 days").
- **A list's tab strip shows there is more.** When the tabs overflow, the far edge fades while there is more to
  scroll to. The strip keeps its width, so nothing moves.

### Fixes

- A tenant App's Save or New refused by the App's own rules answered 403 and lost the fields: the tenant's context
  dropped them on the way to the transport. It now answers the rejected envelope with each field and its rule's
  sentence, as an App without tenants does.
- A role naming `fields` made startup appear to hang (130 s on a large tenant App, against 6 s now). Each command's
  check resolved every role's whole access afresh for every table it writes. The command-and-edit spelling
  (`fields: { <table>: { write: [...] } }` beside a command that writes the table) therefore works in practice.
- A tags filter (`tags has vpn`, `?tags=vpn`) ended the session on a tenant list: the rail's counts read through a
  breakdown that did not know `tags`. A breakdown now compiles it as the list does, and a malformed question refuses
  only that read (400) instead of the tenant's session.
- A command on a table with no `version` column answered 503 in a tenant App: the row digest it compares was read
  in a form the tenant's transaction refused.
- A tenant App's `address: 'number'` over a column unique per tenant (`UNIQUE (tenant_id, number)`) was refused at
  startup as not kept unique: the tenant's catalog dropped the pair with its tenant column. It now keeps it, so
  `/desk/incidents/INC0010001` addresses a record.
- A tenant could not delete a link row it owns (a tag taken off a record): the row's reference to the tenant's
  profile counted as a parent the tenant does not read.
- A split inbox served as the home now picks within itself: a row opens beside the list, not as a page over it.
- The key hint on a primary or danger button was drawn in the dim hint color on the button's fill; it takes the
  button's own text color.
- A tenant App whose resources stated a write rule (a text length or pattern) refused every write: the
  record's history refused the access that carried the rules.
- A custom section's values were labelled by the wrong columns when the page read the row once for several
  sections; each value is now read by its own path.
- A workflow step named in a loop (`w.run(['approve', 1], …)`) could never run its command: its request id held
  characters a command refuses. A step whose name does not fit is given a digest id.
- A custom section that draws nothing no longer keeps its place (an empty box with a heading) on the page.
- A dashboard figure measured as an average or a ratio said every digit the database sent ("78.261"); it is
  said to one decimal place at or past 1, and to three significant digits below it.
- A board of more than 64 cards offered no lane moves: its question of which cards each verb's `when` held
  passed the query language's 64 OR branches. The cards are asked in runs that fit.
- A tenant jobs module that declared only `mail` failed to start ("Job registry must not be empty.").
- `npm run test:components` left a 9 MB folder in the system temp directory on every run (Vitest's module copies);
  the run now removes it.
- The repository's sources and the sample Apps are formatted by `oxfmt` (`npm run format`), and `npm run format:check` is part of the static gate.

## 0.8.7

- **A conversation, as a page section.** `timeline()` takes `order: 'asc'` (oldest first, scrolled to the
  end), a pinned `composer: { reply, note }` (a Reply / Internal note toggle running two named commands on the
  record, for the roles granted them), a per-row `tint` and `compact` system rows. The record's head takes
  `header({ actions: [...] })`: the named verbs are drawn and the rest wait in More. `actions` is the third verb
  list beside `primary` and `destructive`, and says what `actions` says on a resource: the record's verbs.
- **A split chooses its rows and takes keys.** `split.row { primary, lines, facts, badge, avatar }` draws each
  row, and a list view's `keys` binds single keys to the picked record's actions, with the key shown beside
  its verb and inactive while an input has focus. Thread's Inbox uses both.
- **Properties in place.** `fields(..., { edit: true })` edits a property through the action that sets it;
  the server's enforcement is unchanged and a reader who cannot write sees it read-only.
- **Quiet chrome.** `heading: false` on a list or room keeps its title for screen readers and draws none; a
  page `note` is `variant: 'quiet' | 'callout'`; a theme palette has `sectionRule`, `headRule`, `ruleWeight`,
  `navCurrent` and `navCurrentText`; a navigation group may say `placement: 'footer'` (the foot of the sidebar).
- **`openView` takes a search and filters**, so a link from one view lands on another already narrowed.
- **Change your email address in the account screen** when the App signs in by email and sends mail: a
  verification link goes to the new address and a notice to the old one.
- **The container image runs on arm64 too** (Graviton, Apple silicon): `ghcr.io/rbaljinder/tablewalk` is one
  tag for linux/amd64 and linux/arm64.
- **TypeScript 7 is the baseline.** `typescript` is `^7.0.2` here and an optional peer `>=7` for an App's
  project; `tablewalk check` runs the installed `tsc` and reads the definition path of an error through its
  API client, and refuses an older compiler with `npm i -D typescript`. TypeScript 7 loads no `@types`
  package it is not told to, so an App with a commands module names `"types": ["node"]`. A cold typecheck of
  the repository went from 21 s to 3 s, and the 150-table App from 3.9 s to 0.8 s.
- **Tenant Apps: a signed-in form a component runs.** A form's command, which names no record, is in the
  payload's `grantedCommands` for a member granted it, `useCommand` reaches it through its form, and the tenant
  transport sends its empty key instead of answering "This record has no usable key".
- **Tenant Apps: history names people by their template** without ending the session, and a read the client
  asks wrongly answers `400 invalid_read` instead of `tenant_context_unavailable`.
- **Tenant Apps: another customer's record address is not found.** `/api/pages/compose` answers `404 not_found`,
  the same as for a missing record; the page shows its ordinary not-found and the session stays.
- **Tenant Apps: natural keys unique within a tenant.** `address: 'number'` is accepted on a tenant-owned
  resource whose column is unique together with the tenant column (`UNIQUE (tenant_id, number)`); the catalog
  now reports such pairs (`uniquePairs`) on SQLite, PostgreSQL and MySQL.
- **The API says `numeric` and `timestamptz`.** PostgreSQL and MySQL `numeric`/`decimal` go out as exact
  decimal text (`format: decimal`), PostgreSQL `timestamptz` as an RFC 3339 instant (`format: date-time`).
  Neither can be filtered or sorted by, and a column the API cannot say is refused when the App is
  checked, not when the spec is exported.
- **API creates, updates and deletes need no commands module.** An App whose only commands are its API's
  generic writes loads without one, and `defineCommands({})` is an empty registry, not an error.
- **Text rules on a column.** `text: { code: { pattern: '^[A-Z]{3}$', message }, name: { min: 2, max: 80 } }`
  on a resource is said under the field as it is typed and held on every write. On PostgreSQL a
  `varchar(n)`, a `CHECK (char_length(col) >= n)` and a `CHECK (col ~ '...')` give the same rule unasked.
  Compass's lead email says what an address looks like.
- **Tags everywhere.** A resource's `tags` read like a column: chips in a list's `show` with "+N", an any-of
  choice in `filters` (`?tags=bug,docs`), `tags has bug` in the query language, and a field of the New form,
  whose record and link rows are written in one transaction. Read under the reader's grants and row access,
  on SQLite, PostgreSQL and MySQL. Thread's issue list shows and filters its labels.
- **Person rows for new accounts.** `auth.me.create: { name: 'full_name' }` makes a new account's row on its
  first signed-in request, after sign-up, an invitation or a first single sign-on, once; `tablewalk check`
  requires the email column unique and every other required column a default. Not yet in a tenant App.
- **A command may read above its caller, said out loud.** `elevate: { read: ['rate_card'] }` names the tables of
  `read` a command reads under its own authority, so a role granted it need not read them; the caller sees only
  the declared output, the App API still requires the role to read them, and `tablewalk check --design` lists
  every elevation.
- **A list over a table your role cannot read** says it is not available to you, not "Fix the query above".
- **One reading of a stored time, on every database.** A timestamp that carries its zone (SQLite's `...Z`,
  Postgres's `+00`) is said in the App's `ui.timezone`.
- **A page names the roles that may open it.** A list, dashboard, room, signed-in form or App page takes
  `roles: ['agent', 'admin']`. Anyone holding none of them is never served it: it leaves the menu, ⌘K, search
  and the address book, and its address reads as one that names no view. It narrows table grants and never
  widens them, holds for the App API and tenant Apps, and an unknown role, an empty list, a public form or a
  home that lands a role where it cannot go is refused when the App loads.
- **A top bar by role.** `ui.shell.placement: { top: ['employee'] }` gives a person whose every role is listed
  the top bar, and everyone else the sidebar, so a portal reads as a portal.
- **One search across resources.** A dashboard's `find('How can we help?', ['article', 'catalog_item'])` is a
  big box whose answers come grouped by resource, read under the reader's grants, row access and roles, and
  through the search engine when one is configured; ⌘K and it share one record search. Preview.
- **A card's description.** `cards(..., { description: 'summary' })` draws a body line under the title at the
  card's full width, three lines at most. Commons' shelves describe each board with it.
- **Rollups and dashboard windows over computed columns.** A rollup's `sum`, `min` or `max` may name a computed
  column of its `from` table, and a dashboard section's `over` a computed date; each is compiled inline. A
  computed column that reads a rollup, reads through a reference or says `me` is refused by name.
- **Query strings checked wherever they are written.** A metric's compare and target, a rollup's column, a page
  section's `when`, a custom section's rows, and the whole `when` of an action, notify rule or machine verb (only
  its first word before) are read against their table as you type.
- **An action kept out of the record's header.** `header: false` leaves it out of the action bar and row menu;
  it stays granted and runnable from a queue, a board or `useCommand`.
- **Fixes.** A rows section's disabled sort button no longer tells an App's reader to type in the query
  bar; a form's `now` default reads `2026-10-04 07:21`, as the date field says it; a reference picker's
  placeholder uses the resource's noun; a reference a form opened with shows the record's name, not its key;
  Compass's Postgres fixture gives tasks an identity key and a default priority, so "Add task" starts
  without a startup warning. A reply sent from a conversation's composer no longer opens its command's form beside it while it is in flight. Two browser tests that flaked once on CI no longer do.

## 0.8.6

- **A busy server stays fast.** At 500 simultaneous users (API calls, page loads, real browsers and record
  actions) accepted requests now finish in about 150 ms instead of 10 s, with no errors. An App page is
  validated once per catalog and role rather than on every request (that was a fifth of a busy server's CPU),
  and what a role is served, parsed queries, resolved paths, view catalogs and condition splits are kept,
  bounded and frozen.
- **"Busy" instead of a failure.** When every pooled connection is taken, the server answers
  `503 server_busy` with `Retry-After` within two seconds instead of a 500 after ten. A refused write says it
  was not applied; the client retries reads with backoff and never retries a write silently.
- **Pools sized from the machine.** An App's reader and writer pools default to twice the cores, between 4
  and 16, with never fewer readers than writers.
- **Fewer statements per write.** A database without the schema epoch store keeps its catalog answers for
  five seconds and drops them as soon as a write meets a missing table or column, so a plain write is BEGIN,
  write, COMMIT again.
- **Shutdown is prompt.** Closing the server releases idle keep-alive connections at once, and
  `tablewalk serve` gives in-flight requests ten seconds to finish.
- **Fixes.** A quoted value ending in an escaped quote, or text after an emoji, could be cut or offset when a
  view's query was read; the three copies of that rule are now one. Stylesheets added while a navigation is
  held are waited for, so a page no longer paints unstyled for a frame. A dialog's focus trap stands aside
  for another dialog opened above it.
- **For contributors.** No import cycles, and a strict test keeps it that way; knip checks for dead code on
  every `npm test`; `npm run affected` follows type imports; the browser suite runs against the built client;
  CI shards are packed by recorded timings and a pull request's run fits in about sixteen minutes. A soak
  harness (`scripts/soak`) drives k6-style stages with browser Web Vitals, flame graphs and pool statistics.

## 0.8.5

- **Security: a breakdown request could reach SQL unchecked (0.8.4 and earlier).** A structured `def` sent
  to `/api/breakdown` put its measure function and its date bucket into the query without checking either,
  so anyone allowed to ask for a breakdown could inject SQL. Both are now checked against fixed lists
  (`MEASURE_FUNCTIONS`, `DATE_UNITS`) and anything else is refused. Upgrade if you run 0.8.4 or earlier where
  people you do not fully trust can read.
- **Say it once: the DSL stops asking for what it can read.** A `restated` check warning names what an App
  says that the framework already knew (a label equal to the column made words, `format: 'number'` beside
  `unit`, a currency equal to the App's, `signUp: 'invite'`, `default: true` on the only source,
  `targets: 'none'` beside `public: true`, a command input label equal to its key, a handler that parses its
  own output); one shared column-naming rule serves server and client, so a column `customer_id` is
  "Customer", never "Customer ID".
- **Resources read by default.** Every declared resource reads; only `access: 'write'` writes, and
  `access: 'read'` and the no-access rule are gone (a resource no role should read is left undeclared or left
  out of the roles' `read` lists). `public: true` implies `targets: 'none'`.
- **Smaller forms for pages, events and workflows.** `excludeSelf` is gone: siblings are
  `similar(title, table, { same: [column] })`. A bare `field.choice` value reads as words (all-caps codes stay
  verbatim). An event named alone in `events` carries the output fields of the same names. A workflow is named
  by its key (`name` goes; `version` defaults to 1). An aside's `fields` section defaults to `properties`, and
  a tone map falls back to `neutral`.

- **A list's board and split are keys of the view.** `listView('Deals', 'opportunity', { board: { by: 'stage',
  primary: 'name' } })` and `{ split: { detail: [...] } }` take the options the raw presentations took;
  `presentation: { kind: 'board' | 'split' }` is refused, and a view says one of `board`, `split` and `presentation`.
- **Record branding's version is the row's `version` column.** `versionField` is gone from `fromRecord`; a
  `version` integer column, when the table has one, is the branding's version, and the fresh-read comparison
  holds otherwise.
- **`notify` rules read `when` in the query language.** `when: 'status = received or status = cancelled'`
  replaces `{ status: [...] }` (`=`, `!=`, `in`, joined by and / or); a notify rule's and a fixed action's `when`
  have their first column checked against the table's columns by tsc. The `restated` check also names a
  `display.values` word that a declared vocabulary or a tone already says (`checked_out: 'Checked out'`).
- **Reference fixes.** A nav entry's menu word is `{ to, label }` (the generated reference said `{ view, label }`).

- **Four short forms for the agent that builds an App.** `tablewalk schema --brief` prints one line per
  table (columns with short types, `*` keys, `?` nullable, `{a|b}` vocabularies, `→ table` relations);
  `tablewalk check --brief` one line per problem, `code file:line message — fix: …`, with the exit codes
  unchanged; `tablewalk explain <code>` one screen on a check code from the check-codes page (an unknown
  code lists the nearest); and `tablewalk shot --text` what each page shows (title, headings, table columns and
  row count, actions, empty states, page errors) as text instead of a PNG.
- **The agent guidance costs half the tokens.** The block `tablewalk agent init` writes to `AGENTS.md` is a
  30-line map: where things live, six rules, and which command answers what (`schema --brief` to orient,
  `check --brief` after every edit, `explain <code>`, `shot --text` to verify a page, `shot` only for
  layout). The skill routes to `tablewalk docs <topic>` instead of copying it: its copy of the chooser is
  gone (`tablewalk docs choose` is the one), and the rest is cut to what neither `check`, the types nor the
  docs say, 48.6 KB to 25.0 KB in all; its loop runs on the short forms.
- **A fresh project's first problems are each one line with the fix.** TypeScript is an optional peer at
  `^5.7.3`, so `npm i typescript` installs 5; a TypeScript 7 (no JS API) fails `check`'s typecheck with
  `npm i -D typescript@5` instead of crashing. `check` refuses an App whose package.json is not
  `"type": "module"` in one line (`npm pkg set type=module`); `agent init` and a scaffold into an existing
  project say the same. A commands module without `export default defineCommands({ … })` is told exactly
  that. `tablewalk migrate stores up --app <dir>` now also creates the command journal and the App's event
  store its commands need, and the startup refusals name it. A config's connections win over
  `DATABASE_URL`, which is no longer opened as a second connection beside them (it still serves a start
  with no config, and `"${DATABASE_URL}"` in a connection reads it). `shot` prints the exact browser
  install line, `npx playwright install --only-shell chromium`.
- **A record that is gone says so plainly, and its header breathes.** "This task no longer exists. It
  may have been deleted." starts on the content's edge with a way back to the list, under the heading
  "Task not found" rather than the name the link carried; a record page's eyebrow no longer sits on the
  breadcrumb's rule.
- **The sign-in card is quieter and clearer.** The closed-sign-up line "Accounts are created by an admin."
  and its divider are gone (no "Create account" link already says it); "Continue with GitHub" and "Continue
  with Google" carry their marks; the password's Show keeps its keyboard ring inside the field.
- **Console has Operations and Analytics rooms (preview).** Operations shows an App's jobs
  (scheduled, running, retrying and dead), its event and webhook deliveries, its workflows and its
  store layouts. Dead jobs and failed deliveries can be redriven, and workflows cancelled or retried.
  Analytics shows events by day, the App's declared funnels and simple breakdowns, as counts only.
  Each room answers App by App from that App's own `operations` grant, which gains
  `'jobs'`, `'deliveries'`, `'stores'` and `'analytics'` beside `'workflows'`. Every change
  records the signed-in account as its operator.
- **A tenant App gets what a single App gets, each inside one tenant.** Jobs at times say
  `realm: 'tenant'` (once per active tenant each slot) or `realm: 'platform'` (once, no
  tenant's rows); workflows run, each instance keyed by its tenant, so another tenant's event
  never wakes it; `activity()` feeds are filtered by owner in the history store before their
  limit; signed-in forms create their row in the member's tenant (and, under `auth.rows:
  'policy'`, inside the member's rows). A database holds one tenant App: a second is refused
  by name (`TenantStoreOfAnotherApp`). Public reads stay refused (a visitor has no tenant),
  as do email, mentions, webhook effects and the App API's event feed and generic writes.
- **An App's Export menu offers the columns and CSV only, and a highlighted menu item stays in its row.** JSON and
  "Copy this position" stay in the Workbench; the keyboard ring is drawn inside the item
  instead of across the rules between groups.
- **Form controls in one column are one size, and a date is never clipped.** A typeahead no longer
  starts left of, and runs wider than, the inputs, selects and dates around it (each field's `1fr`
  column took the box's minimum width; it is `minmax(0, 1fr)` now), a date field keeps room for
  its whole value beside the calendar button, and a dialog's buttons stand 8px apart.
- **Each look has its own softer focus ring.** The ring was the accent, which in Sage (and Mono, Canvas, Ink,
  Tray) is near-black and drew a heavy outline. A palette now has `focus`: a mid-tone tint of the look's hue, at
  least 3:1 on the page, panel and subtle ground in light and dark (checked at startup for a custom theme). It is
  the accent where a theme sets none, and follows an App's own accent.
- **Widgets in one dashboard row are one height.** A metric with a target bar no longer
  ends above its neighbours: cards stretch to the row, and a trend or target sits on the
  card's bottom edge.
- **The App DSL is inventoried and consolidated.** `test/fixtures/public-surface.json`
  lists every public key, helper and value, and `test/public-surface.test.ts`
  fails on a rename or removal once the DSL freezes at 0.9.0. Before that, one
  word per idea: `statusCheck.shows` and `statusCheck.stepUp.shows` are `show`;
  `resources.*.form.visibleIf` is `form.when`; a validation rule's `if` is
  `when`; a landing page's `hero.headline` is `hero.heading` (and the
  `ui.theme` `fromRecord` field and its `{headline}` placeholder are `heading`);
  `onlyOn` is gone from App pages, which always read their own connection.
  Compatibility policy draft in `docs/compatibility.md`, adopted at 0.9.0.
- **The helpers are the only spelling.** A view, a dashboard or page section, a list
  presentation, a page and a resource action are each made by their helper (`listView()`,
  `checklist()`, `page()`, `action()`, …); a raw object in their place is a type error that
  names the helper, and `check` names the helpers for a shape it does not know. What a helper
  returns is unchanged, so `app.json` and a build carry the same plain objects. The samples,
  the scaffold, `new --api`, the skill and the docs use the helpers throughout.
  `listView('issue')` takes the resource's own label, and a mistyped table in a helper is
  said beside the real one (`'"ordrs"' is not assignable to type '"orders"'`).
- **One App, its own spelling, fewer refusals.** An App bound by a root `connection` whose name
  is an identifier has that source by that name, so the API's generic writes serve it as they
  serve one bound by `sources` (a name that cannot be a source's is told how to write one). An
  exposed command's output may hold `text({ max, pattern })` and `date()`, published with
  `maxLength`, `pattern` and `format: date`. A workflow's `waitFor` timeout may come from the
  start event; `check` records it as `dynamic`. A funnel id and a custom analytics event are
  spelled as a view id is (`'compare-opened'`), and the landing is a funnel's view step.
  `display.unit` needs no `format` on a numeric column. An API sort may be a nullable column,
  its nulls last both ways on every dialect. A role's `fields` may narrow only `write`.
  `[role-cannot-read]` no longer fires for a role only the API or a job principal holds. A
  scaffolded list's tabs end with All, and an App scaffolded from a URL without `--name` is
  named after its database.
- **A command action's `when` is its command's.** A button that runs a command is shown where the
  command's own `when` holds, so the two can no longer drift apart; `when` stays on `set` actions. The served
  action carries the command's condition. A verb of a state machine is offered only from the states its
  graph lists: a new lead no longer shows "Convert to application", which the command already refused.
- **A command's `when` is query-language text.** `when: { status: ['open'] }` is `when: 'status = open'`;
  one spelling of one condition.
- **A command's revision is its `version` column.** `versionField` is gone: a target's non-null integer
  `version` column is the revision a command checks, and without one the row digest is used, as before.
- **`defineEvent(name, shape({ … }))`.** An event's fields are the keys of its payload shape; the separate
  `fields` list and the hand-written parser are gone.
- **`query` holds conditions, `sort` holds the order.** A sort, show or limit clause inside a `query` of a
  list view, a tab or a dashboard section is refused (the query bar and an address keep them); a tab takes
  a `sort` of its own beside its `query`.
- **One duration spelling, one parser.** `'<n> <unit>'` (seconds to weeks) everywhere a time span is
  written: a dashboard's `refresh` (`'30 seconds'`), a saved form's `resume.after`, an experiment's
  `conversionWindow` and `deliveryGrace`, a funnel's `conversionWindow`, a machine timer, a workflow's
  waits and an `hmac()` window. `'5m'`, `'30s'` and the `…Hours` keys are gone.
- **A form's `show` is derived from its `groups`,** as it already was from its `steps`; writing both is refused.
- **A record page is called by its resource's `noun`.** `page('Pay statement', 'payment', …)` is
  `page('payment', …)`, and the page's name and the New form's agree.
- **One footer.** `ui.footer` is the footer the landing draws too; the landing's own `footer` is gone.
- **One link key, `to`.** It takes a view id or `appLink()` on a nav entry, a note's action, a headline's
  action, a metric, an empty state's action, a hero action and a first-run step (`{ title, text, to }`,
  as a landing's steps read). `home[].view` still chooses and does not link.
- **A command group's words are `description`,** as a form group's are; `help` stays on a single input.
- **A dashboard section names its table `from`,** as page sections, rollups and custom reads do. The
  helpers still take it positionally.
- **A tone says its values as words.** `values: true` is gone: a column with a `tone` reads `IN_REVIEW` as
  "In review" without it, and `values` is a map of your own words.
- **Validation is conditions.** `{ must: 'close_date >= created_on', when?, message }` replaces
  `kind`, `field`, `operator`, `other` and `value`: one condition language, with a column compared with
  another column beside a number, date or flag. `x is not empty` requires a value, blank text included.
- **The inventory lists a repeated shape once.** A message that may be translated, a link target, a
  component declaration and the keys every kind of a section list shares are one entry each in
  `test/fixtures/public-surface.json` (1,957 DSL entries became 1,447), so one rename fails one entry.
- **`tablewalk shot --scale <1-3>`** sets the device scale (default 1), so a
  screenshot at 2 is sharp without the page laying out differently.
  `--width <px>` (320 to 2560) sets the window's width in place of the desk's or the phone's, and a
  clock pinned by `TABLEWALK_CLOCK` is the page's too, so the docs' pictures (`scripts/docs-shots.mjs`,
  every seed and the server on one day) are the same on any day they are taken. The check code
  `component-colour` is `component-color`.
- **Store upgrades.** `tablewalk migrate stores status|up` moves each of
  tablewalk's own stores (sign-in, history, journal, flags, events, deliveries,
  jobs, workflows) to its current layout; serving never migrates and a store
  behind its layout refuses to open and names the command. Each App has its own
  event, delivery, job and workflow stores (PostgreSQL event store v3, delivery
  v2, jobs v2, workflows v2), and MySQL stores carry a schema epoch. `tablewalk flags` and
  `tablewalk experiments` `upgrade-v1-to-v2` are removed.
- **Inbound webhooks.** The `--jobs` module declares inbound endpoints that
  verify a signature over a signed timestamp, which `hmac()` requires, and run
  a command with an idempotent receipt (tenant Apps refuse them; suites allow
  them). `envelope: false` hands the handler the raw
  body. Keystone's lender receives its credit result this way.
- **API-only Apps (preview).** `tablewalk new --api <name>` writes an App that
  is only an API: a table in its own SQLite file with the journal and event
  store provisioned, a command that emits an event, the App API and MCP
  declared, and a README with the token recipe and a curl walk-through. It
  passes `check` as written. The site's [Build an API](site/src/content/docs/docs/build-an-api.md)
  page (`tablewalk docs build-an-api`) walks through it.
- **Generic writes.** `expose(fields, { create, update, delete })` opts a
  resource into writes from the API, off by default. Each is a command the
  platform defines (`create-<resource>`, `update-<resource>`,
  `delete-<resource>`) on the existing command routes, with receipts,
  `Idempotency-Key` replay, the 403/409/410/422 refusals and OpenAPI. It runs
  under the token's roles' own editor rules: field ceilings, validation,
  transitions and stamps. `check` refuses misuse (`api-write-unsupported`,
  `api-write-field`, `api-write-no-role`, `api-write-name-taken`).
- **The event feed.** `api.events` names the command events the App serves at
  `GET …/v{n}/$events`, oldest first behind an opaque cursor. Each event is a
  token operation, `event:<name>`, and a token sees an event only about a
  record its roles read. The feed says nothing of who acted. `check` refuses an
  unknown event (`api-event-unknown`) and a tenant or row-policy App
  (`api-event-unsupported`).
- **AsyncAPI 3.** `GET …/$asyncapi` (narrowed to the token's events) and
  `--export asyncapi` (the whole surface: feed events, the webhooks commands
  post to and, with `--jobs`, the signed inbound endpoints) describe the App's
  event-driven side beside its OpenAPI document.
- **Depot has an API.** It serves its catalog and stock, a supplier's contact
  details (a generic update), the dock's `shipList`, and `order.shipped` on the
  feed. Its seeds provision the event store.
- **Workflows (preview).** `tablewalk/workflows`: durable multi-step processes
  with waits, retries and a lock on their step lines, checked by `tablewalk check`
  and run on SQLite or PostgreSQL. An operations room lists, cancels and
  retries one App's instances, and keeps who cancelled or retried each one.
  Keystone's credit decision is one.
- **Behavior analytics and OpenFeature (preview).** An `analytics` key declares
  what an App collects and its funnels, in a store you own, with a beacon and
  an HTTP sink and `useAnalytics`. `tablewalk/openfeature` serves App flags to
  OpenFeature clients.
- **Suites.** An App in a suite keeps its keyed and saved forms,
  notifications, command events and effects, jobs, search, analytics and
  declared read API, each on its own stores; the refusals that remain give
  their reasons on the suites page. OIDC is the suite's shared identity, with
  grants derived from claims, which count only for a session that provider
  opened (in a single App too: a password session of the same account no
  longer keeps roles the provider gave). Sign-in state (status-check lockouts and
  step-up sessions) is shared through the rate-limit cache switch (Valkey) and
  falls back to the process.
- **Role labels.** `auth.roles.<id>.label` names a role for people; `check`
  warns `[role-label]` when it is missing, and the sample Apps carry labels.
- **Quality gates.** Web Vitals now gate CI, `release.yml` waits on a
  `ci-green` job for the tagged commit, and `scripts/delay-proxy.mjs` measures
  an App over a slow link.
- **Fixes from building the Keystone Apps.**
  - A tenant policy that does not load says why on the console (`because:`),
    as a row policy does: the unknown key, the ownership rule, the missing
    callback, or the module's own error and line.
  - A commands or jobs module that does not load says why on the console, and
    a declaration error in a commands module is said as itself, no longer as
    "could not be loaded".
  - A command refused as `invalid_result` records why for the operator in
    every case (a key that matched several rows, a saved result that no longer
    fits the output, events that could not be made).
  - A rollup query that says `me` is refused by `check` and the types, where
    it counted against the letters "me".
  - A dashboard whose sections keep their own window calls the unpicked
    window "Default", not "All time".
  - A queue, cards or checklist titled by a reference says the record's name,
    not its key; a card's "View …" says the resource's `noun`; an App's home
    crumb says the App's home, not "Schema".
  - A board or calendar titled by a reference says the record's name, not its
    key, as the queue, cards and checklist do.
  - The bootstrapped admin is named from its email ("Margaret Hollis").
  - Docs: tenant Apps have rollups; a granted fixed action works under a row
    policy, on the principal's rows.
- **Query strings are typed.** With a generated `tablewalk-schema.d.ts`, a view's or tab's `query` and
  `sort`, a dashboard's or page's `query` and `by`, a rollup's `query`, a command's `when` and a reference
  field's picker query are read against the table's columns: a misspelled column, an unknown operator, or a
  value outside a column's vocabulary, kind or date phrases is a type error on the string, and the error names
  it (`` `amout` is not a column of opportunity ``, `won is not a value of stage: …`). The generated file
  now carries `Columns` (each column's kind or declared values) and registers it. An unquoted value with a
  space says to quote it and shows the quoted form: `status = "in progress"`.
- **DSL gaps closed before the freeze.**
  - A column whose values are a declared vocabulary (a text column's
    `CHECK (… IN (…))`) sorts in the order it was written, on every engine, in
    lists, the column menu, keyset pages and the API. Free text still sorts as
    text, and a native enum already sorts this way.
  - A fixed action's `set` takes an expression, as a computed column does:
    `computed.date('today + 14 days')`, `computed.date('now + 1 week')`, worked
    out on the server in the command's transaction. `check` refuses one that
    does not parse, reads a column, or does not fit the column's type.
  - A card without a `title` is titled by the resource's `recordLabel`.
  - Measures: `median amount` (PostgreSQL; `check` refuses it on SQLite and
    MySQL with the reason), and computed measures: aggregates and numbers
    joined by `+ - * /` (`sum won / sum amount as rate`), a zero divisor giving
    an empty value. A metric's `target` is a number or a goal read from data:
    `{ table, query, measure }`.
  - An App's own input component draws an input inside a command's input
    group, named by its path (`trade.vin`), in forms and command actions.
  - One way per thing in forms: a saved form's step `id` defaults to its
    label's slug as every other step's does; a headline action's `presets` is
    `defaults` and a related create's `fill` is `prefill`, the words the
    rest of the DSL uses for those ideas.
  - The types refuse a command's `initial` that returns a value as
    `undefined`, and a page `header({ primary })` whose id is not a literal.
- **Docs and samples.** The site is seven groups: Start, Learn, Build an App, Database browser, Run it,
  Test and measure, and Reference. Each how-to page opens with its purpose and a working example cut from a
  sample App (or the command or `tablewalk.json` entry the task is), and says what you will see, when to use
  it, the common mistakes and where to go next; a test holds every page to that shape. The DSL reference
  (`tablewalk docs app-dsl`, then `dsl-views` and its siblings) and the command-line reference are generated
  from the schema and the help text, so a key or flag cannot ship without an entry, and the pictures are
  regenerated from the sample Apps and the database browser on a pinned day (`scripts/docs-shots.mjs`). The
  glossary links each term to its page. The sample Apps, scaffold and agent skill use only current keys.
- **The database browser, running an App, and testing it have pages of their own.** The browser's
  one page is four: Walk a database, Query language, MCP for coding agents and Keyboard. Run it
  starts with Connections and services (PostgreSQL first); Operations and Observe are one page,
  and the check steps, `--json` and codes are one, where each problem's `docs` link now lands on
  its code's row. Each page opens with its purpose and an example, and ends with common mistakes
  and where to go next; the long contracts moved to `docs/suites.md`, `docs/experiments.md`,
  `docs/service-virtualization.md` and `docs/performance.md`.

## 0.8.4

- **Console targeting and experiment workflows.** Targeting rules, percentage
  rollouts, scope context, readable history and revision-checked restore. A wider
  flag workspace and responsive detail layouts use improvements in the public
  UI components; mobile detail portals preserve their component styles.
- **Experiment analytics (AN2 preview).** Explicitly provisioned PostgreSQL
  results storage, immutable epochs, actual-use exposures, committed-event
  conversion delivery, binary metrics and guardrails, fixed-window results and
  evidence-bound winner decisions. Separate source provisioning and durable
  exposure obligations keep missing delivery visible. Visitor identity requires
  explicit interaction and stays separate from native account identity. Public
  visitor conversions currently use ordinary App commands; tenant public-intake
  and platform conversion events still require a journal extension.
- **Typed service virtualization.** `tablewalk/testing` and `tablewalk virtual`
  provide local HTTP/JSON services with typed handlers, request matching,
  isolated state, controllable time, seeded randomness, scenarios, delays and
  faults. Unexpected requests and failed verification fail teardown.
- **Public App testing helpers.** Disposable workspaces and App/suite hosts,
  independent HTTP clients, account and grant helpers, authorization matrices
  and runnable API/browser examples. Test hosts reject non-loopback TCP
  connections by default and report attempted violations at teardown.

## 0.8.3

- **Basic flags and Console (preview).** Typed App flags, `useFlags` presentation
  reads and server command `enabledBy` gates. The opt-in suite Console uses the
  public sidebar DSL with Sage and supports read, fixed-value set, kill, history
  and revision-checked revert. Console admission is separate from scoped
  target-App flag capabilities. PostgreSQL control storage requires explicit
  `tablewalk flags provision --suite <suite.json>` or
  `tablewalk flags upgrade-v1-to-v2 --suite <suite.json>`; serving never migrates.
  Advanced targeting/audience editors and AN2 analytics remain deferred;
  allocation and experiment declarations are foundations, not a complete
  experiment lifecycle. Suite experiment configuration is rejected at serve
  and the experiments CLI is unavailable in this preview.
- **Several Apps, one process.** `tablewalk suite <suite.json>` serves explicitly
  configured Apps at root and subpath mounts, with App-owned connections,
  policies, commands and jobs. Startup captures each App's environment; shutdown
  drains accepted work before closing its stores.
- **Shared suite sign-in with independent App access.** Optional suite identity
  provides one email/password account and cookie, persisted per-App role grants,
  operator administrator bootstrap, an authorized chooser and coordinated
  logout. App administrators can issue audited, one-time invitations bound to a
  stable account ID. Tenant memberships, administration, invitations and support
  retain their App's authority. Identity and grant storage currently use separate
  SQLite files.
- **Keystone in one process.** `examples/apps/keystone/start-suite.mjs` provisions
  the six-App demonstration with explicit account grants and tenant memberships.
  Dealer and Customer policies use their App's connections and stable account
  bindings. The acceptance journey submits a dealer's deal and reads the same
  application in the lender App.
- **Suite navigation and administration.** Explicit App switching, an
  account-persisted default App, checked cross-App links and scoped grant
  administration. Following a link checks the destination's current authority;
  choosing another App does not change the saved default.
- **Tenant storefronts and public placement.** Authorized, request-scoped branding
  can follow an enrolled storefront host. Public reads stay within published
  rows, and placed intake rechecks eligibility inside its transaction. Dedicated
  journals support bounded receipt recovery after placement or handler changes.
  Keystone's launcher provides an explicit additive placement upgrade.
- **App and Workbench boundaries.** App records use their authored pages without
  exposing the Workbench inspector. Workbench appearance is independent of App
  themes; record Back and previous/next controls use quieter styling.
- **Counts match their destination.** A dashboard metric targeting a list
  includes that list's standing filter, and its first tab when no metric query
  is supplied. Comparisons and time windows preserve the same cohort.
- **Authoring and test reliability.** Opt-in strict design checks, more actionable
  build/type-drift diagnostics, release-aligned packaged documentation and guarded
  operation guidance. Browser fixtures reuse closed seed snapshots with isolated
  writable copies; visual setup batches independent sign-ins.

## 0.8.2

- **Sign in through your identity provider.** `auth.providers: [oidc('workforce')]`
  signs people in through any OpenID Connect provider the config file names
  (`{ "kind": "oidc", "issuer", "clientId", "clientSecret": "${…}" }`): Entra ID,
  Entra External ID and B2C user flows, Okta, Auth0, Keycloak. PKCE, state and
  nonce; the ID token verified against the provider's keys, issuer, audience,
  age and nonce; only the ID token kept. A role's `from: { groups: [...] }`
  gives it from the token's claims at every sign-in, audited in the account
  history and recorded in authority.lock; a sign-in its claims give no role is
  refused with a sentence. `signUp: { providers, domains }` makes accounts at a
  first sign-in. A provider's address links to an existing account only when
  verified, and ends what an unverified account held. A step-up counts from the
  provider's own authentication, with more than one factor where it demands
  it. A tenant App's `oidc.tenants()` sends a work email to its tenant's own
  provider, which asserts only its domains (`tablewalk docs identity-providers`).
- **Writers that scale.** An App writes through a pool of writers per
  database (`"pool": { "write": n }`, `--write-pool`, 4 by default): same-record
  commands within one process enter in arrival order, while writes to different
  records run side by side, a job's command writes through a connection of its own,
  and App editors send the values they showed to detect conflicting saves.
  Direct API writes without expected values remain unconditional assignments.
  MySQL gets the same pool. A write waits at most `--lock-timeout` (5 s) for a row another
  transaction holds and is then refused, nothing applied, with 503,
  `Retry-After` and `row_locked`; a migration gives up its lock wait the same
  way and tries again. An App has no Undo: a change is corrected by another
  change. The database browser keeps one writer, one write at a time, and
  its Undo.

- **One command definition.** Server-only `defineCommand` declares inputs and
  behavior together; manifests reference command names, and `tablewalk check`
  generates their types. Contract versions are derived and recorded in
  `authority.lock`, with explicit bumps for published changes. Records without
  a version column use a digest including binary contents. App API and MCP
  clients can prepare a command to obtain that record revision.
- **State machines and scheduled jobs.** A resource's machine describes its
  states and verbs, supplies action IDs and enforces valid moves across write
  paths. State timers reject work from an earlier stay in the state. Jobs can
  run at intervals or on cron schedules, with durable claims and explicit
  missed-slot behavior.
- **First paint in the document.** Eligible first-room reads travel with the
  HTML, bounded by time and byte limits and tied to the current account.
  Unsupported or over-budget reads use the normal request path. Private row
  policies retain private, no-store responses.
- **A tighter App DSL.** Actions have stable IDs; computed columns participate
  in SQL reads; `check --json` supplies structured diagnostics. Display,
  sorting and record-page authoring use the consolidated helpers and types.
- **Keystone example project.** Six apps share a PostgreSQL business database:
  lender, tenant lead desk, dealer settings, public dealer site, marketplace
  and customer portal. A local launcher mounts them under one host while each
  keeps its own authentication and policies. Ignition and Forecourt remain
  regression fixtures; public guides now lead to Keystone.
- **Deployment and diagnostics.** Root and subpath mounts, a development
  observer, OpenTelemetry configuration and versioned SQL migrations join the
  deployment tools. Record pages compose their initial reads in one request;
  catalog caching and client layout fixes reduce repeated work and shifts.

## 0.8.1

- **An App serves only what it declares.** A table an App doesn't declare
  answers exactly as a table that doesn't exist, on every endpoint, signed in
  or not, with or without roles. There is no Workbench inside an App: its
  menu, key, builders, layouts and saved pages are gone from App mode, and
  `--mcp` refuses an App (`--app-mcp` is the App's own MCP). The standalone
  browser (`npx tablewalk <db>`) keeps the Workbench.
- **Hidden columns.** `resources.X.hidden: ['password_hash']` keeps a column
  from every reader, with or without sign-in; a connection can hide columns in
  tablewalk.json (`"hidden": { "account": ["password_hash"], "*": ["*_token"] }`)
  for the Workbench, MCP and every App on it. A hidden column is cut from what
  the server answers, a filter or sort on it is refused, raw SQL is refused on
  that connection, and history redacts it.
- **References without foreign keys.** `references: { col: { to, column } }`
  declares a soft key: grid names, links, related lists and rollups follow it.
  Within one source it joins; across sources it's read in one batched lookup
  through the target source's own reader, so its row scope, grants and hidden
  columns apply. References work under row policy and tenancy.
- **A source per schema.** `sources: { settings: { connection, schema } }`:
  one database, several sources, each scoped to its schema, with writes,
  journals, Undo and search in the right place. `resources: 'all' | [...]` on a
  source replaces empty `{}` blocks, and an App may have no default source, so
  every name stays `source.table`.
- **Forms that say what they want.** A resource's form takes `form.fields`
  (`label`, `help`, `placeholder`, `multiline`), draws the input the column
  calls for (radios or a list in words, a switch, date and money fields, a
  textarea), groups fields in described sections, opens as a drawer or a
  centered page (`open`), defaults to `today`, `now` or `me`, narrows a picker
  by an earlier field (enforced at the server), and a related list's New fills
  in the parent.
- **Public forms saved on every step.** A public multi-step form writes each
  step to the App's real tables behind an opaque, HttpOnly draft cookie; the
  server never shows what was typed back, the review is drawn from the page's
  own memory, and leaving is guarded. A form's reply is a receipt and a
  message only; receipts are random. `statusCheck` answers an applicant's
  status by receipt and confirming details (every wrong answer the same, with
  lockout and a staff alert), with an emailed code for more; `link` attaches
  an application to an account on the same device, through the status check,
  or by a verified email. Saved forms work on tenant Apps.
- **Record pages in one anatomy.** `header({ status, facts, primary,
  destructive })` names the record with a status chip, a facts line (a word
  before or after a value) and one filled forward action, destructive verbs
  last and quiet; `current()` shows the one child that matters now; rollups
  reach two tables away. A resource with no page opens on this anatomy.
- **Email.** An `email` service in tablewalk.json sends over SMTP (or to a log
  file): notices by email (`notify` with `email: true`, with an opt-out per
  person), `@mentions`, sign-up verification and password resets. Mail is
  queued with the change and sent after commit, with retries.
- **Tenant Apps catch up.** Record history, notices, CSV import, custom
  components, rollups and saved public forms work on tenant Apps, scoped to
  the tenant. Tenants are called by name, references show names instead of
  composite ids, breakdowns name their buckets, and tenant and lender lists
  have canonical `?tab=` addresses.
- **Undo in an App's confirmations.** After an insert or a delete, the toast
  offers Undo to the person who made the change while the row is unchanged
  and their grants still allow it; a delete that cascaded offers none.
- **Faster, especially over a remote database.** A snapshot begins in one
  message and answers before its commit; the catalog is described again only
  when it moved; a store is attested in full once per transaction, and a
  session's admission is reused under strict invariants. On Ignition, a warm
  record page went from about 590 to 213 ms locally and 3.3 to 0.9 s with the
  database 20 ms away. Lists page by key, costly SQLite reads leave the event
  loop, jobs wake on commit (PostgreSQL LISTEN/NOTIFY), MySQL reads are
  pooled, public pages are compressed, and a filter rail sends one request.
- **Looks own their shape.** Menus, lists, popovers, toasts, dialogs and cards
  take their corners, shadows and focus ring from the look; Mono is square
  and flat. A test refuses a hard-coded corner or shadow. Each look's
  stylesheet loads only when it's worn. Sage and Signal tables are open.
- **An App's column menu is short.** At most: two sorts worded for the column
  ("A → Z", "Newest first"), Filter… (one control fitted to the column,
  shared with the filter rail, rarer conditions behind "More conditions"),
  Clear filter, and Pin column. Filters read in words everywhere in an App
  ("Status is not Done"); hidden and masked columns never show a value.
- **Display.** Charts run in date order, values read as words (`values`,
  `humanize`), `format: 'masked'` masks a value (presentation only), long
  tokens collapse, card facts take labels, a TEXT column can be a date on
  SQLite, 0/1 flags read Yes/No, a reference column shows its record's name,
  and related lists beside the aside drop columns rather than clip them. The
  aside is a third of the record, so a side menu fits three figures and four
  columns at 1280.
- **Build Apps with an agent.** A `tablewalk` agent skill ships in the
  package; `tablewalk agent init` installs it for Claude Code, Codex, Cursor
  and Copilot. `tablewalk docs <topic>` prints the shipped reference offline
  (also served over MCP), with a composition guide per page type.
  `tablewalk shot` screenshots an App's pages; `tablewalk check --design`
  warns on 20-odd design smells with the fix to write. The scaffold drafts a
  look, a top menu, headers, rollups, worded values and grouped forms, and
  comes out clean.
- **Authoring.** `tablewalk check` reports every load error in one run,
  regenerates types even when the App fails to load, keeps the App's rollups
  in them, and points each error at a docs topic. Scaffolding qualifies table
  names two schemas share and skips Liquibase and Flyway tables. `apps[].env`
  passes named environment variables to an App; `--app-entry` swaps the entry
  file; `tablewalk build` builds an App that reads them.
- **Interface copy in one catalog.** The platform's own words live in a typed
  catalog, shortened in the production build, and a lint refuses new
  hard-coded text.
- **Security.** An account-administration audit trail in both auth stores,
  written in the change's own transaction. Command field authorization, and
  action grants under row policy. Tests can't reach the developer's config
  home. See SECURITY.md for the caches' invariants.
- **The site is at [tablewalk.dev](https://tablewalk.dev).** Every link in the
  package and the docs points there.
- **Samples.** Every sample App comes out clean under `check --design`.
  Ignition's financing form is saved on every step, and the lender has a page
  of its own for an application. The sample seeds carry the indexes they need.

## 0.8.0

- **Button and Field primitives.** `Button` (primary, secondary, quiet,
  danger; three sizes; a busy state that keeps focus) and `Field` (label over
  the control, hint and problem under it, wired into `aria-describedby` and
  `aria-invalid`) draw sign-in, command forms, prompts, confirmations and the
  account profile, with a story for every state. Every form control is one
  36px field in every look; the typeahead is one box.
- **Sign-in and dialogs.** Sign-in says what is wrong beside each field,
  links back to the App's public pages, fills a phone, and offers "Forgot
  password?": with `TABLEWALK_AUTH_RESET=log` a one-time, one-hour reset link
  is written to the server log only and a reset ends the account's other
  sessions; without it the screen says an administrator resets passwords.
  Form and dialog actions sit under the fields, full width on a phone, where a
  full-screen dialog keeps them at its foot; a guided form draws no Back on
  its first step.
- **The looks hang together.** The top bar marks the current page once, inside
  the bar. Record tabs are in sentence case outside Mono; Mono underlines its
  links. Nothing takes a colour by position, and an App's accent is its charts'
  first colour. Mono stays square when an App sets a radius. Every room shares
  one content edge (`--room-inset`) and every App one phone gutter. Sidebars
  have one heading style, aligned current fills, a fade when they scroll and
  asides the page's length. The browser tab reads "Leads · Compass"; an App
  without a logo shows its initial; search is a labelled box and settings sit
  behind a gear. Avatars and loading placeholders are visible on every card.
- **Lists, grids and boards.** A list that fits one page draws no pager; past
  one, its range with Previous and Next — and cards, queues and checklists now
  page at all. Grids keep the row's name readable before other columns grow,
  and a dashboard's list drops columns past its width. Boards count every lane
  over the whole list, so work-in-progress limits are real, load 20 cards a
  lane at a time, give records with no value their own lane, look the same on
  a dashboard and their own page, and snap one lane at a time on a phone.
  Phone summaries are two lines; filters that don't fit on a desk fold into
  "+ Filter"; storefront lists drop operator furniture; the split inbox marks
  its row with a tint.
- **Empty and error states you can act on.** One empty block and one problem
  block, with Try again, offline said as offline, and one failure said once
  per screen. Every page section, dashboard section, room and mounted root
  stands behind an error boundary; the browser suites and `npm run smoke` fail
  on a caught section error and on any CSP violation.
- **A Content-Security-Policy on the shell.** Scripts from the server (inline
  startup scripts pinned by hash), requests to the server alone
  (`connect-src 'self'`), images from this origin, `data:`, `blob:` or https,
  and no framing by other sites.
- **Dashboards and records.** Stat cards stand from one top edge and name the
  period a change is measured against ("vs prior 90 days"); breakdowns,
  donuts and matrices follow the column's vocabulary order, else biggest first;
  line charts keep true-size labels and carry a hidden data table. Default
  fields leave out surrogate keys; email, phone and web values are links in
  Apps (`format: 'email' | 'phone' | 'url'`); a missing reference and partial
  totals say so in words; an ordered workflow strip marks the way travelled.
- **Conditions say `me` and compare columns.** Tabs, view and dashboard
  queries and `when` may compare with `me`, the signed-in person, resolved by
  the server per request — the account's email beside text, and with
  `auth.me: { table, column }` their row beside a reference, so
  `owner_id = me` is "My tickets". `on_hand < product_id.reorder_level`
  compares two columns (before, a path on the right compared with its own
  text and matched every row).
- **Record name templates.** `recordLabel: 'PO-{id}'` or
  `'{product_id.name} × {qty}'` is computed in SQL on every engine, so lists,
  pickers, breadcrumbs and references show, sort and search the same name; a
  table with no name column reads "Purchase order #3".
- **The scaffold and the check read a database the way a person would.**
  Line tables become related lists, not menu entries; tabs lead with All;
  names come from a filled column; paths are relative to the App; `--name`
  names it. `--check-app` warns about literals a number, date or yes/no column
  can't hold and about `= null`; `tablewalk check` places each finding on its
  file and line; a `sort`'s first key is typechecked; `Rows` types an INTEGER
  as `number`. A read-only App no longer asks for Undo history on every page.
- **Accessibility, measured.** The browser gate reads every room with axe in
  every look, light and dark, and fails on serious findings; what it found is
  fixed (board and field semantics, explorer tabs, keyboard reach, contrast).
  Error notifications stay until dismissed and are announced at once; the page
  has one main region and a skip link; small row controls take 44px on touch;
  a calendar month is one Tab stop with arrow-key movement. The startup
  contrast check also measures row grounds, tone chips, the danger banner and
  the focus ring.
- **Fewer requests, a size budget.** A dashboard asks for its breakdowns in
  one request (`/api/breakdowns`); the build checks the first-paint bundle
  against a budget and the built-client check caps a cold visit.
- **Eight sample Apps.** Tick, Thread, Compass, Ignition, Forecourt, Payday,
  and new: Depot (warehouse operations) and Commons (a moderated community
  forum). Parcel, the App over an HTTP API, is now a test fixture
  (`test/fixtures/apps/parcel`) that keeps its browser coverage.
- **One vocabulary for the App DSL.** A metric and a breakdown are one helper
  each, on a dashboard and on a page: `metric(title, table, opts)` and
  `breakdown(title, table, by, opts)` count a dashboard's whole table, and,
  given `whose`, the rows that point at the page's record —
  `metric('Open tasks', 'task', { whose: 'account_id', query: 'status = open' })`,
  `breakdown('Issue status', 'issue', 'status', { whose: 'project_id' })`. A
  page's sum is the same `measure` a dashboard writes: `metric('Open balance',
  'invoice', { whose: 'customer_id', measure: 'sum total' })`. `count()`,
  `total()` and `countBy()` are gone. A dashboard's rows of a table are
  `rows()` and `kind: 'rows'`, where they were `list()` and `kind: 'list'`,
  so `list` means a list view and a page's related rows and nothing else. A
  form's `visibleIf` and a validation rule's `if` are conditions in the query
  language `when` already speaks — `visibleIf: { due_on: 'completed = false' }`,
  `if: 'stage = closed_won'` — read against the record's own values: local
  columns compared with `=`, `!=`, `<`, `<=`, `>`, `>=`, `in` and `is (not)
  empty`, under `and`, `or` and brackets. The `{ field, operator, value }`
  objects and their `all`/`any` groups are gone. The samples use exactly the
  helpers the docs teach: Thread and the others import `page`, not an alias.
- **A fixed action can stamp the moment and the person.** In a fixed action's
  `set`, `'now'` writes the server's current time and `'me'` writes the
  signed-in account's email: `action('Resolve', { set: { status: 'resolved',
  resolved_at: 'now', resolved_by: 'me' } })`. A `DATE` column gets the day in
  `ui.timezone` (UTC without one), a `TIMESTAMP` or `DATETIME` the UTC instant,
  and a text column the email. The server replaces the word inside the write,
  after the action's `transitions` are judged, so a request cannot choose the
  moment or the person. Declare the stamped columns in `transitions` and
  nothing else moves them. Both words are now reserved in a fixed action's
  `set`. `'now'` on a column that is not a date or time, `'me'` on a number,
  key or reference column, `'me'` in an App without sign-in, and any stamp in a
  tenant App are refused at startup. The Payday and Forecourt commands that
  stamp a time or an approver stay commands: their roles have no generic
  write, and Forecourt's also add a history row.
- **Fewer, stronger looks, and Mono is the default.** The built-in looks are
  Mono, Canvas, Iris, Ink, Sage, Signal and the new Tray. Graphite, which differed from Canvas only in
  details, and Coral, whose tinted, side-ruled stat cards were what the design
  system refuses, are retired; Coral's colours remain as Iris's Coral palette.
  An App that names no look, and a custom theme that names no `base`, now
  wears Mono. `ui.theme.preset: 'graphite'` or `'coral'`, and those bases,
  are refused at startup. A built-in look's palettes can now be named by the
  App as well as picked by a reader: `ui.theme: { preset: 'iris', palette:
  'coral' }`, or Signal's Sky, Mint and Lilac.
- **Building blocks that look finished out of the box.** A list's New is
  filled as its primary action; a stat card is as tall as what it says; a
  breakdown's bars are solid quantities; a matrix's row heads are no longer
  ruled like column heads; a line of facts never opens a line with its dot;
  a section's empty note speaks the reader's words, not a table's name; a
  folded section's chevron is drawn rather than a 3px glyph; the landing's
  search box matches the selects beside it; and native controls — checkboxes,
  date pickers, scroll bars — follow dark mode. Mono marks "current" one way
  everywhere, frames its stat cards at a hairline and keeps its label dress
  for column heads, not a row's own values.
- **Public pages read as a storefront.** A signed-out reader of a public
  page sees no record-kind label, no Back, no folding sections and no
  Workbench furniture. A fields section can be drawn as a card —
  `fields('Sold by', [...], { presentation: 'card' })` — naming the record a
  reference points at, a few facts, and a link to its page. A reference in a
  record's fields is a link in the ink, not a boxed chip.
- **A sign-in that looks like the front door.** The form says "Sign in to
  {App}", "Create your {App} account" or "Join {App}", sits a little above
  the middle of the window, lets the reader show the password they typed, and
  keeps its note under a rule instead of in a box.
- **Fields read their state the same way everywhere.** In an App, a disabled
  control is a filled ground and dim ink with no pointer — it looked exactly
  like an enabled one — and an invalid one wears the danger edge beside its
  written problem. A form's controls are 36px tall on the surface colour in
  every look.
- **The stylesheets are layered.** Every stylesheet sits in one cascade
  layer — base, components, kit, look, structure, craft, print — so a look
  can dress anything and can never move layout; the rules that used to win
  by `:root` specificity (dialogs full screen on a phone, the date picker's
  grid, a record's property rail) live in `structure.css`. Proven by
  computed-style snapshots of every sample page and story in every look,
  equal before and after except three rules that had never applied.
- **Grid columns are measured, not guessed.** A column's starting width
  comes from its values measured in the grid's own font, so a column of names
  is as wide as its names, not a guess from their character count.
- **More building blocks, finished.** A record's tabs wear the look's tab
  dress (Mono's inverted label, Ink's underline, the accent pill) instead of
  the Workbench's 10px capitals. Two sections sharing a row share one rule,
  not one each. A breakdown's bars end on one line whatever their counts'
  widths, and its labels get room before the bars do. A line chart's level
  moves aside when the line peaks through it. A section's lone value takes
  the whole row. A ticked flag facet is its own Clear, keeping its count in
  line. A dialog has a minimum width and the look's radius. A board's edge
  fade reaches the phone's edge. Signal's headline and landing primaries are
  ink, as its buttons are. A read-only value lines up with the editable ones
  beside it. On a desk a list's search box narrows before its last filter is
  cut off at the window's edge. A disabled button looks disabled in every
  look. A property rail's captions stop at 12rem. An empty list starts on the
  list's own inset. A JSON table right-aligns its columns of figures. A
  primary over a hero photo keeps an edge on the scrim. A workflow's state
  outside its steps reads "On hold", not `on_hold`, and a repeated group
  numbers its rows "Row 1".
- **A vocabulary's values are words in an App.** A value from a column's
  CHECK or enum vocabulary reads `In progress` for `in_progress` in an App's
  lists, fields and filter facets, as its tone chip already did; the stored
  value stays in the title, and the Workbench shows the data exactly.
  Breakdowns, donuts, stacked bars and matrices say their groups the same
  way. A dashboard's windows read "Last 30 days", and a metric whose own
  query already names its window no longer adds "(all time)" to its title.
  An empty chart or breakdown says "Nothing to draw yet." rather than a
  table's name. On a dark bar the signed-in name is in the bar's ink.
- **Chart colours a reader can tell from the card.** A chart's first four
  series now meet 3:1 against the surface in every built-in look (Mono's
  greys alternate dark and mid, so neighbours differ too), and theme
  diagnostics warn when a custom theme's do not.
- **Payday is a fuller Gusto-style workspace.** Departments, onboarding, a
  company calendar and payroll calendar, pay statements broken into
  earnings, taxes and deductions, time off balances and policies, weekly
  timesheets, benefits plans and enrollments, documents awaiting signature,
  and reports, all from shared building blocks with no App-specific CSS.
- **An App is where the docs say it is.** An App with no `id` is served at
  the slug of its name — `Helpdesk` at `/helpdesk`, as the reference always
  said — not at `/app-helpdesk`; its account store follows the id. An address
  that names no App says so and lists the Apps served, where it used to
  report that the database could not be reached, and startup prints each
  App's address under `Listening on`. An App named or identified `api` is
  refused, since `/api` is the server's own.
- **`--check-app` names what can never happen.** A literal a column never
  holds — a tab on `status = resolvd`, a `when`, a `set`, a form default, a
  tone, a board lane or a workflow step outside the column's CHECK or enum
  values — a fixed action no role may write, and a command action or form no
  role is granted are App warnings at startup, and `--check-app` prints them
  as `warning:` lines under its verdict without failing on them.
- **Command startup errors say the fix.** The missing requirements are named
  one by one with the line that supplies each; the overlap of a command's
  writes with a role's generic writes names the role, the table and the grant
  to change; a missing command journal names `migrateSqliteCommandJournal(path)`
  or `migratePostgresCommandJournal(url)`.
- **The types check what the docs say they check.** Generated schema types
  now carry `References`, where each of a table's references lands, and a
  `show`, a split's `detail`, a queue's, calendar's or card's lines, a
  label, a page's fields and related lists, and a related section's `whose`
  are typed as the table's own columns and label paths, checked hop by hop
  for two hops (`owner_id.nmae` fails with `Did you mean 'owner_id.name'?`).
  The helpers keep the author's literals, so `listView()`, `related()`,
  `rows()` and the rest are checked where they land as a plain object is;
  `listView()` refuses an unknown key; and `action()` names a mistyped
  `set` column even beside a good one. `TypedAppConfig` takes the
  references second: `TypedAppConfig<Tables, References, Connections>`.
  `tablewalk check` hints which table a path was judged against. A list of
  names kept in its own `const` needs `as const`.
- **Smaller authoring fixes.** A command whose handler returns nothing may
  leave `output` out. A `ui.logo` refusal names `logo`, not `icon`. A landing
  whose only call to action is `signIn()` typechecks in its own module. A
  related list's wrong `whose` is named as not a column, or not a reference
  to the record. A money range in a list's filters uses the App's
  `ui.currency` when its rule names none. The MCP `scaffold_app` tool points
  agents at `app.ts`, and `validate_app` describes a page by its real keys.
- **What building Payday found.** A line of facts, a card and a sheet name
  the record a reference points at instead of its key, and a reference read
  through another (`employee_id.department_id`) is named the same way, in
  page fields and related lists. A display rule's `subtitle` on a column
  shown through a reference (`employee_id.name`) reads that record's column,
  not the host row's, or is left out. A page metric's sum narrowed by `query`,
  or reached through more than one reference, is measured over the rows the
  list beside it shows instead of refusing at runtime after `--check-app`
  accepted it. A toned figure keeps its format and unit (`104 h`). A bulk
  command's label that names its record counts the selection ("Approve 2
  timesheets"). A chart's and a matrix's months read "Jan 2026", "Feb" in the
  App's locale instead of `2026-01`. And a command can refuse in the reader's
  words: `refuse('Quinn has 0 h of Personal left')` is `ineligible_state`
  with that sentence in the command form and a selection's report.
- **Calendars of ranges.** `calendar(date, primary, { end })` draws a record
  from its first day to its last as one bar, continued across week rows and
  moved whole; `primary`, `lines` and a new `badge` (a status as its tone) may
  name a record through one reference (`employee_id.name`). Payday's Who's out
  drops the text column it kept for the calendar's sake, and its payroll
  calendar shows each run across its pay period.
- **Compact queues and aside lists.** A queue row is the title and its badge on
  one line, its lines and facts on one wrapping line, the action at its end,
  so it fits half a dashboard. Rows in a dashboard's aside draw names, a
  quiet line and a trailing value instead of a cut-short table, and shows at
  most three columns.
- **Related lists and metrics say more.** A related list takes `empty: false`
  (left out while it has no rows), `totals` (the list view's footer of sums,
  over every related row) and `same` (a second key shared with the page's
  record). A dashboard metric's `view` opens that list, the whole card a link
  marked by an arrow.
- **`tablewalk check`: the authoring loop in one command.** `tablewalk check
  --app <dir>` with the App's database regenerates `tablewalk-schema.d.ts`
  when the database has changed (saying which tables), typechecks the App
  with its tsconfig — errors said as `file:line`, the actual mismatch and, for
  common DSL mistakes, a hint — and runs `--check-app`, warnings included.
  Each step has its own verdict line and exit code (2 types, 3 typecheck,
  4 validation). The agent guide now names it as the command to run after
  every edit.
- **The scaffold writes a project in the samples' style.** `--scaffold-app`
  now writes helper-built TypeScript — `defineApp`, `listView`, `dashboard`,
  `page`, `fields`, `related`, `tones` — across `app.ts`, `resources.ts`,
  `views.ts`, `dashboard.ts` and `pages/`, with `tablewalk-schema.d.ts`, a
  `tsconfig.json`, a README and, outside a tablewalk checkout, a
  `package.json`. Lists say their table's plural with an icon, read references
  by name and leave out ids and versions; short CHECK vocabularies get tones
  and status tabs; each main table gets a record page with grouped fields and
  related lists; the Overview counts each main table and breaks the busiest
  down. The draft passes `tablewalk check` as written. `--ts` and `--mjs` are
  gone, and the `scaffold_app` MCP tool returns the same files.

- **Custom components (preview).** An App can draw what no built-in section
  does with its own React module. `component('payroll-timeline', { module:
  './widgets/PayrollTimeline.tsx', props })` declares it by path; `custom('Pay
  history', comp, { record, rows, props })` places it on a page or a
  dashboard, and a `kind: 'value'` component stands where a display rule
  does. A section's reads are declared, planned like a related list's,
  checked at load and authorized on every request; dashboard reads follow the
  window and filters. Modules compile with Rolldown (an optional peer, needed
  only by an App that declares components) on load and on save, and
  `tablewalk build` writes a `components/` graph pinned to its version. Each
  module's CSS is served in `@layer components`, scoped to its element, and
  the page's React is shared through a hashed import map. New `tablewalk/ui`
  (a kit, data, navigation, format and look hooks, `SectionProps` and
  `ValueProps`) and `tablewalk/ui/testing` (`renderSection`, `renderValue`,
  `fixtures`); React and Testing Library are optional peers for authors who
  write and test components. `tablewalk check` adds a components step that
  fails on markup or code from text and on server-environment access (exit 5) and warns on literal colours and radii, long or unguarded motion,
  shadows and unprefixed classes. Components are not drawn on public
  surfaces or in tenant Apps yet. Payday's pay run shows a Pay history
  timeline, and the roadmap now scopes its "no arbitrary scripts" line to
  definitions.
- **Canonical App addresses.** Every record, list, dashboard and form of an
  App has one address: a record is its id under the view that shows its
  table (`/compass/leads/127`), so following a reference opens the target's
  own address while Back and the breadcrumbs still retrace the walk.
  Dashboards are their key with `?period=`, a list's search is `?search=`, a
  dashboard's drill opens the target list with its own filters, the New form
  is `/compass/leads/new` and a record tab `/compass/accounts/13/opportunities`.
  Opt in to `path` on views and pages, a natural key (`address: 'name'`,
  refused unless the database keeps it NOT NULL and unique) and a public slug
  (`slug: true`: a 301 to the current spelling, a real `<title>` and a
  canonical link). `tablewalk check --routes` prints every address. Older
  links still open and are rewritten; the database browser keeps its
  query-language links.
- **Record history.** A `history()` page section shows a record's own
  changes, newest first — who, when, the action or command, and each field
  from what to what in the App's words. Declaring it makes the resource keep
  a durable history in reserved tables, written in each write's own
  transaction on SQLite, PostgreSQL and MySQL and provisioned once with
  `provisionSqliteRecordHistory`, `provisionPostgresRecordHistory` or
  `provisionMysqlRecordHistory` from `tablewalk/maintenance`. It is read for
  the reader asking: records they cannot read have none, and fields they
  cannot read or that `audit.redact` names show only that they changed. A
  signed-out reader of a public page is not shown it. Not yet under
  `auth.rows: 'tenant'`.
- **Lists edited in place.** `editable` on a grid list view: Enter or F2
  edits a cell, Enter saves, Esc cancels, Tab moves on. Each cell is the
  record form's update, checked the same way on the server, optimistic with
  rollback. A selection gains "Set field…", one value to every selected
  record, reported applied or refused like bulk actions. Columns no cell
  could save are refused at load.
- **Rollups.** A resource can declare `rollups`, numbers about the rows that
  point at each record — `count('opportunity', { query })`, `sum('order_line',
  'amount')`, `min` and `max`, through one reference. They read like columns
  in lists, sorts, tabs, conditions and record fields, are computed in the
  same statement on SQLite, PostgreSQL and MySQL, and are narrowed by the
  child table's row policies and grants. A tab whose condition names one is
  counted like any other.
- **Record pages draw charts, notes and embedded views.** `chart(title,
  from, by, { whose })`, `note(text, { title, icon, action })` and
  `embed(view, { whose })`; a side panel's sections stack from its top.
- **Attachments preview and manage their files.** Images, PDFs and text open
  in the lightbox; each file downloads, and can be renamed or removed where
  the App is writable; the drop area is visible. A file resource may name a
  `thumbnail` column, which cards and gallery strips draw while a dense
  screen still gets the file, and pictures revalidate to 304s.
- **A first run for a new App.** `firstRun(title, steps)` puts a welcome with
  next actions in place of empty dashboards and steps aside once the tables
  have rows. The scaffold writes one, and empty-state copy for its lists.
- **Dashboards draw bars, marks and a greeting.** `chart(…, { shape: 'bar' })`
  draws one series with the current bar marked and its value said; any
  dashboard section takes an `icon`; a metric's trend is drawn in its
  change's tone where `better` says which way is good; a dashboard's new
  `heading` and its `description` may greet `{me.name}`, filled by the server
  from the signed-in session. A windowed card's title says the window it
  counts ("Won (last 90 days)"), and the picked window takes its place.
- **Tray, a seventh look, opt-in.** An analytics desk: navigation on a soft
  grey canvas beside a white pane, each dashboard section a light-grey tray
  holding one white card — the one look where a box holds another, and only
  on a dashboard — stat cards with their trend beside the figure, list heads
  on a tinted band, the current item and primary actions in the ink, light
  and dark. `ui: { theme: { preset: 'tray' } }`. Its stylesheet loads only
  when it is worn. Depot wears it.
- **Faster reads, fewer statements.** The catalog is read once per
  connection, reads no longer ask whether their table exists, and a
  single-value metric no longer counts its one row: on Compass the first view
  after start is 1 statement instead of 112 and a list page 2 instead of 4.
  A filtered list counts to 10,000 and says "10,000+" with a click to count
  exactly; turning a page no longer recounts; a record's references are
  bounded the same way. A list's tab badges come from one `/api/counts`
  request and, where the reader allows, one statement. `/api/run` takes
  `count: 'none'`.
- **Compressed, revalidated API and pages.** JSON of 1 KB or more is sent
  brotli or gzip. The schema, App, pages and runtime answer 304 when
  unchanged, keyed to the signed-in person; row-policy and tenant replies are
  never stored. A public page with its own head carries a strong ETag.
  Signed-in images are sent `private, no-cache` with an ETag, so a withdrawn
  grant takes effect at once and a revisit is a 304.
- **Streamed exports.** "All matching rows" streams CSV, JSON or NDJSON from
  `POST /api/export` in batches, with no count and flat server memory.
- **PostgreSQL** row-scope CTEs are inlined (`NOT MATERIALIZED`, 12+), and two
  readers stay connected through idle spells.
- **First pages load only what they draw.** A sign-in screen or public form
  downloads 163 KB of script in brotli instead of 353 KB; an App page 314 KB,
  the Workbench 318 KB; the server preloads each page's part, and the App
  manifest parser is out of every first page. Icons ship as path data, and an
  App's icons arrive with the App. Dashboards stop re-running every tile
  when their tab regains focus; typing in a list's filter no longer redraws
  the grid; long pages of cards, queues and checklists draw only the visible
  rows; a long Workbench table list is drawn as it scrolls. `npx tablewalk`
  no longer installs React, Base UI, TanStack or Phosphor, which are bundled
  into the client.
- **Settings in the account menu.** Signed in to an App, Preferences, dark
  mode and the Workbench are in the account menu and the settings gear is
  not drawn; signed out, the gear is named "Settings"; the Workbench keeps
  "More". An account known only by its email shows its avatar in the bar.
- **Phones and polish.** A phone's App bar is one row in every App; the list's
  own search is the one search box on a phone; a list's New says "+ New"
  beside a long title. A focused field's ring sits flush on its edge in every
  look. The filter bar, filter rail, record actions, board confirmations and
  the Workbench's SQL, connection, export and write-mode dialogs use the
  shared Button and Field. A split list's grid drops columns beside the
  detail pane. A list narrowed to nothing says "No matches" with a Clear; a
  record that is gone is said once, with no actions; `density: 'compact'` is
  visibly denser in every look; dashboard figures wrap instead of
  overlapping; an aside's title may wrap while its count stays on one line;
  a bar chart labels as many ticks as fit. Forecourt's vehicles open
  newest-listed first.
- **Depot, a sample App for warehouse operations.** A distributor's inventory
  across three warehouses on SQLite or PostgreSQL. Pick, pack and ship queues
  work on a phone; receiving goes into bins; transfers, adjustments and blind
  cycle counts run through commands that keep a stock ledger in step with
  every bin. It shows rollups, in-place triage and Set field…, `history()`,
  product photos with thumbnails, `firstRun()`, command forms with repeating
  lines, three roles and the Tray look.
- **Commons, a sample App for a moderated community.** A makers' forum anyone
  may read: a front page, boards, threads, project photos and member
  portraits drawn by its seed. Members join, post, react and edit only their
  own words through commands; anyone reports a post through an anonymous
  public form; moderators work queues with bulk commands, keep removed words
  private and read a health dashboard. SQLite or PostgreSQL, in the Ink look.
- **A dropped PostgreSQL connection no longer stops the server.** A pooled
  client that lost its backend mid-lease emitted an error nobody listened
  for, which ended the process; every pool client now listens, and the
  failing query is answered as the store being unavailable.
- **History names people, never their email.** Record history, the activity
  feed and notices say the writer's name as it was at the write ("Someone"
  without one); the account is kept for audit and never sent to a reader.
- **Fixed on the way.** The Docker image's build stage copies what `npm run
  build` now needs. A module past 1,000 lines is noted by the structure test,
  not failed; 1,500 is the hard stop.

- **Custom components go further (preview).** A component can change data
  through the App's own commands (`useCommand`, running a command or opening
  the platform's form), stand in a form's field (`inputs`), draw a list view's
  rows (`customList`) or a whole room (`room()`, whose `reads` gate who is
  offered it and are recorded in authority.lock). `ui.connect` and `ui.images`
  open declared origins in the page's policy and authority.lock. Components
  draw for signed-out visitors over what `auth.public` opens, held to the
  public grant as the App loads, with no command to run. `tablewalk/ui/testing`
  gains `renderList`, `renderRoom`, `renderInput` and examples that double as
  Storybook stories. Commons gets a post stream with reactions and a profile
  header; Depot a bin map, a stock sparkline and a phone pick walk.
- **Notifications and a personal inbox.** A resource's `notify` rules tell
  people when a record is created, a column changes (an assignment) or an
  action runs; who is told is read off the record — an email column, or a
  person via `auth.me`, through up to two references. The notice is written
  in the write's own transaction into a store provisioned once with
  `provisionSqliteInbox`, `provisionPostgresInbox` or `provisionMysqlInbox`.
  Each person reads only their own notices, and only while they can read the
  record. A bell with the unread count sits in the App bar;
  `/{app}/notifications` lists them all.
- **Commands know who is acting.** `actor.email` and `actor.name` come from
  the verified session. Depot's ledger records who moved each unit; Commons
  members get "My threads". `me` works where a role may not read people's
  emails.
- **Grant a fixed action without write.** `auth.roles.<role>.actions: {
  pay_run: ['Submit for review', 'Approve payroll'] }` lets a role run named
  fixed actions on a resource it reads but does not write. The server admits
  the update only as exactly that action — its `set`, stamps, reason and
  `when` on the stored row, inside the write — and Undo stays. Listed in
  `authority.lock`. Payday's payroll, time-off decline, timesheet approval and
  reminders are now granted fixed actions.
- **Manage accounts and settings records.** An account holding `admin` in an
  App that signs people in adds accounts, sets their roles, deactivates or
  reactivates them and sets a new password from the account menu, authorized
  on the verified session and again by Better Auth, never locking itself out,
  every change logged. `resources.<r>.settings: 'Company profile'` opens a
  one-row resource from Settings.
- **CSV import (preview).** `import: true` on a resource or a list view offers
  Import beside New: map a file's columns, check every row without writing,
  and import the rows that pass in one transaction with one Undo. Cells are
  read in the App's locale, references by their record's name, vocabulary by
  value or word, and the reader's grants, row policy, validation and the
  database judge every row. `import: { command, match }` runs a business
  command per row. Rows with problems download as a spreadsheet-safe CSV.
- **Rollups wherever a column reads.** In a card's figure, facts and lines, a
  queue's facts (through a reference too), a picker's query, and as a
  dashboard or page measure, a breakdown's key and a condition; a page
  `breakdown()` takes a `measure`; a rollup may read another rollup, two hops,
  each level narrowed by its rows' grants. A record named by its key
  (`recordLabel: 'SO-{id}'`) shows that name in a list's key column.
- **Dashboards: section periods, live lists, an activity feed, photos and
  marks.** A section may carry its own `windows` (`?period.<section>=`);
  `embed(view, { interactive: true })` brings search, filters, selection and
  bulk actions into the section; `activity()` lists recent changes across
  resources from their history, as the reader may read them; a display rule's
  `avatar: { from, whose }` draws a person's photo and `icons` marks a
  vocabulary's words. Fourteen new App icons.
- **Tenant reads on PostgreSQL are much cheaper.** A list goes from 223 to 22
  statements and a metadata read from 102 to 10: each snapshot repeats its
  full catalog check only when a digest of the catalog has changed, a read
  drops four redundant snapshots, and a request looks up its session once
  while still checking the session row at every step. Invitation and
  support-session stores gain tenant-leading indexes (stores from before are
  refused and must be provisioned again), and the support log shows the
  newest 100 visits.
- **Accessibility.** A selectable queue is a grid of selectable rows with Open
  as a button in the row, so axe passes in every look and the keyboard works
  as before.
- **Security.** A signed-in reader's pictures are `private, no-cache` with
  `Vary: Cookie`, so a sign-out, a withdrawn grant or the next account on a
  shared browser takes effect at once. A public page's `<title>` and canonical
  link take a record's name as plain text. Compiled components and their
  source maps are private in an App that signs people in (a visitor to its
  public pages gets the code, never a map). An export's column list reads
  only a row's own values. `tablewalk check` catches more ways a component
  can turn text into markup or code.

## 0.7.1

- **Related records are readable on phones.** Ordinary App related lists use
  record summaries below 761px, with a Records/Table switch for comparison.
  Desktop tables, authored cards, galleries and attachments retain their
  presentation. Summary navigation preserves complete keys, including aliased
  composite keys and large identifiers; names and reference labels reuse the
  existing query. Missing keys never become navigable summaries.
- **Shared controls show their state clearly.** The selected Records/Table
  control remains visible across all eight looks, including hover. Record
  summary titles carry one keyboard focus ring instead of outlining both the
  action and its container.
- **Related collections join Storybook.** Real page sections cover populated,
  empty and missing-reference lists. The review script now captures both light
  and dark mode at desktop and phone widths. Interaction checks exercise
  presentation switching, visible selection and keyboard focus in every look.
- **Release documentation matches shipped capabilities.** Current-version
  statements, sample coverage and policy/form/media boundaries are reconciled.
  Publishing instructions describe the existing CI, registry verification,
  installers and local site-deployment fallback. Existing App definitions stay
  compatible; this patch adds no DSL vocabulary. Full interface translation,
  broader component-state review and performance optimization remain follow-up
  work.

## 0.7.0

- **Shared building blocks have broader visual coverage.** Storybook includes
  complete record pages, sidebar/main layouts, cards and tables, guided forms,
  command validation, dialogs and work collections using the actual App themes.
  Review scripts capture desktop and phone layouts and exercise keyboard focus,
  nested controls and draft retention. Ordinary task queues use a single clear
  opening action, and command validation stays aligned beneath its field.

- **Related lists explain empty states.** Record sections accept the same
  `empty` guidance and optional destination link as list views. Unavailable
  destinations are removed for each reader; create and upload controls remain
  usable. Payday demonstrates this on employee Onboarding tabs.
- **Interface translation foundations.** Preferences offers English and Spanish
  for its controls, framework navigation controls and dashboard list links, remembered per
  App in the browser. Changes apply without reloading forms. This is initial
  framework coverage. Feature-local `messages()` catalogs and `copy()` references
  translate resource captions, list labels, page names, section headings/tabs,
  and list/related-list empty guidance with an English fallback; only referenced
  entries are served, and field projection removes unavailable captions. Payday's
  employee page demonstrates the authored copy. Full interface translation
  remains follow-up work. Number/date formatting keeps its existing
  locale rules.
- **Records have an explicit name.** Resource `recordLabel` chooses a local
  field or reference path for headings, references and pickers. An unavailable
  explicit name falls back to the complete primary key rather than an unrelated
  text field; existing Apps retain inferred names when no label is declared.
  Page headings reuse a local label's avatar display rule without another read.
  On narrow screens, record navigation sits below the name.
- **Dashboard embeds retain their cards.** Embedded card views preserve their
  presentation and let readers open records without enabling inline mutations.
  Cards with no image declaration render compactly without a photo placeholder.
  `media: 'avatar'` reuses the image source for a portrait, with primary-derived
  initials when absent or unavailable.
- **Dashboards offer clear next steps.** Read-only queue embeds support named
  record-opening buttons and status badges using ordinary column display rules.
  Queue `facts` add compact, labeled context such as pay dates, employee counts
  and time-off date ranges, using the resource's captions and field permissions.
  Notes can include curated icons and a link to an
  available App view. A reachable dashboard's note can open a secondary view
  without adding it to the sidebar; links never grant destination access. The `two-thirds`
  section width supports unequal rows; dashboard `aside` gives supporting
  content its own independent, responsive column. An optional dashboard
  `description` puts plain-text context beneath its heading.
- **Payday joins the examples.** A single-company people and payroll workspace
  demonstrates feature-local review commands, approval notes, directory pages
  and task dashboards with benefits enrollment views over synthetic SQLite data. It does not calculate
  or transfer pay.
- **Sage record pages use focused detail panels.** Editing groups use quiet bordered surfaces; summaries and supporting details
  keep a compact layout with fine dividers and sentence-case profile tabs.
  Payday demonstrates it across people, onboarding tasks, payroll runs, time-off
  requests, benefit enrollments and pay statements using the public page DSL.
- **Apps can give their sidebar its own rhythm.** `ui.shell.sidebar` offers
  comfortable navigation spacing and a pinned workspace identity footer.
  Apps hide Workbench navigation and search entries by default; opt in with
  `ui.shell.workbench: true`. Authoring and generic database editing tools live
  in Workbench, leaving the App menu focused on reader preferences.
- **App chrome stays compact across screen sizes.** Sidebar Apps use an
  accessible mobile drawer with workspace identity and a single-row header.
  Shared header spacing, navigation typography and list-panel alignment keep
  the shell proportionate to its content without App-specific CSS.
- **Examples have distinct brand marks.** `ui.logo` selects a decorative SVG
  mark from the curated icon set for the App header and sign-in screen, while
  the App name remains the accessible label.
- **Concurrent PostgreSQL tenant reads.** Read snapshots use the bounded source
  pool without serializing independent requests. Context validation and draining
  outstanding reads on retirement remain enforced. Validated immutable catalog
  snapshots and their comparison fingerprints are reused. PostgreSQL source
  readers retain their validated ownership declaration while comparing each
  fresh physical catalog; database and membership checks remain current.
  Record fields and root probes skip unused exact totals; list views keep
  their existing counts. Page planning and reference enumeration
  combine root admission and required field reads into one scoped query.
  Platform-only external sources bind on first use within a request, so pages
  do not initialize sources they never read.
  Platform reads avoid a duplicate source snapshot before binding or querying;
  session checks, query-snapshot validation and final revalidation remain enforced.

- **Features keep related declarations together.** Example features own their
  actions, command references and explicit role grants. `commandGrants(...refs)`
  avoids repeating command IDs; it does not grant access from a visible button.
  Generated schema types now include `Resources`, `Views`, `Pages`, `Page` and
  `Navigation` for checked authoring modules.
- **Forms declare their steps once.** Without an explicit `show`, step fields
  consistently drive rendering, required-field checks and permission projection.
  An explicit `show` still takes precedence.
- **App menu counts are opt-in.** Set `ui.shell.counts: true` to request live
  row counts; omitted counts keep the menu quiet by default, while Workbench
  catalog estimates remain unchanged.
- **Tenant navigation stays usable through ordinary focus changes.** An
  unexpired lease survives brief tab switches while foreground verification
  runs; expiry, failed verification and session changes still block access.
  Signing in at a tenant App's staff door now opens its root instead of trying
  to interpret `sign-in` as a data query.
- **Platform reads avoid redundant setup.** Final authorization revalidation
  checks the current session and membership without rebuilding an empty second
  read context; schema-change and revocation checks remain enforced.
- **Public forms beside private account data.** Row-policy deployments can
  explicitly enroll fixed public forms with a captured scope and result
  attestation. Submissions always use public authority, even when signed in,
  and retain durable retry receipts. Public read access never implies writes.
- **Forecourt accounts do useful work.** Shortlists persist across sessions;
  signed-in inquiries belong to the verified account. Anonymous inquiries stay
  anonymous. Staff can record replies and close inquiries with atomic history.
  The sample uses reusable vehicle cards and feature-owned workflows. Existing
  sample databases need the updated schema; no automatic migration is supplied.
- **Policy-protected media works on SQLite and PostgreSQL.** File GET/HEAD
  responses retain binary content and wait for policy checks before sending.
  They use no-store caching; policy file uploads remain unsupported.
- **Offline types for policy Apps.** A single explicit `--app` can use
  `--export types` without loading private policy, command or auth modules.
- **Layout fixes.** Long card facts wrap, and hidden labels no longer create
  an outer scroll range that leaves blank space beneath the content pane.
- **Forms keep their place.** Submitting preserves button focus, refusals focus
  the field or error summary, and receipts take focus to their heading. Form
  headings follow the App's theme. Tenant selection now says when a workspace
  is opening while its metadata loads.
- **Empty lists can explain the next step.** List views accept `empty` copy
  and an optional link to an available list or dashboard. Forecourt's empty
  shortlist offers Browse vehicles. Filtering keeps the ordinary no-matches
  state. Dashboard embeds inherit this guidance when their filter matches the
  source view; narrower embeds retain the ordinary no-matches state. Calendar
  lists retain their existing presentation.

## 0.6.0

A release about being able to move: the suite catches the defects that were
costing days, the codebase says who may reach into tenancy, and the App
platform stops losing its own look at the door. Plus what a marketplace needs
— a footer under every room, a form that opens over the record it is about,
and an account anyone may make.

- **A fixture for the pairs that break.** Every defect in 0.5.0 and 0.5.1 was
  invisible until two features met, and every one passed its own feature's
  tests. `test/combinations.test.ts` composes a minimal App out of parts — a
  resource, an `api` exposure, a command registry, a feature, tenancy, a
  workflow strip — starts the real CLI over the pair, and proves both halves
  still work together. Five pairs so far, including the one that stopped a
  tenant App starting at all.
- **A built tenant App can be served.** `tablewalk build` output carries a
  `build` fact, which the tenant host's admission list did not name, so every
  built tenant deployment was refused — production being exactly what a tenant
  App is built for. The refusal also said nothing, because the reason was
  dropped twice on its way out; startup now records why it refused and the CLI
  prints the chain for the operator who started it.
- **The sign-in screen wears the App's look.** A landing and a public form were
  already told the App's name and theme when signed out. The door was not, so
  an App whose accent is blue met its first visitor in the database browser's
  green.
- **A footer under every room** (`ui.footer`): a line of small print and a row
  of links, the same shape a landing's footer has, and a landing that declares
  none of its own wears the App's.
- **A call to action can open its form over the record** (`open: 'modal'` on a
  headline action). The price, the photographs and the mileage are why anyone
  is filling the form in; sending them to a page of its own takes that away.
  The link keeps the form's address, so a new tab still opens the page.
- **Panes that fit the window.** A filter rail needs more room than a phone
  query describes: at 641px the two-column grid left a card grid 352px and one
  narrow column, with the rest of the window empty. Under 860px the rail's
  sheet takes over and the rows get the width. Scroll bars on an App's panes
  are drawn from its theme rather than the platform's chrome, and the list's
  control strip reserves its gutter instead of always drawing a bar.
- **Who may reach into tenancy is now stated.** `src/server/tenant/`'s generic
  evidence helper moved out to `src/server/evidence.ts`, taking the folder's
  external importers from 38 to 10 — the three public barrels, the modules
  named for tenancy, and the entry points that compose a deployment. A ratchet
  keeps it that way.
- **The suite says what a change could have broken.** `npm run affected` walks
  the import graph backwards from the files you changed. Changing a component
  selects 72 of 810 suites and no tenancy tests at all. It prints what it
  cannot follow, and never gates a release.
- **Two checks against false confidence.** An assertion that an element is
  absent must name something the client can draw — an "assert absent" that
  outlives its element passes forever — and a document that offers a flag to
  `tablewalk` must offer one the CLI takes.
- CI shards six ways rather than three; `--demo` builds its database in a
  directory of its own, so two runs on one machine no longer corrupt each
  other; the component suite runs on Vitest 5; and eight duplicate browser
  tests are gone, each with a note saying what still covers it.
- **A public catalogue beside private rows.** `auth.public` may now stand with
  `rows: 'policy'`. The two answer different readers and never meet: a visitor
  is scoped by the public grant — the resources it names, read whole — and a
  signed-in account is scoped by the policy, which is never asked about a
  visitor because there is no account to ask it about. Before this, the two
  were refused together and a row-policy deployment denied a signed-out
  request outright, so an App could be browsable or hold per-account rows, but
  not both. Under a policy a visitor's public surface is reads; a public
  form's command is not offered yet. `rows: 'tenant'` is still refused — a
  tenant App's public surface is its own.
- **Forecourt** gains a second look (Marketplace), a footer, modal calls to
  action, a shortlist, and open sign-up: anyone may make an account, and the
  role a new one gets reads the catalogue and not the sales inbox.

## 0.5.1

- **A record's action bar draws every verb it offers again.** A tenant App's
  record asks the server which of its commands are available now, and it asks
  about all of them in one request. A request owns one transaction, so the
  batch opened one per command and every command after the first was refused —
  which failed the request, and the bar hides a verb it has no answer for. A
  record offering one command was fine; Ignition's lead, which offers three,
  drew no buttons at all. The batch now runs in the request's one transaction,
  over the union of its commands' footprints, each command still judged under
  its own. Both realms, a dealership's and the lender's, were affected.
- **One unanswerable verb no longer hides the others.** Where visibility
  cannot be answered for a whole batch, the browser asks each command again on
  its own, so a misdeclared verb costs an App author that verb and not the rest
  of the bar.
- **A two-realm tenant App's menu is its own realm's.** Each realm's served
  rooms, menu, home and pages are now taken from the realm projection alone. In
  0.5.0 they were taken from the whole App and then narrowed by what would
  resolve against the context's catalog, which is a different question: a
  dealership was offered the lender's headings and the one room of the lender's
  that reads a dealership's own table, and the lender was offered the whole
  dealership menu. No rows crossed and no refusal was missing — each room
  answered with the reader's own data under its own row rules — but a realm was
  told which screens the other keeps. An App's `api.views` exposure is judged
  the same way now, so a view placed in a `"platform"` group without saying so
  itself can no longer be exposed to a tenant-bound token.

- **The Node suite runs in two lanes.** A file that still works in the one
  database `TABLEWALK_TEST_PG` or `TABLEWALK_TEST_MYSQL` names runs serially;
  everything else runs in parallel. Lane membership is read off the source, so
  a new file touching a shared engine lands in the serial lane by default
  rather than by somebody remembering, and the rule's failure mode is
  slowness rather than a race. The suite went from 1,068 s to 470 s with the
  same 9,065 tests and the same four skips.
- **A build's own test hook gets a build's budget.** The hook that runs
  `tablewalk build` before serving a sample from its output was left on the
  suite's default timeout: the two minutes the file asked for reached its tests
  and never its hooks. It only began failing once a second worker competed for
  the CPU the build wants.
- **Four tests that could not fail were removed.** Each asserted that an
  element was absent by a name nothing renders any more — one of them deleted
  in the same commit that added its guard. An "assert absent" that outlives
  its element passes forever, so it costs time and returns false confidence.

## 0.5.0

An App reached by other programs, and tenancy made usable: an App's reads and
commands through a scoped local API and as MCP tools for a coding agent,
tenant invitations, events, public intake and audited support access, two new
looks and new record and dashboard building blocks. Everything new here is a
preview and may change before 1.0.

- **Scoped API tokens (preview).** `tablewalk api-token` issues, inspects and
  revokes tokens in an App's own sign-in store, SQLite or PostgreSQL, from the
  command line, with no server running. A token belongs to an account and to
  the roles and operations it was issued for, and the account is checked
  again on every request.
- **A local read API (preview).** `--api-reads` serves an App's declared
  resources and views to bearer tokens on loopback: items, lists with signed
  cursors and bounded counts, and an OpenAPI document narrowed to what the
  token may read. It needs `--api-integers` (`decimal-string` or `number`) and
  `--api-requests-per-minute`; cookies never authenticate it. It serves
  SQLite and PostgreSQL Apps alike.
- **Commands through the API (preview).** An App may expose targeted
  commands under `api.commands`; started with `--commands`, `--api-reads`
  serves them beside the reads with idempotent receipts, recovery, and
  sanitized 401/403/409/410/422 refusals, and `/$openapi` describes both.
  `tablewalk api-token issue --commands <file>` issues tokens for such an App.
- **Tenant Apps through the API (preview).** `tablewalk api-token issue
  --tenant <id>` binds a token to one active tenant membership at the version
  it read; a tenant App's `--api-reads` and `--app-mcp` serve under its
  `--policy`, re-checking that membership on every request and refusing
  another tenant's rows, keys and cursors. API lists order text keys by
  bytes, so opaque text keys page. A database fault answers 503, not a
  refusal. Tenant receipt recovery and row-policy Apps are refused.
- **App MCP (preview).** `--app-mcp` serves one App's API as MCP tools over
  stdio for a coding agent, on SQLite and PostgreSQL, with the token read
  only from `TABLEWALK_API_TOKEN`, checked once at startup, and every listing
  and call re-authorized as an HTTP request is. It needs no session secret.
  Claude Code is the documented and exercised client.
- **OpenAPI export (preview).** `--export openapi --api-integers <kind>`
  prints an App's API contract and enables no route; `--commands <file>` adds
  its command operations. The OpenAPI importer reads the exported document
  back.
- **Tenant invitations and tenant command events (preview), on SQLite and
  PostgreSQL.** A tenant App started with `--policy` can issue account-bound
  invitations and record its commands' events in a tenant-scoped event store.
  Both stores are provisioned beforehand through `tablewalk/commands` and
  `tablewalk/maintenance`; startup checks them and never creates one.
  Invitations need a writable connection, and a grant may name only the
  App's tenant roles. Webhook effects on a tenant command stay refused, as
  does SQLite business storage with a PostgreSQL sign-in store for
  invitations.
- **Tenant Apps run jobs (preview).** A tenant App started with `--policy`
  may also run `--jobs`: each tenant's committed facts reach a job that runs
  one of the App's own commands as a service principal bounded by that tenant,
  or as the platform's, fenced on the tenant and platform rows it read.
  `provisionSqliteTenantJobs` and `provisionPostgresTenantJobs` set the stores
  up beforehand, and startup only ever checks them. Webhook effects stay
  refused.
- **Two realms in one App (preview).** The business that runs the tenants can
  have screens of its own, not only commands: a view, page, home rule or
  command reference marked `realm: 'platform'` is checked against what the
  platform sees, while everything else is checked against what a tenant sees,
  so a tenant-realm screen still cannot name a platform-owned table. A
  refusal at startup now says which stage refused.
- **A tenant App may read a platform-only source (preview).** A source marked
  `realm: 'platform'` is read by the platform realm alone, and never appears
  in a tenant's, member's, command's or public form's catalog at all. It is
  read-only, cannot be joined across sources, is refused through the API and
  MCP, and cannot be the App's own database or sign-in store under another
  name.
- **Setting a tenant App up from the command line (preview).**
  `tablewalk/maintenance` gains steps that create tenants and the platform
  row, grant and revoke platform and tenant memberships, and create native
  accounts in the App's own sign-in store, each one journaled with the
  operator who ran it.
- **A tenant administers itself (preview).** `delegates` on the
  administration and invitation policies lets a tenant role's own members
  manage their tenant, within the same ceilings and never on their own
  membership. An invitation may be addressed to an email: claiming it with its
  one-time link creates that account and accepts the invitation in one step.
  The address is not verified, and claims have a rate budget of their own.
- **Public intake on a tenant App (preview).** A tenant App's public form
  places each submission with one tenant through an intake address the
  server resolves from the platform's own rows (`intake: { address }` in the
  tenant policy; the link carries `?via=`). A visitor never chooses or learns
  which tenants exist: every placement answers alike, and a submission no
  address places goes to the platform's own queue.
- **Record and dashboard building blocks (preview).** A record's property
  rail (`presentation: 'properties'`), a record's sections as tabs (`tab` on a
  section), an ordered workflow strip that draws the steps already passed and
  marks the steps the record's own fixed edits can reach now — a command says
  nothing here, because where it moves a record is its handler's to decide and
  not something the App declares — stacked bars and a
  `target` on a dashboard's chart or metric, a `duration` display format, a
  themed calendar for record dates and date-times, and a print stylesheet
  that puts a record or a list on paper as its content. Startup and
  `--check-app` name each one as a preview.
- **Audited support access to a tenant, reads only (preview).** A platform
  role granted `supportAudit` can enter one tenant for a short session and
  **look**: a support session reads the tenant it entered and acts on
  nothing. Every read is recorded before its answer is released — a read that
  cannot be recorded is refused rather than served unlogged — and every write,
  Undo and command under a support lease is refused with one clear, public
  refusal. The tenant keeps its own log of these visits, readable by its
  members whose role is granted `supportLog`, so a tenant can see who came in
  and what they looked at without having to ask the business that runs it; the
  ledger the platform reads is the same record, not a second one kept
  separately, and only the platform's view carries the operator's email.
  Entering needs `TABLEWALK_AUDIT_KEY`, kept apart from `BETTER_AUTH_SECRET`;
  a deployment that grants support access without it is refused at startup
  rather than served unrecorded. The audited _write_ path is built and tested
  behind this door — a write and its record commit together or not at all —
  but nothing yet carries support evidence into a write, so no release lets
  support change a tenant's data.
- **Two new looks.** Sage: warm cream grounds with the content on white
  panels, soft shadows, sage-green charts, and a status that carries meaning
  as a tinted pill. Signal: deep blue-black navigation with an electric-lime
  block for the current page, tabs and primary actions in ink, square stat
  cards and large figures, with Sky, Mint and Lilac palettes.
  There are now eight built-in looks — Canvas, Graphite, Iris, Coral, Ink,
  Mono, Sage and Signal — all held to the same contrast checks.
- **Palettes apart from looks.** Preferences offers a look's palettes
  separately from the look and from Light/Dark, and remembers the choice for
  each App and look.
- **Fixes.** A picker's list no longer flickers a pixel wider and narrower as
  it opens. A record's action bar asks each of its conditions once, and no
  longer shows "Checking…" when there is nothing to check. The App API says
  `temporarily_unavailable` for a 503 whether a read or a command hit it, and
  a sign-in store that cannot answer now says so with a 503 instead of
  answering 401, which claimed the token was at fault; a token that really is
  revoked, expired, unknown or for another App still answers 401. A
  PostgreSQL
  database is now read in a fixed order — its foreign keys, a table's indexes
  and the check that gives a column its allowed values could each come back
  in a different order from one read to the next.

## 0.4.0

How Apps look, what they are built from, and how their logic is written. Six
built-in looks with one structure and type scale; record and list blocks
(cards, galleries, facts and sheets, similar lists, a filter bar of controls
and filter rails with ranges, boards you arrange and lists kept in hand
order, dragged by mouse, pen or touch); readable addresses; commands written
against their data (declared inputs, a typed `db`, a checked record, output
shapes), with `lookup` before the transaction and `effects` after it
(preview); `tablewalk build` for Apps in production (preview); a client that
loads in a fraction of the bytes and stays cached; PostgreSQL pools sized per
connection and safe behind PgBouncer or RDS Proxy; an API as a connection
(preview); a public marketplace sample; and, for tenant Apps, the platform
realm (preview). The database browser keeps its own look and is still
read-only by default; editing stays a per-connection opt-in enforced at the
adapter.
Upgrading a `tablewalk.json` with pages: each page's `"name"` is now
`"label"`, and a metric's `"fn"`/`"column"` is one `"measure"` (below).

- **Through a list without leaving it.** Space on a grid's row glances at
  its record over the list, and Escape hands the focus back to the row. A
  record opened from a list — its page, a glance or a dialog — says where it
  sits ("3 of 20", or "3" where the list has no total) beside its name, with
  Previous and Next arrows, and `j` and `k` step the same way: in the list's
  own order and filter, and past its page, whose next or previous page is
  read with the same question. A step replaces the record in the trail, so
  Back returns to the list. The single keys stand aside while you type or a
  dialog is open. The `?` panel puts the keys for the room you are in first,
  and an App's reader gets a keys-only panel from `?` or ⌘K ("Keyboard
  shortcuts").
- **A split list steps with its detail.** The detail beside a split list says
  where it is ("3 of 20") and J and K step it through the list; the list marks
  the row the detail is showing and keeps it in view, and a record on another
  page turns the list to that page.
- **Every list steps past its page.** A record opened from cards, a queue, a
  checklist or a narrow screen's record summaries, and a glance or a dialog
  opened from any list, steps past the page's edge with the list's own
  question, as a record opened from the grid already did. A query that names
  its own limit is the whole list.
- **The record dialog uses the screen.** On a wider screen the record dialog
  opens up to 80rem wide and 88% of the window tall, the same height for
  every record. Stepping with ← → or J and K keeps the record being left in
  place until the next one is ready, then fades it in (not at all under
  reduced motion) instead of collapsing to "Reading…" and growing back, and
  the "N of M" between the arrows no longer touches them.
- **The database browser is the database.** In an App's Workbench a row
  opens as a record, the next step of the walk, even where the App shows that
  table as a split list and detail; the App's heading, New button and split
  stay in the App, and a step through the list replaces the record instead of
  stacking another.
- **The database browser looks like itself again.** `npx tablewalk <db>`, and
  an App's Workbench, wear the browser's own look — warm paper, the green
  accent, the code face in its chrome and its data, flat dense rows, small
  uppercase column heads — in light and dark, instead of an App's Canvas. The
  six looks dress Apps only, and the browser's Preferences offer no Visual
  theme; a reader's pick is kept for the next App they open. Kept from this
  release: figures in the reader's locale, the key and reference marks, the
  record trail. Cleaned up: the filter row, pager and record head stand at
  one control height, and the record head's buttons are one quiet size.
- **Tidier list chrome.** An App list's filter bar reads from the left: its
  boxes, then Filter, then the view's own verbs together — Advanced, Save
  view…, Clear filters — instead of right-justified boxes with those verbs
  strewn after them. A split list's authored limit is the view's, like its
  columns: no longer a "limit 25 ×" chip, and no longer a reason to offer
  Clear filters on a list nobody filtered. The bulk bar says nothing until
  something is chosen: with no selection a grid shows only "Select all N",
  and "N selected", the verbs and **Clear selection** appear with the first
  choice; the last report keeps its own Dismiss. A split's New makes one of
  its records, named by its detail's title ("+ New issue", "+ New update"),
  never by the workspace ("+ New inbox"), picking rows in a split
  replaces the selection instead of stacking crumbs ("Inbox › Inbox") and
  Backs, and the trail's Back sits beside the list's verbs, not adrift in the
  middle of the bar. A grid cell's tooltip appears only where the column
  clips the value, no longer on every value past 40 characters. On a phone
  the filter boxes stand in one aligned column.
- **Lists keep a margin.** Beside a side menu, as under a top bar, the page
  has its own air on both sides, so a grid's card, a board's lanes, a split
  and the pager no longer run from the menu's rule to the window's edge; a
  queue, a checklist and a board's "N shown" keep the same inset as the text
  above them.
- **A split sits beside its list.** The split layout's column rule nested one
  `minmax()` inside another, which CSS refuses, so the whole rule was dropped
  and the detail stacked under its list at every width; on a wide screen it
  stands beside the list again.
- **A split's detail is the App's record.** Beside a split list the pane
  reads the picked row the way the App's record dialog does: the record's
  name as its heading (changed where it is said), its star, actions and tags,
  the split's authored fields (`detail.show`) with the App's captions and
  dressed values, and the pending bar inline — under one head holding the
  kind of record, its place in the list ("3 of 24", ← →, J and K),
  **Details →** to its full page, and Close. It was the workbench's record
  view squeezed into the pane: column types, "As a page", "Copy for agent",
  Layout and a rail of references, its head wrapping a word to a line. The
  split measures its own room, not the window: below about 40rem — a 1024px
  window with the side menu open is just under that — the detail comes first
  and the list under it; a phone keeps the dialog. Picking the next row or
  stepping holds the record being left in place until the next one is ready.
- **A queue's Open waits for its row.** Where a pointer can hover, a queue
  row's Open shows when the row is hovered or holds focus, instead of a
  bordered button on every row; Tab still reaches it, and on touch it stays.
- **A pass over every sample's screens.** A row's own ⋯ menu is hidden until
  its row is hovered or has focus (always shown on touch), not drawn faintly
  on every row. A fit grid gives its spare width first to the columns still
  cut short (a title up to 360px), then evenly, and a second line or a tone
  chip counts toward a column's width, so a title no longer clips beside a
  half-empty column. Lists turn into record summaries only at phone widths
  (760px and under); a tablet keeps the grid. The record dialog's head says
  the kind of record and the page below says its name, once. An App's list no
  longer shows the query's milliseconds or a "key" mark on a column head.
  Fixed: tabs and a dashboard's window pills no longer wrap a label over two
  lines (the row scrolls); on a phone the current crumb ends in an ellipsis
  instead of leaving the home icon alone on a line; a list's count no longer
  stands alone above its tabs when the shell hides the title; a filter
  rail's Clear no longer sits on its first value's count; and a page's
  summary band no longer doubles the rule of the sections after it.
- **Focus shows wherever the keyboard is.** A list's filter boxes, and every
  field in a look, show focus with the house ring; the looks' own field
  border had outranked it, so the filter boxes showed none. The entry the
  arrows are on in a menu, a Select, the palette, a picker or the query's
  completions wears the ring too, instead of a tint alone (1.04:1 on
  Canvas's white). A current top-bar entry filled with the accent (Coral,
  Mono) rings in its own ink.
- **Words on tints read at 4.5:1 in every look.** Status words, avatar
  initials, placeholders, a filled tab's count, a record's "3 of 20" and
  faded control marks now clear WCAG AA by day and night. Iris's selected tab
  and Coral's current top-bar group wear the ground's ink by night instead of
  white, and Coral's soft accent is a step lighter.
- **Saves and moves are said, and focus is never dropped.** The toast speaks
  through a status region that is always on the page, so a screen reader
  hears a save or a calendar move. ⌘K opens a named dialog that keeps Tab.
  Closing an App's New form returns focus to the button that opened it, and
  Tab stays in the drawer; a card moved to another lane with Alt and an
  arrow keeps the focus; a multi-step form's Next and Save, and Sign in, say
  they are busy rather than going disabled, which dropped the focus. A New
  form's required fields and a command form's refused field say so to
  assistive technology.
- **Touch and motion.** A board card's ⋯ is a 24px target. Thirteen hover
  fades and turning chevrons that moved under `prefers-reduced-motion` are
  still now, and a repository test fails any stylesheet that moves for a
  reader who asked it not to.
- **Structure is every look's now.** Canvas, Graphite, Iris, Coral, Ink and
  Mono draw structure with rules instead of boxes: a table is its rows under
  one 2px rule in the ink, with no panel around it; board lanes stand under
  the same rule, and a board of rows keeps it on its lane heads, so its cells
  are places rather than boxes; a section's rule is 2px in the ink, and two
  sections sharing a row share one rule. Captions and column heads take a
  darker ink, still AA and quieter than the text, and each look's corners are
  its own tightened radius (Canvas, Graphite and Iris 4px, Coral 3px, Ink 2px,
  Mono square).
- **Status reads as its word.** A tone that carries meaning is a dot and its
  word; a neutral value is plain text. No table cell draws a pill; a label on
  a record keeps its chip, with its ×.
- **A type scale.** Three steps of heading (a list's 20px title, a record's
  26px, 30px in Ink and Mono, a landing's 32 to 44px headline), each in the
  look's heading face at the look's own weight, never past 700. Titles are
  tracked in and capitals tracked out again: a blanket reset had set every
  letter-spacing in the looks to zero.
- **Neutral grounds.** Iris, Coral and Graphite draw their content on white
  (near-black by night) and keep their color for the bar, the accent and the
  current item; the crumb bar no longer draws a band. Ink keeps its paper.
  Mono draws its hairlines in grey under black rules and headings, and its
  dashboard cards lose the offset shadow. The looks use the system's own sans;
  Inter was named first but never rendered.
- **Display type to try (preview, `?craft=bold`).** An opt-in layer for the
  screens that are the point of a visit: a record's head up to 34px, a
  dashboard's 50px figures (a row each on a phone) and a 60px landing
  headline. `?craft=bold` turns it on and the browser remembers it,
  `?craft=off` forgets it, and nothing changes for anyone who never asks. An
  App's own accent, radius and face still win, and the database browser
  never wears it. docs/design.md describes what the layer may and may not do.
- **Look fixes.** A record's toolbar keeps its name's row at every desktop
  width. The landing's hero grows with its headline, so the stat line stays on
  the photo, and a wrapped stat line no longer opens with a dot. Coral's
  selected tab is visible by night. The sidebar's current row is a tint, with
  no crescent down its side. Ink's and Mono's last column head no longer clips
  into "…". A board whose lanes run past the window fades at its far edge
  until the last is in view. Planning's cells lose their unlabeled counts.
  Record fields and Ink's dashboard figures use tabular figures.
- **A field can be found.** Every form control's edge (a text box, a
  textarea, a Select's button, a record picker, the query bar, a list's filter
  boxes and the filter rail's) now reads at 3:1 or better against the field and
  against the page around it (WCAG 1.4.11), in all six looks, light and dark,
  in the database browser's own look, and in the sample Apps' Meridian and
  Showroom. It was the section hairline, 1.1 to 1.6:1. Each look carries the
  edge as one new palette role, `borderControl` (`--border-control`);
  section, card, table and divider rules keep their quiet hairline.
- **The startup theme check reads what the page shows.** A custom theme whose
  `borderControl` is under 3:1 on its `surface` or `background` is warned at
  startup, and the meaning colors (`positive`, `warning`, `negative`, `key`)
  are checked on the page's `background` as well as on its panels.
  `docs/theming.md` lists the new role.
- **A glance holds Tab.** A list that opens its rows as a glance (`open:
  'peek'`, or Space on any row) opens a dialog that takes the focus: Tab and
  Shift+Tab stay in the panel, J and K still step through the list, and
  Escape, or a click on the scrim, hands the focus back to the row it was
  opened from, whichever record it had stepped to.
- **A calendar week is not a list row.** Hovering a week no longer tints it
  like a list row, which took an outside day's faint date below 4.5:1; every
  date reads at 4.5:1 in every look.
- **Headings step in order.** A record page's and a dashboard's sections are
  h2 under the room's name, not h3, and every Workbench room has an h1 (the
  landing's is visually hidden), so a screen reader's outline no longer skips
  a level or starts nowhere. Nothing looks different.
- **Select all is the checkbox in the header row.** An App list that offers
  bulk actions no longer puts a labeled "Select all 20" control on its own row
  above the grid. The select-all box sits in the header row, lined up with
  the row checkboxes, with no label and no count: checked when every loaded
  row is chosen, mixed when only some are, and announced as "Select all
  issues" (the resource's own noun, or "rows"). It is in the Tab order, and
  Space toggles it. The bar of bulk actions over the rows appears only once
  something is selected.
- **A list's filters are controls, not a form.** An App list's bar is one
  search box on the list's name column, a quiet "+ Status" for each filter the
  view declares, and what is applied said as chips in the same row. A "+"
  opens the column's picker in a popover (the checklist with live counts,
  Min/Max, date presets or, for a reference, the typeahead), and the picker
  applies from one button that says what it will show ("Show 12"). A chip
  opens its picker again; its × or Backspace takes it out, and two or more
  earn one Clear all. A reference's chip says the name, not the id. On a phone
  the pickers are one Filters sheet ("Filters · 2"), the search stays in view
  and the chips wrap under it, so the first record is on the first screen.
  Every picker writes the condition its box or facet did, so addresses
  (`?priority=high`), saved views, tabs and the crumb read as before, and
  `filterBar: 'rail'` and `filterBar: false` are unchanged. The Filter and
  Clear filters buttons are gone.
- **The client loads in a fraction of the bytes, and a browser keeps it.** An
  App's first page fetches one script and one stylesheet: 356 KB with brotli
  (434 KB gzip, 1.5 MB decoded), where every page used to fetch 3.8 MB
  uncompressed. A return visit downloads nothing: the page answers 304 and
  every script and stylesheet comes from the browser's cache. The client is
  minified, with source maps in the package and their sources inside, so
  devtools and a mapped trace still land on the original line. Every script,
  stylesheet and page in `dist/client` is compressed once, at build time (a
  `.br` and a `.gz`, node:zlib, no new dependency; the source maps, which only
  devtools fetches, are sent as they are), and the server picks brotli, then gzip, then
  the file as it is, by `Accept-Encoding`, with `Vary`. Every script and
  stylesheet, the entry included, is named for its content under `assets/` and
  served `public, max-age=31536000, immutable`; `index.html`, the maps and
  anything unhashed are `no-cache` with a strong ETag and answer 304.
- **Loaded on demand.** The SQL editor, the query composer, the page builder
  and layout editor, the schema diagrams, dashboards and their charts, boards
  and calendars and their drag, the New form and its field library, the
  Workbench record view, breakdowns, the agent console, connection management,
  and the account, tenancy and authoring dialogs each load the first time they
  are used. A part on its way says nothing for a moment, then one still line; a
  part that cannot load, because the server was updated since the page opened,
  is replaced by a sentence and a Reload button. Fixed: every page served from
  the build logged a refused stylesheet, a request for a `/composer.css` that
  exists only in the source tree. `npm run test:built:browser` loads the built
  client in a browser from a cold cache and a warm one, and CI runs it.
- **PostgreSQL pools are sized per connection, and say when they are the
  limit.** A connection's `"pool": { "read": 16 }` in `tablewalk.json` (1 to 64) sets how many reads may hold a connection at once, and `--read-pool`
  (`TABLEWALK_READ_POOL`) the default for every PostgreSQL pool in the
  process; four stays the default. Writes keep one connection per database:
  the adapter writes one transaction at a time, and `docs/postgresql.md` says
  why a second writer would change what callers rely on, and how to plan
  `pods × databases × (read + 1)` connections. Every checkout is metered. An
  operator's support bundle (`GET /api/operations/support`) gains a capacity
  section (each pool's size, in-use and queued counts and its wait and hold
  times, named by its connection's position rather than its name, beside the
  event loop's busy and idle time), and readiness a `pools` check that
  degrades as `pool_saturated`. Read together they tell adding pods from
  raising a pool from a slow database.
- **Behind PgBouncer or RDS Proxy.** `--pooler transaction`
  (`TABLEWALK_POOLER`) sets nothing on a PostgreSQL session: the read-only
  guard and the statement cap are set in every transaction instead, SQL a
  person typed is followed by the in-transaction half of `DISCARD ALL` before
  its transaction ends, and a cancelled read no longer cancels by a backend
  id that would be the pooler's. Direct connections keep the cheaper session
  defaults. The authentication store still needs a direct or session-mode
  connection, and MySQL, which reads through one connection, has no pool to
  size.
- **`tablewalk build`: an App made ready for production.** An App still runs
  straight from its source directory, and the database browser has no build
  step. `tablewalk build` is the optional production step for an App: it does
  once, in CI, what a start does at every boot, adds the typecheck a start
  never runs, and writes a directory a server starts from without loading
  TypeScript.
- **`tablewalk build --app <dir> [--out <dir>] [--config <path>] [--commands
  <file>] [--jobs <file>] [--policy <file>]`** typechecks the App (its
  `tsconfig.json`, with the App's or tablewalk's TypeScript; skipped and said
  when neither has it), validates it through the same loader a start runs
  (parse, features, references, `pages/`, `authority.lock` by lines), bundles
  its definition and server entries, and writes `app.json`,
  `tablewalk-build.json` and `server/<kind>.mjs` into `--out` (default
  `build/<dir name>`), swapped in only when every step passed. Exit codes: 1
  could not build, 2 typecheck, 3 validation, 4 bundle. With `--config`
  reaching the App's database, the build also writes the App's generated types
  and runs `--check-app` on the staged build; otherwise it says those checks
  run at start.
- **Rolldown, an optional peer dependency**, bundles: the definition into one
  self-contained file, the server entries into one build whose shared modules
  stay one instance. `tablewalk/commands` and installed packages stay imports.
  Without Rolldown, each module is type-stripped on its own with Node's
  `stripTypeScriptTypes`, and the build says so. Unminified, with source maps.
- **Serving a build**: `tablewalk --app <build>` reads the compiled App with no
  worker, no TypeScript and no parse, re-hashes every file, and refuses a build
  made by another tablewalk version or edited since, with the fix. It never
  watches or reloads. `--commands`, `--jobs` and `--policy` must be the build's
  own bundles; `--write-authority` is refused on a build. Every sample, built
  with Rolldown and without, loads as a deep-strictly equal definition with the
  same command and job registrations. Loading the App falls from 43–59 ms to
  2–4 ms, and a production start of Thread from 246 ms to 140 ms.
- **Docker**: `examples/docker` is a multi-stage image: the builder compiles
  tablewalk, builds the four compose samples and seeds their data; the runtime
  ships the builds and nothing to compile. New site page, **Build and deploy
  an App**, including running behind a load balancer.
- **Commands are written against their data, a clean break.** A command's
  inputs are declared once, keyed by name, in the order the form asks them,
  with `field.*` from `tablewalk/app`: `text`, `textarea`, `email`, `phone`,
  `url`, `number`, `money`, `date`, `bool`, `choice(values, { each })`,
  `reference(resource, …)` and `group(fields, { repeat })`. A field is required
  unless it says `optional: true`, and its label is read from its key. New
  rules: text `min`/`max`, `format` (email, phone, url), `pattern` with the
  `message` a mismatch shows, `case`; number `step`; `below`/`above` a sibling
  number or date. The form and the server read a value by the same parser, and
  the array form is gone. `defineCommand({ ...ref, source, … })` spreads the
  reference, so the contract is written once and startup refuses a drift.
- **A typed `db`.** `defineSource<Rows>('lending')` types a handler's `db` from
  the generated `Rows`: `db.<table>.get`, `find`, `where` (an object, the query
  language, or a tagged template whose values are always quoted), `count`, and
  on written tables `insert`, `update(row, changes)` (guarded at the row's
  values, the revision bumped, a conflict `stale_record`) and `remove`. More
  than 1,000 rows without `.limit` is refused rather than cut. `tx` stays, as
  the escape hatch.
- **The target arrives read and checked.** `record` (or `records`) is read in
  the transaction before the handler runs: missing is `not_found`, another
  revision `stale_record` (not for a service principal), and one that fails
  the command's `when` is `ineligible_state`, naming the key when several were
  sent. `refuse(code, detail?)` says no, typed `never`. Output shapes (`shape`,
  `text`, `int`, `number`, `id`, `bool`, `date`, `literal`, `list`, `optional`,
  `nullable`, `oneOf`, `ShapeOf` from `tablewalk/commands`) type what `handle`
  returns and check it before commit, dropping undeclared keys. `validate` is
  for the rule a declaration cannot state, and may be any synchronous Standard
  Schema (valibot, zod, arktype); tablewalk depends on none of them. Removed
  from `tablewalk/commands`: `BusinessCommandExecutionError`, `WriteConflict`
  and `BusinessCommandValidator`. Ignition's six handler files went from 737
  lines to 410.
- **A command can look things up before it writes.** `lookup` reads the App's
  other sources (reference data in another database, or an HTTP connection
  through egress) before the command's transaction opens, with the target as
  it stands, and hands the handler `lookup`: JSON, bounded, frozen. The
  handles read only (`get`, `find`, `where`), under the same resource ceiling
  and role grants as the command's own reads. A lookup that fails refuses a
  first attempt, `temporarily_unavailable` and not applied, while the replay
  of a request that committed still answers its receipt; a `refuse(...)`
  inside lookup keeps its own code. A tenant App looks up only resources every
  tenant reads (`owner: 'global'`), through the tenant's own row scope, and
  startup and `--check-app` refuse the rest.
- **And say what should happen after it commits.** `effects` name what a
  committed command asks of the outside world. Each is POSTed after commit,
  through the event delivery a command's events already use, to an
  operator-configured `"kind": "webhook"` connection, with an
  `Idempotency-Key` that is the same on every attempt of one effect. A 2xx is
  delivered. Every other answer, and a webhook that can't be reached, is asked
  again after backoff (1 s, doubling to five minutes, eight attempts), like
  any event destination's, then fails for an operator to redrive
  (`redriveEventDeliveries`).
- **Boards you arrange.** A card is dragged to another lane, or moved there
  with Alt+← and Alt+→ or from its ⋯ menu; each is the same move, through the
  resource's actions where `transitions` says so. A board's
  `order: '<numeric column>'` reads each lane in that column's order, and a
  reader who may edit it drags a card into place, presses Alt+↑ or Alt+↓, or
  picks a place from the card's menu (up, down, top, bottom). A move writes the
  one card's place, halfway between its new neighbors; the lane is numbered
  again, 1,024 apart, only when there is no number left between them. Each
  write is an ordinary update, checked, recorded and undoable. A move is
  announced and the focus stays on the card. Thread's board orders by a new
  `rank`.
- **Quieter boards.** A card's moves, places and edits are one ⋯ menu,
  quiet until the card is hovered or focused, instead of two selects under
  every card; a chosen move hands the focus back to the card. A lane says its
  value the way a tone chip does ("In progress", the stored `in_progress` as
  its title), and so does a card's line from a vocabulary.
- **Swimlanes and limits.** A board's `swimlanes: '<column>'` draws a row per
  value of another column, and one for none, each folding under lane heads
  drawn once; a card changes row by a drag, Alt+Shift+↑/↓ or its menu, as an
  ordinary update, and where the column is not the reader's to change the
  board says why. `limits: { in_progress: 4 }` shows "3 / 4" on a lane's head,
  in the warning color past it — shown, never enforced.
- **A card lands where it is dropped.** On a board with `order`, a card
  dragged into another lane lands before the card it was dropped on (or last):
  the lane through its action, then the place as a second ordinary update, each
  undoable; if the place fails, the card keeps its new lane and the reader is
  told.
- **Boards by a reference: planning.** A board's `by` may reference another
  table (`by: 'cycle_id'`): the lanes are that table's rows by label, led by
  one for none, and a card moves between them by an ordinary update of the
  reference, unless the resource's transitions give it to its actions.
  Thread's new Planning view is the issues by cycle, a row per priority.
- **Card edits in place.** A card's primary and line are edited where they
  stand, with F2 or Edit in its menu, in the record page's own editor and bar:
  Enter saves, Escape puts the value back, and the save is recorded and
  undoable. A click and Enter still open the record.
- **Drag with a finger.** A board's cards and a calendar's records drag by
  mouse, pen or touch now. A finger holds an item still for a moment before
  it lifts, so a swipe still scrolls the lanes or the page; a mouse lifts once
  it moves. The item's copy follows the pointer, the lanes and the page
  scroll near their edges, and Escape puts the item back. A drop lands
  before the card whose top half it is let go over. Moves still go only
  where the resource's transitions allow, each an ordinary update with Undo,
  said aloud with the focus back on the card, and Alt with the arrow keys and
  the card's ⋯ menu still do the same. On a phone, a record can be dropped
  on another day of the calendar's agenda.
- **Lists kept in your order.** A list view's `order: '<numeric column>'`
  (the board's own word) keeps a grid, a checklist, a queue or cards in the
  order an editor gives them: drag a row into place, press Alt+↑ or Alt+↓ on a
  focused row, or pick Move up, Move down, Move to top or Move to bottom from
  the row's grip, which shows on hover or focus and always on touch. A move
  writes the one row's place, halfway between its new neighbors, renumbering
  1,024 apart only when there is no room, and each write can be undone. A
  tab's own sort, a header or the Sort menu reads the rows another way, and
  the grips hide until the order is back. `order` beside a sort in the view's
  `query` is refused, with the reason. Tick's Open and Today tabs keep your
  order in a new `position` column.
- **An empty board cell is a place, not a box.** On a board with rows, an
  empty cell keeps its size and still takes a drop but draws no edge of its
  own; the edge comes back, in the accent, only while a card is carried over
  it, so a mostly empty Planning no longer reads as a grid of empty boxes. A
  carried card's copy no longer draws a "Details" line above it, and on a
  phone the first lane starts at the gutter the crumbs and tabs use.
- **Menu icons and the icon rail.** A list, dashboard or signed-in form
  view, and a nav group, may name an `icon` — one of Phosphor's icons by its
  own name, from a curated set of 64 business menus use (`house`, `kanban`,
  `users`, `receipt`…). An unknown name is refused with the nearest ones.
  Icons are drawn before the entry's words in the side menu, the top bar and
  their menus, quieter than the words and in the current entry's color; an
  App that names none looks as it did. `ui.shell.rail: true` makes folding
  the side menu (« or ⌘B) leave a 56px rail of those icons instead of hiding
  it: an entry without an icon shows its initial, group headings become
  rules, the fold button stays in the rail as the way back, and every entry
  keeps its name for screen readers and says it on hover. Thread and Compass
  carry icons; Thread folds to the rail.
- **HTTP sources, in preview.** An API is a connection now.
  `tablewalk --from-openapi spec.json > desk.http.json` drafts a description
  of its lists and items — columns, the filters and sort it documents, its
  paging — saying on stderr what it guessed and what it skipped, and a config
  entry with `"kind": "http"` browses it like a database, in the explorer and
  in an App. The API is asked
  only what the description declares; an `or`, a `contains` or an
  undocumented sort is refused with what does work ("It can filter by
  status =, tag ="). Lists page without totals, a record is read from its
  item path, and nothing is written. Requests leave through one door: https
  unless `"insecure": true`, the resolved address checked and the checked one
  connected, redirects refused, JSON only, 5 MB and 15 s at most; private
  networks are reachable, cloud-metadata addresses are not unless
  `"allowLinkLocal": true`. The credential is a `${VAR}` in `auth`, expanded
  at open, sent as one header, and never shown. See docs/http-sources.md.
  `tablewalk --openapi <spec file or URL>` does it in one command, with no
  config: the description is drafted in memory, the base URL is the spec's
  server (or `--api-url`), and `--api-token-env NAME` sends `$NAME` as a
  bearer token. Over an API, a column header offers Filter on … and sorting
  only where the API documents them, and inside an App a refusal names
  columns by the App's captions ("Carrier") rather than the API's
  (`carrier_id`).
  The sixth sample, Parcel, is a shipment tracker over a local mock carrier
  API that requires a bearer token: tabs, filters and a sort that are the
  API's own parameters, no totals, carriers named on each shipment and a
  carrier's shipments listed on its page. References between resources are
  guessed by the draft from a column's name (`carrier_id` → `carriers`) and
  followed one step, each target read once from its item path; a filter or
  sort on a referenced field, or a second step, is refused. In the database
  browser, an API's table has an **API** tab in place of Definition: its list
  and item reads as a form drawn from the description (the declared filters,
  search, sort and paging, or the key), sent by the server with the
  connection's credential, answered with the request line, the status and
  the JSON body; an undeclared parameter is refused before anything is sent,
  and a list's question opens as the table view. Not in Apps, and not on a
  shape-only connection.
- **A cache and a search engine, both optional.** A config file can name a
  Valkey cache (`"kind": "cache"`) and a Typesense search engine
  (`"kind": "search"`) beside its databases. Neither is a database or a
  source of truth, neither is listed as a connection, and a deployment that
  names neither runs as before; nothing new is installed with the package.
  Credentials are `${VAR}` references expanded when the service is first
  used, and saving the connection list from the browser writes both back
  unchanged. docs/services.md.
- **Cached API answers.** An HTTP connection's `"cache": { "ttl": 60 }`
  answers the same read from the cache for that many seconds: the process's
  own memory, or the shared Valkey. Only a 2xx is kept; the explorer's API tab
  always asks the API.
- **Public-form rate limits across instances.** With a cache named, a public
  form's per-client and total windows are counted there, so every instance
  behind a load balancer spends one budget; when the cache does not answer,
  each instance counts its own.
- **Search inside an App.** A resource's `search: { connection, fields }`
  sends a `contains` filter on those fields — the list's filter box, reference
  pickers, the palette, saved views — to the engine, which answers keys (at
  most 250, best first); the rows are read from the database under the
  reader's grants, so rows and counts agree. The App's inserts, updates and
  deletes keep the index in step, and `tablewalk --reindex [resource]` fills
  it from the database. While the engine is down the filter runs on the
  database and the reader is told once. Not yet on tenant Apps. Preview.
- **A row without a name is called by its number.** Where a table has no
  name-like column, a `*_number` column (`tracking_number`,
  `invoice_number`) now titles its rows, in crumbs, record heads and pickers,
  before the first text column does, which could be another row's id.
- **Filter rails.** A list view's `filterBar: 'rail'` draws its filters as a
  rail of facets beside the rows instead of the bar: a vocabulary or a
  reference is a checklist of its values with live counts (ticking several
  asks `in (…)`), a flag a toggle, a date its presets (Overdue, Today, This
  week, Next 7 days, No date) and a range, anything else a contains box. Each
  writes the query the bar's boxes write, so the address, the chips and a
  pasted link all say it. On a phone the rail is a Filters sheet applied by
  one button. Not beside a split. In preview; Compass's Tasks list uses it.
- **Saved views.** The App list's saved filters are views now: Save view…
  keeps the tab, filters and sort on screen under a name, Rename view… and
  the × after the tabs change it, and opening one is the ordinary list
  address. An App without sign-in keeps one shared list, as before. An App
  that signs people in, which refused saving outright, now keeps each
  account's own ("My views") in the same store, owned by the verified session.
  Row-policy and tenant Apps still keep none.
- **Figures in the reader's locale, everywhere.** Numbers, money, percents,
  dates, times, file sizes, relative days ("yesterday", "in 3 days") and the
  count in front of a noun are written in the reader's browser locale, or the
  App's `ui.locale` when it pins one — on the grid, the record, the pager,
  the menu's counts, dashboards and charts alike, not in the grid alone. A
  German reader sees 1.234,50 € and 05.03.2026. Stored dates keep their day
  in every timezone and timestamps are shown as written, as before; an id
  past 2^53 keeps every digit. The words stay English, and "1 rows" is gone.
  One module (`src/client/locale.ts`) writes them all. A review that confirms
  an exact change (tenant administration) keeps the instant it will submit,
  to the millisecond, beside the reader's date.
- **JSON, laid out.** A json or jsonb value — and JSON text in a column
  declared JSON — is drawn by its shape instead of as `[object Object]`: an
  object as labelled fields, an array of like records as a table, short words
  as chips, links as links, dates and numbers in the reader's locale, `true`
  as a Yes pill and null as a dash. Two levels are open and deeper ones fold
  behind their count; long arrays show twenty at a time. Raw shows the
  pretty-printed text and Copy takes it. A grid cell says the shape in one
  line (`{ id, name, +3 }`, `[12 items]`) and opens the whole document over
  the grid on a click or on Enter; records and pages show it inline. A
  document is read-only in every field editor: the text box showed
  `[object Object]`, and anything typed over it was staged as the value.
- **Cards.** A list view's `presentation: { kind: 'cards', primary, value?,
  badge?, lines?, facts?, image? }` draws its rows as a grid of cards, one to
  four columns by the room's width: a picture at 4:3 (lazy, with a
  placeholder when there is none), the title, one figure in the column's
  display rule, up to four lines under their captions, a line of `facts` and
  a badge; the whole card opens the record. `image` is a
  column holding an image address, or `{ from, whose, sort? }`, the first file
  of a related file resource. Preview.
- **Galleries and a lightbox.** A related list over image files with
  `presentation: 'gallery'` draws a lead photo and thumbnails; the lead opens
  a lightbox with Previous and Next, a counter, the caption, the arrow keys, a
  swipe and Escape. `GET /api/file` takes `inline=1` and then answers inline
  only when the bytes themselves are PNG, JPEG, GIF, WebP or AVIF. Preview.
- **Accordions.** A fields section's `presentation: 'accordion'` is a
  disclosure with a real button over its region, shut by `collapsed`; the
  landing's FAQ uses the same component. Preview.
- **Headlines.** A fields section's `presentation: 'headline'` draws the
  first field as a large figure (a price), the rest as a row of facts, and one
  or two `actions` — the landing's `{ label, view }` — that open one of the
  App's views, a public form included. In the side panel (`region: 'aside'`)
  it is a card beside the photos that stays in view. Preview.
- **Rows on a public front page.** In an App with `auth.public`, a landing's
  call to action may open a list or dashboard the public reads, a `view`
  section shows a cards list, and a `search` section offers a list's own
  filters and opens it with those conditions. The landing is then drawn
  inside the App. Its hero may carry a photo from a file resource the
  public reads (`image: { from, key, alt }`), laid out `split` or `overlay`,
  the search panel inside it (`search`) and a line of `highlights`. Preview.
- **Forecourt reads as a marketplace.** A car's page leads with a gallery
  that steps through its photos where it stands (arrows, "1 / 4",
  thumbnails, the lightbox), a line of key facts, and a price card that says
  the price, an estimated monthly payment with its terms, and two calls to
  action: Inquire, and Schedule a test drive, each opening the inquiry form
  already filled with the car. Features are a grid of checks, the
  specification and history are two-column sheets, the dealer sits in a card
  of their own, and similar vehicles follow as cards. The Vehicles
  list says each car's year, mileage, fuel and transmission and who sells
  it, and sorts by price, mileage and year. A car's title says its trim once.
- **Public addresses in words.** A signed-out visitor's list is
  `/forecourt/vehicles?make=Toyota&sort=price`, a car is
  `/forecourt/@vehicle~49`, and the crumb says "Vehicles · Toyota" where it
  said "Vehicles · filtered"; Back and Forward keep the walk.
- **App addresses read as words, signed in too.** A view as it opens is its
  key (`/thread/board`, and `/thread/inbox/~2` with a split's pick); a tab is
  `?tab=working`; a filter the view offers is `make=Toyota,Honda`,
  `price=10000..20000`, `price=..15000` or `year=2018..`; a sort is
  `sort=-price,year`. Only a question those cannot say (an `or` across
  columns, a column the view does not filter by, a show of the reader's own)
  is `q=` its text. The view's show clause and standing conditions are never
  in the address, a view opens on its first tab so that tab is the key alone,
  and a tab's own sort goes unsaid. A query-language address still opens and
  is rewritten in words. The database browser keeps query-language
  addresses, and a tenant's address keeps `?tenant=` as its only parameter.
  Fixed: closing a split's pick stacked its list a second time
  (`/thread/inbox/inbox`), and a list linked into another connection was read
  without that App's views.
- **Forecourt filters from a rail.** Its Vehicles list filters from a rail
  on the left of its cards (`filterBar: 'rail'`): make, model and body ticked
  with their counts, price and miles as Min/Max ranges, model year, fuel and
  transmission as checklists. On a phone the rail is the Filters sheet,
  applied by one **Show N** button. Beside the rows, the chips that say the
  selection head the results with one **Clear all** and the Sort menu.
- **A rail's numbers are ranges.** A plain column in any rail shows as what
  its values are, judged once over the rows the view stands on: a number
  with more than twelve values is a Min/Max range (with its currency symbol
  or unit), one with fewer a checklist in numeric order; text with up to
  fifty values a checklist, with more a contains box; the name column stays
  the search box. A range is the query language's own condition
  (`price between 10000 and 20000`, `>=`/`<=` for one end), so it is a chip,
  an address (`price=10000..20000`) and a saved view like any other. Fixed:
  a rail's counts left out the view's standing condition, so Forecourt
  counted sold cars the list never shows.
- **Page blocks.** A fields section may be `facts` (the values in one
  line) or `table` (a label-and-value sheet, `columns: 2`), and a headline
  takes a `subfigure` and a `note`. A headline action may `prefill` a form
  from the record and add `presets`; the form view names what its address
  may fill with `prefillable`. A related list may be cards, and
  `excludeSelf` leaves out the record the page is on. A list view's `sorts`
  offer named orders in a Sort menu. A display rule takes a `unit` ("mi",
  "/mo") after a number or money, and `format: 'items'` lays a text of lines
  out as a list. Cards take a `facts` line and one-hop label paths.
- **Similar lists on pages (preview).** `similar(title, from, { same, near }, opts)`
  lists the rows of the page's own table that are like the record: every
  `same` column (one to four) equal to the record's value, every `near` number
  column (one or two) within ± a fraction of it (`0.25` is 25% either way; a
  whole-number column keeps whole-number bounds). Rows come closest first on
  the first `near` column, then in the section's `sort`, then by key, and the
  record itself is always left out. The server reads the values from the
  record's own row, never from the request, and the list runs as one ordinary
  read under the reader's grants, row policy, public read ceiling and tenant
  scope. A record with an empty `same` value, or a `near` value that is not a
  number, shows no similar rows, never all of them. `whose`, `about`,
  `create` and `excludeSelf` are refused beside `similar`. Forecourt's vehicle
  page ends with "Similar vehicles" (the same body type, within 25% of the
  price, not yet sold) where it listed the dealer's other cars, which stay one
  click away through "Sold by".
- **A refused key says what was meant.** An unknown key in an App is refused
  with the key it is a slip of (`views "tasks" has no "lable". Did you mean
  "label"?`) or, when another place takes it, with where it belongs
  (`"primary" belongs inside "presentation" (checklist, queue, board,
  calendar, cards)`), still followed by the keys the place takes. A command's
  input declaration names the stray key and what its field type takes, where
  it said "unknown command metadata property" or "field options do not match
  its type".
- **One word for each thing a timeline stream, a card and a search say.** A
  stream says who wrote each row with `author`, where `by` groups rows
  everywhere else: `stream('comment', 'issue_id', 'created_at', 'name', {
  author: 'author_id.name' })`. A card's one line of values under its figure
  is `facts`, as a fields section's `facts` presentation says them: `{ kind:
  'cards', primary: 'title', facts: ['year', 'mileage'] }`. A landing's search
  names the list's own filters as `filters`: `search: { view: 'vehicles',
  filters: ['make', 'price'] }`. A New form says what shows when in one map
  keyed by field: `visibleIf: { due_on: { field: 'completed', operator: 'eq',
  value: false } }`.
- **Defaults are not written, and a no-op is refused instead of ignored.** A
  fields section shows a reference's record by default, so `names` takes only
  `false`. `density` and `sizing` beside a checklist, queue, board, calendar
  or cards presentation are refused like `totals` and `rowActions` (a split's
  list is a grid and keeps them). A dashboard board and a dashboard embed of a
  board view take no `width`: a board is always full width. A dashboard-level
  `table` that no section inherits is refused. A page section's `hidden` and
  `collapsed` are booleans (`"false"` is refused instead of read as true). A
  view of cards, a queue, a checklist or a board fetches its presentation's
  columns without a `show`.
- **More helpers, all plain data.** `listView(label, table, opts)` and the
  presentations `checklist(primary, checked)`, `queue(primary)`,
  `calendar(date, primary)` and `cards(primary)`; `embed(view, opts)` for a
  dashboard's or a landing's `{ kind: 'view' }` section; `countBy(title, from,
  whose, by)` for a page breakdown; `money(currency, { unit })`, `number({ unit
  })`, `relative()` and `items()` for display rules; and the landing's
  `text(title?, text)` and `search(view, filters)`. Each keeps the names it is
  given as literals, so a column a helper names is still checked against its
  table under `satisfies App`. The samples write only what they mean.
- **A record's word, said once on its resource.** `resources: { issue: { noun:
  'issue' } }` — its plural made by rule, or `{ one: 'person', many: 'people'
  }` — names the New button ("New issue"), a split's detail heading ("Issue"),
  and, when they say none, a page's label and a list view's label ("Issues").
  Without a noun, New says the table's own name: a list's label is no longer
  singularized by rule ("Statuses" made "New statuse"), and a split's detail
  no longer borrows a title.
- **A page's `label`, and the landing's.** A page says `label` (was `name`) and
  may leave it out: `page('issue', [...])` is called what the resource's noun
  says, else its table's name. The landing's browser title is `label` (was
  `title`). `label` names a control or a destination; `title` heads a region.
- **tablewalk.json pages change too.** A `tablewalk.json` page is the same
  page body, so an existing config must rename each page's `"name"` to
  `"label"` (the id it derives, and every page address, stay the same), and
  write each metric section's `"fn"`/`"column"` as one `"measure"`:
  `"fn": "sum", "column": "total"` → `"measure": "sum total"`, and drop
  `"fn": "count"`, which is the default. Saved pages and tenant page metadata
  need nothing. A page that still says `name` is refused with the keys a page
  takes.
- **A split says only its detail.** `presentation: { kind: 'split', detail:
  ['name', 'description'], limit: 25 }` (was `{ list: { show, query, limit,
  filterBar }, detail: { title, show } }`): the list beside the record is the
  view's own `show`, `query`, tabs and filter bar, and the detail is headed by
  the resource's noun.
- **A list view's default `sort`.** `sort: 'created_on desc'` reads the list
  in that order when nothing else says one: a tab's own sort wins over it, and
  the Sort menu over both. It stays out of the bar and the address, as `order`
  does, and is refused beside `order`, a sort in `query`, a board or a
  calendar. Compass's lists say it once instead of on every tab.
- **One page-metric spelling.** A page metric says `measure`, as a dashboard's
  does: `{ kind: 'metric', measure: 'sum amount' }` (was `fn: 'sum', column:
  'amount'`); absent is a count. `total(title, from, whose, column)` writes
  `measure: 'sum <column>'`.
- **Yes/no keys are booleans.** `delete`, `favorite` (a resource, a list view
  and a dashboard), `quickAdd`, `rowActions`, a form's `public`, a related
  list's `excludeSelf` and a display rule's `avatar` take `true` or `false`,
  and `false` says what leaving it out says (was `true` only).
- **An unknown key two edits from a short one is no longer offered it.** A
  page's `name` is told the keys a page takes rather than "Did you mean
  "base"?"; a one-letter slip ("bye" for `by`) is still offered its key.
- **Fixed on pages.** Accordion sections next to each other are one group,
  with one rule and no empty bands; a long text on a page is no longer boxed
  like the workbench's; and an accordion's heading keeps its color under the
  pointer.
- **Forecourt.** A fifth public sample: a used-vehicle marketplace browsed
  signed out, with generated studio photos, a public inquiry form and a
  staff sign-in, and a README section on what a public site still needs.
- **Typed connection names and theme presets.** `--app … --export types` now
  also writes `Connections`, the server's configured connection names, and
  `App = TypedAppConfig<Tables, Connections>`, so a mistyped `connection` or
  `sources.*.connection` fails the typecheck instead of the first start.
  `defineApp` checks `ui.theme.preset` against the built-in themes and the
  App's `ui.customThemes`. A standalone `--export types` is unchanged.
- **Delete is opt-in.** A resource says `delete: true` for its records to be
  deletable; without it the server refuses a delete in the App, whatever
  `access` and the connection allow, and no Delete is drawn. The plain
  database browser is unchanged. Undo of a record you just created still works.
- **Favorites.** `favorite: true` on a resource stars its records, and on a
  list or dashboard view stars the view. Starred records and views are listed
  under Favorites at the top of the menu, kept per browser and connection, and
  per account when signed in. Off unless the App turns it on. In an App the
  page pin gives way to it.
- **Grids select like queues.** A grid over a resource with `bulk` actions
  draws a checkbox in each row and "Select all" for the loaded page, above the
  queue's bulk bar: the same keys, limit, per-record writes and report. The
  selection and bulk logic is now one hook shared by both.
- **Row menus.** A list view's `rowActions: true` puts a ⋯ at the end of each
  row with that record's own actions, the same verbs as its page: nothing is
  asked until the menu opens, and choosing one never opens the row.
- **Compact lists.** A list view's `density: 'compact'` tightens its rows, for
  a list read as a ledger; a reader's zoom still applies on top.
- **Totals.** A list view's `totals: ['amount']` sums numeric columns in a
  footer row, over everything the tab and filters match rather than the page.
- **Avatars, second lines and meters.** A display rule can put an initials
  disc before a name (`avatar: true`), say another column of the record as a
  muted second line under it in lists (`subtitle: 'email'`), and draw any
  number as a bar against a `max`, coloured by its tone rule. The colours come
  from the theme's chart palette, so a name keeps one colour everywhere.
- **Three new looks.** Coral (Canvas's structure, warm and bold:
  cream, a plum bar, one coral accent, stat cards tinted in chart colours),
  Ink (a printed page: warm paper, near-black ink, serif titles and figures,
  rules instead of boxes) and Mono (black and white: square corners, 2px rules,
  monospace figures, colour only for status), each in light and dark, join
  Canvas, Graphite and Iris.
- **A public side to a signed-in App.** `auth.public: { read: ['vehicle', 'dealer'] }`
  lets signed-out visitors browse exactly the resources it names, read-only
  and optionally narrowed by `fields`; everything else still needs a session.
  Each resource is named (there is no `true`), the grant is in the App's
  authority lock, writes and commands stay behind sign-in (public forms
  aside), and a signed-out home rule may now open a view the public reads
  all of. The App shows a Sign in link instead of the sign-in screen.
- **Steps on the New form.** A resource's `form.steps` now draws the New
  drawer and dialog as a stepper: a page per step, Next checking that page's
  required fields, Back keeping the draft, and one insert from the last page.
  Quick Add stays a single row.
- **Tags through a link table.** `tags: { through: 'issue_label', to: 'label', tone: 'tone' }`
  on a resource puts its tags under each record's title as toned chips: rows
  of the tags table, linked through a table with one reference to each side.
  Where the App writes and deletes the link table, a picker adds a tag and a
  chip's × removes one, each a single link row inserted or deleted, so grants,
  history and Undo apply. Thread's issues carry labels.
- **Files and attachments.** A resource can say its rows are files:
  `file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' }`,
  the bytes in a BLOB or bytea column. A related list over it draws as
  attachments: each file a download under its own name, with its size and
  date, and, with `create`, an Attach button and a drop target. An upload is
  one ordinary insert, so grants, validation and history apply; `maxBytes`
  caps it (10 MB by default, 25 MB at most). Downloads are always saved, sent
  with `nosniff` and a sandbox policy. Thread's issues take attachments.
- **A calendar for any dated list.** A list view's
  `presentation: { kind: 'calendar', date: 'due_on', primary: 'subject' }` puts
  its records on a month grid by that date, asking the list's own question for
  the month in view, so tabs and filters narrow what it shows. A record opens
  the way a board card does; a busy day shows three and a "+N more". Where the
  date is writable and not a declared transition, a record is dragged to
  another day, or moved with Alt and an arrow key, as an ordinary undoable
  update. On a phone the month reads as an agenda. Compass has a Task calendar.
- **Status that moves only through actions.** A resource can declare
  `transitions: { status: 'actions' }`: the server then refuses any change to
  that column except one an action makes, checking the action's `when` against
  the stored record inside the write, and an action can ask `reason: '<column>'`
  for a note written with the change. Editors do not offer the column, a New
  form leaves it to its default, and Undo still returns a record to where it
  was. Thread's issues move this way, and Cancel issue asks why.
- **Activity with a composer.** A timeline stream can say who wrote each row
  (`author: 'author_id.name'`), beside the words, and a timeline can take `create`:
  an "+ Add update" button that adds a row of its first stream, bound to the
  record through the same form as a related list's create. Dates read as days
  ago, with the date on hover. Thread's issue page keeps its conversation in
  Activity; the separate Discussion table is gone.
- **Records fit the room they are drawn in.** A record opened in a peek, a side
  panel or a split list's detail stacks its columns for that space instead of
  keeping the wide-screen page, where names broke a letter to a line.
- **A record's fields sit closer.** 14px between rows and 3px under a label,
  down from 22px and 6px: a label still reads with its own value and apart
  from the next, and a record takes less of the screen.
- **Lists name themselves in the crumb bar.** An App list puts its title, the
  count of rows its tab and filters match, its star, New and Export in the
  breadcrumb bar; its tabs and filters share one row under it, each filter named
  beside its box, and the pager says "1–20 of 77". The rows start about 200px
  higher. The chip row appears with the first filter; an embedded list keeps
  its own heading.
- **Three looks: Canvas, Graphite and Iris.** Canvas — neutral greys, panelled
  tables, pill tabs with counts, dotted status pills and stat cards — is the
  default for every App; the database browser keeps a look of its own (see
  "The database browser looks like itself again"). Graphite frames white
  panels in grey with hairline tables and soft badges; Iris wears Canvas's
  structure in one clear violet under a deep indigo bar. Each has light and
  dark palettes that pass the contrast checks and is an inheritable `base`.
  The old default look now dresses only the database browser, and the Studio,
  Signal, Ember, Dispatch, Foundry, Index, Circuit and Quiet Workspace themes
  are retired; a stored choice of
  one falls back to the App's preset, then Canvas. An App's own `accent`,
  `radius` and `font` still win over the look.
- **An App's interface is sans.** Labels, headings, menus and chips take the
  sans face unless the App or its preset names one; code, the query language
  and, in the default look, a grid's short values keep the code face.
- **A record's toolbar.** The record's name and its toolbar share one row:
  the first action filled, the next two quiet, the rest under More, and
  Delete, when allowed, last in More. On a phone the toolbar keeps one button
  and More, on a row of its own under the name.
- **The record's name is edited where it is said.** In an App the head
  shows the name and the section that owns it stops repeating the field;
  where the name may be changed, the head is its editor, with the same Save
  as any other field.
- **The edit pencil sits beside its value.** Where a pointer can hover it
  appears on hover or keyboard focus; on touch it stays, dim.
- **Toned values say the word.** A value dressed by a tone rule is drawn the
  way its picker and a workflow strip say it: `in_progress` reads "In
  progress". A code or a phrase stays as stored, and the stored word is kept
  as its title for a reader writing a query.
- **A section titled by its one field says its name once.** The field's label
  is kept for assistive technology.
- **Signed Mac builds again.** The desktop workflow prepares its own signing
  keychain on GitHub's current macOS runner, and a dispatch from a branch is a
  trial that keeps its installers and releases nothing.
- **Split list/detail is stable.** A `split` view keeps its list beside the
  selected record, resolved by the view the row was opened from, so a split
  and a plain list over one table each keep their own room. Startup and
  `--check-app` no longer name it as preview.
- **A lead is qualified, not approved.** Ignition's lead gate says
  `qualified` where it said `approved`, so a lead's step is never read as a
  loan approved: `qualifyLead` replaces `approveLead` (the Qualify action,
  singly or on a selection in New leads), and the lead's `qualified_by` and
  `qualified_on` replace `approved_by` and `approved_on`. A loan
  application's `approved` is unchanged. The lead table's CHECKs changed, so
  a lending file is reseeded rather than migrated.
- **A support session's audit, stored.** The groundwork for "enter as
  dealer": `provisionSqliteSupportAudit` and `migratePostgresSupportAudit`
  (from `tablewalk/commands`) create the reserved `__tablewalk_support_*`
  tables beside the tenant store, once, under a new deployment secret,
  `TABLEWALK_AUDIT_KEY` (at least 32 bytes, kept apart from
  `BETTER_AUTH_SECRET`); `verifySqliteSupportAudit` and
  `verifyPostgresSupportAudit` report, by id, any session whose rows were
  altered. Every entry is chained with a keyed MAC to the one before it, the
  chain starts from the session's own columns, and the session carries a
  MAC'd tip, so an edited value, a deleted or reordered entry, a forged or
  rewound tip or an edited session no longer verifies and is never extended.
  A store under another App, store or key, a changed layout, an extra
  trigger or, on PostgreSQL, another role's privilege is refused and left
  unchanged. Nothing writes to it yet: support sessions, their audited writes
  and the read ledger arrive in later slices.
- **The platform realm (preview).** A tenant App may declare the operator
  that runs it (a lender over its dealers): `auth.tenancy.platform: { label }`,
  beside a `label` for what one tenant is called and a `profile` resource with
  one row per tenant. Every resource says whose its rows are, `owner:
  'tenant'`, `'global'` (reference data every tenant reads) or `'platform'`,
  and roles, menus, views, pages, home rules, signed-in forms and command
  references say which `realm` they serve. A platform member signs in to the
  platform context, which the tenant chooser offers under its label and a
  link opens with `?realm=platform`: it reads every tenant's rows under the
  policy's `resolvePlatformRows`, with the owner of each shown, and changes
  records only through commands registered with `realm: 'platform'`. Those
  write the operator's own rows and update a tenant's, across tenants and all
  or nothing, and never create, delete or move one. A tenant's context never
  reads a platform row, whatever its policies grant. One browser tab switches
  between a tenant and the platform context. SQLite and PostgreSQL.
- **Tenant store 2 and command journal 4.** The tenant store records whether
  a row is a tenant or the platform, and what kind each membership is. The
  command journal keeps each receipt in its realm, so a platform command and
  a tenant's never answer for one another, and every audit row names the
  tenant that owns the record it changed, read from the record itself.
  Startup refuses an older store or journal, and the provisioning helpers
  leave one unchanged.
- **The platform realm's commands in the browser.** The platform context
  offers its own commands as record actions, exactly where a tenant's context
  offers a tenant's: only on the platform lease, only commands registered with
  `realm: 'platform'`, and only to a member whose platform role grants one. A
  tenant's context is never offered a platform command, and the platform
  context presents nothing to edit, since it writes through its commands only.
  The tenant guide and the site's tenant section document the platform realm,
  and the startup docs now give tenant store 2 and command journal 4.
- **A notice for a role that can do more than read.** When a connection that
  is not writable opens over a PostgreSQL or MySQL role that is a superuser,
  holds a write grant or may `CREATE`, tablewalk says so once on stderr. Reads
  still run in read-only transactions; the getting-started guide's "Database
  roles" section shows a role that can only read.

## 0.3.0

The App platform: a data-only TypeScript DSL that turns a database you
already have into an application, served by the same `npx tablewalk` with no
build step. The standalone database browser is unchanged and still launches
on its own. Browsing stays read-only; editing is a per-connection opt-in
(`"writable": true`) enforced at the adapter, and an App can only narrow it.
A feature marked preview may change shape before 1.0; startup and
`--check-app` print one `preview:` line for each one an App uses.

### Apps and the DSL

- One vocabulary. The root is grouped as identity (`id`, `name`), data
  (`connection` or `sources`, `resources`), auth (`auth`), content (`views`,
  `pages`, `features`, `home`, `nav`) and chrome (`ui`). Every place takes a fixed set of
  keys, and an unknown key is refused with the keys that place takes.
- Resources. One `resources.<table>` block per resource holds everything the
  App says about it: its `physical` binding, its `access` ceiling (`'read'`
  or `'write'`), a column ceiling (`fields`), `display` rules, `validation`
  (preview), column `labels`, the New `form`, `actions` and its record
  `page`. Every table a view shows is a declared resource; an empty block,
  `{}`, is enough. A resource's New form and actions reach its records
  wherever they open, and its captions name the column everywhere it shows.
- Views. Everything a visitor can open is keyed in `views`, of kind `list`,
  `dashboard`, `form` or `landing`; the key is the view's address. A list
  view has `show`, `tabs`, quick `filters`, a standing `query`,
  `open: page | peek | modal`, `quickAdd`, `sizing` and a `presentation`:
  checklist, keyboard-first queue with bulk actions on exactly the selected
  records, board whose cards move only through the resource's own actions,
  or split list/detail (preview). A dashboard has metric (with compares,
  `previous period`, `better` and `spark`), breakdown, chart, matrix, list,
  board and note sections, embeds of list views, time windows,
  pick-filters and refresh.
- `home` is required: a view id, or ordered rules that end with a rule for
  everyone. Nothing is inferred from `nav`.
  The server evaluates the rules on every request, from the verified
  session's roles (in a tenant App, the current membership's), so a manager
  and a viewer can start on different views. A signed-out rule opens a
  landing or a public form, and a rule whose view a visitor cannot open gives way
  to the next. `/api/app` carries each person's home, and the signed-out
  who-am-I names only a public one.
- `nav` is optional and only arranges references: view ids, `{ view, label }`
  and `navGroup`s, nested up to eight deep. An App without it draws no menu.
  The folded top menu drills in only when a group holds another group;
  otherwise it shows labelled sections, every room one tap away. Menu counts
  are live and bounded, and show `10,000+` past ten thousand.
- Features. An App can list `features`, ordered slices written with
  `defineFeature`: views, pages, a nav fragment the App places with
  `{ feature }`, how resources present, home rules appended after the App's,
  and grants to the App's roles within its ceilings. Identical facts merge,
  conflicting ones are refused naming both contributors, view, page and nav
  group ids are global, and a refusal or problem about what a feature wrote
  names the feature. The effective authority is committed beside the App as
  `authority.lock`: `--check-app --write-authority` writes it, `--check-app`
  fails on any difference, the server refuses to start an App whose authority
  differs from its lock, and a reload that changes authority waits for a
  restart.
- Pages, keyed by id or one `pages/<key>.json` file each: fields, summaries,
  side panels, workflow strips, timelines, related lists with contextual
  creation, breakdowns and metrics. Full pages and modals edit with explicit
  Save, opt-in blur autosave (`ui.editing`), exact-image Undo and honest
  pending and uncertain outcomes.
- Forms: a resource's curated New form and Quick Add with defaults, groups
  and `visibleIf` fields; multi-step `form.steps` (preview). Resource
  `validation` rules (preview) — `required`, or `compare` with another field
  or a constant, each with an optional `if` — hold on every write, and a
  refused Save marks the field.
- `auth`: Better Auth sign-in (email, GitHub, Google; invite or open
  sign-up) with a SQLite or `postgres://` session store, `rows` (`all`,
  `policy`, `tenant`) and `roles` that grant reads, writes, commands,
  operator reads (`readiness`, `bundle`) and columns within the resource
  ceilings. An omitted grant denies.
- `ui`: shell placement, visibility, width and gutters; nine built-in themes
  and `ui.customThemes` from `defineTheme`; editing, export, locale, time zone
  and currency.
- Command forms (preview): a `form` view, `commandForm(label, command,
  steps?, options)`, runs one command that creates records, drawn as a
  stepper when it has steps, with a done screen. It is signed in — a room for
  the roles granted its command, run through the signed-in grant — unless it
  says `public: true`: then it is served to anyone at `/{app}/form/{key}` and
  runs one command registered with `public: true` under a public principal,
  rate limited per client and in total. Richer command inputs: `date` (with
  `min`/`max`), `choice` (radios for a few options, a listbox for more),
  `group` sections nested at most two deep, and `repeat: { min, max }` rows
  people add and remove; a form's steps may name groups. A command's input is
  declared once, browser-safe: `defineCommand` takes the same field list as
  its `commandRef` (a difference is refused at startup), the server derives
  the parser from it and names nested refusals (`vehicles[1].stock`), and a
  command adds only `validate(input, context)` for its own rules.
  `initial(context)` prefills a record action's form through prepare, read
  in the revision's transaction within the command's footprint under the
  same authorization as execution. Caps: 32 fields a list, 128 in all, 50
  rows (10 on a public form) and 32 KiB of public input. Landing
  pages (preview): a landing view is the signed-out front page at `/{app}`
  and `/{app}/welcome`, content only, reading no data.
- Business commands: `tablewalk/commands` with typed input, durable receipts
  and audit on SQLite and PostgreSQL, idempotent replay and truthful uncertain
  outcomes. `targets: 'many'` commits a queue's selection in one transaction,
  with one audit row per target in command journal version 3.
- Named sources bind several databases; each operation stays source-local.
  Row policies (`auth.rows: 'policy'` with `--policy`) scope reads, and on
  SQLite and PostgreSQL scope updates, creation, Undo and, with a
  deleted-record policy, deletion and restore.
- `defineApp` checks the App's own references in the editor — nav, home,
  embeds, calls to action, roles and `resources.*.page` — and schema-typed
  names check tables and columns. `--check-app` judges the rest against the
  catalog, names a view by its key, and names a resource whose actions or
  form cannot run on the connection, withholding them rather than breaking
  every list over it.
- Four public samples with seeds and READMEs, Tick, Thread, Compass and
  Ignition, and a Docker Compose that runs all four.

### Tenancy (preview)

- Tenant Apps (`auth.rows: 'tenant'` with `--policy`) run on one provisioned
  SQLite file or dedicated PostgreSQL database: membership admission, per-tab
  contexts, ownership injection, record history, business commands and
  tenant administration (**Account → Manage tenants**). On PostgreSQL the
  source is a database of its own, every visible table a declared resource or
  a reserved `__tablewalk_*` table, and revocation is fenced by row locks held
  to COMMIT. A tenant App's sign-in may use a `postgres://` auth store.
- `tablewalk/commands` exports the one-time maintenance steps a deployment
  runs before the first start: `provisionSqliteTenantStore` and
  `provisionSqliteTenantAdministrationJournal`, and on PostgreSQL
  `migratePostgresTenantStore` and `migratePostgresTenantAdministrationJournal`
  under the server-wide maintenance advisory lock. Each is idempotent on the
  exact layout and refuses anything else unchanged. Startup and `--check-app`
  attest and never create.

### Security

- MCP `sql` and `explain` refuse statements that touch tablewalk's own
  runtime and sign-in tables, checked both in the statement's text and in
  what the database says it reads, so a view or a search path cannot reach
  them. Every MCP call that runs SQL has a statement timeout (30 seconds by
  default; `timeout_ms` lowers it) and stops when the client cancels it, and
  counts in `query`, `breakdown` and `record` stop at 10,000 and say so.
- A public command's audit keeps the shape of each write, not what the
  applicant typed. `defineCommand` takes `audit: { redact: 'values' | string[] }`;
  a public command defaults to `'values'`, a signed-in one keeps full values
  unless it says otherwise. Receipts, replay and the idempotency fingerprint
  do not change.
- The public forms' rate limit reads `X-Forwarded-For` only from a trusted proxy:
  loopback always, and the addresses and ranges named with `--trust-proxy`
  (or `TABLEWALK_TRUST_PROXY`), walking the header from the right past every
  trusted hop. It feeds rate limiting only; `--trust-proxy-header` and
  sign-in are separate.

### Operations

- Durable jobs (preview). `--jobs <file>` loads a server-only `defineJobs`
  module (`tablewalk/jobs`) beside `--commands` and one `--app`. A job starts
  on a committed command event, is due when its schedule says, and runs one
  command as a principal the server declares with App role names, authorized
  again on every attempt; every hop is keyed by the event id, and an attempt
  after the first looks the command's receipt up before running.
  `tablewalk/commands` exports `defineEvent` and `defineEventProjection`, and
  `tablewalk/maintenance` provisions an App's event store and a jobs
  deployment (`provisionSqliteJobs`, `provisionPostgresJobs`). Readiness
  reports `jobs` and `events.delivery`. Ignition's review clock flags an
  application whose review date passes undecided.
- `tablewalk/maintenance` provisions, inspects, redrives and prunes the
  durable job store and event delivery, on SQLite and PostgreSQL. On
  PostgreSQL, delivery follows each batch's transaction id and never moves
  past a transaction still running, so an event whose transaction commits
  late is never skipped. Delivered receipts are pruned by age in bounded
  batches without being discovered again, and failed or unknown work can be
  redriven up to three times, each redrive recorded with its operator.
- Opt-in HTTP diagnostics and metrics, and `GET /api/operations/readiness`
  and `/api/operations/support` for roles granted `operations`.
- PostgreSQL reader and writer pools with transaction leases, and
  `migratePostgresCommandJournal` and `migratePostgresAuthStore` for its
  command journal and sign-in store.
- `npm test` audits exports, checks the repository's structure (module size
  ceilings, module headers, import layers), fails if a removed spelling
  returns, and parses every whole-App example in the documentation with the
  App parser.

### The browser

- The client renders through React with Base UI headless behaviour; the
  explorer grid, walk and query bar are unchanged in use.
- Paging, page size and a column header's sort or filter redraw the explorer
  table in place. `/api/count` and `/api/run` take an optional `countLimit`.

### Fixes

- HTTP servers keep idle connections for 65 seconds, above the idle timeouts
  of common reverse proxies and load balancers, so a proxy reusing a pooled
  connection no longer meets a reset as the server closes it.
- A record picker, a command form's reference field and the palette's record
  hits no longer offer a stale first row while a search answers. Until the
  answer for the current text lands, they offer only the rows whose label
  contains it, and do not say nothing matches.
- The docs site's search sits at the right of the header with the GitHub and
  theme controls on every page, and the home page's title reads "Tablewalk —
  follow the data, build the workspace".

### Removed

Since the framework has no users yet, nothing is kept for compatibility:

- Fallbacks for the former product name: its config files, stored
  credentials, keychain entries and browser storage.
- `#/` links, the MCP `table` tool's `name` alias, `TABLEWALK_AUTH_SECRET`,
  comma-joined page paths, the `conn` request field on App servers, the
  version-2 command journal upgrade and the bare `tablewalk` package import.
- The unused event inbox, consumer and authoring modules. The outbox and
  durable delivery stay.

### Known limits

- MySQL has no durable command execution and no scoped writer. Tenant Apps
  run on SQLite and PostgreSQL, not MySQL; invitations stay private and
  SQLite-only, and so do tenant command events.
- The PostgreSQL sign-in store must be solely the connecting role's and apart
  from every business connection; startup checks both. Store URLs expand
  `${NAME}` only. MySQL is not an auth store.
- Jobs run only a registered business command, under a service principal
  the `--jobs` module declares, on one source that holds the job store.
  Recurring schedules, and jobs for tenant or row-policy Apps, are not in
  this release.
- A public form is the one anonymous write route, and it is bounded: one
  command per form, fixed rate limits, no applicant identity, status lookup or
  upload, and not on row-policy or tenant Apps. Signed-in forms are not on
  row-policy or tenant Apps yet either.

## 0.2.0

App mode: a directory of configuration that curates the browser into an
application. Published August 30, 2026.

## 0.1.0

The database browser with MCP tools, deep links and saved pages.
