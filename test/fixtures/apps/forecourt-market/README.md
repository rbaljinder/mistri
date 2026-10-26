# Forecourt

Forecourt is a used-car marketplace: six made-up independent dealers in US cities, about a hundred cars on the lot, and the sales desk that answers the people who ask about them. Anyone may browse it signed out, a buyer signs up to save cars and follow their own inquiries, and the desk works the inquiries from a pipeline. It runs on SQLite or PostgreSQL over synthetic data; the photographs are real, public-domain pictures of the models the lot sells (not of these cars), and nobody reads what the inquiry form sends.

## The design

The marketplace is a photograph first. Every room a buyer sees is built so the car is the biggest thing on it, the price the second, and everything else quiet:

- **The front page** opens on a photograph with the heading over it and one box to search (a car's name, suggesting the makes and models on the lot as you type; the refinements wait on the list), then **Featured this week** and **Just arrived** as large photo cards.
- **Cars for sale** is a grid of cards: the photo across the top, the name, the price large, and one line of facts — the miles, the fuel and the city. Beside it a rail of counted refinements (make, body, price, year, miles, fuel, drive, transmission), and the address is the question: `/vehicles?body_type=SUV&price=..30000&sort=price` survives a reload and a link.
- **A car's page** is the gallery first, a sticky price card beside it with the price (and what it was, struck through, when it has come down), the monthly estimate and the two ways to ask (**Ask about this car**, **Book a test drive**, each opening the inquiry form with the stock number and topic filled in), then a grid of key facts, the specification, the features and the history, who sells it, and cars like it.
- **The desk** is a dashboard, a pipeline board whose lanes are an inquiry's stages and whose drag is the verb, an inquiry page that reads as a conversation, and **Stock**, the lot edited in place.

It wears **Midnight** (`theme.ts`), its own theme on Lumen with `defineTheme`: Lumen's white cards, Inter and tones under a deep ink-navy bar, with one amber for the buyer's next move, the price card's button and the current room. On white the amber is a deep amber-brown that holds AA under the button's light text and as text; by night it is the bright amber under navy-black text, on a navy page with lifted navy cards. The shell's menu runs along the top. There is no App-specific CSS or component.

## Setup

```sh
node --import tsx test/fixtures/databases/forecourt/seed.mjs /tmp/forecourt.db
npx tsx packages/mistri/src/server/index.ts check --app test/fixtures/apps/forecourt-market --config /tmp/forecourt.db.json \
  --commands test/fixtures/apps/forecourt-market/commands.ts --policy test/fixtures/apps/forecourt-market/policy.ts
BETTER_AUTH_SECRET=<32+ random characters> MISTRI_AUTH_ADMIN_EMAIL=you@example.test MISTRI_AUTH_ADMIN_PASSWORD=<password> \
  npx tsx packages/mistri/src/server/index.ts --app test/fixtures/apps/forecourt-market --config /tmp/forecourt.db.json \
  --commands test/fixtures/apps/forecourt-market/commands.ts --policy test/fixtures/apps/forecourt-market/policy.ts --port 4917
```

Open `http://localhost:4917/` signed out for the marketplace, or sign in as the administrator for the desk. The seed dates everything back from today (or `FORECOURT_TODAY=YYYY-MM-DD`, which makes the same file every time), provisions the command journal the inquiry form and the desk's verbs write through, and refuses an existing path. `--policy` is required: a buyer reads only their own inquiries, and never the desk's notes.

On **PostgreSQL**, seed an empty database directly; the schema there is written by hand with real types (`date`, `timestamp`, `boolean`, `bytea`) and the same CHECKs:

```sh
node --import tsx test/fixtures/databases/forecourt/seed-postgres.mjs postgres://…/forecourt /tmp/forecourt-pg.json
npx tsx packages/mistri/src/server/index.ts --app test/fixtures/apps/forecourt-market --config /tmp/forecourt-pg.json \
  --commands test/fixtures/apps/forecourt-market/commands.ts --policy test/fixtures/apps/forecourt-market/policy.ts
```

## Roles

| Role | Reads | Writes (generic) | Commands |
| --- | --- | --- | --- |
| Signed out | cars, their photos, the dealers' public face, the front page's photo | nothing | the inquiry form (`inquireAboutVehicle`) |
| `shopper` (Buyer, the role sign-up gives) | the same, and their own saved cars, inquiries and the buyer-facing lines of their conversations | nothing | save and remove a car, ask about a car |
| `staff` (Sales desk), `admin` | everything | a car's price, was-price, status, featured, badge, mileage, sold date and description; its photos | reply, add a note, log a call, book a test drive, record an offer, mark sold, mark lost, assign |

Sign-up is open, so the role a stranger gets is the smallest one. The administrator makes desk accounts under **Manage accounts**. An inquiry and its conversation move by commands alone: the server refuses a plain write on them for every role.

## First journeys

1. **Find a car.** Search the front page for `RAV4` (or type `toy` and pick Toyota), or open **Cars for sale**, tick SUV, set a ceiling of $30,000 and sort by lowest price. Copy the address: it is the same list for anyone who opens it.
2. **Ask about it.** On a car's page, **Book a test drive**: the form opens with the stock number and topic filled in. Send it signed out and keep the reference, or sign up first and the inquiry is under **My inquiries** with every reply.
3. **Save a shortlist.** Signed in, press the star beside a car's name; **Saved cars** draws them as the catalog does: the photo, the name, the price and the miles.
4. **Work the desk.** Sign in as the administrator: **Desk** says what is open and new, how inquiries arrive week by week, what sold and how long the lot has stood. Open **Pipeline**, drag an inquiry from New to Test drive (the verb asks for the time), or open one: its conversation reads oldest first, a reply sends from the composer under it, and the first reply moves a new inquiry to Contacted. A note is the desk's own, tinted, and never shown to the buyer.
5. **Keep the lot.** **Stock** edits price, badge, featured and status in the grid; **Over 30 days** is the cars to reprice.

## Module map

| Module | What it holds |
| --- | --- |
| `app.ts` | Identity, the source, roles and their grants, the public grant, homes, the shell and the look. |
| `resources.ts` | Every table's captions, display rules, computed values (`days_on_lot`), record names, public slugs and actions. |
| `cards.ts` | The car card and the dealer card. |
| `landing.ts` | The front page: the hero with its search, the two rows of cars and the questions. |
| `views.ts` | The marketplace list, the front page's rows, the inquiry form, a buyer's own lists, the pipeline, the inquiries and the stock grid. |
| `dashboard.ts` | The desk's dashboard. |
| `pages/` | A car, an inquiry and a dealer. |
| `commands.ts` | The command manifest; the verbs live in `inquiry-commands.ts` (the form and a buyer's own), `shortlist-commands.ts` and `desk-commands.ts`. |
| `policy.ts` | Row policies: a buyer's own saved cars and inquiries, and only the buyer-facing lines of a conversation. |
| `navigation.ts` | The top menu. |

The database setup lives in `test/fixtures/databases/forecourt/`: `seed.mjs` (SQLite, through its migrations), `seed-postgres.mjs`, `desk.mjs` (the desk's history), `photoSource.mjs` and `photos/`.

## Photos

`test/fixtures/databases/forecourt/photos/` holds 24 photographs from Wikimedia Commons, each released under CC0 or into the public domain, with `CREDITS.md` naming every file's source, author, license and the day it was fetched. `manifest.json` says each one's make, model, body, colour and the model years it passes for, and the seed builds the catalog from it: every listing is a model it has a picture of, in that picture's colour and years, and each photo serves several listings at different years, miles and prices. The seed reads only those files and is deterministic.

`fetch-photos.mjs` is how the set was made and can be made again: it checks each file's license on Commons before downloading, crops it to 3:2 at 1280 pixels (a 420-pixel thumbnail beside it) and re-encodes it, which drops every byte of metadata. The seed never runs it. Delete `photos/manifest.json` and the seed draws every car instead (`photos.mjs`, three or four studio renders each).

## Tests

`e2e/forecourt-marketplace.spec.ts`: a buyer searches from the front page, refines in the address (counts and the cheapest price read from the database, kept by a reload), opens a car (its address, its monthly estimate, no desk sections), books a test drive signed out and the inquiry is written; the desk replies from the conversation and the inquiry moves to Contacted. Run it with `npm run e2e -- e2e/forecourt-marketplace.spec.ts`. The retired fixture under `test/fixtures/apps/forecourt` shares this seed and keeps its own specs (`e2e/forecourt*.spec.ts`, `test/forecourt-*.test.ts`).

## Known limits

- **Mark sold** closes the inquiry, not the car: the desk marks the car sold in **Stock** (see the gaps below).
- One photograph a car. A real dealer shoots twenty; the gallery, the lightbox and their steps are there for the photos the desk adds with the gallery's **Add photo**.
- No trade-in valuation, finance application or reservation deposit: an inquiry asks, and the desk answers.

## Platform gaps

Found while building this App; each says what it needed, what it does instead, and the platform block it asks for.

1. **A command that also writes an inline-edited table.** Need: **Mark sold** to close the inquiry and mark the car sold. Instead: it closes the inquiry and says to mark the car in **Stock**. Block: a command allowed to write a table the same role also edits in place.
2. **A gallery's rename and remove.** Need: the desk to take a photo down or rename it from the car's gallery. Instead: the gallery adds photos (an upload is an insert `policy.ts` judges, like every other write) but offers no rename or remove, which the desk's old file list did, and `policy.ts` has no `authorizeDeletedRecord`. Block: a gallery's own remove for a reader who may delete.
3. **Category tiles on a landing.** Need: "Browse by body type" as image tiles. Instead: the body refinement on the list. Block: a landing section of tiles, each an image and a link to a refined list.
4. **A card variant for a marketplace.** Need: a borderless, price-first card. Instead: the standard card with the price as its value. Block: a card `variant` (borderless, value above the title).
