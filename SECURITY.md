# Security

## Reporting

tablewalk opens databases. If you find a way for it to read, write or reach
something it should not, please report it privately rather than in a public
issue, by email to security@mistriwork.dev. You will get an acknowledgement
within a few days and a fix or a reasoned answer as soon as one exists.
Credit is given in the release notes unless you would rather it were not.

## The model, in short

- **Read-only by default, per connection.** Writes exist only behind
  `"writable": true` in the config, checked by the server in every route
  and tool that writes (the Workbench's write routes, the MCP write tools,
  an App's saves and commands) before a statement reaches the database; the
  adapter does not check it, and runs whatever it is handed. Every read runs
  in a read-only transaction. The database role is the limit that holds
  whatever the server does, so connect as one that can only read where
  nothing should write. Retargeting a connection makes it read-only again.
- **Loopback by default.** The server binds `127.0.0.1`. Every request is
  checked against the `Host` it arrived for (the DNS-rebinding defence),
  and writes are checked for `Origin` and content type.
- **No authentication.** Anyone who can reach the port can read every
  connection the server holds and add network connections of their own.
  Bound beyond loopback the server stops trusting the browser with
  environment references, keychain lookups, SQLite file paths, config
  saves and redirects of config-named connections, and dials a URL it typed
  sealed: no user or password filled in from `PG*` variables or `~/.pgpass`,
  and no loopback, private or link-local (cloud metadata) address — but that is a line
  between "your machine" and "the network", not a login. Anything reachable
  past a private network belongs behind a proxy that authenticates — and
  `--auth-proxy-header` carries that proxy's decision in, refusing requests
  that skipped it or carry it from a peer that is neither loopback nor in
  `--auth-proxy-from`, and journaling every write with who made it.
- **Queries compile to structure, never to SQL text.** Every value is a
  bound parameter; table names are checked against the catalog before being
  quoted; raw SQL runs one statement at a time inside a read-only session
  and is bounded by a LIMIT wrap.
- **An app directory is code.** `app.mjs` / `app.ts` manifests are
  evaluated in a worker with the server's privileges and hot-reloaded on
  save. Keep the directory writable only by the account running mistri.
- **The page talks to its own server alone.** The shell every App and the
  Workbench are drawn in carries a Content-Security-Policy: scripts come from
  the server (and its inline startup scripts, pinned by hash), requests
  go to the server (`connect-src 'self'`), no plugin or frame of another
  origin loads, and no other site may frame the page. Images may still come
  from any https address, since an App can name a picture by URL. Every read
  and write is authorized on the server regardless; the policy is what keeps
  a script from sending what the reader sees anywhere else.
  Every answer also carries `Referrer-Policy: strict-origin-when-cross-origin`
  and a `Permissions-Policy` that grants no camera, microphone, location or
  payment sheet, and an answer that arrived over https (TLS, or a trusted
  proxy's `X-Forwarded-Proto`) carries `Strict-Transport-Security`.
- **A custom component is deployment code.** An App may draw part of a page
  with its own React module (`component()` in the App directory). It is
  trusted like `app.ts` and `commands.ts`: whoever can write the App
  directory already runs code. It runs in the reader's browser with the
  reader's session and can reach nothing the reader could not through the
  App — every read is authorized on the server, and the policy above keeps
  its requests on the server's origin, and on the origins the App names in
  `ui.csp` — each recorded in its authority.lock. It changes
  data only through the App's commands, on the one command pipeline. It is
  compiled with the server's modules, Node's builtins and its environment out
  of reach, and `mistri check` fails a component that turns text into
  markup or code (`dangerouslySetInnerHTML`, `innerHTML`, `eval`,
  `new Function`). A signed-out visitor meets one only over what
  `auth.public` opens, reads only through the public grant and runs no
  command; landings, public forms and tenant Apps draw none. In an App that signs people in, a component's
  compiled files are served to a signed-out visitor only where `auth.public`
  opens pages to them, its source map never, and neither is kept by a shared
  cache. The lint reads text, not a parse, and is heuristic: `mistri check` fails
  on it and so does every load, serve or `dev`, which refuses to serve the
  component. An App's author is trusted, so it is a guard against accidents,
  not a sandbox; the policy above is the boundary.
- **Every read an App serves is the reader's own read.** A streamed export
  (`/api/export`), a list's batched tab counts (`/api/counts`), a bounded
  total, a rollup and a record's history are each answered through the same
  authorized reader as the list: the reader's table and field grants, row
  scope and row policy. An export or a count that names a field the reader
  may not read is refused, not narrowed into an oracle. A rollup is the
  catalog's, never the request's, and is served only where the reader can
  read its child rows, the reference and the column it sums. A record's
  history is read only after the reader has read the record, and a field
  they may not read says that it changed with no values. A history entry, a
  dashboard's activity and a notice name the writer by the name their
  account had when they wrote, or as "Someone"; the account's email is kept
  in the store and never answered to a reader, and a name that reads as an
  address is not kept at all. A signed-out
  visitor never exports or reads a history; an export is refused inside a
  row-policy App and a tenant host.
- **A hidden column is never served.** A resource's `hidden` (with sign-in
  or without) and a connection's `"hidden"` in tablewalk.json cut columns
  from the catalog the server answers with, at the choke point every read
  goes through: the App's authorized reader, and for the connection the
  adapter itself, so the Workbench, MCP and every App on it inherit it. A
  query, filter, sort, walk, export or count that names one is refused as
  naming a column that is not there, a history keeps no value of it, and raw
  SQL is refused on a connection that hides columns. It is not a database
  privilege: anyone with the connection URL still reads the column, and a
  role without `SELECT` on it is the stronger boundary.
- **A declared reference is a join, never an authority.** A resource's
  `references` (a soft key the database holds no foreign key for) is an edge
  in the App's catalog only, so the reader's grants and hidden columns prune
  it as they prune a real key, and a request cannot supply one. No write
  check, cascade or delete impact reads it, and a row-scoped catalog carries
  it for paths only, outside the fingerprint attested against the database.
  Into a source on another connection it is read in a second step through
  that source's own reader and row scope, so a label never names a row the
  reader could not read there; a tenant App's stay within its one source.
- **A public page's head is text.** For a signed-out visitor to an App with
  `auth.public`, the server writes a public record's name into the shell's
  `<title>` and a canonical link, escaped, and answers other spellings of
  its address with a 301 to a path on the same site. It reads the record
  with the public grant alone.
- **A tenant login's admission is kept, its fences are not.** A tenant host
  keeps the membership evidence one login was admitted with and starts that
  login's next request from it rather than reading it again. It keeps evidence
  only — never grants, row scopes or a refusal — keyed by the deployment,
  store, source, account, the native session instance and the tenant, served
  only inside the evidence's own validity window and only after the session
  is verified again, dropped on sign-out and whenever the evidence meets a
  refusal. Nothing depends on it being current: every read revalidates the
  membership in the snapshot its rows come from, and every write holds the
  tenant and membership rows locked to COMMIT, so a revoked member is refused
  within one request. Stale evidence is admitted afresh once, and only before
  anything could have been written. A writer transaction likewise attests each
  reserved store it uses — the tenant store, the administration journal, the
  support audit — in full once, and every later fence rereads, in the same
  round trip, what the lock that attestation was taken under does not hold
  still: under the tenant store's `ROW SHARE`, triggers, indexes and keys;
  under the journal's and the audit's `ROW EXCLUSIVE`, which makes those
  wait, index definitions; and under every lock, grants, ownership, new
  reserved tables and the store's binding. A savepoint rolled back forgets
  the attestation (docs/postgresql.md). A platform read is refused on a
  revoked membership by the read's own snapshot or by the release fence after
  its last read, as a tenant read is; the context owner no longer observes
  the membership a third time after that.
- **Revalidation is per person.** Metadata (the schema, the App, its pages)
  is `private, no-cache` with an ETag that covers the principal as well as
  the bytes, and `Vary: Cookie`; one reader's tag never validates for
  another. A picture drawn in place (`/api/file?inline=1`) is tagged by its
  bytes, but the read and its grants run before any 304; for anyone signed
  in it is `private, no-cache`, so a sign-out or the next account on a shared
  browser holds at once. An App without sign-in, or a signed-out visitor to
  a public one, may keep a picture for an hour: that reader is nobody in
  particular, and the saving is the accepted trade.
- **An App's accounts are its administrators'.** In an App that signs people
  in, an account holding the `admin` role manages the others from the account
  menu: adds them, sets their roles, deactivates them, sets a new password.
  The route checks the verified session alone and Better Auth's admin plugin
  checks it again; an administrator cannot demote or deactivate themself.
  Better Auth's own endpoints for the same changes (`/api/auth/admin/set-role`,
  `ban-user`, `unban-user`, `set-user-password`, `update-user`, `remove-user`)
  and for signing in as another account (`impersonate-user`) answer 404, so
  every change goes through the screen and its trail.
  Every change writes a row of the account-administration trail, the
  `accountAudit` table of the App's own sign-in store (the SQLite file, or
  `mistri.auth_account_audit` in the PostgreSQL store), in the same transaction as
  the change: a change whose row cannot be written is rolled back and not
  made. A row names who (the account and its email), when, the action, the
  account changed, the fields it changed as they were and became, and the
  request's principal (the actor's own session, or an administrator
  impersonating them). An account made on someone's behalf writes one too,
  in the transaction that makes it: by the operator's `createAppAccounts`
  maintenance step (principal `maintenance`, no actor account), or by an
  invitation's claim (principal `invitation:<id>`, the new account its own
  actor, since the invitation's token is what vouched). It never holds a password, a password hash, a session
  token or the signing secret; a new password is recorded only as set. The
  table is append-only — triggers on SQLite, rules on PostgreSQL, which bind
  the owner and a superuser too — and both stores' exact-layout checks count
  it, so a table they do not expect is still refused. **Retention: none.**
  mistri never prunes the trail; it lasts as long as the store. An
  operator who must prune it does so in maintenance, by hand, with the
  guard dropped and restored. Administrators read it from Manage accounts
  (History, or an account's own); after a change commits, the same fact is
  one line in the server's log.
- **An anonymous public form is write-only.** Whoever fills one in is told
  a receipt and the author's fixed words, never anything typed or stored:
  startup and `mistri check` refuse a public command whose output shape
  could carry anything else, and nothing reads by a receipt alone. A form
  saved on every step (`save: 'each-step'`) writes the App's real tables as
  the applicant goes. It finds the application only through an HttpOnly,
  SameSite=Strict cookie scoped to the form's API path, holding 256 random
  bits, whose SHA-256 alone is on the root row. That hash is cleared on
  submit, and a forged, expired, finished or copied-after-submit cookie finds
  nothing and gets one answer. A step's transaction is fenced to its own
  application: the root by its key, the rows beneath it by their link, which
  the server fills. A step writes no column the platform keeps and never
  moves the draft state. The page draws its review from memory alone and
  never from browser storage. The one sanctioned read is a declared status
  check. It takes the random receipt plus one to three confirming details,
  answers a state in the author's words, gives the same reply in the same
  time for any wrong answer, and locks a receipt after five failures. A
  detail declared `keyed` is stored and compared only as an HMAC under
  `MISTRI_FORM_KEY`, and never journalled or logged. Its page marks no
  field for a refusal, so it never says which detail was wrong. Every attempt
  is one line in the server's log (the outcome, a digest of the receipt, the
  signed-in account), and the attempt that locks a submitted application's
  receipt stamps a declared `alert` column that the App's own `notify` rule
  turns into a notice for staff. A saved form's token hashes are never kept
  in a record history. A declared step-up opens more than the state only with
  a six-digit code sent to the application's own email column, never an
  address a request names, and only beside the check's details asked again:
  a code works once, for ten minutes, burns after five wrong tries, is kept
  only as a digest, and three go to an application an hour; sending is not
  waited on, so the clock does not tell a found application from a missing
  one. The session it opens is fifteen minutes in one browser (HttpOnly,
  SameSite=Strict) and shows only the declared details.
