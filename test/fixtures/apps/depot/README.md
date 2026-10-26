# Depot

Depot is the warehouse system of Switchback Supply, a fictional outdoor and cycling distributor with three warehouses — Reno, Columbus and Allentown — 220 SKUs of tents, packs, helmets, tires and merino, and six months of stock moving through them. It runs on SQLite or PostgreSQL over synthetic data; nothing here connects to a carrier, a supplier or an accounting system.

Every unit moves through a named command, and every command writes the ledger: a receipt, a transfer, a pick, an adjustment and a count's variance are each a line in `stock_movement` with the bin's and the network's quantity after it, in the same transaction as the stock level it changes. Stock is never a plain edit for anyone. Depot does not use a line's `consumes` rule for this: `consumes` moves one balance a line points at, and a movement here changes a bin's stock and the network's at once and writes a ledger line saying who and why, which only a command can do.

## What it demonstrates

- **Today** (Operations): pick lists to pick, what is due to ship, receipts due, the next lists to pick and the lines to receive, lines moved by day (its own period — the last week, month or quarter — picked in its heading), stock value by warehouse, orders shipped by warehouse and the open orders, worked in place (searched, filtered, and a selection's ship-by, priority or carrier set at once); beside it **Latest updates**, the week's changes to pick lists, purchase orders, orders and the ledger from their record history (Today / Yesterday / This week, and a search), the SKUs below their reorder point and this week's adjustments. A priority wears signal bars (a rush a flame), and a purchase order's stage its mark. On an empty database (`--empty`) it opens on a **first run** instead: add suppliers, add products, draft a purchase order.
- **The floor**, worked on a phone as often as at a desk: **Pick lists** as a queue by stage (to pick, to pack, to ship), each row saying how many lines and units its order holds (the order's rollups, through the reference), several packed together from a selection; **Receiving**, every open purchase-order line oldest first, received into a bin from its own dialog; the **Count sheet**, a blind count — the bin and the SKU, never what the system expects.
- **Orders**: triaged in place — ship-by date, priority and carrier edit in the grid, and **Set field…** writes one of them to a selection. An order's stage is read from its pick list through rollups (`lines`, `units`, `released`, `shipped_at`), with tabs for open, late, rush, not yet released and shipped. A phone order is keyed with **New order** and **Add line**, then released to the floor from **Release an order**, whose picker offers only orders with lines that are not yet released (`released = 0 and lines > 0`, rollups in a picker's query). The order column reads as the order's name, `SO-25152`.
- **Imports**: a new line of products arrives as a spreadsheet — **Products › Import** maps its columns, checks every row (a supplier or category by its name, a home bin by its code, list price against cost) and writes the good rows in one transaction with Undo; a count done on paper comes back through **Count sheet › Import**, each row running **Record count** on the open line its bin and SKU find.
- **Inventory**: **Products** with on hand, on order and stock value rolled up from the bins and the open purchase-order lines, a Low stock tab (`on_hand < reorder_point`), and the reorder point, reorder quantity and home bin edited in place; a **Catalog** of cards with each product's studio photo (a thumbnail drawn on the card); **Stock** by bin with Transfer and Adjust on each row; the **Movements** ledger; **Bins**, **Warehouses** and **Cycle counts**, and **Start a count** for an aisle.
- **Specifications**: a tent's capacity and season, a headlamp's lumens — each category's attributes are rows a manager keeps (**Attributes**, a resource like any), and a product's values live in its one `specs` JSON column (`defined: { specs: { from: 'attribute', per: 'category_id' } }`). They are drawn on the product page and the New form as its own fields, edited in place, held to their type, options and required at the server, and offered as facets on the **Catalog** rail.
- **Purchasing**: a dashboard of what is on order (in dollars, and in units summed over each SKU's `on_order` rollup), what arrived, open value by supplier and what is due in; **Purchase orders** by stage; **New purchase order**, a two-step form whose lines are a repeating group of SKU and quantity; **Suppliers**, each with what is still on order from it — a rollup of each purchase order's `open_value` rollup — and, on its page, that open value by warehouse.
- **Purchase-order flows**: a flow is rows that Purchasing edits under **Flows**, not code. The seed's **Large order approval** starts when an order over $5,000 is drafted. It asks a manager to approve, waits for the decision, and sends the order to the supplier only if the manager approved it. `jobs.ts` runs the flows as the `automation` principal through the App's own commands (`flows` on `purchase_order`, `flowRunner`). The order's page shows each run and its steps under **Flows**, a flow's own page draws its steps as a diagram, and an order that went for approval draws its run over them.
- **Record pages**: a product with its photo gallery, stock by location (totalled), peak on hand by month, the movement ledger, open purchase orders, open orders and its history; a purchase order with its ordered workflow strip, lines, receipts, supplier card and history; a pick list in bin order (the picker's walk), with what was taken from where once picked; an order with its lines, pick list and the history of its triage; a warehouse, a bin, a bin's own ledger, a cycle count.

It uses shared building blocks only, through the App DSL: a `diagram()` of a flow's steps, a footer navigation group (**Setup**: warehouses, bins and flows), CSV `import` (plain and through a command), row-defined fields, rollups, `editable` grids and Set field…, `history()`, a file resource with thumbnails, cards, galleries, queues with bulk commands, command forms with steps and repeating groups, `initial` prefills, page charts and embeds, `firstRun()`, bounded menu counts, role-chosen homes and the header's **+ New** menu (`ui.shell.new`), which offers each role only what it may make. There is no App-specific CSS or component. It wears **Lumen**, the default look: white cards lifted on a cool ground, the current room a soft blue pill, stat cards with their marks in tinted circles.

## First journeys

1. **Receive a truck.** Open **Receiving**, choose a line due today and **Receive**: the quantity still open and the SKU's home bin are filled in. The bin's stock, the ledger and the line move together, and the purchase order becomes partly received until its last line is.
2. **Pick, pack and ship.** Open **Pick lists** and a list to pick; **Pick** takes each line from its bins. The rush order for North Woods Outfitting wants more Beacon 400s than Columbus holds: picking it is refused, saying how many are on hand, and nothing moves. Pack several picked lists together from the queue, then **Ship** one with its tracking number.
3. **Count an aisle.** **Start a count** of an aisle, record what each bin holds from the **Count sheet**, then **Complete count** on the count (a manager's verb): each variance becomes a line in the ledger. Columbus's aisle B is already half counted.
4. **Reorder.** Open **Products › Low stock**, raise a reorder point in place, then draft a **New purchase order** and **Send to supplier** from its page.
5. **Approve a large order.** Draft a **New purchase order** worth more than $5,000 on a server started with `--jobs`. The flow asks a manager to approve it, and the order waits under **Purchase orders › Awaiting approval**. **Approve** on its page sends it to the supplier, and its **Flows** aside shows the run complete.

## Setup

```sh
node --import tsx test/fixtures/databases/depot/seed.mjs /tmp/depot.db
npm run start -- check --app test/fixtures/apps/depot --config /tmp/depot.db.json
BETTER_AUTH_SECRET=<32+ random characters> MISTRI_AUTH_ADMIN_EMAIL=you@example.test MISTRI_AUTH_ADMIN_PASSWORD=<password> \
  npx tsx packages/mistri/src/server/index.ts --config /tmp/depot.db.json --app test/fixtures/apps/depot --jobs test/fixtures/apps/depot/jobs.ts --port 4745
```

`--jobs` runs the purchase-order flows; without it, the App serves the same pages and no flow starts.

Open `http://localhost:4745/` and sign in as the administrator, who holds the `admin` role (a manager). **Today** greets its reader by their account's name; the seed makes no accounts, and the administrator the server creates is named for the part of its address before the `@` ("Hello, you") until you give your own under **Your profile** in the account menu. Accounts you invite are named when you make them. The seed provisions the command journal, the event store, the job and workflow stores and the record history the App needs (with the last week's changes in it, `history.mjs`, so the activity feed opens on the week the data describes), dates everything back from today (or `DEPOT_TODAY=YYYY-MM-DD`), and refuses an existing path. `--empty` makes the warehouses, bins and categories only, to see the first run.

On **PostgreSQL**, copy a fresh SQLite seed into an empty database; the copy uses real types (`date`, `timestamp`, `numeric(12,2)`, `bytea`), identity keys, the same CHECKs, and provisions the journal and history there:

```sh
node --import tsx test/fixtures/databases/depot/seed-postgres.mjs postgres://…/depot /tmp/depot.db
npx tsx packages/mistri/src/server/index.ts --config /tmp/depot.db.pg.json --app test/fixtures/apps/depot
```

## Roles

| Role | Reads | Writes (generic) | Commands |
| --- | --- | --- | --- |
| `operator` (the default role) | everything | orders (triage) | receive, transfer, pick, pack, ship, start a count, record a count |
| `purchaser` (home: Purchasing) | everything | products, photos, attributes, suppliers, flows and their steps | draft, send and cancel purchase orders |
| `manager`, `admin` | everything | products, photos, attributes, suppliers, bins, orders and their lines, flows and their steps | all of the above, and adjust stock, release an order, complete a count, approve or reject a purchase order; `admin` also operates the workflows (and starts a manual flow) |
| `automation` (the flows' principal, no account) | everything | nothing | ask for approval, send a purchase order |

Accounts are invited. The administrator adds them and sets their roles under **Manage accounts** in the account menu: an operator, a purchaser or a manager, and deactivates one who leaves. `createAppAccounts` from `@mistriwork/mistri/maintenance` still makes operators in bulk from a script. A table a command writes — stock, the ledger, purchase orders and their lines, pick lists, counts — is written by commands alone: the server refuses a role that also grants a plain write on one.

## Module map

| Module | What it holds |
| --- | --- |
| `app.ts` | Identity, the source, roles and their grants, home rules, the shell and the look. |
| `resources.ts` | Every table's captions, display rules, rollups, record names, New forms, validation and actions. |
| `commands.ts` | Every command, whole: what it acts on, its input, its handler, and `move`, the one way stock changes. The App names each by its key (`command: 'receiveLine'`); `mistri check` types those names in `mistri-commands.d.ts`. |
| `views.ts` | The lists, queues, cards and command forms. |
| `dashboards.ts` | Operations (with its first run) and Purchasing. |
| `navigation.ts` | The side menu. |
| `jobs.ts` | The `--jobs` entry: `flowRunner` for the purchase orders' flows, run as `automation`, which hears `po.decided`. |
| `api.ts` | The [App API](../../../site/src/content/docs/docs/build-an-api.md): products and stock to read, a supplier's contact details to update, `shipList`, and `order.shipped` on the event feed. |
| `pages/` | Product; purchase order, line and supplier; pick list and order; warehouse, bin, bin stock, cycle count and count line; and `pick-walk.page.tsx`, the pick walk (below). |
| `components.ts`, `widgets/` | Depot's own [custom components](../../../site/src/content/docs/docs/custom-components.md): the **bin map** on a warehouse's page (every bin by where its code puts it, shaded by fill), the **stock sparkline** beside on hand in Products and Low stock (the last thirty days from the ledger), and, in `pages/`, the **pick walk**, a [free-form page](../../../site/src/content/docs/docs/custom-components.md#free-form-pages) for the phone that opens on the lists its loader (`pickWalk` in `commands.ts`) reads, walks one list a line at a time in bin order and ends in the Pick command (`page.useCommand`). Each has its examples (`*.examples.tsx`, stories in Storybook) and tests. |

## The API

A storefront or a carrier's system reaches Depot with a manager's token: `api.ts` exposes products, stock levels and pick lists to read, a supplier's contact details to update (a generic write, `update-supplier`), the dock's `shipList`, and the event feed of `order.shipped`. The seed provisions the event store `shipList` writes into. Issue a token and serve it as [App API](../../../site/src/content/docs/docs/app-api.md) says, with `--commands test/fixtures/apps/depot/commands.ts --api-reads`. Then `GET /api/apps/depot/v1/$events` lists every shipment since the cursor you last read. `test/depot-api.test.ts` ships a pick list and reads the event back.

## Tests

Every ledger line says who moved it (`moved_by`, the account's email from the command's `actor`), and **Movements › Mine** is the signed-in account's. A purchase order is stamped with the buyer who drafted it (`buyer`, `buyer_email`), **Purchase orders › Mine** lists theirs, and its `notify` rule tells that buyer when the order is received or cancelled: the bell in the App bar and `/notifications`. The seed provisions the notification store with the journal and the history. `e2e/notifications.spec.ts` covers the notice and the ledger's who.

`e2e/depot.spec.ts`: receiving a line fills its bin and writes the ledger and the order; a catalog file is checked row by row, imported as one write kept in each product's history, and undone as one; a paper count imports through Record count and an operator cannot import the catalog; a short pick list is refused whole and a full one picked from its bins; an operator cannot send a purchase order or change a reorder point, on the page or at the server; Low stock lists exactly the active SKUs under their reorder point. Run it with `npm run e2e -- e2e/depot.spec.ts`.

## Known limits

- An order's lines stay editable after it is released: a pick reads them as they are then. A real deployment would close them with a command, which would make them command-only.
- Nothing recalculates a stock level's value when a unit cost changes; it is revalued at the next movement.
- Transfers stay inside one warehouse; moving stock between warehouses, returns and backorders are not modelled.
