# Atelier

Atelier is the back office of a fictional fashion label with two stores, Atelier SoHo and Atelier Silver Lake, and a warehouse in Secaucus. Its catalog is 120 products in 1,112 variants (a color and a size each), sold over six months to 400 customers in 1,500 orders. It runs on PostgreSQL, its target, or SQLite over synthetic data. Nothing here connects to a payment processor, a carrier or a storefront. A payment is a record that the money arrived, and a refund is a record that it was given back.

An order is three records, each with its own machine: the **order** (open, confirmed, completed, cancelled), its **payment** (pending, paid, partially refunded, refunded, voided) and its **fulfillment** (pending, packed, shipped, delivered, cancelled). A return has a fourth (requested, approved, received, refunded, or rejected). Every step is a named command. The order shows its *financial status* and *fulfillment status* as `latest` rollups: each is the payment's or the fulfillment's own status, read where it is written, so no command copies it onto the order. Commands judge them in their `when` too: an order cancels only while its parcel is pending. Cancelling is one command on the order: the payment's and the fulfillment's machines name it, so a pending payment is voided and a pending parcel cancelled with it, in one transaction. Stock is never an edit for anyone: receiving, packing, a returned piece put back on the shelf and an adjustment all move it through one function, `moveStock`. That function writes the ledger and refuses to take a shelf below zero.

## What it demonstrates

- **Today** (the home): what is waiting to be confirmed, paid, packed or answered as a return, and the fulfillment steps as a pipeline. Below them are the open orders, orders by day, by state and by channel. Beside them are the variants at or under their reorder point and the latest activity.
- **Selling**:
  - **Orders**, with tabs for open, to confirm, unpaid, to pack, in transit, completed, cancelled and all, and their totals.
  - **New order**, a three-step command form: who and where, then the products as a lines grid (each variant with its product's picture, name and SKU, offered only while it is for sale; the quantity; the price copied from the variant and the line's amount, summed as the subtotal), then the discount code and the payment method. It is priced by `pricing.ts`, the same rules the seed used.
  - **Fulfillment**, a board by stage, each card titled by its order and footed by the location it ships from.
  - **Returns**, **Payments** and **Refunds**.
- **Record pages**:
  - An order with its items, totals, payment, fulfillment, refunds, returns and history. The payment, the parcel and each return carry their own verbs in a row's ⋯ menu.
  - A payment with its refunds.
  - A fulfillment with what to pack and what was taken from which shelf.
  - A return with what is coming back and what went back on the shelf.
- **On paper**: an order's **Invoice** and a fulfillment's **Packing slip**, each in its record's More menu (`/orders/1696/invoice`, `/fulfillment/696/packing-slip`). Each is a `document()` in `pages/orders.ts`, printed by the browser and saved as a PDF from its print dialog.
- **Catalog**:
  - **Products**, with variant counts, on hand, price range, units sold and revenue as rollups, plus tags, CSV import, and Publish, Archive and Restore.
  - The **Lookbook**, cards with each product's photo.
  - **Variants**, with prices and reorder points edited in place.
  - **Collections** and **Tags**.
  - A product page with its gallery and its variants.
- **Stock**:
  - **Inventory**, by location, with **Receive** and **Adjust** on each row.
  - **Low stock**.
  - The **Movements** ledger.
  - **Locations**.
- **Marketing**:
  - **Customers**, with orders, spend and last order as rollups, filtered by spend and order count. A customer's orders total what was refunded on them.
  - **Discounts**, percent or fixed, with a minimum, a window and a limit, plus Pause and Resume.
