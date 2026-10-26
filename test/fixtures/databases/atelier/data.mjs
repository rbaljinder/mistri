/**
 * Six months of Atelier, as rows: the catalog and its photos, stock in three
 * locations, about four hundred customers and fifteen hundred orders in every
 * state an order can be in, with their payments, fulfillments, returns,
 * refunds and the stock ledger they moved. Both seeds write these rows, so the
 * SQLite file and the PostgreSQL database hold the same shop.
 *
 * Deterministic for a given day: every date counts back from it, and the
 * random choices come from one fixed generator. Orders are priced by the
 * App's own rules (apps/atelier/pricing.ts), so a seeded order and one the
 * New order form makes add up the same way.
 */
import { priceOrder, returnCents, toAmount, toCents } from '../../apps/atelier/pricing.ts';
import { COLLECTIONS, COLORS, DISCOUNTS, FIRST_NAMES, LAST_NAMES, LOCATIONS, PLACES, STREETS, TAGS, TYPES } from './catalog.mjs';
import { renderGarment } from './images.mjs';

export const HISTORY_DAYS = 182;
export const ORDER_COUNT = 1500;
export const CUSTOMER_COUNT = 400;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const pad = (n, width = 2) => String(n).padStart(width, '0');
/* The shop's own clock. A timestamp column keeps no zone, and a moment without one is read as the wall clock it was
   written in, in the App's zone (app.ts `timezone`): so a moment is written as New York's clock, not UTC's, or an
   evening order would read as placed tomorrow. */
const ZONE = 'America/New_York';
const wall = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const stamp = (ms) => {
  const part = Object.fromEntries(wall.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
};
const dayOf = (ms) => stamp(ms).slice(0, 10);
/** Today in New York, the shop's day, as `YYYY-MM-DD`: the seeds' default. */
export const shopToday = () => dayOf(Date.now());
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** mulberry32: small, fast and the same on every machine. */
function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (p) => next() < p;
  /** One of `items` by weight. */
  const weighted = (items, weight) => {
    const total = items.reduce((sum, item) => sum + weight(item), 0);
    let at = next() * total;
    for (const item of items) {
      at -= weight(item);
      if (at < 0) return item;
    }
    return items[items.length - 1];
  };
  return { next, int, pick, chance, weighted };
}

const DESCRIBE = {
  apparel: [
    'Cut for an easy, relaxed fit',
    'A close, tailored fit through the body',
    'Garment-washed for a soft hand',
    'Finished with French seams',
  ],
  shoes: ['Leather-lined with a cushioned footbed', 'Stitched by hand in a family workshop', 'A stacked heel and a rubber-tipped sole'],
  accessories: ['Made to wear every day and last for years', 'Finished by hand', 'Packed in a recycled gift box'],
};
const CARE = {
  apparel: 'Cold wash, lay flat to dry.',
  shoes: 'Wipe clean; condition the leather twice a year.',
  accessories: 'Store in its dust bag away from sunlight.',
};
const TYPE_CODES = {
  Tees: 'TEE',
  Shirts: 'SHT',
  Knitwear: 'KNT',
  Dresses: 'DRS',
  Skirts: 'SKT',
  Trousers: 'TRS',
  Denim: 'DNM',
  Outerwear: 'OUT',
  Shoes: 'SHO',
  Bags: 'BAG',
  'Hats & Scarves': 'HAT',
  Belts: 'BLT',
  Jewelry: 'JWL',
  Sunglasses: 'SUN',
};
const STAFF = ['ines@atelier.example', 'marco@atelier.example', 'priya@atelier.example', 'dana@atelier.example'];
const WAREHOUSE_STAFF = ['luis@atelier.example', 'kim@atelier.example'];

/**
 * The rows of every table, keyed by table, in foreign-key order.
 * `today` is a `YYYY-MM-DD`; the shop's day ends at midnight in New York, and
 * nothing is dated after it. `photos: false` leaves the product images out.
 */