- **An application joins an account on proven control, never on matching
  data.** A name, a birth date or an SSN that matches links nothing. A saved
  form's `link` allows three proofs: this browser straight after submitting (a
  30-minute claim in an HttpOnly, SameSite=Strict cookie, its SHA-256 on the
  root, spent only by a signed-in "Yes" on the account screen the done screen
  leads to, and burned by "No", "This is a shared device", signing out, its
  expiry or the next application), a signed-in status check, and an account
  email the sign-in store has verified that matches the address the
  application captured. That last one only offers: each application is
  linked by its own "Yes", since anyone can type someone else's address into
  a form; it links without asking only where the applicant also proved that
  address with a code in the form, and the address proved is still the one
  on the application. An unverified account email matches nothing. The link is
  one compare-and-set write of the root's owner column, with when and by which
  path beside it; it is refused when the application already has an owner,
  counted in a budget of its own, recorded in the record history as the
  account's write and in the server's log. Once linked, the application is
  read only through its owner's session, and the anonymous status check no
  longer answers for it. Where the server sends email, the account is told
  that the application was added.
- **Email goes only to accounts that may read what it says, after the write
  commits.** The one email service is the config's, with `${VAR}`
  credentials, TLS required (`smtps://`, or `smtp://` offering STARTTLS)
  unless the connection says `"insecure": true`, and its host resolved under
  the shared network rules. A notice's email is queued in the write's own
  transaction and sent after it commits, never from inside it; the sender
  asks again, as the recipient, whether the address is an account of the
  App, whether it turned email off, and whether its grants may read the
  record now, and drops the message otherwise. Its words are the inbox's for
  that reader. An @-mention is resolved on the server through the people
  table and tells only someone who may read the record. A failed send is
  retried with backoff and never fails the write.