- **Sales** (the owner's desk): sales, orders and average order, sales by week, top products, sales by category and by channel, discount codes, refunds by month, return reasons and the best customers.

It uses shared building blocks only, through the App DSL. The building blocks are:

- machines with command verbs and `when` guards, and machines that move with another record's command
- command forms with steps, repeating groups and a lines grid (`field.lines`) whose bad line is refused at its cell, field `default`s, a picker narrowed by the record, and refusals said beside the field they are about
- `initial` prefills, where a default is computed
- rollups through references, as list filters and related-list totals, and `tags`
- related lists with each row's own actions
- a file resource with thumbnails, cards and a gallery
- a board
- CSV `import`
- `editable` grids
- `history()`
- dashboards with metrics, steps, charts, embeds and rows
- role-chosen homes and the header's **+ New** menu

There is no App-specific CSS or component. It wears **Lumen**, the default look.

## First journeys

1. **Take an order.** In **New order**, choose a customer, add two variants and enter `FALL20`. The order is created with its payment pending and its parcel waiting. On the order, choose **Mark as paid** from the payment row's ⋯ menu, then **Confirm order**.
2. **Pick, pack and ship.** Open **Fulfillment** and choose a pending parcel. **Pick & pack** takes each line from its location's shelf. When a line wants more than the shelf holds, it is refused, the message says how many are there, and nothing moves. **Ship** asks for a carrier and a tracking number, and says beside the field when one is missing. **Mark delivered** completes the order once it is paid.
3. **Take something back.** On a delivered order, **Start a return** fills in its lines at their whole quantity, and its picker offers only that order's lines. Trim them to what is coming back. Then **Approve**, **Receive** (into the warehouse by default) and **Refund**. The refund is what the pieces were worth on the order, after its discount and with tax, and never more than is left of the payment.
4. **Refund by hand.** On a paid payment, **Refund** offers what is left. Ask for more and it is refused, with a message that says how much remains.

## Setup

SQLite, for a quick local try:

```sh
node --import tsx test/fixtures/databases/atelier/seed.mjs /tmp/atelier.db
npm run start -- check --app test/fixtures/apps/atelier --config /tmp/atelier.db.json
BETTER_AUTH_SECRET=<32+ random characters> MISTRI_AUTH_ADMIN_EMAIL=you@example.test MISTRI_AUTH_ADMIN_PASSWORD=<password> \
  npx tsx packages/mistri/src/server/index.ts --config /tmp/atelier.db.json --app test/fixtures/apps/atelier --port 4747
```

PostgreSQL, into an empty database. The seed uses `numeric(12,2)` money, `date`, `timestamp`, `bytea` photos, identity keys and the same CHECKs:

```sh
node --import tsx test/fixtures/databases/atelier/seed-postgres.mjs postgres://…/atelier /tmp/atelier.pg.json
npx tsx packages/mistri/src/server/index.ts --config /tmp/atelier.pg.json --app test/fixtures/apps/atelier --port 4747
```

Both seeds date everything back from today, or from `ATELIER_TODAY=YYYY-MM-DD`. Both refuse an existing database or config, and both provision the command journal and the record history. Open `http://localhost:4747/` and sign in as the administrator, who is an owner.

## Roles

| Role | Reads | Writes (generic) | Commands |
| --- | --- | --- | --- |
| `staff` (the default role) | everything | the catalog, customers, an order's note | take, confirm, complete and cancel orders; mark paid and refund; start, approve, reject and refund returns; pack, ship and deliver; receive a return |
| `warehouse` (home: Fulfillment) | everything except a customer's phone, address book and notes | nothing | pack, ship and deliver; receive a return; receive stock |
| `owner`, `admin` | everything | the catalog, customers, discounts, an order's note | all of the above, and adjust stock |

Orders, payments, fulfillments, returns, refunds and stock are written by commands alone.

## Module map

| Module | What it holds |
| --- | --- |
| `app.ts` | Identity, the source, roles and their grants, home rules, the shell and the look. |
| `resources.ts` | The catalog, stock, customers and discounts: captions, rollups, tags, imports and actions. |
| `orders.ts` | The order, its lines, payment, refunds, fulfillment and returns, and their four machines. |
| `pricing.ts` | How an order and a return are priced, in whole cents: line totals, discount, shipping, tax by state. |
| `commands.ts`, `commands/` | Every command, by the record it moves: orders, payments, fulfillment, returns and stock, with `moveStock` in `shared.ts`. |
| `views.ts` | The lists, the board, the lookbook and the New order form. |
| `dashboards.ts` | Today and Sales. |
| `pages/` | Order, payment, fulfillment and return; product, variant, customer, collection and discount. |
| `navigation.ts` | The side menu. |

## Tests

`test/atelier.test.ts` runs the App in-process over a fresh seed:

- the seed's invariants
- the whole order lifecycle, each step by its machine's verb
- refunds capped at what was paid
- two fulfillments racing for the last unit on a shelf, where exactly one wins and the other is refused with nothing moved
- a new order's totals adding up the way the seed's do

`e2e/atelier.spec.ts` signs in as staff, packs a paid order, refunds part of a payment and paints the dashboards, the board, the lookbook and a product's gallery.