export function generate({ today, photos = true }) {
  const r = random(20_260_909);
  // Midnight in New York, the moment the data stops: the last open orders came in last evening.
  const anchor = Date.parse(`${today}T04:00:00Z`);
  const start = anchor - HISTORY_DAYS * DAY;
  const t = {
    location: [],
    tag: [],
    product: [],
    product_tag: [],
    product_image: [],
    collection: [],
    collection_product: [],
    variant: [],
    inventory_level: [],
    customer: [],
    discount: [],
    sales_order: [],
    order_line: [],
    payment: [],
    fulfillment: [],
    order_return: [],
    return_line: [],
    refund: [],
    inventory_movement: [],
  };

  /* ---------- places and labels ---------- */
  LOCATIONS.forEach((location, i) => t.location.push({ id: i + 1, ...location, active: true }));
  const [SOHO, SILVER_LAKE, WAREHOUSE] = [1, 2, 3];
  TAGS.forEach(([name, tone], i) => t.tag.push({ id: i + 1, name, tone }));
  const tagId = (name) => TAGS.findIndex(([n]) => n === name) + 1;

  /* ---------- the catalog ---------- */
  const products = [];
  const variants = [];
  const photoCache = new Map();
  let productId = 0;
  for (const type of TYPES) {
    type.styles.forEach((style, s) => {
      const id = ++productId;
      const n = id - 1;
      // A few new this month, a few still being written up, a few retired after the spring.
      const fresh = s === type.styles.length - 1 && n % 2 === 0;
      const draft = s === type.styles.length - 2 && n % 5 === 0;
      const archived = s === 0 && n % 4 === 0;
      const status = draft ? 'draft' : archived ? 'archived' : 'active';
      const created = fresh || draft ? anchor - r.int(3, 20) * DAY : start - r.int(20, 260) * DAY;
      const band = Math.floor((type.price[1] - type.price[0]) / 10);
      const price = type.price[0] + 10 * ((s * 3 + n) % (band + 1));
      const onSale = !fresh && !draft && n % 9 === 4;
      const k = type.category === 'accessories' ? 1 + (n % 3) : type.category === 'shoes' ? 2 : 2 + (n % 2);
      const colors = [
        ...new Set(Array.from({ length: type.colors.length }, (_, i) => type.colors[(s + i * 2 + Math.floor(i / 3)) % type.colors.length])),
      ].slice(0, k);
      const product = {
        id,
        title: style,
        handle: slug(style),
        vendor: type.vendor,
        product_type: type.type,
        category: type.category,
        status,
        description: `${r.pick(DESCRIBE[type.category])}. ${type.material}${colors.length > 1 ? `, in ${colors.length} colors` : ''}.`,
        material: type.material,
        care: CARE[type.category],
        created_on: dayOf(created),
        version: 0,
      };
      t.product.push(product);
      const meta = { product, type, colors, fresh, draft, archived, onSale, created, price, popularity: 0 };
      products.push(meta);
      colors.forEach((color, c) => {
        for (const size of type.sizes) {
          const vid = variants.length + 1;
          const sale = onSale ? Math.max(18, Math.round((price * 0.7) / 10) * 10 - 2) : price;
          const row = {
            id: vid,
            product_id: id,
            sku: `${TYPE_CODES[type.type]}-${pad(id, 3)}-${COLORS[color].code}-${size === 'One size' ? 'OS' : size}`,
            color,
            size,
            position: c * type.sizes.length + type.sizes.indexOf(size) + 1,
            price_amount: toAmount(sale * 100),
            compare_at_amount: onSale ? toAmount(price * 100) : null,
            cost_amount: toAmount(Math.round(price * 38)),
            barcode: `0${String(840_000_000_000 + vid * 7919).slice(0, 11)}`,
            reorder_point: type.category === 'apparel' ? 4 : type.category === 'shoes' ? 2 : 3,
            active: status !== 'archived',
            version: 0,
          };
          t.variant.push(row);
          variants.push({ row, meta, size, sizeIndex: type.sizes.indexOf(size), priceCents: sale * 100 });
        }
      });
      if (photos) {
        colors.slice(0, n % 5 === 0 ? 1 : 2).forEach((color, position) => {
          const key = `${type.shape}:${color}:${n % 3}`;
          if (!photoCache.has(key)) photoCache.set(key, renderGarment(type.shape, COLORS[color].rgb, n % 3));
          const shot = photoCache.get(key);
          t.product_image.push({
            id: t.product_image.length + 1,
            product_id: id,
            position: position + 1,
            alt: `${style} in ${color.toLowerCase()}, laid flat`,
            file_name: `${product.handle}-${slug(color)}.png`,
            content_type: 'image/png',
            byte_size: shot.photo.length,
            data: shot.photo,
            thumbnail: shot.thumb,
          });
        });
      }
    });
  }
  // What sells: a long tail, the bestsellers well ahead. A shuffled rank, so no type wins by its place in the list.
  const ranked = products.filter((p) => !p.draft).sort((a, b) => ((a.product.id * 37) % 101) - ((b.product.id * 37) % 101));
  ranked.forEach((p, i) => {
    p.popularity = 1 / (1 + i * 0.12);
  });
  const bestsellers = new Set(ranked.slice(0, 12).map((p) => p.product.id));

  /* ---------- tags and collections ---------- */
  const tag = (product, name) => t.product_tag.push({ id: t.product_tag.length + 1, product_id: product, tag_id: tagId(name) });
  for (const p of products) {
    const id = p.product.id,
      title = p.product.title;
    if (p.fresh || p.draft) tag(id, 'New arrival');
    if (bestsellers.has(id)) tag(id, 'Bestseller');
    if (p.onSale) tag(id, 'Sale');
    if (p.onSale && id % 2 === 0) tag(id, 'Final sale');
    if (/Linen/.test(title)) tag(id, 'Linen');
    if (/Cashmere/.test(title)) tag(id, 'Cashmere');
    if (p.type.type === 'Tees' || /Poplin|Canvas/.test(title)) tag(id, 'Organic cotton');
    if (p.type.vendor === 'Calder & Co.' && p.type.type === 'Denim') tag(id, 'Made in USA');
    if (p.type.category === 'accessories' && p.price < 100) tag(id, 'Gift idea');
    if (id % 11 === 3) tag(id, 'Low waste');
  }
  const RULES = {
    new: (p) => p.fresh || p.draft,
    linen: (p) => /Linen|Gauze|Camp|Sundress/.test(p.product.title),
    knit: (p) => p.type.type === 'Knitwear' || /Knit|Cashmere|Mohair/.test(p.product.title),
    work: (p) => ['Shirts', 'Trousers'].includes(p.type.type) || /Blazer|Belt/.test(p.product.title),
    denim: (p) => p.type.type === 'Denim' || /Denim|Chambray/.test(p.product.title),
    evening: (p) => /Silk|Satin|Slip|Clutch|Pearl|Tuxedo|Slingback|Halter/.test(p.product.title),
    accessories: (p) => p.type.category === 'accessories',
    gift: (p) => p.type.category === 'accessories' && p.price < 100,
    sale: (p) => p.onSale,
  };
  COLLECTIONS.forEach(({ title, handle, description, rule }, i) => {
    t.collection.push({
      id: i + 1,
      title,
      handle,
      description,
      published: true,
      created_on: dayOf(start - (30 - i * 3) * DAY),
      version: 0,
    });
    products
      .filter((p) => !p.archived && RULES[rule](p))
      .forEach((p, position) =>
        t.collection_product.push({
          id: t.collection_product.length + 1,
          collection_id: i + 1,
          product_id: p.product.id,
          position: position + 1,
        }),
      );
  });

  /* ---------- discount codes ---------- */
  DISCOUNTS.forEach((d, i) =>
    t.discount.push({
      id: i + 1,
      code: d.code,
      description: d.description,
      kind: d.kind,
      percent_off: d.kind === 'percent' ? d.percent_off : null,
      amount_off_amount: d.kind === 'fixed' ? toAmount(d.amount_off * 100) : null,
      min_subtotal_amount: toAmount(d.min * 100),
      starts_on: dayOf(anchor + d.from * DAY),
      ends_on: d.to === null ? null : dayOf(anchor + d.to * DAY),
      usage_limit: d.limit,
      active: d.active,
      version: 0,
    }),
  );
  const discountUses = new Map();

  /* ---------- customers ---------- */
  const customers = [];
  const seen = new Set();
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    let first, last;
    do {
      first = r.pick(FIRST_NAMES);
      last = r.pick(LAST_NAMES);
    } while (seen.has(`${first} ${last}`));
    seen.add(`${first} ${last}`);
    const [city, state, zip] = r.weighted(PLACES, (p) => p[3]);
    const regular = i % 7 === 0;
    const created = regular ? start - r.int(30, 500) * DAY : start + r.int(-60, HISTORY_DAYS - 2) * DAY;
    const row = {
      id: i + 1,
      name: `${first} ${last}`,
      email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + `${i % 3 === 0 ? '' : i}@example.com`,
      phone: `(${state === 'CA' ? 323 : state === 'NY' ? 212 : 646}) 555-${pad(100 + (i % 900), 4)}`,
      address: `${r.int(12, 980)} ${r.pick(STREETS)}`,
      city,
      state,
      zip,
      accepts_marketing: r.chance(0.45),
      created_on: dayOf(created),
      note: regular && i % 3 === 0 ? 'Prefers a call when a size comes back in.' : null,
      version: 0,
    };
    t.customer.push(row);
    customers.push({ row, created, weight: regular ? 7 : i % 3 === 0 ? 2 : 1 });
  }

  /* ---------- orders, day by day ---------- */
  const inWindow = (code, ms) => {
    const d = t.discount.find((x) => x.code === code);
    const day = dayOf(ms);
    return d.starts_on <= day && (d.ends_on === null || d.ends_on >= day);
  };
  const dayWeights = Array.from({ length: HISTORY_DAYS }, (_, d) => {
    const ms = start + d * DAY;
    const weekday = new Date(ms).getUTCDay();
    const promo = ['SPRING20', 'SUMMER15', 'FALL20'].some((code) => inWindow(code, ms)) ? 1.6 : 1;
    return (0.7 + (d / HISTORY_DAYS) * 0.6) * (weekday === 0 || weekday === 6 ? 1.35 : 1) * promo * (0.85 + r.next() * 0.3);
  });
  const weightSum = dayWeights.reduce((a, b) => a + b, 0);
  const perDay = dayWeights.map((w) => Math.floor((w / weightSum) * ORDER_COUNT));
  for (
    let left = ORDER_COUNT - perDay.reduce((a, b) => a + b, 0), d = HISTORY_DAYS - 1;
    left > 0;
    left--, d = (d + HISTORY_DAYS - 7) % HISTORY_DAYS
  )
    perDay[d]++;

  const sellable = (p, ms) => !p.draft && (!p.archived || ms < start + 70 * DAY) && p.created <= ms;
  const tracking = (carrier) =>
    carrier === 'UPS'
      ? `1Z${Array.from({ length: 16 }, () => '0123456789ABCDEFGHJKLMNPRSTUVWXYZ'[r.int(0, 32)]).join('')}`
      : carrier === 'USPS'
        ? `9400${Array.from({ length: 18 }, () => r.int(0, 9)).join('')}`
        : Array.from({ length: 12 }, () => r.int(0, 9)).join('');
  const lineRows = new Map(); // order id → its order_line rows
  const orderMeta = [];
  let orderId = 1000;
  for (let d = 0; d < HISTORY_DAYS; d++) {
    const times = Array.from({ length: perDay[d] }, () => r.next()).sort();
    for (const slot of times) {
      const id = ++orderId;
      const channel = r.weighted(['online', 'store', 'phone'], (c) => ({ online: 72, store: 24, phone: 4 })[c]);
      // A store sells between ten and eight, New York time; the web shop all day, busiest in the evening.
      const placed =
        channel === 'store'
          ? start + d * DAY + 10 * HOUR + Math.floor(slot * 10 * HOUR)
          : start + d * DAY + (Math.floor((slot < 0.7 ? 8 + slot * 22 : slot * 24) * HOUR) % DAY);
      if (placed >= anchor) {
        orderId--;
        continue;
      }
      const eligible = customers.filter((c) => c.created <= placed);
      const customer = r.weighted(eligible.length ? eligible : customers, (c) => c.weight).row;
      const store =
        channel === 'store'
          ? customer.state === 'CA'
            ? SILVER_LAKE
            : customer.state === 'NY' || customer.state === 'NJ'
              ? SOHO
              : r.chance(0.6)
                ? SOHO
                : SILVER_LAKE
          : WAREHOUSE;
      const shipping = channel === 'store' ? 'pickup' : r.chance(0.15) ? 'express' : 'standard';
      const storeRow = t.location[store - 1];
      const shipTo = channel === 'store' ? { address: storeRow.address, city: storeRow.city, state: storeRow.state, zip: null } : customer;

      /* What is in the basket: one to four different pieces, by popularity, mostly one of each. */
      const count = r.weighted([1, 2, 3, 4], (n) => ({ 1: 55, 2: 28, 3: 12, 4: 5 })[n]);
      const pool = products.filter((p) => sellable(p, placed));
      const chosen = [];
      for (let i = 0; i < count; i++) {
        const p = r.weighted(pool, (x) => x.popularity);
        const options = variants.filter((v) => v.meta === p);
        // Middle sizes sell most.
        const v = r.weighted(options, (x) =>
          x.size === 'M' || x.size === '8' ? 3 : x.size === 'S' || x.size === 'L' || x.size === '7' || x.size === '9' ? 2.2 : 1,
        );
        if (!chosen.some((c) => c.v === v)) chosen.push({ v, quantity: r.weighted([1, 2, 3], (q) => ({ 1: 88, 2: 10, 3: 2 })[q]) });
      }
      const lines = chosen.map(({ v, quantity }) => ({ quantity, unitCents: v.priceCents }));
      const goods = lines.reduce((sum, l) => sum + l.quantity * l.unitCents, 0);

      /* A code, sometimes: one valid that day whose minimum the basket meets and whose limit is not reached. */
      let discount = null;
      if (r.chance(channel === 'store' ? 0.06 : 0.16)) {
        const valid = t.discount.filter(
          (x) =>
            inWindow(x.code, placed) &&
            goods >= toCents(x.min_subtotal_amount) &&
            (x.usage_limit === null || (discountUses.get(x.id) ?? 0) < x.usage_limit) &&
            (x.active || x.code === 'FRIENDS30'),
        );
        if (valid.length) {
          discount = r.pick(valid);
          discountUses.set(discount.id, (discountUses.get(discount.id) ?? 0) + 1);
        }
      }
      const priced = priceOrder(lines, { discount, shipping, state: shipTo.state });

      const order = {
        id,
        customer_id: customer.id,
        location_id: store,
        channel,
        placed_at: stamp(placed),
        status: 'open',
        shipping_method: shipping,
        ship_name: customer.name,
        ship_address: shipTo.address,
        ship_city: shipTo.city,
        ship_state: shipTo.state,
        ship_zip: shipTo.zip,
        discount_id: discount?.id ?? null,
        discount_code: discount?.code ?? null,
        subtotal_amount: toAmount(priced.subtotal),
        discount_amount: toAmount(priced.discount),
        shipping_amount: toAmount(priced.shipping),
        tax_rate: priced.taxRate.toFixed(5),
        tax_amount: toAmount(priced.tax),
        total_amount: toAmount(priced.total),
        note: null,
        confirmed_at: null,
        completed_at: null,
        cancelled_at: null,
        cancel_reason: null,
        version: 0,
      };
      t.sales_order.push(order);
      const rows = chosen.map(({ v, quantity }, i) => ({
        id: t.order_line.length + i + 1,
        sales_order_id: id,
        line_no: i + 1,
        variant_id: v.row.id,
        sku: v.row.sku,
        description: `${v.meta.product.title} · ${v.row.color}${v.size === 'One size' ? '' : ` / ${v.size}`}`,
        quantity,
        unit_price_amount: v.row.price_amount,
        line_amount: toAmount(quantity * v.priceCents),
      }));
      t.order_line.push(...rows);
      lineRows.set(id, rows);

      const payment = {
        id: t.payment.length + 1,
        sales_order_id: id,
        method:
          channel === 'store'
            ? r.weighted(['card', 'apple_pay', 'cash'], (m) => ({ card: 70, apple_pay: 20, cash: 10 })[m])
            : r.weighted(['card', 'paypal', 'apple_pay'], (m) => ({ card: 62, paypal: 18, apple_pay: 20 })[m]),
        status: 'pending',
        charge_amount: order.total_amount,
        paid_amount: '0.00',
        refunded_amount: '0.00',
        reference: null,
        paid_at: null,
        version: 0,
      };
      t.payment.push(payment);
      const fulfillment = {
        id: t.fulfillment.length + 1,
        sales_order_id: id,
        location_id: store,
        status: 'pending',
        carrier: null,
        tracking_number: null,
        packed_at: null,
        packed_by: null,
        shipped_at: null,
        delivered_at: null,
        version: 0,
      };
      t.fulfillment.push(fulfillment);
      const pay = (ms) => {
        payment.status = 'paid';
        payment.paid_amount = order.total_amount;
        payment.paid_at = stamp(ms);
        payment.reference =
          payment.method === 'cash'
            ? 'Cash'
            : payment.method === 'paypal'
              ? `PAYID-${r.int(100000, 999999)}`
              : `${r.pick(['Visa', 'Mastercard', 'Amex'])} ending ${r.int(1000, 9999)}`;
      };
      const pack = (ms) => {
        fulfillment.status = 'packed';
        fulfillment.packed_at = stamp(ms);
        fulfillment.packed_by = channel === 'store' ? r.pick(STAFF) : r.pick(WAREHOUSE_STAFF);
      };

      const age = (anchor - placed) / HOUR;
      if (channel === 'store') {
        // Paid at the till and carried out of the door.
        pay(placed);
        pack(placed);
        Object.assign(fulfillment, { status: 'delivered', carrier: 'Pickup', shipped_at: stamp(placed), delivered_at: stamp(placed) });
        Object.assign(order, {
          status: 'completed',
          confirmed_at: stamp(placed),
          completed_at: stamp(placed),
        });
      } else if (age > 16 && r.chance(0.03)) {
        // Called off before it was packed: a pending payment is voided, a taken one refunded in full.
        const cancelled = placed + r.int(2, 8) * HOUR;
        if (r.chance(0.5)) {
          pay(placed + HOUR);
          payment.status = 'refunded';
          payment.refunded_amount = payment.paid_amount;
          t.refund.push({
            id: t.refund.length + 1,
            payment_id: payment.id,
            sales_order_id: id,
            order_return_id: null,
            refund_amount: payment.paid_amount,
            reason: 'Order cancelled',
            refunded_at: stamp(cancelled),
            refunded_by: r.pick(STAFF),
          });
        } else {
          payment.status = 'voided';
        }
        fulfillment.status = 'cancelled';
        Object.assign(order, {
          status: 'cancelled',
          cancelled_at: stamp(cancelled),
          cancel_reason: r.pick(['Customer changed their mind', 'Ordered the wrong size', 'Payment did not go through', 'Duplicate order']),
        });
      } else if (age < 16) {
        // Still open: in last evening, not yet looked at.
      } else {
        const confirmed = placed + r.int(1, 3) * HOUR;
        order.status = 'confirmed';
        order.confirmed_at = stamp(confirmed);
        if (age >= 40 || id % 4 !== 0) pay(confirmed + 10 * 60_000);
        if (payment.status === 'paid' && (age >= 64 || (age >= 28 && r.chance(0.55)))) {
          const packed = placed + r.int(16, 26) * HOUR;
          pack(packed);
          if (age >= 64) {
            const carrier =
              shipping === 'express' ? 'FedEx' : r.weighted(['UPS', 'USPS', 'FedEx'], (c) => ({ UPS: 50, USPS: 35, FedEx: 15 })[c]);
            const shipped = packed + r.int(2, 8) * HOUR;
            Object.assign(fulfillment, { status: 'shipped', carrier, tracking_number: tracking(carrier), shipped_at: stamp(shipped) });
            const delivered = shipped + (shipping === 'express' ? r.int(20, 40) : r.int(48, 120)) * HOUR;
            if (delivered < anchor - 6 * HOUR) {
              fulfillment.status = 'delivered';
              fulfillment.delivered_at = stamp(delivered);
              Object.assign(order, { status: 'completed', completed_at: stamp(delivered) });
            }
          }
        }
      }
      orderMeta.push({ order, payment, fulfillment, placed, priced });
    }
  }

  /* ---------- returns and refunds ---------- */
  const refund = (meta, cents, reason, at, returnId = null) => {
    const { payment, order } = meta;
    const refunded = toCents(payment.refunded_amount) + cents;
    if (refunded > toCents(payment.paid_amount)) throw new Error(`Seed would refund more than #${order.id} was paid.`);
    payment.refunded_amount = toAmount(refunded);
    payment.status = refunded === toCents(payment.paid_amount) ? 'refunded' : 'partially_refunded';
    t.refund.push({
      id: t.refund.length + 1,
      payment_id: payment.id,
      sales_order_id: order.id,
      order_return_id: returnId,
      refund_amount: toAmount(cents),
      reason,
      refunded_at: stamp(at),
      refunded_by: r.pick(STAFF),
    });
  };
  const restocked = []; // { variant, location, quantity, at, returnId }
  for (const meta of orderMeta) {
    const { order, fulfillment } = meta;
    if (order.channel === 'store' || fulfillment.status !== 'delivered') continue;
    const delivered = Date.parse(`${fulfillment.delivered_at.replace(' ', 'T')}Z`);
    if (delivered > anchor - 3 * DAY) continue;
    if (r.chance(0.012)) {
      // A courier ran late: a goodwill credit off the order, not a return.
      refund(
        meta,
        Math.min(r.pick([1000, 1500, 2500]), toCents(order.total_amount)),
        'Goodwill credit for a late delivery',
        delivered + DAY,
      );
      continue;
    }
    if (!r.chance(0.075)) continue;
    const requested = Math.min(delivered + r.int(2, 14) * DAY, anchor - 2 * HOUR);
    const sinceRequest = (anchor - requested) / DAY;
    const reason = r.weighted(
      ['too_small', 'too_large', 'not_as_pictured', 'changed_mind', 'damaged', 'arrived_late'],
      (x) => ({ too_small: 30, too_large: 26, not_as_pictured: 14, changed_mind: 20, damaged: 6, arrived_late: 4 })[x],
    );
    const rows = lineRows.get(order.id);
    const returned = rows.length > 1 && r.chance(0.3) ? rows : [r.pick(rows)];
    const id = t.order_return.length + 1;
    const status =
      sinceRequest < 1.5
        ? 'requested'
        : sinceRequest < 8
          ? id % 4 !== 0
            ? 'approved'
            : 'requested'
          : sinceRequest < 12
            ? 'received'
            : r.chance(0.86)
              ? 'refunded'
              : 'rejected';
    const received = requested + r.int(4, 7) * DAY;
    const row = {
      id,
      sales_order_id: order.id,
      status,
      reason,
      requested_on: dayOf(requested),
      location_id: status === 'received' || status === 'refunded' ? WAREHOUSE : null,
      received_at: status === 'received' || status === 'refunded' ? stamp(Math.min(received, anchor - HOUR)) : null,
      refund_amount: null,
      note: status === 'rejected' ? 'Worn and without its tags; returned to the customer.' : null,
      version: 0,
    };
    t.order_return.push(row);
    for (const line of returned) {
      const restock = reason !== 'damaged';
      t.return_line.push({
        id: t.return_line.length + 1,
        order_return_id: id,
        order_line_id: line.id,
        quantity: line.quantity,
        restock,
      });
      if (row.received_at && restock)
        restocked.push({
          variant: line.variant_id,
          location: WAREHOUSE,
          quantity: line.quantity,
          at: Date.parse(`${row.received_at.replace(' ', 'T')}Z`),
          returnId: id,
        });
    }
    if (status === 'refunded') {
      const cents = returnCents(meta.priced, returned);
      const left = toCents(meta.payment.paid_amount) - toCents(meta.payment.refunded_amount);
      row.refund_amount = toAmount(Math.min(cents, left));
      refund(meta, Math.min(cents, left), `Return ${id}`, Date.parse(`${row.received_at.replace(' ', 'T')}Z`) + DAY, id);
    }
  }

  /* ---------- stock and its ledger ---------- */
  const levelKey = (variant, location) => `${variant}:${location}`;
  const events = new Map(); // level → [{ at, quantity, kind, reference, … }]
  const add = (variant, location, event) => {
    const key = levelKey(variant, location);
    if (!events.has(key)) events.set(key, []);
    events.get(key).push(event);
  };
  for (const { order, fulfillment } of orderMeta) {
    if (!fulfillment.packed_at) continue;
    const at = Date.parse(`${fulfillment.packed_at.replace(' ', 'T')}Z`);
    for (const line of lineRows.get(order.id))
      add(line.variant_id, fulfillment.location_id, {
        at,
        quantity: -line.quantity,
        kind: 'fulfilled',
        reference: `#${order.id}`,
        moved_by: fulfillment.packed_by,
        fulfillment_id: fulfillment.id,
      });
  }
  for (const back of restocked)
    add(back.variant, back.location, {
      at: back.at,
      quantity: back.quantity,
      kind: 'returned',
      reference: `Return ${back.returnId}`,
      moved_by: r.pick(WAREHOUSE_STAFF),
      order_return_id: back.returnId,
    });

  /* What the open orders still have to pick, by shelf: a pending fulfillment packs from its own location. */
  const waiting = new Map();
  for (const { order, fulfillment } of orderMeta) {
    if (fulfillment.status !== 'pending' || order.status === 'cancelled') continue;
    for (const line of lineRows.get(order.id)) {
      const key = levelKey(line.variant_id, fulfillment.location_id);
      waiting.set(key, (waiting.get(key) ?? 0) + line.quantity);
    }
  }

  let receipt = 4100;
  const middle = start + 91 * DAY;
  for (const v of variants) {
    for (const location of [SOHO, SILVER_LAKE, WAREHOUSE]) {
      const key = levelKey(v.row.id, location);
      const list = events.get(key) ?? [];
      const p = v.meta;
      // What is left on the shelf today: the warehouse holds the depth, the stores a few of each.
      let leftover;
      if (p.archived) leftover = 0;
      else if (location === WAREHOUSE) {
        const roll = r.next();
        leftover = p.draft ? r.int(8, 20) : roll < 0.04 ? 0 : roll < 0.12 ? r.int(1, 2) : roll < 0.3 ? r.int(3, 6) : r.int(7, 26);
      } else leftover = p.draft ? 0 : r.chance(0.3) ? 0 : r.int(1, 5);
      // A few shelves found a damaged piece or came up one short at a count.
      if (leftover >= 3 && r.chance(0.012))
        list.push({
          at: Math.max(anchor - r.int(2, 28) * DAY, p.created + DAY),
          quantity: -1,
          kind: 'adjusted',
          reference: 'Stock count',
          reason: r.pick(['Damaged on the floor', 'Short at the count', 'Used for a photo shoot']),
          moved_by: r.pick(STAFF),
        });
      /* A shelf an open order still has to pick from holds at least that much: rolled empty, the order could never
         be packed, and which one did turned on the day the seed was made for (the warehouse's 0 of SHT-018-BLK-XL
         under 2026-10-22's order #2462). Raised after every roll above, so the rest of the data is the same. */
      leftover = Math.max(leftover, waiting.get(key) ?? 0);
      const out = list.filter((e) => e.quantity < 0).reduce((sum, e) => sum - e.quantity, 0);
      // Returns come back on top: what was bought in covers every sale and today's shelf.
      const need = out + leftover;
      const first = Math.max(p.created, start - 14 * DAY);
      if (need > 0) {
        const early = list.filter((e) => e.at < middle && e.quantity < 0).reduce((sum, e) => sum - e.quantity, 0);
        const opening = middle > first ? Math.min(need, Math.max(early, Math.ceil(need * 0.55))) : need;
        list.push({ at: first, quantity: opening, kind: 'received', reference: `PO-${++receipt}`, moved_by: 'luis@atelier.example' });
        if (need > opening)
          list.push({
            at: middle,
            quantity: need - opening,
            kind: 'received',
            reference: `PO-${++receipt}`,
            moved_by: 'luis@atelier.example',
          });
      }
      list.sort((a, b) => a.at - b.at || b.quantity - a.quantity);
      let onHand = 0;
      for (const e of list) {
        onHand += e.quantity;
        if (onHand < 0) throw new Error(`Seed stock for ${v.row.sku} at location ${location} went below zero.`);
        t.inventory_movement.push({
          id: 0,
          moved_at: stamp(e.at),
          kind: e.kind,
          variant_id: v.row.id,
          location_id: location,
          quantity: e.quantity,
          on_hand_after: onHand,
          reference: e.reference,
          reason: e.reason ?? null,
          moved_by: e.moved_by ?? null,
          fulfillment_id: e.fulfillment_id ?? null,
          order_return_id: e.order_return_id ?? null,
        });
      }
      t.inventory_level.push({
        id: t.inventory_level.length + 1,
        variant_id: v.row.id,
        location_id: location,
        on_hand: onHand,
        version: 0,
      });
    }
  }
  t.inventory_movement.sort((a, b) => (a.moved_at < b.moved_at ? -1 : a.moved_at > b.moved_at ? 1 : 0));
  t.inventory_movement.forEach((m, i) => {
    m.id = i + 1;
  });
  return { tables: t, anchor };
}
