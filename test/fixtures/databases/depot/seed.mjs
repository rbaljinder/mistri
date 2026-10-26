/**
 * Depot's disposable SQLite fixture: a small outdoor and cycling distributor
 * with three warehouses, 220 SKUs and six months of stock moving through
 * them, dated back from today (or `DEPOT_TODAY`, `YYYY-MM-DD`).
 *
 * The ledger is the truth, and everything else agrees with it: every stock
 * level is the sum of its movements, every movement says the bin's and the
 * network's quantity after it, a received purchase-order line is a receipt
 * in the ledger and a shipped order's lines are its picks. The seed walks the
 * days in order — the morning's receipts, the day's orders and picks, the
 * evening's replenishment moves, adjustments and cycle counts — so nothing
 * goes below zero on the way. It ends on today's work: pick lists to pick,
 * purchase orders on the water, a count half done, a few SKUs short.
 *
 *   node --import tsx test/fixtures/databases/depot/seed.mjs <new-file.db> [--empty]
 *
 * `--empty` makes the warehouses, bins and categories only: a depot on its
 * first day, which is what the home dashboard's first run is for. The seed
 * refuses an existing file or companion config, provisions the command
 * journal, the record history (with the last week's changes in it,
 * history.mjs) and the notification store, and writes `<file>.json` with a writable
 * connection named `depot`. seed-postgres.mjs copies the result into
 * PostgreSQL.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';
import { provisionStores } from '@mistriwork/mistri/maintenance';
import commands from '../../apps/depot/commands.ts';
import jobs from '../../apps/depot/jobs.ts';
import { ATTRIBUTES, BLURBS, CATEGORIES, COLOUR_CODES, CUSTOMERS, LINES, SPECS, SUPPLIERS, WAREHOUSES } from './catalog.mjs';
import { renderProduct } from './photos.mjs';
import { seedHistory } from './history.mjs';

/* The tables, in SQLite's words. seed-postgres.mjs says them again in
   PostgreSQL's, with the same names, keys and CHECKs. */