- **A role granted a fixed action writes that action and nothing else.**
  `roles.<role>.actions` lets a role run a named fixed action on a resource it
  does not write. The server admits the update only when it is exactly that
  action (its `set`, its reason, its `when` on the stored row, inside the
  write); any other column or value is refused whole.
- **An inbound webhook is a signature over a signed time.** `hmac()` refuses
  a declaration without `timestamp` (at load, so serving and `check` both stop
  on it), and the timestamp must be in what is signed: a delivery outside its
  `window`, or one whose signature covers the body alone, is refused. The
  command's receipt makes a retry inside the window idempotent; the window is
  what stops a captured delivery from running again after its receipt is
  pruned. An unknown endpoint answers `404` and a known one `401` to an
  unsigned call, so endpoint names are discoverable; they are not secrets,
  and the signature is the credential.
- **A workflow is one App's.** On a PostgreSQL database several Apps share,
  each App's workflow store is its own namespace (its job namespace): an
  operator with `operations: ['workflows']` lists, cancels and retries only
  that App's instances, another App's id is `not_found`, and a signal wakes
  only that App's waits. Every Cancel and Retry is kept in the instance's
  history with the operator who made it.
- **A role from claims is the provider's.** A grant derived from an identity
  provider's claims (`auth.roles.<role>.claims`) counts only for a session that
  provider opened, in a suite and in a single App. A password session of the
  same account, or one another provider opened, does not get it, so roles the
  provider takes away cannot be kept by signing in another way. A role set by
  hand counts for any session. A claim rule may name its provider
  (`claims: { provider: oidc('workforce'), … }`): a sign-in through another
  never reads it. A rule without one is read from any of the App's
  providers, and `mistri check` warns of it where the App has more than
  one.
