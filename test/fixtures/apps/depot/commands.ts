/* Depot's business commands: where every unit of stock moves. Registered
   through the explicit --commands entry, never imported from the App graph.

   One rule runs through all of them: a bin's quantity changes only with a
   line in the ledger that says so, in the same transaction, with the bin's
   and the network's quantity after it. So a receipt, a transfer, a pick, an
   adjustment and a count's variance are each one call to `move` below, and
   the ledger and the stock levels cannot disagree. A refusal says why in the
   reader's words, and leaves nothing written. */
import {
  defineCommand,
  defineCommands,
  defineEvent,
  defineLoader,
  defineLoaders,
  defineSource,
  field,
  int,
  list,
  oneOf,
  refuse,
  shape,
  text,
  type WriteTable,
} from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

const source = defineSource<Rows>('depot');

/* A moment as the seed writes it: the warehouses' wall clock to the second, Los Angeles (app.ts `timezone`). A timestamp
   column keeps no zone and a moment without one is read as written, so UTC's clock put an evening pick in tomorrow. */
const wall = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const stamp = (now: () => Date) => {
  const part = Object.fromEntries(wall.formatToParts(now()).map(({ type, value }) => [type, value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
};
/** The warehouses' day, `YYYY-MM-DD`, in Los Angeles. */
const day = (now: () => Date) => stamp(now).slice(0, 10);
/* Money is written as decimal text: numeric on PostgreSQL, NUMERIC on SQLite, exact on both. */
const cents = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const said = shape({ message: text({ max: 300 }) });
const made = shape({ reference: text({ max: 40 }), message: text({ max: 300 }) });

/** Who a line of the ledger was moved by: the account's email, from its verified session (the actor), never a form. */
const by = (actor: { email?: string }) => actor.email ?? null;

/** The tables a stock move reads and writes: the level in the bin and the ledger. */
type StockDb = { stock_level: WriteTable<Rows['stock_level']>; stock_movement: WriteTable<Rows['stock_movement']> };

/**
 * One line of the ledger and the bin it moves: `qty` in (positive) or out
 * (negative) of `bin`, never below zero. Returns the bin's quantity after.
 */
async function move(
  db: StockDb,
  when: string,
  m: {
    kind: 'receipt' | 'pick' | 'transfer' | 'adjustment' | 'count';
    by: string | null;
    product: Rows['product'];
    bin: Rows['bin'];
    qty: number;
    reference: string;
    reason?: string;
    note?: string | null;
    purchase_order_id?: number;
    pick_list_id?: number;
    cycle_count_id?: number;
  },
): Promise<number> {
  const cost = Number(m.product.unit_cost);
  let level = await db.stock_level.find({ product_id: m.product.id, bin_id: m.bin.id });
  const before = level ? Number(level.qty) : 0;
  const after = before + m.qty;
  if (after < 0) refuse(`${m.bin.code} holds ${before} of ${m.product.sku}, not ${-m.qty}.`);
  if (level) level = await db.stock_level.update(level, { qty: after, value: cents(after * cost) });
  else
    level = await db.stock_level.insert({
      product_id: m.product.id,
      bin_id: m.bin.id,
      warehouse_id: m.bin.warehouse_id,
      qty: after,
      value: cents(after * cost),
    });
  const network = (await db.stock_level.where({ product_id: m.product.id }).limit(500)).reduce((sum, row) => sum + Number(row.qty), 0);
  await db.stock_movement.insert({
    moved_at: when,
    kind: m.kind,
    product_id: m.product.id,
    bin_id: m.bin.id,
    warehouse_id: m.bin.warehouse_id,
    qty: m.qty,
    unit_cost: m.product.unit_cost,
    value: cents(m.qty * cost),
    bin_qty_after: after,
    on_hand_after: network,
    reference: m.reference,
    reason: m.reason ?? null,
    note: m.note ?? null,
    purchase_order_id: m.purchase_order_id ?? null,
    pick_list_id: m.pick_list_id ?? null,
    cycle_count_id: m.cycle_count_id ?? null,
    moved_by: m.by,
  });
  return after;
}

/* ---------- purchasing ---------- */

/* A draft from the form: every SKU from the supplier that makes it, at its
   standard cost, one line each. */
export const draftPurchaseOrder = defineCommand({
  source,
  target: 'purchase_order',
  targets: 'none',
  input: {
    supplier: field.reference('supplier', { by: 'id', labelColumn: 'name' }),
    warehouse: field.reference('warehouse', { by: 'id', labelColumn: 'name', label: 'Ship to' }),
    expected_on: field.date({ label: 'Expected', optional: true, help: 'Left empty, the supplier’s lead time from today.' }),
    lines: field.group(
      {
        product: field.reference('product', { by: 'id', labelColumn: 'sku', query: 'status = active', label: 'SKU' }),
        quantity: field.number({ integer: true, min: 1, max: 100000 }),
      },
      { repeat: { min: 1, max: 30 } },
    ),
    notes: field.textarea({ max: 500, optional: true }),
  },
  read: ['supplier', 'warehouse', 'product'],
  write: ['po_line'],
  output: made,
  async handle({ db, actor, now }, input) {
    const supplier = await db.supplier.get({ id: Number(input.supplier) });
    const warehouse = await db.warehouse.get({ id: Number(input.warehouse) });
    const expected = input.expected_on ?? day(() => new Date(now().getTime() + supplier.lead_time_days * 86_400_000));
    if (expected < day(now)) refuse('invalid_input', 'expected_on');
    const seen = new Set<number>();
    const lines: { product: Rows['product']; quantity: number }[] = [];
    for (const line of input.lines) {
      const product = await db.product.get({ id: Number(line.product) });
      if (product.supplier_id !== supplier.id) refuse(`${product.sku} comes from another supplier, not ${supplier.name}.`);
      if (product.status !== 'active') refuse(`${product.sku} is discontinued and is not reordered.`);
      if (seen.has(product.id)) refuse(`${product.sku} is on two lines; put its whole quantity on one.`);
      seen.add(product.id);
      lines.push({ product, quantity: line.quantity });
    }
    const po = await db.purchase_order.insert({
      supplier_id: supplier.id,
      warehouse_id: warehouse.id,
      status: 'draft',
      ordered_on: day(now),
      expected_on: expected,
      // The buyer by name, and by the email a notice about the order is sent to (resources.ts).
      buyer: actor.name ?? actor.email ?? 'Depot',
      buyer_email: actor.email ?? null,
      notes: input.notes ?? null,
      /* Its value as drafted, stored: what an approval flow's condition reads (draft_value > 5000), since a
         flow judges the order's own columns and the total is a rollup of its lines. */
      draft_value: cents(lines.reduce((sum, { product, quantity }) => sum + quantity * Number(product.unit_cost), 0)),
    });
    let lineNo = 0;
    for (const { product, quantity } of lines) {
      const cost = Number(product.unit_cost);
      await db.po_line.insert({
        purchase_order_id: po.id,
        line_no: ++lineNo,
        product_id: product.id,
        qty_ordered: quantity,
        qty_received: 0,
        open_qty: quantity,
        unit_cost: product.unit_cost,
        amount: cents(quantity * cost),
        open_value: cents(quantity * cost),
        status: 'draft',
      });
    }
    return {
      reference: `PO-${po.id}`,
      message: `Drafted for ${supplier.name}, ${plural(lines.length, 'line')}, shipping to ${warehouse.name}.`,
    };
  },
});

/* Sent: its lines are on order from now on, and count in each SKU's "on order". */
export const sendPurchaseOrder = defineCommand({
  source,
  target: 'purchase_order',
  write: ['po_line'],
  read: ['supplier'],
  output: said,
  async handle({ db, record, now }) {
    const lines = await db.po_line.where({ purchase_order_id: record.id }).limit(200);
    if (!lines.length) refuse(`PO-${record.id} has no lines to send.`);
    for (const line of lines) await db.po_line.update(line, { status: 'open' });
    await db.purchase_order.update(record, { status: 'sent', sent_on: day(now) });
    const supplier = await db.supplier.get({ id: record.supplier_id });
    return { message: `PO-${record.id} sent to ${supplier.name}.` };
  },
});

/* Cancelled before anything arrived: nothing is on order any more. */
export const cancelPurchaseOrder = defineCommand({
  source,
  target: 'purchase_order',
  write: ['po_line'],
  input: { reason: field.textarea({ max: 300, help: 'Kept on the purchase order.' }) },
  output: said,
  async handle({ db, record }, { reason }) {
    const lines = await db.po_line.where({ purchase_order_id: record.id }).limit(200);
    if (lines.some((line) => Number(line.qty_received) > 0)) refuse(`Part of PO-${record.id} has arrived; it can no longer be cancelled.`);
    for (const line of lines) await db.po_line.update(line, { status: 'cancelled', open_qty: 0, open_value: cents(0) });
    const notes = record.notes ? `${record.notes}\nCancelled: ${reason}` : `Cancelled: ${reason}`;
    await db.purchase_order.update(record, { status: 'cancelled', notes });
    return { message: `PO-${record.id} cancelled.` };
  },
});

/* ---------- approval, as a flow asks for it ---------- */

/* A large order waits for a manager's word before it goes out. The Purchase
   approvals flow (its rows, po_flow and po_flow_step) runs these: its
   `approval` step asks, as the flows' principal, and waits for the decision,
   which a manager gives from the order's page; on approval its `send` step
   sends the order. The decision is a fact, po.decided, whose `order` names
   the order the waiting run is about. */
export const poDecided = defineEvent('po.decided', shape({ order: int(), approval: text({ max: 10 }) }));
const decided = shape({ message: text({ max: 300 }), order: int(), approval: text({ max: 10 }) });

export const requestApproval = defineCommand({
  source,
  target: 'purchase_order',
  input: { approver: field.text({ max: 60, help: 'Who is asked: a role or a name, as the flow step says.' }) },
  when: 'status = draft',
  output: said,
  async handle({ db, record }, { approver }) {
    await db.purchase_order.update(record, { approval: 'requested', approver });
    return { message: `PO-${record.id} is waiting for approval by ${approver}.` };
  },
});

const decide = (approval: 'approved' | 'rejected') =>
  defineCommand({
    source,
    target: 'purchase_order',
    when: 'status = draft and approval = requested',
    output: decided,
    events: { decided: poDecided },
    async handle({ db, record }) {
      await db.purchase_order.update(record, { approval });
      return { message: `PO-${record.id} ${approval}.`, order: Number(record.id), approval };
    },
  });
export const approvePurchaseOrder = decide('approved');
export const rejectPurchaseOrder = decide('rejected');

/* ---------- receiving and stock ---------- */

/* A line received into a bin of the warehouse the order ships to. The bin,
   the ledger, the line and the order's status move together: the order is
   partly received until its last line is. */
export const receiveLine = defineCommand({
  source,
  target: 'po_line',
  input: {
    quantity: field.number({ label: 'Quantity received', integer: true, min: 1, max: 100000 }),
    bin: field.reference('bin', {
      by: 'id',
      labelColumn: 'code',
      query: 'active = true',
      label: 'Into bin',
      help: 'A bin in the warehouse the order ships to.',
    }),
  },
  read: ['product', 'bin', 'warehouse'],
  write: ['purchase_order', 'stock_level', 'stock_movement'],
  when: 'status = open',
  output: said,
  async initial({ db, record }) {
    const po = await db.purchase_order.get({ id: record.purchase_order_id });
    const product = await db.product.get({ id: record.product_id });
    // Into the SKU's home bin where the order ships to Reno's shelves; elsewhere where it already lives.
    const home = product.home_bin_id === null ? undefined : await db.bin.find({ id: product.home_bin_id, warehouse_id: po.warehouse_id });
    const there =
      home ?? (await db.stock_level.where({ product_id: product.id, warehouse_id: po.warehouse_id }).orderBy('qty', 'desc').first());
    const bin = home ? home.id : there && 'bin_id' in there ? there.bin_id : undefined;
    return { quantity: Number(record.open_qty), ...(bin === undefined ? {} : { bin }) };
  },
  async handle({ db, record, actor, now }, input) {
    const po = await db.purchase_order.get({ id: record.purchase_order_id });
    if (po.status !== 'sent' && po.status !== 'partial') refuse(`PO-${po.id} is ${po.status}; only a sent order is received.`);
    const product = await db.product.get({ id: record.product_id });
    const open = Number(record.open_qty);
    if (input.quantity > open) refuse(`Only ${open} of ${product.sku} ${open === 1 ? 'is' : 'are'} still open on this line.`);
    const bin = await db.bin.get({ id: Number(input.bin) });
    if (bin.warehouse_id !== po.warehouse_id) {
      const warehouse = await db.warehouse.get({ id: po.warehouse_id });
      refuse(`${bin.code} is not in ${warehouse.name}, where PO-${po.id} ships.`);
    }
    if (!bin.active) refuse(`${bin.code} is not in use.`);
    const after = await move(db, stamp(now), {
      kind: 'receipt',
      by: by(actor),
      product,
      bin,
      qty: input.quantity,
      reference: `PO-${po.id}`,
      purchase_order_id: po.id,
    });
    const left = open - input.quantity,
      cost = Number(record.unit_cost);
    await db.po_line.update(record, {
      qty_received: Number(record.qty_received) + input.quantity,
      open_qty: left,
      open_value: cents(left * cost),
      status: left ? 'open' : 'received',
    });
    const stillOpen = await db.po_line.count({ purchase_order_id: po.id, status: 'open' });
    await db.purchase_order.update(po, stillOpen ? { status: 'partial' } : { status: 'received', received_on: day(now) });
    return { message: `Received ${input.quantity} × ${product.sku} into ${bin.code}; it holds ${after}.` };
  },
});

/* From one bin to another in the same warehouse: two lines in the ledger. */
export const transferStock = defineCommand({
  source,
  target: 'stock_level',
  input: {
    to_bin: field.reference('bin', { by: 'id', labelColumn: 'code', query: 'active = true' }),
    quantity: field.number({ integer: true, min: 1, max: 100000 }),
  },
  read: ['product', 'bin', 'warehouse'],
  write: ['stock_movement'],
  when: 'qty > 0',
  output: said,
  async handle({ db, record, actor, now }, input) {
    const product = await db.product.get({ id: record.product_id });
    const from = await db.bin.get({ id: record.bin_id });
    const to = await db.bin.get({ id: Number(input.to_bin) });
    if (to.id === from.id) refuse('Choose another bin to move the stock to.');
    if (to.warehouse_id !== from.warehouse_id) {
      const warehouse = await db.warehouse.get({ id: from.warehouse_id });
      refuse(`${to.code} is in another warehouse; a transfer stays inside ${warehouse.name}.`);
    }
    if (!to.active) refuse(`${to.code} is not in use.`);
    if (input.quantity > Number(record.qty)) refuse(`${from.code} holds ${Number(record.qty)} of ${product.sku}, not ${input.quantity}.`);
    const when = stamp(now);
    await move(db, when, {
      kind: 'transfer',
      by: by(actor),
      product,
      bin: from,
      qty: -input.quantity,
      reference: 'Transfer',
      note: `To ${to.code}`,
    });
    const after = await move(db, when, {
      kind: 'transfer',
      by: by(actor),
      product,
      bin: to,
      qty: input.quantity,
      reference: 'Transfer',
      note: `From ${from.code}`,
    });
    return { message: `Moved ${input.quantity} × ${product.sku} from ${from.code} to ${to.code}; it holds ${after}.` };
  },
});

/* The shelf says otherwise: its quantity set to what is there, with a reason
   that fits the direction. */
export const adjustStock = defineCommand({
  source,
  target: 'stock_level',
  input: {
    quantity: field.number({ label: 'Quantity on the shelf', integer: true, min: 0, max: 100000 }),
    reason: field.choice([
      { value: 'damaged', label: 'Damaged' },
      { value: 'lost', label: 'Lost' },
      { value: 'found', label: 'Found' },
      { value: 'expired', label: 'Expired' },
      { value: 'correction', label: 'Correction' },
    ]),
    note: field.textarea({ max: 300, optional: true }),
  },
  read: ['product', 'bin'],
  write: ['stock_movement'],
  output: said,
  async initial({ record }) {
    return { quantity: Number(record.qty) };
  },
  async handle({ db, record, actor, now }, input) {
    const product = await db.product.get({ id: record.product_id });
    const bin = await db.bin.get({ id: record.bin_id });
    const change = input.quantity - Number(record.qty);
    if (!change) refuse(`${bin.code} already holds ${input.quantity}; there is nothing to adjust.`);
    if (input.reason === 'found' && change < 0) refuse('Found stock adds to the shelf; this takes away. Choose another reason.');
    if (['damaged', 'lost', 'expired'].includes(input.reason) && change > 0)
      refuse(`Stock ${input.reason} leaves the shelf; this adds to it. Choose another reason.`);
    await move(db, stamp(now), {
      kind: 'adjustment',
      by: by(actor),
      product,
      bin,
      qty: change,
      reference: 'Adjustment',
      reason: input.reason,
      note: input.note ?? null,
    });
    return { message: `${bin.code} now holds ${input.quantity} of ${product.sku} (${change > 0 ? '+' : ''}${change}).` };
  },
});

/* ---------- orders and the floor ---------- */

/* A keyed order goes to the floor: its pick list, once, when it has lines. */
export const releaseOrder = defineCommand({
  source,
  target: 'pick_list',
  targets: 'none',
  input: {
    // Read through the order's rollups: only an order with lines, not yet on the floor, is offered.
    order: field.reference('sales_order', {
      by: 'id',
      labelColumn: 'id',
      query: 'released = 0 and lines > 0 and ordered_on = last 14 days',
      label: 'Order number',
      help: 'Orders taken in the last two weeks with lines and not yet released.',
    }),
  },
  read: ['sales_order', 'order_line', 'customer'],
  output: made,
  async handle({ db, now }, input) {
    const order = await db.sales_order.get({ id: Number(input.order) });
    if (await db.pick_list.count({ sales_order_id: order.id })) refuse(`SO-${order.id} is already on the floor.`);
    if (!(await db.order_line.count({ sales_order_id: order.id })))
      refuse(`SO-${order.id} has no lines yet; add what the customer ordered first.`);
    const customer = await db.customer.get({ id: order.customer_id });
    await db.pick_list.insert({
      sales_order_id: order.id,
      warehouse_id: order.warehouse_id,
      reference: `SO-${order.id}`,
      ship_to: `${customer.name}, ${customer.city}, ${customer.state}`,
      status: 'to_pick',
      released_at: stamp(now),
    });
    return { reference: `SO-${order.id}`, message: `Released to the floor for ${customer.name}.` };
  },
});

/* Every line taken from its bins — its own pick bin first, then the SKU's
   home bin, then the fullest — or none of them: a pick list the warehouse
   cannot fill whole stays to pick, and says what is short. */
export const pickList = defineCommand({
  source,
  target: 'pick_list',
  read: ['order_line', 'product', 'bin', 'warehouse'],
  write: ['stock_level', 'stock_movement'],
  output: said,
  async handle({ db, record, actor, now }) {
    const lines = await db.order_line.where({ sales_order_id: record.sales_order_id }).orderBy('id').limit(200);
    if (!lines.length) refuse(`${record.reference} has no lines to pick.`);
    const when = stamp(now);
    let units = 0;
    for (const line of lines) {
      const product = await db.product.get({ id: line.product_id });
      const levels = (await db.stock_level.where({ product_id: product.id, warehouse_id: record.warehouse_id }).limit(100)).filter(
        (level) => Number(level.qty) > 0,
      );
      const rank = (level: Rows['stock_level']) => (level.bin_id === line.bin_id ? 0 : level.bin_id === product.home_bin_id ? 1 : 2);
      levels.sort((a, b) => rank(a) - rank(b) || Number(b.qty) - Number(a.qty));
      const available = levels.reduce((sum, level) => sum + Number(level.qty), 0);
      if (available < line.qty) {
        const warehouse = await db.warehouse.get({ id: record.warehouse_id });
        refuse(`Only ${available} of ${product.sku} on hand in ${warehouse.name}; this order needs ${line.qty}.`);
      }
      let left = line.qty;
      for (const level of levels) {
        if (!left) break;
        const take = Math.min(left, Number(level.qty));
        const bin = await db.bin.get({ id: level.bin_id });
        await move(db, when, {
          kind: 'pick',
          by: by(actor),
          product,
          bin,
          qty: -take,
          reference: record.reference,
          pick_list_id: record.id,
        });
        left -= take;
      }
      units += line.qty;
    }
    await db.pick_list.update(record, { status: 'picked', picked_at: when });
    return { message: `Picked ${plural(units, 'unit')} on ${plural(lines.length, 'line')}.` };
  },
});

/* Packed together from the queue: every selected list, or none. */
export const packLists = defineCommand({
  source,
  target: 'pick_list',
  targets: 'many',
  read: ['order_line'],
  output: oneOf(
    shape({ packed: int({ min: 1 }), message: text({ max: 200 }) }),
    shape({ packed: int({ min: 2 }), cartons: list(int({ min: 1 }), { min: 2, max: 200 }), message: text({ max: 200 }) }),
  ),
  async handle({ db, records, now }) {
    const cartons: number[] = [];
    for (const list of records) {
      const lines = await db.order_line.where({ sales_order_id: list.sales_order_id }).limit(200);
      const units = lines.reduce((sum, line) => sum + Number(line.qty), 0);
      // About eight units to a carton, as the packing bench works it.
      const boxes = Math.max(1, Math.ceil(units / 8));
      await db.pick_list.update(list, { status: 'packed', packed_at: stamp(now), cartons: boxes });
      cartons.push(boxes);
    }
    return records.length === 1
      ? { packed: 1, message: `Packed in ${plural(cartons[0], 'carton')}.` }
      : { packed: records.length, cartons, message: `Packed ${records.length} pick lists.` };
  },
});

/* A shipment leaving the dock is the fact a storefront waits for: the API's
   event feed carries it (api.ts), so the shop can tell its customer. The
   API serves this output, so its text has no length rule a client would
   have to count the way JavaScript does; the input already bounds it. */
const shipment = shape({ message: text(), reference: text(), order: int(), carrier: text(), tracking: text() });
const orderShipped = defineEvent('order.shipped', shape({ order: int(), reference: text(), carrier: text(), tracking: text() }));

export const shipList = defineCommand({
  source,
  target: 'pick_list',
  read: ['sales_order'],
  input: {
    carrier: field.choice(['UPS', 'FedEx', 'USPS', 'Freight']),
    tracking: field.text({ label: 'Tracking number', max: 40, case: 'upper' }),
  },
  output: shipment,
  events: {
    shipped: orderShipped,
  },
  async initial({ db, record }) {
    const order = await db.sales_order.get({ id: record.sales_order_id });
    return { carrier: order.carrier as 'UPS' | 'FedEx' | 'USPS' | 'Freight' };
  },
  async handle({ db, record, now }, input) {
    await db.pick_list.update(record, { status: 'shipped', shipped_at: stamp(now), carrier: input.carrier, tracking: input.tracking });
    return {
      message: `${record.reference} shipped by ${input.carrier}.`,
      reference: record.reference,
      order: Number(record.sales_order_id),
      carrier: input.carrier,
      tracking: input.tracking,
    };
  },
});

/* ---------- cycle counts ---------- */

/* A blind count of one aisle: a line for every bin stock in it, with what
   the system expects kept off the sheet the counter reads. */
export const startCount = defineCommand({
  source,
  target: 'cycle_count',
  targets: 'none',
  input: {
    warehouse: field.reference('warehouse', { by: 'id', labelColumn: 'name' }),
    aisle: field.text({
      max: 4,
      case: 'upper',
      pattern: /[A-Z]{1,4}/,
      message: 'An aisle is its letters, as the shelf labels say it: A, B, R.',
    }),
  },
  read: ['warehouse', 'bin', 'stock_level'],
  write: ['cycle_count_line'],
  output: made,
  async handle({ db, now }, input) {
    const warehouse = await db.warehouse.get({ id: Number(input.warehouse) });
    if (await db.cycle_count.count({ warehouse_id: warehouse.id, aisle: input.aisle, status: 'counting' })) {
      refuse(`Aisle ${input.aisle} in ${warehouse.name} is already being counted.`);
    }
    const bins = await db.bin.where({ warehouse_id: warehouse.id, aisle: input.aisle }).limit(500);
    if (!bins.length) refuse(`${warehouse.name} has no aisle ${input.aisle}.`);
    const levels = await db.stock_level.where({ bin_id: bins.map((bin) => bin.id) }).limit(1000);
    if (!levels.length) refuse(`Nothing is stocked in aisle ${input.aisle} in ${warehouse.name}.`);
    const count = await db.cycle_count.insert({ warehouse_id: warehouse.id, aisle: input.aisle, status: 'counting', started_on: day(now) });
    for (const level of levels) {
      await db.cycle_count_line.insert({
        cycle_count_id: count.id,
        stock_level_id: level.id,
        product_id: level.product_id,
        bin_id: level.bin_id,
        expected_qty: Number(level.qty),
      });
    }
    return {
      reference: `CC-${count.id}`,
      message: `${plural(levels.length, 'bin stock', 'bin stocks')} to count in aisle ${input.aisle}.`,
    };
  },
});

export const recordCount = defineCommand({
  source,
  target: 'cycle_count_line',
  read: ['cycle_count', 'bin'],
  input: { counted: field.number({ label: 'Counted on the shelf', integer: true, min: 0, max: 100000 }) },
  output: said,
  async handle({ db, record }, input) {
    const count = await db.cycle_count.get({ id: record.cycle_count_id });
    if (count.status !== 'counting') refuse(`CC-${count.id} is complete; its counts are closed.`);
    await db.cycle_count_line.update(record, { counted_qty: input.counted });
    const bin = await db.bin.get({ id: record.bin_id });
    return { message: `${bin.code}: ${input.counted} counted.` };
  },
});

/* A count closed: each bin set to what was counted, against what it holds
   now (not when the count began, so a pick in between is not a variance),
   and each difference a line in the ledger. */
export const completeCount = defineCommand({
  source,
  target: 'cycle_count',
  read: ['product', 'bin'],
  write: ['cycle_count_line', 'stock_level', 'stock_movement'],
  when: 'status = counting',
  output: said,
  async handle({ db, record, actor, now }) {
    const lines = await db.cycle_count_line.where({ cycle_count_id: record.id }).limit(1000);
    const open = lines.filter((line) => line.counted_qty === null).length;
    if (open) refuse(`${plural(open, 'bin')} ${open === 1 ? 'is' : 'are'} still to count on CC-${record.id}.`);
    const when = stamp(now),
      today = day(now);
    let net = 0,
      changed = 0;
    for (const line of lines) {
      const product = await db.product.get({ id: line.product_id });
      const bin = await db.bin.get({ id: line.bin_id });
      const level = await db.stock_level.get({ id: line.stock_level_id });
      const variance = Number(line.counted_qty) - Number(level.qty);
      if (variance) {
        await move(db, when, {
          kind: 'count',
          by: by(actor),
          product,
          bin,
          qty: variance,
          reference: `CC-${record.id}`,
          cycle_count_id: record.id,
        });
        changed++;
        net += variance;
      }
      const counted = await db.stock_level.get({ id: line.stock_level_id });
      await db.stock_level.update(counted, { last_counted_on: today });
      await db.cycle_count_line.update(line, { variance, variance_value: cents(variance * Number(product.unit_cost)) });
    }
    await db.cycle_count.update(record, { status: 'completed', completed_on: today });
    return { message: changed ? `${plural(changed, 'bin')} corrected, ${net > 0 ? '+' : ''}${net} units net.` : 'Every bin matched.' };
  },
});

/* The pick walk's first screen (pages/pick-walk.page.tsx): the lists waiting
   on the floor, first to ship first, each with its warehouse and its order's
   ship-by date and priority. Run on the server as the reader, read-only: a
   list, an order or a warehouse their grants do not show is not in it. */
export const loaders = defineLoaders({
  pickWalk: defineLoader({
    source,
    reads: ['pick_list', 'sales_order', 'warehouse'],
    async load({ db }) {
      const waiting = await db.pick_list.where({ status: 'to_pick' }).orderBy('released_at').limit(40);
      const warehouses = new Map<number, string | null>();
      for (const id of new Set(waiting.map((list) => list.warehouse_id)))
        warehouses.set(id, (await db.warehouse.find({ id }))?.name ?? null);
      const lists = [];
      for (const list of waiting) {
        const order = await db.sales_order.find({ id: list.sales_order_id });
        lists.push({
          id: list.id,
          reference: list.reference,
          shipTo: list.ship_to,
          warehouse: warehouses.get(list.warehouse_id) ?? null,
          shipBy: order?.ship_by ?? null,
          rush: order?.priority === 'rush',
        });
      }
      /* First to ship first; a list whose order this reader cannot see goes last. Released order breaks a tie (the read's order). */
      return { lists: lists.sort((a, b) => (a.shipBy ?? '\uffff').localeCompare(b.shipBy ?? '\uffff')) };
    },
  }),
});

export default defineCommands({
  draftPurchaseOrder,
  sendPurchaseOrder,
  cancelPurchaseOrder,
  requestApproval,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  receiveLine,
  transferStock,
  adjustStock,
  releaseOrder,
  pickList,
  packLists,
  shipList,
  startCount,
  recordCount,
  completeCount,
});