export const SCHEMA = `
  CREATE TABLE warehouse(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, address TEXT NOT NULL,
    city TEXT NOT NULL, state TEXT NOT NULL, phone TEXT NOT NULL, manager TEXT NOT NULL, dock_doors INTEGER NOT NULL);
  CREATE TABLE bin(id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES warehouse(id), code TEXT NOT NULL UNIQUE,
    aisle TEXT NOT NULL, zone TEXT NOT NULL CHECK(zone IN ('pick','reserve','receiving')), capacity INTEGER NOT NULL,
    active BOOLEAN NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE category(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL CHECK(department IN ('camp','pack','bike','apparel')));
  CREATE TABLE supplier(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact TEXT NOT NULL, email TEXT NOT NULL,
    phone TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, lead_time_days INTEGER NOT NULL CHECK(lead_time_days > 0),
    terms TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE product(id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES category(id), supplier_id INTEGER NOT NULL REFERENCES supplier(id),
    color TEXT, size TEXT, unit TEXT NOT NULL DEFAULT 'each' CHECK(unit IN ('each','pair','set')), upc TEXT UNIQUE,
    unit_cost NUMERIC(12,2) NOT NULL CHECK(unit_cost >= 0), list_price NUMERIC(12,2) NOT NULL CHECK(list_price >= 0), weight_lb NUMERIC(8,2),
    reorder_point INTEGER NOT NULL DEFAULT 0 CHECK(reorder_point >= 0), reorder_qty INTEGER NOT NULL DEFAULT 1 CHECK(reorder_qty > 0),
    home_bin_id INTEGER REFERENCES bin(id), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','discontinued')),
    description TEXT, specs JSON NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE attribute(id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES category(id), key TEXT NOT NULL, label TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text','textarea','number','money','date','datetime','bool','choice','choices')),
    options TEXT, required BOOLEAN NOT NULL DEFAULT 0, help TEXT, position INTEGER NOT NULL DEFAULT 0, UNIQUE(category_id, key));
  CREATE TABLE product_photo(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product(id), position INTEGER NOT NULL,
    caption TEXT, file_name TEXT NOT NULL, content_type TEXT, byte_size INTEGER, data BLOB NOT NULL, thumbnail BLOB);
  CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('shop','outfitter','online','team')),
    city TEXT NOT NULL, state TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, warehouse_id INTEGER NOT NULL REFERENCES warehouse(id));
  CREATE TABLE purchase_order(id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES supplier(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouse(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','partial','received','cancelled')),
    ordered_on DATE NOT NULL, sent_on DATE, expected_on DATE NOT NULL, received_on DATE, buyer TEXT NOT NULL, buyer_email TEXT, notes TEXT,
    draft_value NUMERIC(12,2), approval TEXT CHECK(approval IN ('requested','approved','rejected')), approver TEXT,
    version INTEGER NOT NULL DEFAULT 0);
  -- The purchase orders' flows, as rows Purchasing edits (resources.ts flows; the runner is jobs.ts).
  CREATE TABLE po_flow(id INTEGER PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL CHECK(start IN ('created','updated','manual')),
    condition TEXT, changes TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE po_flow_step(id INTEGER PRIMARY KEY, flow_id INTEGER NOT NULL REFERENCES po_flow(id), position INTEGER NOT NULL,
    kind TEXT NOT NULL, title TEXT, duration TEXT, field TEXT, condition TEXT, goto INTEGER, event TEXT, approver TEXT,
    UNIQUE(flow_id, position));
  CREATE TABLE po_line(id INTEGER PRIMARY KEY, purchase_order_id INTEGER NOT NULL REFERENCES purchase_order(id), line_no INTEGER NOT NULL,
    product_id INTEGER NOT NULL REFERENCES product(id), qty_ordered INTEGER NOT NULL CHECK(qty_ordered > 0),
    qty_received INTEGER NOT NULL DEFAULT 0 CHECK(qty_received >= 0), open_qty INTEGER NOT NULL CHECK(open_qty >= 0),
    unit_cost NUMERIC(12,2) NOT NULL, amount NUMERIC(12,2) NOT NULL, open_value NUMERIC(12,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','received','cancelled')),
    version INTEGER NOT NULL DEFAULT 0, UNIQUE(purchase_order_id, line_no));
  CREATE TABLE sales_order(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouse(id),
    channel TEXT NOT NULL DEFAULT 'phone' CHECK(channel IN ('edi','web','phone')),
    customer_po TEXT, ordered_on DATE NOT NULL DEFAULT CURRENT_DATE, ship_by DATE NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('rush','high','normal','low')),
    carrier TEXT NOT NULL DEFAULT 'UPS' CHECK(carrier IN ('UPS','FedEx','USPS','Freight')), notes TEXT,
    version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE order_line(id INTEGER PRIMARY KEY, sales_order_id INTEGER NOT NULL REFERENCES sales_order(id),
    product_id INTEGER NOT NULL REFERENCES product(id), qty INTEGER NOT NULL CHECK(qty > 0), bin_id INTEGER REFERENCES bin(id),
    version INTEGER NOT NULL DEFAULT 0);
  -- A receiver's signature for a shipment, drawn on the pick list's form and kept as a picture (resources.ts).
  CREATE TABLE delivery_signature(id INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_type TEXT, byte_size INTEGER, data BLOB NOT NULL);
  CREATE TABLE pick_list(id INTEGER PRIMARY KEY, sales_order_id INTEGER NOT NULL UNIQUE REFERENCES sales_order(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouse(id), reference TEXT NOT NULL, ship_to TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'to_pick' CHECK(status IN ('to_pick','picked','packed','shipped')),
    released_at TIMESTAMP NOT NULL, picked_at TIMESTAMP,
    packed_at TIMESTAMP, cartons INTEGER, shipped_at TIMESTAMP, carrier TEXT, tracking TEXT,
    signature_id INTEGER REFERENCES delivery_signature(id), version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE cycle_count(id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES warehouse(id), aisle TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'counting' CHECK(status IN ('counting','completed')), started_on DATE NOT NULL,
    completed_on DATE, note TEXT, version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE stock_level(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product(id), bin_id INTEGER NOT NULL REFERENCES bin(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouse(id), qty INTEGER NOT NULL CHECK(qty >= 0), value NUMERIC(12,2) NOT NULL,
    last_counted_on DATE, version INTEGER NOT NULL DEFAULT 0, UNIQUE(product_id, bin_id));
  CREATE TABLE cycle_count_line(id INTEGER PRIMARY KEY, cycle_count_id INTEGER NOT NULL REFERENCES cycle_count(id),
    stock_level_id INTEGER NOT NULL REFERENCES stock_level(id), product_id INTEGER NOT NULL REFERENCES product(id),
    bin_id INTEGER NOT NULL REFERENCES bin(id), expected_qty INTEGER NOT NULL, counted_qty INTEGER CHECK(counted_qty >= 0),
    variance INTEGER, variance_value NUMERIC(12,2), version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE stock_movement(id INTEGER PRIMARY KEY, moved_at TIMESTAMP NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('receipt','pick','transfer','adjustment','count')),
    product_id INTEGER NOT NULL REFERENCES product(id), bin_id INTEGER NOT NULL REFERENCES bin(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouse(id), qty INTEGER NOT NULL, unit_cost NUMERIC(12,2) NOT NULL, value NUMERIC(12,2) NOT NULL,
    bin_qty_after INTEGER NOT NULL, on_hand_after INTEGER NOT NULL, reference TEXT NOT NULL,
    reason TEXT CHECK(reason IN ('damaged','lost','found','expired','correction')), note TEXT,
    purchase_order_id INTEGER REFERENCES purchase_order(id), pick_list_id INTEGER REFERENCES pick_list(id),
    cycle_count_id INTEGER REFERENCES cycle_count(id), moved_by TEXT);
  CREATE INDEX stock_movement_product ON stock_movement(product_id, moved_at);
  CREATE INDEX stock_movement_bin ON stock_movement(bin_id, moved_at);
  CREATE INDEX stock_level_bin ON stock_level(bin_id);
  CREATE INDEX po_line_product ON po_line(product_id);
  CREATE INDEX order_line_order ON order_line(sales_order_id);
  CREATE INDEX order_line_product ON order_line(product_id);
  -- The references a record's lists find their rows by (mistri check names each).
  CREATE INDEX product_supplier ON product(supplier_id);
  CREATE INDEX product_photo_product ON product_photo(product_id);
  CREATE INDEX bin_warehouse ON bin(warehouse_id);
  CREATE INDEX stock_level_warehouse ON stock_level(warehouse_id);
  CREATE INDEX stock_movement_warehouse ON stock_movement(warehouse_id);
  CREATE INDEX stock_movement_purchase_order ON stock_movement(purchase_order_id);
  CREATE INDEX stock_movement_pick_list ON stock_movement(pick_list_id);
  CREATE INDEX purchase_order_supplier ON purchase_order(supplier_id);
  CREATE INDEX po_flow_step_flow ON po_flow_step(flow_id);
  CREATE INDEX pick_list_warehouse ON pick_list(warehouse_id);
  CREATE INDEX cycle_count_warehouse ON cycle_count(warehouse_id);
  CREATE INDEX cycle_count_line_count ON cycle_count_line(cycle_count_id);`;