- **The analytics beacon has a budget.** `/_mistri/analytics` takes at
  most 20 events and 16 KB a request, 300 requests a minute per client
  (behind `trustedProxies`, the forwarded client) and 6,000 a minute in all,
  then answers `429`. Anyone who can reach the App can post within that
  budget, so a total can be skewed, never a person's data read; retention
  bounds what it costs.
- **Sign-in state falls back to the process.** Status-check lockouts and
  step-up evidence live in the rate-limit cache when one is configured. When
  the cache stops answering, each instance keeps its own, so during an outage
  a sender meets each instance's fresh budget. Step-up is not invented: a
  session the instance did not see is unknown and must step up again, and a
  suite session whose provider is unknown holds no grant derived from claims.
- **The test host's network guard is not a sandbox.** Under `mistri test`
  the guard refuses TCP connections (fetch, http, https, tls) that leave the
  host. DNS lookups, UDP and spawned processes are not covered: it keeps tests
  honest, and the App directory is trusted code either way.
- **`MISTRI_SERVER_TIMING=1` is for load testing only.** It answers every
  request with a `Server-Timing` header that includes the process's own state
  (heap, garbage collection, pool use and queues), to any requester, signed in
  or not. It names no statement, row or key, but it is a free look at how loaded
  the process is. Keep it off in production, or set `MISTRI_SERVER_TIMING_TOKEN`:
  the process entry is then added only to a request that sends the token as an
  `x-mistri-timing` header. `mistri check --deploy` warns when timing is on
  without a token.
- **Credentials** come from the environment, the OS keychain, or a 0600
  file, and never reach the browser in any response.

The full account is in the README under *Read-only, and meant* and *What it
will and will not answer*, and in DEPLOY.md for containers.
