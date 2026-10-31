> Regression fixture retained for existing coverage. Start new apps from [Keystone](../../../../test/fixtures/apps/keystone/README.md).

# Forecourt

A used-vehicle marketplace, App ID `forecourt`: the public-site sample, and the
one about presentation. Anyone may browse it without signing in. A front page
has a studio photo, a search panel and the dealers' picks. A Vehicles list
draws cards — photo, price, the facts in one line, who sells it and where —
beside a rail of filters on the left (make and body ticked with their counts,
price and miles as ranges), with the chips that say the selection and a Sort
menu at the top of the results. Each vehicle page leads with a gallery and the car's key
facts, beside them an offer card with the price, a monthly estimate and two
ways to ask, then the car told in full and similar vehicles. Visitors
ask about a car through a public inquiry form that the car's page fills in.
Staff sign in to read the inquiries, which the public never reads.

Sixty cars from six made-up US dealers, with real makes and models, priced
in dollars and written in the en-US locale. Every photo is a studio render
the seed draws itself: no downloaded image and no maker's logo or badge. The
default look is Marketplace, Sage with a blue accent; Showroom, Canvas with a
deep racing-green accent, is also registered in
[theme.ts](theme.ts).

## Start

Use Node 24 or newer and install repository dependencies with `npm install`.
From the repository root, seed a disposable copy outside the watched App. The
seed runs under `--import tsx` because it migrates the command journal the
inquiry form needs. It takes about ten seconds to draw 211 photos, into a
12 MB SQLite file, and refuses an existing database or config.

The fresh fixture schema includes `saved_vehicle` for durable per-account
shortlists, `inquiry.account_id` for account-owned inquiries, and
`inquiry_activity` for private staff follow-up notes. No command needs a
version column: a stale form is refused by the record's own revision. The schema is the
migrations in `test/fixtures/databases/forecourt/migrations/`, which the seed
applies before it writes the rows, and `forecourt.db.json` names them, so
`npx tsx packages/mistri/src/server/index.ts migrate status --config "$forecourt_demo/forecourt.db.json"`
says what is applied. A schema change is a new migration there
(`migrate new … --migrations test/fixtures/databases/forecourt/migrations`).

```sh
forecourt_demo=$(mktemp -d "${TMPDIR:-/tmp}/tablewalk-forecourt.XXXXXX")
node --import tsx test/fixtures/databases/forecourt/seed.mjs "$forecourt_demo/forecourt.db"
npx tsc -p test/fixtures/apps/forecourt/tsconfig.json
npx tsx packages/mistri/src/server/index.ts check --config "$forecourt_demo/forecourt.db.json" --app test/fixtures/apps/forecourt \
  --policy test/fixtures/apps/forecourt/policy.ts
```

Then the private settings, which belong to neither the App source nor committed
configuration, and the server:

```sh
export XDG_CONFIG_HOME="$forecourt_demo/auth"
export BETTER_AUTH_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
export MISTRI_AUTH_ADMIN_EMAIL=admin@example.invalid
export MISTRI_AUTH_ADMIN_PASSWORD='choose-a-long-private-password'
npx tsx packages/mistri/src/server/index.ts --config "$forecourt_demo/forecourt.db.json" --app test/fixtures/apps/forecourt \
  --policy test/fixtures/apps/forecourt/policy.ts --port 4730
```

Open <http://127.0.0.1:4730/> signed out: that is the public site.
**Sign in** (top right) as the bootstrapped administrator to read the
inquiries. `XDG_CONFIG_HOME` keeps the login store beside the fixture, so an
existing local login database is never reused. Choose another port if 4730 is
taken.

## Reading order

1. [app.ts](app.ts): the App's identity, its one source, the resource ceilings,
   sign-in roles, `auth.public` (what
   a signed-out visitor reads: `vehicle`, `vehicle_photo`, `dealer` without its
   sales inbox, and `site_image`), where each visitor starts, the menu, the
   feature composition, row-policy auth, look, and en-US locale with prices in
   dollars. The App keeps the top-level ceilings and roles; `policy.ts` scopes
   account-owned rows to the verified session.