/* ---------- deterministic chance ---------- */

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const rand = random(20260704);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;
function weighted(items, weight) {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let r = rand() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/* ---------- dates ---------- */

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (date) => date.toISOString().slice(0, 10);
/* Today in Los Angeles, the warehouses' day (app.ts `timezone`): UTC's date is already tomorrow on a Pacific evening. */
const shopToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOf(d);
};
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const at = (day, hour, minute = 0) => `${day} ${pad(hour)}:${pad(minute)}:00`;
/** The next working day on or after `day`: warehouses ship Monday to Friday. */
const working = (day) => {
  let d = day;
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
  return d;
};
const money = (n) => Math.round(n * 100) / 100;

const HISTORY_DAYS = 182;
const BUYERS = ['Nora Whitaker', 'Sam Okafor'];

/* ---------- the catalog as SKUs ---------- */

function products() {
  const out = [];
  const sizeCode = (size) =>
    size
      .replace(/[^A-Za-z0-9.]/g, '')
      .replace(/\./g, '')
      .toUpperCase()
      .slice(0, 5);
  for (const [category, supplier, model, name, cost, price, unit, shape, colours, sizes, demand, orderQty] of LINES) {
    const variants = [];
    for (const colour of colours) for (const size of sizes.length ? sizes : [null]) variants.push({ colour, size });
    // Middle sizes sell most; the first colour a little more than the rest.
    const weights = variants.map((v) => {
      const s = v.size ? sizes.indexOf(v.size) : 0;
      const middle = sizes.length > 2 && s > 0 && s < sizes.length - 1 ? 1.6 : 1;
      return middle * (v.colour === colours[0] ? 1.25 : 1);
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    variants.forEach((v, i) => {
      const colourCode = COLOUR_CODES[v.colour];
      const sku = [category, model, colourCode, v.size ? sizeCode(v.size) : null].filter(Boolean).join('-');
      const title = [name, v.size, v.colour]
        .filter(Boolean)
        .join(v.size ? ', ' : ' — ')
        .replace(`, ${v.colour}`, ` — ${v.colour}`);
      out.push({
        category,
        supplier,
        sku,
        name: v.size ? `${name}, ${v.size} — ${v.colour}` : `${name} — ${v.colour}`,
        title,
        cost,
        price,
        unit,
        shape,
        colour: v.colour,
        size: v.size,
        demand: (demand * weights[i]) / sum,
        orderQty,
        model,
      });
    });
  }
  return out.map((p, i) => ({ ...p, id: i + 1 }));
}

/* ---------- the seed ---------- */

export async function seed(file, { empty = false, today = process.env.DEPOT_TODAY } = {}) {
  file = resolve(file);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new database path.`);
  const TODAY = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : shopToday();
  const START = addDays(TODAY, -HISTORY_DAYS);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=ON; ${SCHEMA} BEGIN;`);
    const insert = (table, row) => {
      const cols = Object.keys(row);
      return db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    };
    const prepared = new Map();
    const put = (table, row) => {
      const cols = Object.keys(row),
        key = `${table}:${cols.join(',')}`;
      if (!prepared.has(key))
        prepared.set(key, db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`));
      return prepared.get(key).run(...cols.map((c) => row[c] ?? null));
    };

    /* Warehouses and their bins: pick shelving by aisle, bay and level, a
       reserve aisle of pallet positions, and a receiving dock. */
    const bins = []; // { id, warehouse, code, aisle, zone }
    WAREHOUSES.forEach(([code, name, city, state, address, phone, manager, doors, layout], w) => {
      insert('warehouse', { id: w + 1, code, name, address, city, state, phone, manager, dock_doors: doors });
      const add = (binCode, aisle, zone, capacity) => {
        const id = bins.length + 1;
        put('bin', { id, warehouse_id: w + 1, code: `${code}-${binCode}`, aisle, zone, capacity, active: 1 });
        bins.push({ id, warehouse: w + 1, code: `${code}-${binCode}`, aisle, zone });
      };
      for (const aisle of layout.aisles)
        for (let bay = 1; bay <= layout.bays; bay++)
          for (let level = 1; level <= 3; level++) {
            add(`${aisle}-${pad(bay)}-${level}`, aisle, 'pick', 120);
          }
      for (let bay = 1; bay <= layout.reserve; bay++) add(`R-${pad(bay)}`, 'R', 'reserve', 600);
      add('DOCK', 'DOCK', 'receiving', 2000);
    });
    CATEGORIES.forEach(([code, name, department], i) => insert('category', { id: i + 1, code, name, department }));
    const categoryId = (code) => CATEGORIES.findIndex((c) => c[0] === code) + 1;
    /* What a product of each category is specified by: rows a buyer edits, not columns (product.specs). */
    ATTRIBUTES.forEach(([category, key, label, type, options, required, help, position], i) =>
      insert('attribute', {
        id: i + 1,
        category_id: category ? categoryId(category) : null,
        key,
        label,
        type,
        options: options ? options.join('\n') : null,
        required: required ? 1 : 0,
        help,
        position,
      }),
    );

    /* The purchase orders' one flow, made even for an empty depot: an order drafted over $5,000 waits
       for a manager's approval and goes to its supplier when it has it. Its steps are rows: the
       approval step's `approver` is its kind's input (resources.ts), the branch ends a rejected run. */
    insert('po_flow', { id: 1, name: 'Large order approval', start: 'created', condition: 'draft_value > 5000', active: 1 });
    [
      { position: 1, kind: 'approval', title: 'Ask a manager to approve', approver: 'Manager' },
      { position: 2, kind: 'branch', title: 'Go on only if approved', condition: 'approval = approved' },
      { position: 3, kind: 'send', title: 'Send to the supplier' },
    ].forEach((step, i) => insert('po_flow_step', { id: i + 1, flow_id: 1, ...step }));

    if (!empty) populate({ db, put, bins, categoryId, TODAY, START });
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing open */
    }
    throw error;
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  // The store shipList's order.shipped events are kept in, which the API's feed reads.
  await provisionStores({ sqlite: file }, { app: { id: 'depot', source: 'depot' } });
  await provisionStores({ sqlite: file }, { only: ['record-history', 'inbox'] });
  // The job store the flows' runner keeps its runs in (serve with --jobs test/fixtures/apps/depot/jobs.ts).
  await provisionStores({ sqlite: file }, { app: { id: 'depot', commands }, jobs });
  // The week the data describes, as the App would have recorded it (history.mjs).
  if (!empty) seedHistory(file, TODAY);
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'depot', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

function populate({ put, bins, categoryId, TODAY, START }) {
  SUPPLIERS.forEach(([name, contact, city, state, lead, terms], i) =>
    put('supplier', {
      id: i + 1,
      name,
      contact,
      city,
      state,
      lead_time_days: lead,
      terms,
      email: `${contact.split(' ')[0].toLowerCase()}@${name
        .toLowerCase()
        .replace(/[^a-z]+/g, '')
        .slice(0, 14)}.example.test`,
      phone: `(${[303, 503, 801, 385, 408, 208, 414, 330, 949, 206, 802, 406][i]}) 555-01${pad(10 + i * 7)}`,
    }),
  );
  CUSTOMERS.forEach(([name, kind, city, state, wh], i) =>
    put('customer', {
      id: i + 1,
      name,
      kind,
      city,
      state,
      warehouse_id: WAREHOUSES.findIndex((w) => w[0] === wh) + 1,
      email: `orders@${name
        .toLowerCase()
        .replace(/[^a-z]+/g, '')
        .slice(0, 16)}.example.test`,
      phone: `(555) 555-01${pad(i + 10)}`,
    }),
  );

  const catalog = products();
  const W = [1, 2, 3];
  const SHARE = { 1: 0.5, 2: 0.3, 3: 0.2 };
  const pickBins = (w) => bins.filter((b) => b.warehouse === w && b.zone === 'pick');
  const reserveBins = (w) => bins.filter((b) => b.warehouse === w && b.zone === 'reserve');

  /* Where each SKU lives. Reno stocks the whole line; Columbus and Allentown
     the faster movers. Two SKUs share a shelf where there are more SKUs than
     shelves; the fastest in Reno also keep a pallet in reserve. */
  const byDemand = [...catalog].sort((a, b) => b.demand - a.demand);
  const stocked = new Map(); // `${w}:${product}` → { bins: [binId], min, max }
  const home = new Map(); // `${w}:${product}` → pick bin id
  for (const w of W) {
    const shelves = pickBins(w),
      reserve = reserveBins(w);
    const carried = w === 1 ? catalog : byDemand.slice(0, w === 2 ? 150 : 110);
    [...carried]
      .sort((a, b) => a.id - b.id)
      .forEach((p, i) => {
        const shelf = shelves[Math.floor((i / carried.length) * shelves.length)];
        home.set(`${w}:${p.id}`, shelf.id);
        const binsHere = [shelf.id];
        const rank = byDemand.indexOf(p);
        if (rank < reserve.length * 2 && rank % 2 === 0 && w === 1) binsHere.push(reserve[rank / 2].id);
        else if (rank < reserve.length && w !== 1) binsHere.push(reserve[rank].id);
        stocked.set(`${w}:${p.id}`, { product: p, warehouse: w, bins: binsHere });
      });
  }
  // A warehouse's share of each SKU's network demand.
  const shareOf = (w, p) => {
    const carriers = W.filter((x) => stocked.has(`${x}:${p.id}`));
    return SHARE[w] / carriers.reduce((s, x) => s + SHARE[x], 0);
  };

  /* Reorder point: the network's demand over its supplier's lead time and a
     week of safety; reorder quantity: about a month of demand, in whole cases. */
  for (const p of catalog) {
    const lead = SUPPLIERS[p.supplier - 1][4];
    p.reorderPoint = Math.max(4, Math.round(p.demand * (lead + 7)));
    const casePack = p.orderQty >= 12 ? 12 : p.orderQty >= 4 ? 6 : 2;
    p.reorderQty = Math.max(casePack, Math.ceil((p.demand * 30) / casePack) * casePack);
    put('product', {
      id: p.id,
      sku: p.sku,
      name: p.name,
      category_id: categoryId(p.category),
      supplier_id: p.supplier,
      specs: JSON.stringify(SPECS[p.model] ?? {}),
      color: p.colour,
      size: p.size,
      unit: p.unit,
      upc: `0${String(84400000000 + p.id * 97).padStart(11, '0')}`.slice(0, 12),
      unit_cost: p.cost,
      list_price: p.price,
      weight_lb: money(
        {
          tent: 4.2,
          sack: 2.1,
          pad: 1.4,
          stove: 0.6,
          pot: 0.8,
          headlamp: 0.3,
          bottle: 0.4,
          pack: 2.6,
          poles: 1.1,
          helmet: 0.8,
          bikelight: 0.3,
          tire: 1.1,
          pump: 1.3,
          lock: 2.2,
          jacket: 0.9,
          shirt: 0.5,
          glove: 0.3,
          sock: 0.2,
        }[p.shape] *
          (0.9 + (p.id % 5) / 20),
      ),
      reorder_point: p.reorderPoint,
      reorder_qty: p.reorderQty,
      home_bin_id: home.get(`1:${p.id}`),
      // Last year's youth bag is being sold through and not reordered.
      status: p.model === 'CUB' ? 'discontinued' : 'active',
      description: `${p.title}. ${BLURBS[p.shape]}`,
    });
    // One studio shot per SKU, drawn in its colour.
    const { photo, thumb } = renderProduct({ shape: p.shape, colour: p.colour, variant: p.id });
    put('product_photo', {
      product_id: p.id,
      position: 1,
      caption: p.name,
      file_name: `${p.sku.toLowerCase()}.png`,
      content_type: 'image/png',
      byte_size: photo.byteLength,
      data: photo,
      thumbnail: thumb,
    });
  }

  /* ---------- stock and the ledger ---------- */

  const levels = new Map(); // `${product}:${bin}` → { id, product, bin, warehouse, qty, counted }
  const onHand = new Map(); // product → network quantity
  let levelId = 0;
  const level = (p, binId) => {
    const key = `${p.id}:${binId}`;
    if (!levels.has(key)) {
      const bin = bins[binId - 1];
      levels.set(key, { id: ++levelId, product: p, bin: binId, warehouse: bin.warehouse, qty: 0, counted: null });
    }
    return levels.get(key);
  };
  const inWarehouse = (w, p) => [...(stocked.get(`${w}:${p.id}`)?.bins ?? [])].map((b) => level(p, b));
  const available = (w, p) => inWarehouse(w, p).reduce((s, l) => s + l.qty, 0);
  const movements = [];
  const move = (when, kind, p, binId, qty, reference, extra = {}) => {
    const l = level(p, binId);
    l.qty += qty;
    if (l.qty < 0) throw new Error(`${p.sku} went below zero in ${bins[binId - 1].code} on ${when}`);
    onHand.set(p.id, (onHand.get(p.id) ?? 0) + qty);
    movements.push({
      moved_at: when,
      kind,
      product_id: p.id,
      bin_id: binId,
      warehouse_id: bins[binId - 1].warehouse,
      qty,
      unit_cost: p.cost,
      value: money(qty * p.cost),
      bin_qty_after: l.qty,
      on_hand_after: onHand.get(p.id),
      reference,
      ...extra,
    });
  };

  // Opening balances: the day the ledger starts, counted in.
  const mins = new Map();
  for (const [key, s] of stocked) {
    const p = s.product,
      share = shareOf(s.warehouse, p);
    const min = Math.max(2, Math.round(p.reorderPoint * share));
    mins.set(key, { min, up: Math.max(min + 2, Math.round((p.reorderPoint + p.reorderQty) * share)) });
    const qty = p.model === 'CUB' ? between(3, 8) : Math.round(mins.get(key).up * (0.7 + rand() * 0.5));
    const [shelf, reserve] = s.bins;
    if (reserve) {
      const r = Math.round(qty * 0.6);
      move(at(START, 6), 'count', p, reserve, r, 'Opening count');
      move(at(START, 6), 'count', p, shelf, qty - r, 'Opening count');
    } else move(at(START, 6), 'count', p, shelf, qty, 'Opening count');
  }

  /* ---------- purchasing ---------- */

  let poId = 7000;
  const pos = []; // { id, supplier, warehouse, status, ordered_on, sent_on, expected_on, received_on, buyer, lines: [...] }
  const onOrder = new Map(); // `${w}:${product}` → open quantity
  function raisePO(day, supplier, w, wanted, { send = true } = {}) {
    const lead = SUPPLIERS[supplier - 1][4];
    const po = {
      id: ++poId,
      supplier,
      warehouse: w,
      status: send ? 'sent' : 'draft',
      ordered_on: day,
      sent_on: send ? day : null,
      expected_on: working(addDays(day, lead + between(-1, 2))),
      received_on: null,
      buyer: pick(BUYERS),
      lines: [],
    };
    wanted.forEach(({ product, qty }, i) => {
      po.lines.push({ line_no: i + 1, product, qty_ordered: qty, qty_received: 0, status: send ? 'open' : 'draft' });
      if (send) onOrder.set(`${w}:${product.id}`, (onOrder.get(`${w}:${product.id}`) ?? 0) + qty);
    });
    pos.push(po);
    return po;
  }
  function receive(po, line, qty, when) {
    const p = line.product,
      s = stocked.get(`${po.warehouse}:${p.id}`);
    // A pallet goes to reserve where the SKU has one; otherwise straight to its shelf.
    const target = s.bins[1] ?? s.bins[0];
    move(when, 'receipt', p, target, qty, `PO-${po.id}`, { purchase_order_id: po.id });
    line.qty_received += qty;
    onOrder.set(`${po.warehouse}:${p.id}`, (onOrder.get(`${po.warehouse}:${p.id}`) ?? 0) - qty);
    if (line.qty_received >= line.qty_ordered) line.status = 'received';
  }
  // A few purchase orders are held back on arrival, and some arrive short.
  const lateReceipt = new Set(),
    shortReceipt = new Set();

  /* ---------- orders ---------- */

  let orderId = 24000;
  const orders = [];
  const reserved = new Map(); // `${w}:${product}` → quantity promised to lists not yet picked
  const custByWarehouse = (w) =>
    CUSTOMERS.map((c, i) => ({ id: i + 1, name: c[0], city: c[2], state: c[3], w: WAREHOUSES.findIndex((x) => x[0] === c[4]) + 1 })).filter(
      (c) => c.w === w,
    );
  function pickFrom(w, p, qty, when, reference, pickListId) {
    // The shelf first, then the reserve pallet.
    let left = qty;
    const from = [];
    for (const l of inWarehouse(w, p)) {
      if (!left) break;
      const take = Math.min(left, l.qty);
      if (take > 0) {
        move(when, 'pick', p, l.bin, -take, reference, { pick_list_id: pickListId });
        left -= take;
        from.push(l.bin);
      }
    }
    if (left) throw new Error(`short pick ${p.sku}`);
    return from[0];
  }

  /* ---------- walking the days ---------- */

  let countId = 300;
  const counts = [];
  const days = [];
  for (let d = START; d <= TODAY; d = addDays(d, 1)) days.push(d);
  for (const day of days) {
    const dow = weekday(day),
      open = dow !== 0 && dow !== 6,
      isToday = day === TODAY;

    // Morning: the trucks that arrive. Receiving starts at seven.
    if (open) {
      for (const po of pos) {
        if (po.status !== 'sent' && po.status !== 'partial') continue;
        const due = po.status === 'sent' ? po.expected_on : po.remainder_on;
        if (!due || due > day || lateReceipt.has(po.id)) continue;
        if (isToday && po.status === 'sent') continue; // today's trucks are still on the road
        // Two trucks due this week never came: the supplier is rebooking them.
        if (po.status === 'sent' && lateReceipt.size < 2 && due >= addDays(TODAY, -5) && chance(0.5)) {
          lateReceipt.add(po.id);
          continue;
        }
        const when = at(day, between(6, 7), between(0, 59));
        if (po.status === 'sent' && shortReceipt.has(po.id)) {
          // Part of it came: the rest follows in a few days.
          for (const line of po.lines) receive(po, line, Math.max(1, Math.round(line.qty_ordered * (0.5 + rand() * 0.3))), when);
          po.status = 'partial';
          po.remainder_on = working(addDays(day, between(3, 6)));
        } else {
          for (const line of po.lines)
            if (line.qty_received < line.qty_ordered) receive(po, line, line.qty_ordered - line.qty_received, when);
          po.status = 'received';
          po.received_on = day;
        }
      }
    }

    // The day's orders and their picks.
    // Today always has a queue: web and EDI orders land at the weekend too, and wait for the floor.
    if (dow !== 0 || isToday) {
      const count = isToday ? between(14, 19) : dow === 6 ? between(1, 3) : between(6, 11);
      for (let n = 0; n < count; n++) {
        const w = weighted(W, (x) => SHARE[x]);
        const customer = pick(custByWarehouse(w));
        const age = days.length - 1 - days.indexOf(day); // working days are close enough
        const priority = weighted(['rush', 'high', 'normal', 'low'], (x) => ({ rush: 0.08, high: 0.2, normal: 0.62, low: 0.1 })[x]);
        const shipBy = working(addDays(day, { rush: 1, high: 2, normal: 3, low: 5 }[priority]));
        // A pick list is picked the day it is released, or the next; lists released today are waiting.
        const stage =
          age >= 2
            ? 'shipped'
            : age === 1
              ? pick(['shipped', 'shipped', 'packed', 'picked'])
              : pick(['to_pick', 'to_pick', 'to_pick', 'picked']);
        const lines = [];
        const wanted = between(1, 5);
        const candidates = [...stocked.values()].filter((s) => s.warehouse === w && s.product.model !== 'CUB');
        for (let k = 0; k < wanted * 3 && lines.length < wanted; k++) {
          const s = weighted(candidates, (c) => c.product.demand);
          if (lines.some((l) => l.product.id === s.product.id)) continue;
          const key = `${w}:${s.product.id}`;
          const free = available(w, s.product) - (reserved.get(key) ?? 0);
          let qty = Math.max(1, Math.round(s.product.orderQty * (0.5 + rand())));
          if (free <= 0) continue;
          qty = Math.min(qty, free);
          lines.push({ product: s.product, qty });
        }
        if (!lines.length) continue;
        const id = ++orderId;
        const released = at(day, between(8, 11), between(0, 59));
        const order = { id, customer, w, day, priority, shipBy, stage, lines, released, units: lines.reduce((s, l) => s + l.qty, 0) };
        order.carrier = order.units > 40 ? 'Freight' : weighted(['UPS', 'FedEx', 'USPS'], (c) => ({ UPS: 5, FedEx: 3, USPS: 1 })[c]);
        if (stage === 'to_pick') {
          for (const l of lines) {
            l.bin = home.get(`${w}:${l.product.id}`);
            const key = `${w}:${l.product.id}`;
            reserved.set(key, (reserved.get(key) ?? 0) + l.qty);
          }
        } else {
          const pickedAt = at(day, Number(released.slice(11, 13)) + between(1, 2), between(0, 59));
          for (const l of lines) {
            l.bin = pickFrom(w, l.product, l.qty, pickedAt, `SO-${id}`, id);
            l.picked = l.qty;
          }
          order.pickedAt = pickedAt;
        }
        orders.push(order);
      }
    }

    // Evening: shelves topped up from reserve, the odd adjustment, a cycle count.
    if (open) {
      for (const s of stocked.values()) {
        const [shelf, reserve] = s.bins;
        if (!reserve) continue;
        const sl = level(s.product, shelf),
          rl = level(s.product, reserve);
        const min = mins.get(`${s.warehouse}:${s.product.id}`).min;
        if (sl.qty < Math.max(2, Math.round(min * 0.4)) && rl.qty > 0) {
          const qty = Math.min(rl.qty, Math.max(2, Math.round(min * 0.8)));
          const when = at(day, 14, between(10, 50));
          move(when, 'transfer', s.product, reserve, -qty, 'Replenish shelf', { note: `To ${bins[shelf - 1].code}` });
          move(when, 'transfer', s.product, shelf, qty, 'Replenish shelf', { note: `From ${bins[reserve - 1].code}` });
        }
      }
      if (!isToday && chance(0.3)) {
        const s = pick([...stocked.values()]);
        const l = level(s.product, s.bins[0]);
        const reason = weighted(
          ['damaged', 'lost', 'found', 'expired', 'correction'],
          (r) => ({ damaged: 4, lost: 2, found: 2, expired: s.product.shape === 'stove' ? 2 : 0, correction: 1 })[r],
        );
        const qty = reason === 'found' ? between(1, 3) : -Math.min(l.qty, between(1, 3));
        if (qty)
          move(at(day, 15, between(0, 59)), 'adjustment', s.product, s.bins[0], qty, 'Adjustment', {
            reason,
            note: {
              damaged: 'Crushed carton on the shelf',
              lost: 'Not found at pick',
              found: 'Found behind the shelf',
              expired: 'Canister past its date',
              correction: 'Receiving keyed the wrong size',
            }[reason],
          });
      }
      // Tuesdays: one aisle of one warehouse is counted, every bin in it.
      if (dow === 2 && !isToday) {
        const w = W[((days.indexOf(day) / 7) % 3) | 0],
          aisles = WAREHOUSES[w - 1][8].aisles;
        const aisle = aisles[Math.floor(days.indexOf(day) / 21) % aisles.length];
        const cc = { id: ++countId, warehouse: w, aisle, status: 'completed', started_on: day, completed_on: day, lines: [] };
        for (const l of levels.values()) {
          const bin = bins[l.bin - 1];
          if (bin.warehouse !== w || bin.aisle !== aisle) continue;
          const expected = l.qty;
          const variance = chance(0.08) ? (chance(0.5) ? -1 : 1) * between(1, 2) : 0;
          const counted = Math.max(0, expected + variance);
          if (counted !== expected)
            move(at(day, 16, 30), 'count', l.product, l.bin, counted - expected, `CC-${cc.id}`, { cycle_count_id: cc.id });
          l.counted = day;
          cc.lines.push({ level: l, expected, counted });
        }
        if (cc.lines.length) counts.push(cc);
      }
    }

    /* Replenishment, at the day's end. Each supplier has an order day every
       other week; a warehouse then orders everything of theirs that would run
       below its minimum before the next one, up to its maximum. */
    if (open && !isToday) {
      const wanting = new Map(); // `${supplier}:${w}` → [{ product, qty }]
      const fortnight = Math.floor(days.indexOf(day) / 7) % 2;
      for (const [key, s] of stocked) {
        const supplier = s.product.supplier;
        if (s.product.model === 'CUB' || dow !== (supplier % 5) + 1 || fortnight !== supplier % 2) continue;
        const { min, up } = mins.get(key);
        const cycle = Math.ceil(s.product.demand * shareOf(s.warehouse, s.product) * 14);
        const position = available(s.warehouse, s.product) + (onOrder.get(key) ?? 0) - (reserved.get(key) ?? 0);
        if (position >= min + cycle) continue;
        const group = `${supplier}:${s.warehouse}`;
        if (!wanting.has(group)) wanting.set(group, []);
        wanting.get(group).push({ product: s.product, qty: Math.max(2, up + cycle - position) });
      }
      for (const [group, wanted] of wanting) {
        const [supplier, w] = group.split(':').map(Number);
        const po = raisePO(day, supplier, w, wanted);
        // One in eight arrives short; the remainder follows.
        if (chance(0.12)) shortReceipt.add(po.id);
      }
    }
  }

  /* Today's desk: the buyers have drafts waiting to be sent for the SKUs
     running short with nothing on order. */
  const short = [];
  for (const p of catalog) {
    if (p.model === 'CUB') continue;
    const network = onHand.get(p.id) ?? 0;
    const coming = W.reduce((s, w) => s + (onOrder.get(`${w}:${p.id}`) ?? 0), 0);
    if (network < p.reorderPoint && coming === 0) short.push(p);
  }
  const drafts = new Map();
  for (const p of short.slice(0, 12)) {
    if (!drafts.has(p.supplier)) drafts.set(p.supplier, []);
    drafts.get(p.supplier).push({ product: p, qty: p.reorderQty });
  }
  for (const [supplier, wanted] of drafts) raisePO(TODAY, supplier, 1, wanted, { send: false });

  /* The one short pick list: a rush order for more Beacon 400s than Columbus
     holds, released this morning. Picking it is refused until stock moves. */
  {
    const p = catalog.find((x) => x.sku === 'LGT-B40-RED');
    if (!stocked.has(`2:${p.id}`)) throw new Error('Columbus should carry the Beacon 400 in red.');
    const w = 2,
      have = available(w, p) - (reserved.get(`${w}:${p.id}`) ?? 0);
    const customer = custByWarehouse(w).find((c) => c.name === 'North Woods Outfitting');
    orders.push({
      id: ++orderId,
      customer,
      w,
      day: TODAY,
      priority: 'rush',
      shipBy: working(addDays(TODAY, 1)),
      stage: 'to_pick',
      released: at(TODAY, 8, 5),
      carrier: 'UPS',
      units: have + 12 + 1,
      lines: [
        { product: p, qty: have + 12, bin: home.get(`${w}:${p.id}`) },
        {
          product: catalog.find((x) => x.sku === 'H2O-B1L-TEA'),
          qty: 1,
          bin: home.get(`${w}:${catalog.find((x) => x.sku === 'H2O-B1L-TEA').id}`),
        },
      ],
      note: 'Store reset on Friday: ship complete, no backorders.',
    });
  }

  // A count in progress in Columbus, aisle B: half its bins counted so far.
  {
    const cc = { id: ++countId, warehouse: 2, aisle: 'B', status: 'counting', started_on: TODAY, completed_on: null, lines: [] };
    let k = 0;
    for (const l of levels.values()) {
      const bin = bins[l.bin - 1];
      if (bin.warehouse !== 2 || bin.aisle !== 'B') continue;
      cc.lines.push({ level: l, expected: l.qty, counted: k++ % 2 === 0 ? l.qty + (k === 5 ? -2 : 0) : null, open: true });
    }
    counts.push(cc);
  }

  /* ---------- rows ---------- */

  for (const po of pos) {
    put('purchase_order', {
      id: po.id,
      supplier_id: po.supplier,
      warehouse_id: po.warehouse,
      status: po.status,
      ordered_on: po.ordered_on,
      sent_on: po.sent_on,
      expected_on: po.expected_on,
      received_on: po.received_on,
      buyer: po.buyer,
      notes: lateReceipt.has(po.id) ? 'Carrier missed the pickup window; supplier is rebooking.' : null,
      draft_value: money(po.lines.reduce((sum, line) => sum + line.qty_ordered * line.product.cost, 0)),
    });
    for (const line of po.lines) {
      const p = line.product,
        open = line.status === 'open' ? line.qty_ordered - line.qty_received : 0;
      put('po_line', {
        purchase_order_id: po.id,
        line_no: line.line_no,
        product_id: p.id,
        qty_ordered: line.qty_ordered,
        qty_received: line.qty_received,
        open_qty: open,
        unit_cost: p.cost,
        amount: money(line.qty_ordered * p.cost),
        open_value: money(open * p.cost),
        status: line.status,
      });
    }
  }
  /* Two of today's phone orders are keyed but not yet released to the
     floor: they have no pick list until someone releases them. */
  const waiting = new Set(
    orders
      .filter((o) => o.day === TODAY && o.stage === 'to_pick' && !o.note)
      .slice(-2)
      .map((o) => o.id),
  );
  let lineId = 0;
  for (const o of orders) {
    put('sales_order', {
      id: o.id,
      customer_id: o.customer.id,
      warehouse_id: o.w,
      channel: waiting.has(o.id) ? 'phone' : pick(['edi', 'edi', 'web', 'phone']),
      customer_po: `${o.customer.name.split(' ')[0].toUpperCase().slice(0, 4)}-${1000 + (o.id % 900)}`,
      ordered_on: o.day,
      ship_by: o.shipBy,
      priority: o.priority,
      carrier: o.carrier,
      notes: o.note ?? null,
    });
    o.lines.forEach((l) => put('order_line', { id: ++lineId, sales_order_id: o.id, product_id: l.product.id, qty: l.qty, bin_id: l.bin }));
    if (waiting.has(o.id)) continue;
    const shipped = o.stage === 'shipped',
      packed = shipped || o.stage === 'packed',
      picked = packed || o.stage === 'picked';
    const next = working(addDays(o.day, 1));
    const shipDay = o.day < TODAY ? (o.shipBy < next ? o.day : next) : o.day;
    put('pick_list', {
      id: o.id,
      sales_order_id: o.id,
      warehouse_id: o.w,
      reference: `SO-${o.id}`,
      ship_to: `${o.customer.name}, ${o.customer.city}, ${o.customer.state}`,
      status: o.stage,
      released_at: o.released,
      picked_at: picked ? o.pickedAt : null,
      packed_at: packed ? at(o.day, 17, 15) : null,
      cartons: packed ? Math.max(1, Math.ceil(o.units / 8)) : null,
      shipped_at: shipped ? at(shipDay > TODAY ? TODAY : shipDay, 18, 30) : null,
      carrier: shipped ? o.carrier : null,
      tracking: shipped
        ? o.carrier === 'UPS'
          ? `1Z${String(9000000000 + o.id * 7919).slice(0, 10)}`
          : o.carrier === 'Freight'
            ? `PRO ${o.id}88`
            : `9400${o.id}${o.id % 97}`
        : null,
    });
  }
  for (const cc of counts) {
    put('cycle_count', {
      id: cc.id,
      warehouse_id: cc.warehouse,
      aisle: cc.aisle,
      status: cc.status,
      started_on: cc.started_on,
      completed_on: cc.completed_on,
      note: cc.status === 'counting' ? 'Quarterly count of aisle B before the holiday build.' : null,
    });
  }
  // Stock levels as the ledger left them, each valued at its SKU's standard cost.
  for (const l of [...levels.values()].sort((a, b) => a.id - b.id)) {
    put('stock_level', {
      id: l.id,
      product_id: l.product.id,
      bin_id: l.bin,
      warehouse_id: l.warehouse,
      qty: l.qty,
      value: money(l.qty * l.product.cost),
      last_counted_on: l.counted,
    });
  }
  for (const cc of counts)
    for (const line of cc.lines) {
      const variance = line.counted === null ? null : line.counted - line.expected;
      put('cycle_count_line', {
        cycle_count_id: cc.id,
        stock_level_id: line.level.id,
        product_id: line.level.product.id,
        bin_id: line.level.bin,
        expected_qty: line.expected,
        counted_qty: line.counted,
        variance: line.open ? null : variance,
        variance_value: line.open ? null : money((variance ?? 0) * line.level.product.cost),
      });
    }
  /* In time order, the balances after each movement said again: a day's
     receipts come before its picks, its picks before the evening's work. */
  movements.sort((a, b) => (a.moved_at < b.moved_at ? -1 : a.moved_at > b.moved_at ? 1 : 0));
  const binAfter = new Map(),
    networkAfter = new Map();
  for (const m of movements) {
    const key = `${m.product_id}:${m.bin_id}`;
    m.bin_qty_after = (binAfter.get(key) ?? 0) + m.qty;
    binAfter.set(key, m.bin_qty_after);
    m.on_hand_after = (networkAfter.get(m.product_id) ?? 0) + m.qty;
    networkAfter.set(m.product_id, m.on_hand_after);
    if (m.bin_qty_after < 0) throw new Error(`${m.product_id} below zero in bin ${m.bin_id} at ${m.moved_at}`);
    put('stock_movement', m);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) throw new Error('Usage: node --import tsx test/fixtures/databases/depot/seed.mjs <new-file.db> [--empty]');
  console.log(await seed(target, { empty: args.includes('--empty') }));
}
