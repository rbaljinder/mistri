/**
 * Depot's last week of record history, written from the seeded rows: what
 * the floor and the buyers did in the App the seed stands in for, so the
 * Operations dashboard's activity feed and a record's History section open
 * on the week that made the data rather than on nothing.
 *
 * Each row is what the App would have appended in the write's own
 * transaction (the record history store's layout, provisioned by
 * `provisionSqliteRecordHistory`): a pick list released, picked, packed and
 * shipped by its warehouse's floor; a purchase order drafted, sent and
 * received by its buyer; a receipt, a transfer, an adjustment or a count's
 * variance in the ledger; and a rush order's priority raised. The seed has no
 * accounts, so the people are addresses that reach nobody, each kept under the
 * name a reader is shown (what an account's name would have been when it
 * wrote); a pick is said on its pick list rather than as each line it moved.
 */
import { DatabaseSync } from 'node:sqlite';

const STORE = '__mistri_history_change';
/** The App's zone: the seed's wall times are Depot's day there (app.ts, ui.timezone). */
const ZONE = 'America/Los_Angeles';
/* Who works each warehouse's floor, and the buyers and the manager who make the rest. */
const FLOOR = { 1: ['dana.whitfield', 'luis.ortega'], 2: ['marcus.bell', 'ada.nguyen'], 3: ['sofia.reyes', 'tom.becker'] };
const BUYER = { 'Nora Whitaker': 'nora.whitaker', 'Sam Okafor': 'sam.okafor' };
const MANAGER = 'grace.kim';
const address = (person) => `${person}@switchback.example.test`;
/* dana.whitfield → Dana Whitfield: the name a history names its writer by. */
const nameOf = (person) =>
  person
    .split('.')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
const MOVE_ACTION = { receipt: 'Receive', transfer: 'Transfer', adjustment: 'Adjust', count: 'Complete count' };

/* The instant a Depot wall time is, as the store writes `at`. */
function instant(wall) {
  const [day, time = '09:00:00'] = String(wall).split(/[ T]/);
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));
  const part = (type) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  const offset = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - guess;
  return new Date(guess - offset).toISOString();
}

/* A date-only event at a time of day its record's id sets, so a day's work spreads over the day. */
const onDay = (day, id, from = 8) => `${day} ${String(from + (id % 8)).padStart(2, '0')}:${String((id * 17) % 60).padStart(2, '0')}:00`;

