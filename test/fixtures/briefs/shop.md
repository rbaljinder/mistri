# Brief: Kettle & Bloom back office

Status: approved by the shop's owner (interview answered by the agent as the customer, non-interactive session) on 2026-11-15

## What I heard

- **Purpose:** the back office of a small online shop for specialty coffee and brewing gear: see every order and where it
  is, pack and ship it, keep stock from running out, know the customers, and see how the week and month are selling.
  The first thing a person does: open Today and see what is waiting to be packed.
- **People and roles:** three people. The **owner** changes everything and reads the sales figures. **Support** looks
  after orders and customers (returns, notes, customer details). The **warehouse** person packs and ships, receives
  stock, and does not see what a product costs us. (assumed: the split of three)
- **Tenancy:** one organization.
- **Domain:** categories hold products (about 80); a product has a price, a cost, a stock level and a reorder level.
  A customer places orders; an order has lines (product, quantity, price) and moves
  paid → packed → shipped → delivered, and may be returned after it shipped. Orders arrive paid from the storefront.
- **Rules and journeys:** an order cannot be packed if a line asks for more than is on the shelf; it cannot ship
  without a carrier and tracking number; only a shipped or delivered order can be returned, with a reason.
  Journeys: (1) warehouse packs then ships a paid order; (2) owner adds a product and restocks a low one;
  (3) a customer looks up an order by its number and sees where it is.
- **Data:** new, SQLite, no import, believable sample data (80 products, ~60 customers, a few hundred orders).
- **Outside world:** a public catalogue anyone can browse (products, price, in stock or not; never cost or stock
  counts) and a public order-status check by order number and email. No payments, email or SMS in this build.
- **Look and feel:** a brand, not a spreadsheet: warm roasted-coffee brown on cream paper, a serif heading, a cup mark.
  Dark mode and phone both work; the public pages are phone-first, the staff desk is desk-first.
- **Locale:** English (en-US), USD, America/Los_Angeles.

Assumed, not asked: the three roles; the shop's name "Kettle & Bloom"; USD and Pacific time; orders are created by
the storefront (staff can also add one by hand); no cancel state because the customer named five states.

## What I will build

**Schema**

- category: name
- product: name, sku, category, price, cost, stock, reorder level, weight/size note, description, photo, active
- customer: name, email, phone, city, state, joined on
- shop_order: number, customer, status (paid → packed → shipped → delivered; returned), placed at, total, shipping
  method, carrier, tracking number, ship-to address, note, return reason
- order_line: order, product, quantity, unit price
- staff: name, email, role (the sign-in)

**Screens**

1. Today (home dashboard): to pack, shipped this week, sales this week and this month vs the previous, sales by day,
   best sellers, low stock, orders waiting longest.
2. Orders: list with counted tabs per state; an order's page with its lines, customer card, history.
3. Packing: a board of paid → packed → shipped whose card button is the next verb.
4. Stock: products with stock, a Low stock tab and warning tone; receive stock.
5. Products: New/Edit form.
6. Customers: list; a customer's page with what they bought and their lifetime spend.
7. Public: catalogue (cards), a product page, check an order.

**Commands**

- Pack order, where status = paid: sets packed, takes the lines off the shelf. Refuses: a line larger than stock.
- Ship order, where status = packed: asks carrier and tracking number. Refuses: either missing.
- Mark delivered, where status = shipped.
- Return order, where status = shipped or delivered: asks a reason, puts the goods back. Refuses: no reason.
- Receive stock on a product: asks a quantity. Refuses: zero or less.
- Check order (public): order number and email. Refuses: no order of that number with that email.

**Roles and access**

| Role | Reads | Writes | Runs |
| --- | --- | --- | --- |
| owner | all | all | all |
| support | all | customer, order notes | deliver, return |
| warehouse | all but cost and sales figures | none | pack, ship, deliver, receive stock |
| public | catalogue: product and category | none | check order |

**Theme direction:** Lumen underneath, the shop's own theme on top: espresso brown accent, cream grounds, serif
headings; comfortable density; it should feel like the shop's packaging.

**Not in this build:** payments, email notifications to customers, a customer sign-in, the storefront checkout.

## Machine block

```json mistri-brief
{
  "app": { "name": "Kettle & Bloom", "theme": "lumen", "logo": "coffee" },
  "entities": {
    "category": { "name": "text! unique" },
    "product": {
      "name": "text!",
      "sku": "text! unique",
      "category": "ref category!",
      "price": "money!",
      "cost": "money",
      "stock": "int! =0",
      "reorder_level": "int! =5",
      "size": "text",
      "description": "longtext",
      "active": "bool =true"
    },
    "customer": {
      "name": "text!",
      "email": "email! unique",
      "phone": "phone",
      "city": "text",
      "state": "text",
      "joined_on": "date!"
    },
    "shop_order": {
      "number": "text! unique",
      "customer": "ref customer!",
      "status": "choice paid|packed|shipped|delivered|returned =paid",
      "placed_at": "datetime!",
      "total": "money!",
      "shipping_method": "choice standard|express|pickup =standard",
      "carrier": "choice usps|ups|fedex",
      "tracking_number": "text",
      "ship_to": "longtext",
      "note": "longtext",
      "return_reason": "text"
    },
    "order_line": {
      "shop_order": "ref shop_order!",
      "product": "ref product!",
      "quantity": "int! =1",
      "unit_price": "money!"
    },
    "staff": { "name": "text!", "email": "email! unique", "role": "choice owner|support|warehouse =support" }
  },
  "roles": {
    "owner": { "label": "Owner", "read": true, "write": true, "commands": ["packOrder", "shipOrder", "markDelivered", "returnOrder", "receiveStock"] },
    "support": { "label": "Support", "read": true, "write": ["customer"], "commands": ["markDelivered", "returnOrder"] },
    "warehouse": { "label": "Warehouse", "read": true, "write": [], "commands": ["packOrder", "shipOrder", "markDelivered", "receiveStock"] }
  },
  "commands": [
    { "id": "packOrder", "on": "shop_order", "label": "Pack order", "when": "status = paid", "set": { "status": "packed" }, "refuse": ["a line asks for more than is in stock"] },
    { "id": "shipOrder", "on": "shop_order", "label": "Ship order", "when": "status = packed", "set": { "status": "shipped" }, "refuse": ["carrier or tracking number is missing"] },
    { "id": "markDelivered", "on": "shop_order", "label": "Mark delivered", "when": "status = shipped", "set": { "status": "delivered" }, "refuse": [] },
    { "id": "returnOrder", "on": "shop_order", "label": "Return order", "when": "status = shipped or status = delivered", "set": { "status": "returned" }, "refuse": ["no reason given"] },
    { "id": "receiveStock", "on": "product", "label": "Receive stock", "set": {}, "refuse": ["quantity is zero or less"] }
  ]
}
```