2. [resources.ts](resources.ts): prices in dollars, the monthly estimate
   ("$237/mo", a `unit` on a money rule), miles with their unit, battery
   health as a percent, the features as a list (`format: 'items'`, one per
   line in the database), status tones, captions, the two file resources (the
   vehicle photos and the front page's photo), plus the account-owned
   `saved_vehicle` and `inquiry` ceilings and private `inquiry_activity`.
   Inquiry and shortlist presentation and permissions are composed by features
   below.
3. [vehicleCard.ts](vehicleCard.ts): the one card presentation shared by the
   Vehicles list, Recommended, dealer pages and Similar vehicles. It declares
   the price, facts (year · miles · fuel · transmission), dealer name and
   city, highlight badge and lead photo dependency.
4. [views.ts](views.ts): the Vehicles list (standing on `status != sold`, with
   tabs, a filter rail (`filterBar: 'rail'`: make, model and body counted with
   counts, price and miles as ranges, the model year a checklist) and its named
   orders in `sort`: newest listings — the first, so the list opens on it —
   price either way, mileage, model year), the Recommended
   list (featured and unsold, the same for everyone), and Dealers.
5. [features/inquiries.ts](features/inquiries.ts): the public inquiry form,
   staff-only Inquiries list, inquiry display rules and actions, and the
   inquiry record page. It composes the public form and private follow-up
   workflow as one feature.
6. [features/shortlist.ts](features/shortlist.ts) and
   [shortlist.ts](shortlist.ts): the signed-in shortlist surface and its
   save/archive/reactivate commands. Every account, including staff, sees only
   its own saved rows across sessions.
7. [features/account-inquiries.ts](features/account-inquiries.ts) and
   [account-inquiry.ts](account-inquiry.ts): the signed-in vehicle inquiry
   action. It targets a verified vehicle version and stores the verified
   account as owner; an account sees its own inquiry status, while staff see
   the staff inbox and private history.
8. [landing.ts](landing.ts): the front page. The hero has its photo, an
   overlay layout, the search inside it and a line of highlights. The dealers'
   picks follow as cards, then How it works, questions in an accordion, a
   call to action and contact.
9. [pages/vehicle.ts](pages/vehicle.ts): the gallery first, with its steps and
   counter, and the key facts in one line under it (`presentation: 'facts'`).
   Beside them the offer, a headline in the side panel drawn as a card that
   stays in view: the price, the monthly estimate (`subfigure`) and its terms
   (`note`), and two actions that open the inquiry form with the car's stock
   number filled in (`prefill`), one of them with a test-drive message
   (`defaults`); under it the dealer. Then the car in the open, nothing to
   unfold: the dealer's words, the features as a list, specs and history as
   sheets (`presentation: 'table'`), and similar vehicles as the
   marketplace's cards: the same body type, within 25% of the price, the
   closest first (`similar`). The dealer's other cars are one click away,
   through the dealer. [pages/dealer.ts](pages/dealer.ts) is a dealer and
   their cars for sale.
10. The commands are server-only, each whole in one `defineCommand`: its
   input, its handler and what it acts on. [inquiry.ts](inquiry.ts) is the
   public form's, with the inquiry fields the account form shares;
   [inquiry-workflow.ts](inquiry-workflow.ts) holds **Record reply** and
   **Close inquiry**; and [commands.ts](commands.ts), beside the manifest,
   registers them by name. The App names them (`command: 'closeInquiry'`),
   typed by the generated `mistri-commands.d.ts`, and never imports them.
   Record reply stores a summary of a reply already sent and changes the
   inquiry to `replied`; Close inquiry stores the resolution and changes it
   to `closed`. Neither action sends email.
11. [policy.ts](policy.ts) is server-only row policy: catalog rows are public,
   account shortlists and account inquiries are scoped to the verified actor,
   and staff alone read the anonymous inbox and follow-up history.
12. [mistri-schema.d.ts](mistri-schema.d.ts) holds generated names,
   [authority.lock](authority.lock) every grant, and [tsconfig.json](tsconfig.json)
   the typecheck. The seed and photo renderer live in
   [test/fixtures/databases/forecourt](../../../../test/fixtures/databases/forecourt/).

After changing the seed schema, seed a new path and regenerate:

```sh
npx tsx packages/mistri/src/server/index.ts --config "$forecourt_demo/forecourt.db.json" --app test/fixtures/apps/forecourt --export types > test/fixtures/apps/forecourt/mistri-schema.d.ts
npx tsx packages/mistri/src/server/index.ts check --config "$forecourt_demo/forecourt.db.json" --app test/fixtures/apps/forecourt \
  --policy test/fixtures/apps/forecourt/policy.ts --write-authority
```

The schema export above does not load the private policy; the running server
and `mistri check` load it with `--policy`. Both read the commands module the
App keeps beside its manifest.

## Who may do what

- **Signed out**, a visitor reads the vehicles, their photos, the dealers'
  public columns and the front page's photo, and nothing else. Neither
  inquiries nor a dealer's email address are readable. The one write a
  visitor can make is the inquiry form's command. It runs under a public
  principal, reads `vehicle` only to file the inquiry against the stock
  number, writes one `inquiry` row and answers with a reference. It is rate
  limited per client, and its audit keeps the shape, not the values. This form
  always runs anonymously, even when the browser is signed in; it never claims
  an account from an email address.
- **A signed-in shopper** can save a vehicle and remove it later. Removing
  archives the account's row and saving the same vehicle reactivates it, so the
  shortlist survives a new session without duplicate rows. A shopper can also
  send an account inquiry against a verified vehicle; the inquiry stores that
  account as owner and exposes its own status only to that account.
- **Staff and admin** read the anonymous inbox and private history, and use only
  the explicit **Record reply** and **Close inquiry** commands for changes.
  Record reply stores the summary of a reply already sent and moves the
  inquiry to `replied`; Close inquiry stores a resolution and moves it to
  `closed`. Neither command sends email. Each note appears in the inquiry's
  **Follow-up history** timeline with its recorded time. The actor identity is
  retained for audit, while the UI intentionally hides opaque actor IDs.
  Staff and admin also keep separate account-owned shortlists; those rows do
  not become shared staff data.
- The connection is writable only because the public inquiry command and the
  two staff inquiry commands write through it. The App's grants keep every
  other write off.

A car's page opens the form with its stock number already filled in: the
The form's `prefillable` names the two inputs its address may fill, and the page's
actions write them there. That is where the form starts, never what it sends —
the visitor sees both and may change them, and the command checks them as it
checks anything typed. A public form still offers no picker over a table.

## Addresses

Signed out, the address is the thing on screen. A car is its id and its name,
`/vehicles/49-2019-tesla-model-3-long-range` (`slug: true` in
[resources.ts](resources.ts)), whatever list it was opened from; any other
spelling of it is answered with a 301 to that one, and the page's HTML carries
the car's `<title>` and a `<link rel="canonical">`. Signed in, staff read
`/vehicles/49`. The Vehicles list says its question in words:
`/vehicles?body_type=Sedan&price=..15000&sort=-price`.
A price band bounded at both ends in the rail reads `price=10000..20000`, and
several makes ticked read `make=Toyota,Honda`.
The walk that reached a page rides in the tab's history, so Back returns to
the list and its crumbs still say "Vehicles · Sedan". A question the list's
own filters cannot say is kept whole as `?q=`.

## What to try

Signed out, choose a make and a most-you-would-pay in the hero's search and
press **Show vehicles**. The Vehicles list opens with those conditions in its
own address, so a reload or a shared link keeps the result; choose
**Lowest price** from Sort. Narrow further from the rail on the left: tick a
second make, type a Max price and press Enter, and watch the chips above the
cards and the address follow; **Clear all** beside the chips takes the rail's
choices out. Open a card, step through the photos with the
arrows on the lead or in the lightbox (the arrow keys, or a swipe on a phone),
read the features and the history, and press **Schedule a test drive**: the
form already names the car. Send, and keep the INQ reference you are given.
Sign in and open the inquiry in **Inquiries**. Open its record to review the
contact, vehicle and message, then use **Record reply** to capture what staff
already sent or **Close inquiry** to record the resolution. Both actions ask
for a note and append it to **Follow-up history**; they do not send email.
Repeat at phone width.

## What a public site still needs

Forecourt runs as a public site on today's platform. These are the gaps it hit,
reported rather than worked around:

- **Server-rendered HTML.** Every page is drawn by the client after a JavaScript
  bundle loads. The server writes a public page's `<title>` and canonical link
  into the shell, but search engines and link previews otherwise see an empty
  shell, with no description or Open Graph image.
- **Catalog addresses.** A vehicle has one canonical, slugged address, but
  there is no `sitemap.xml` or `robots.txt`.
- **An image pipeline.** Photos are served at their stored size, 640×480 PNG
  (the hero's 1600×700), through the file route for every card and
  thumbnail. There is no resizing, no WebP or AVIF conversion, no `srcset`,
  and no upload path that makes those.
- **Caching at the edge.** File reads are cached `private` for an hour, and
  every data read is per visitor. A public catalog that is the same for
  everyone cannot be cached by a CDN or a shared proxy.
- **Limits on reads.** The public form is rate limited. The signed-out reads a
  browsing visitor makes (lists, searches, photos) have no per-client limit of
  their own.
- **Letting the dealer know.** An inquiry is a row. Nothing emails the dealer or
  the visitor, because there is no public webhook or outbox delivery. Staff can
  record a reply they already sent and close the inquiry with a resolution;
  those notes appear in its follow-up timeline. Beyond a rate limit there is no
  spam protection: no CAPTCHA and no honeypot.
- **Notifications.** The public and account inquiry commands record durable
  inquiries and references, but send no email or webhook notification. Staff
  can record a reply they already sent and close the inquiry with a resolution.
- **One public and staff experience.** Visitors and staff share one App. Staff
  get the menu entries the public cannot read, and the inquiry record provides
  explicit reply-recording and close actions, but there is no separate staff
  home or back office.
- **Consent, analytics and legal pages**: none of them are built in.

## Where it stops

The data is synthetic, and nothing reaches a real dealer. The monthly figure
is an estimate on stated terms, not a quote: there is no checkout, hold,
credit application or saved search. Photos cannot be
uploaded from the vehicle page (a gallery draws; it does not attach). Each
seed draws its photos again, deterministically.