export function seedHistory(file, today) {
  const db = new DatabaseSync(file);
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 7);
  const from = since.toISOString().slice(0, 10);
  const rows = [];
  let write = 0;
  const add = (wall, resource, id, kind, changes, actor, action) =>
    rows.push({
      at: instant(wall),
      write: `seed-${String(++write).padStart(6, '0')}`,
      resource,
      key: JSON.stringify({ id: String(id) }),
      kind,
      changes: JSON.stringify(changes),
      actor: address(actor),
      actorName: nameOf(actor),
      action,
    });
  try {
    for (const p of db
      .prepare(`SELECT id, warehouse_id, reference, released_at, picked_at, packed_at, cartons, shipped_at, carrier, tracking
      FROM pick_list WHERE released_at >= ? OR picked_at >= ? OR packed_at >= ? OR shipped_at >= ?`)
      .all(from, from, from, from)) {
      const [first, second] = FLOOR[p.warehouse_id] ?? FLOOR[1];
      if (p.released_at >= from)
        add(
          p.released_at,
          'pick_list',
          p.id,
          'insert',
          [
            { c: 'reference', a: p.reference },
            { c: 'status', a: 'to_pick' },
            { c: 'warehouse_id', a: p.warehouse_id },
          ],
          MANAGER,
          'Release order',
        );
      if (p.picked_at && p.picked_at >= from)
        add(p.picked_at, 'pick_list', p.id, 'update', [{ c: 'status', b: 'to_pick', a: 'picked' }], first, 'Pick');
      if (p.packed_at && p.packed_at >= from)
        add(
          p.packed_at,
          'pick_list',
          p.id,
          'update',
          [
            { c: 'status', b: 'picked', a: 'packed' },
            { c: 'cartons', b: null, a: p.cartons },
          ],
          second,
          'Pack',
        );
      if (p.shipped_at && p.shipped_at >= from)
        add(
          p.shipped_at,
          'pick_list',
          p.id,
          'update',
          [
            { c: 'status', b: 'packed', a: 'shipped' },
            { c: 'carrier', b: null, a: p.carrier },
            { c: 'tracking', b: null, a: p.tracking },
          ],
          second,
          'Ship',
        );
    }
    for (const po of db
      .prepare(`SELECT id, supplier_id, warehouse_id, status, ordered_on, sent_on, received_on, buyer
      FROM purchase_order WHERE ordered_on >= ? OR sent_on >= ? OR received_on >= ?`)
      .all(from, from, from)) {
      const buyer = BUYER[po.buyer] ?? 'nora.whitaker';
      if (po.ordered_on >= from)
        add(
          onDay(po.ordered_on, po.id),
          'purchase_order',
          po.id,
          'insert',
          [
            { c: 'supplier_id', a: po.supplier_id },
            { c: 'warehouse_id', a: po.warehouse_id },
            { c: 'status', a: 'draft' },
          ],
          buyer,
          'Draft purchase order',
        );
      if (po.sent_on && po.sent_on >= from)
        add(
          onDay(po.sent_on, po.id, 10),
          'purchase_order',
          po.id,
          'update',
          [
            { c: 'status', b: 'draft', a: 'sent' },
            { c: 'sent_on', b: null, a: po.sent_on },
          ],
          buyer,
          'Send to supplier',
        );
      if (po.received_on && po.received_on >= from)
        add(
          onDay(po.received_on, po.id, 7),
          'purchase_order',
          po.id,
          'update',
          [
            { c: 'status', b: 'partial', a: 'received' },
            { c: 'received_on', b: null, a: po.received_on },
          ],
          FLOOR[po.warehouse_id]?.[0] ?? MANAGER,
          'Receive',
        );
    }
    for (const m of db
      .prepare(`SELECT id, moved_at, kind, product_id, bin_id, warehouse_id, qty, reference, reason
      FROM stock_movement WHERE moved_at >= ? AND kind <> 'pick' ORDER BY moved_at, id`)
      .all(from)) {
      const person = m.kind === 'adjustment' || m.kind === 'count' ? MANAGER : (FLOOR[m.warehouse_id] ?? FLOOR[1])[m.id % 2];
      add(
        m.moved_at,
        'stock_movement',
        m.id,
        'insert',
        [
          { c: 'kind', a: m.kind },
          { c: 'reference', a: m.reference },
          { c: 'product_id', a: m.product_id },
          { c: 'bin_id', a: m.bin_id },
          { c: 'qty', a: m.qty },
          ...(m.reason ? [{ c: 'reason', a: m.reason }] : []),
        ],
        person,
        MOVE_ACTION[m.kind] ?? 'Move stock',
      );
    }
    for (const o of db.prepare(`SELECT id, ordered_on FROM sales_order WHERE priority = 'rush' AND ordered_on >= ?`).all(from)) {
      add(onDay(o.ordered_on, o.id, 9), 'sales_order', o.id, 'update', [{ c: 'priority', b: 'normal', a: 'rush' }], MANAGER, '');
    }
    /* The seed plans today's work to its end (a truck shipped at 18:30); what has not happened yet has no history. */
    const now = new Date().toISOString();
    rows.splice(0, rows.length, ...rows.filter((row) => row.at <= now));
    rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.write < b.write ? -1 : 1));
    const append = db.prepare(`INSERT INTO "${STORE}" (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'app', ?)`);
    db.exec('BEGIN');
    for (const row of rows)
      append.run(row.write, row.at, row.resource, row.key, row.kind, row.changes, row.actor, row.actorName, row.action);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return rows.length;
}
