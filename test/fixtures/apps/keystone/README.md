# Keystone

One lending platform, six Apps under one canonical address and one process, with
an explicit public host for the dealer storefront. A suite-owned
account signs in once; explicit App grants, row policies and tenant memberships
decide what it can open.

| Address | App | Try |
| --- | --- | --- |
| `/` | Suite entry | Sign in once; a saved App preference, then the suite's landing rules (lender staff to Lender, Leads members to the lead desk, managers to Dealer, borrowers to Customer), else the chooser |
| `/?app=lender` | [Lender](lender/README.md) | Explicit root App entry: underwriting, funding, servicing and dealer relationships |
| `/leads/` | [Lead desk](leads/README.md) | A dealership's leads and applications, with tenant isolation |
| `/dealer/` | [Dealer settings](dealer/README.md) | Branding, publication, listings and team management |
| `/site/` on the dealer host | [Dealer site](site/README.md) | Public inventory and dealer-scoped inquiries |
| `/marketplace/` | [Marketplace](marketplace/README.md) | Vehicle browsing, shortlists and rate checks |
| `/customer/` | [Customer servicing](customer/README.md) | A borrower's loans, payments, documents and autopay |

The example uses synthetic data. Its commands do not lend money, collect
payments, contact a credit bureau or send a real application to a lender.

## Start a fresh demo

Use Node 24, PostgreSQL, an operator-provided HTTPS reverse proxy and a source
checkout with dependencies installed. The bare `/` is the suite entry, not an
unconditional Lender destination; `/?app=lender` still requires a Lender grant.

### Prepare the HTTPS addresses

The commands below assume these two local HTTPS endpoints are already configured:

| Browser address | Purpose | Reverse-proxy upstream |
| --- | --- | --- |
| `https://keystone.localhost` | Canonical suite address for sign-in and the chooser | `http://127.0.0.1:4880` |
| `https://liberty-ford.localhost` | Public Site placement for dealer `liberty-ford` | `http://127.0.0.1:4880` |

Configure your TLS reverse proxy to listen on port **443** for both names, using
a certificate trusted by your browser that covers both hostnames. Both names
must resolve to the local proxy; if your resolver does not resolve `.localhost`,
add `127.0.0.1 keystone.localhost liberty-ford.localhost` to your local hosts file.
Forward the complete request path and query unchanged, including `/site/` and
`/_mistri/apps`. Preserve the browser's actual `Host` header
(`keystone.localhost` or `liberty-ford.localhost`) and `Origin` header; replacing
`Host` with the upstream's `127.0.0.1:4880` loses the public placement. A forwarded
host header is not a substitute for `Host`.

The launcher serves plain HTTP on loopback port **4880** behind that proxy; it
does not install a proxy, issue certificates or configure browser trust. Complete
that operator setup before using the demo. Public host mappings exclude bare
`localhost` and IP addresses, and named storefront origins require HTTPS.

### Seed and start

Create a dedicated empty database. Setup refuses to replace a runtime directory
or seed a database that already contains tables.

```sh
createdb keystone_demo
node --import tsx test/fixtures/apps/keystone/start-suite.mjs \
  --setup --database postgres://localhost/keystone_demo \
  --runtime /tmp/keystone-demo --port 4880 \
  --public-origin https://keystone.localhost \
  --site-host liberty-ford.localhost
```

Open **https://keystone.localhost/_mistri/apps** for the chooser and
**https://liberty-ford.localhost/site/** for the public dealership. Setup seeds
the database, provisions Leads' tenant stores and Site's placement journal,
creates five explicit demonstration accounts and starts all six Apps on one
listener. The default seed includes featured vehicle photos; `--photos none`
skips rendering them. `KEYSTONE_TODAY=2026-09-26` pins the fixture's dates.

Setup writes generated passwords and private keys only inside the runtime
directory. Do not commit or share that directory. `credentials.json` contains
the accounts, their exact grants, the membership expiry and public intake links:

| Persona | Explicit App access |
| --- | --- |
| Lender administrator | Lender administrator; Customer App administrator |
| Dealer owner | Leads owner and App administrator; Dealer manager and App administrator; Site web administrator and App administrator |
| Dealer support | Leads platform support; Lender relationship manager |
| Borrower | Customer borrower, linked to one customer record |
| Shopper | Marketplace customer and App administrator |

The operator bootstrap explicitly grants each App's first administrator. A
Lender administrator has no Leads grant. The owner's Leads and Dealer business
seats bind to the same stable account ID; email equality never supplies access.
Tenant memberships expire after 365 days. The chooser lists only granted Apps,
and each tenant App separately selects an authorized workspace. Sign-out from
any App ends that suite login everywhere.

Use the same canonical **https://keystone.localhost** origin when signing in.
Ctrl+C drains and closes the one suite server. Resume with the same runtime;
the saved origin, host mapping and listener port are reused:

```sh
node --import tsx test/fixtures/apps/keystone/start-suite.mjs \
  --runtime /tmp/keystone-demo
```

Keep the same HTTPS addresses and proxy routing on resume. Do not pass `--setup`
for an existing runtime or pass origin/host enrollment flags on ordinary resume.

## Enroll an existing suite runtime

For a ready suite runtime created before placement enrollment, stop its suite
process and prepare the HTTPS proxy above. Run this additive upgrade against its
existing directory (replace `/tmp/keystone-demo` with that directory):

```sh
node --import tsx test/fixtures/apps/keystone/start-suite.mjs \
  --runtime /tmp/keystone-demo --upgrade-placement \
  --public-origin https://keystone.localhost \
  --site-host liberty-ford.localhost
```

The upgrade enrolls Site's policy, origin, host and dedicated issuer, explicitly
provisions its placement journal, then exits. It preserves the business database,
accounts, grants, credentials and saved listener port; it does not reseed or
reset passwords. It can be retried with the same enrollment. If the runtime
already has a canonical `publicOrigin`, the upgrade must use that same HTTPS
origin; it cannot replace one. Point the proxy at the runtime's saved port if it
differs from 4880.

Then use the resume command above with the same runtime directory. Ordinary
resume requires enrollment and an intact journal; it never provisions the
journal automatically. `--setup` is only for a new runtime and empty database.

## See what the Apps do

Server output is in `logs/suite.log`; seeding output is in `logs/seed.log`.
The launcher prints URLs and file paths, not passwords. `suite.json` records the
App mounts, policy/job owners and environment aliases. Identity and grants live
in separate SQLite files; Leads' captured audit key remains separate from the
suite sign-in secret. Placement has its own persisted 32-byte base64url issuer
key, passed through `KEYSTONE_PUBLIC_PLACEMENT_KEY`, and a stable source identity
bound to the physical PostgreSQL database and logical `keystone` source. It does
not reuse the sign-in secret. Each startup captures a fresh placement epoch and
the current policy hash while retaining the issuer key and source identity.
Restart preserves accounts, grants and sessions.

From the chooser, open Leads as the dealer owner, select the dealership and
submit a structured deal. The lender reads that same application. The public
Site and Marketplace remain available without App grants. Signed out at
`https://keystone.localhost/site/`, Site is a neutral, unplaced shell rather than
a default dealership. The explicitly mapped dealer host admits inventory,
record-derived branding and placed forms only for an active dealer with a
published site. Inquiry, test-drive and financing submissions are scoped to that
dealer, with eligibility rechecked during the write. The credential
file's intake links open Leads' saved application form. Support uses its own
platform membership and a recent sign-in before entering a dealer.

The older `start.mjs` launcher and individual provisioning scripts remain useful
for independent-App deployments. Their runtime files are separate: use a new
runtime directory and database for the shared suite. Failed setup is not resumed
or repaired automatically.

## Change the example

[SUITE.md](SUITE.md) explains how the Apps share records. The
[database guide](../../databases/keystone/README.md) describes seeding and
individual provisioning steps. The launcher runs source directly; a package
build is not required.

The committed `authority.lock` files describe the Apps' grants and command
contracts. Ordinary setup and restart enforce them. When deliberately changing
an App, inspect `mistri check` and explicitly update its authority lock with
`--write-authority`; a durable command contract change also needs `--bump`.
Launching the demo never rewrites these locks.
