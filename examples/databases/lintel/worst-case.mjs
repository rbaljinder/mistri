/**
 * The hard names and the long tables, added to a seeded Lintel for the visual matrix and a hand check:
 *
 *   node examples/databases/lintel/worst-case.mjs <seeded.db>
 *
 * Residents whose names and emails push a card, a grid cell and a heading past their width (a long hyphenated
 * name with diacritics, a 70-character email, a two-letter name, emoji), one with no lease at all, a lease with
 * more than a thousand charges and payments (a pager and a long ledger), and a repair titled at length. It is a
 * separate file so the sample's own counts, which its tests read, do not move.
 */
import { DatabaseSync } from 'node:sqlite';

const NAMES = [
  ['Maria-Guadalupe Hernández-Villalobos de la Cruz-Montenegro', 'maria-guadalupe.hernandez-villalobos.de-la-cruz@longname-example.test'],
  ['Zoë Ångström-Öhman', 'zoe@example.test'],
  ['Li', 'li@example.test'],
  ['Sam 🎉 Okafor 🏠', 'sam.okafor@example.test'],
  ['Wolfeschlegelsteinhausenbergerdorff Jr.', 'a.very.long.local.part.that.keeps.going.on.and.on.1234567890@subdomain.example.test'],
];

/** The people, the long ledger and the long title, into a database `seed.mjs` made. */
export function addWorstCase(file) {
  const db = new DatabaseSync(file);
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Fixed ids, so the matrix can name their pages (resident 9001 is the long name; lease 9001 is the long ledger).
    const addResident = db.prepare('INSERT INTO resident (id, name, email, since) VALUES (?, ?, ?, ?)');
    const ids = NAMES.map(([name, email], at) => {
      addResident.run(9001 + at, name, email, today);
      return 9001 + at;
    });
    // The first has a lease on a vacant unit, with the long ledger; the rest hold none (a resident with no rows).
    const unit = db.prepare("SELECT id FROM unit WHERE status = 'vacant' ORDER BY id LIMIT 1").get();
    if (!unit) return ids;
    db.prepare("UPDATE unit SET status = 'occupied' WHERE id = ?").run(unit.id);
    const lease = 9001;
    db.prepare(
      "INSERT INTO lease (id, unit_id, resident_id, start_on, end_on, rent, deposit, status, signed_on) VALUES (?, ?, ?, '2020-01-01', '2030-12-31', 150000, 150000, 'active', '2019-12-15')",
    ).run(lease, unit.id, ids[0]);
    const charge = db.prepare(
      "INSERT INTO charge (lease_id, kind, period, description, due_on, amount, status, posted_on, paid_on) VALUES (?, 'other', ?, ?, ?, 2500, 'paid', ?, ?)",
    );
    const payment = db.prepare(
      "INSERT INTO payment (lease_id, charge_id, received_on, amount, method, reference) VALUES (?, ?, ?, 2500, 'ach', ?)",
    );
    db.exec('BEGIN');
    for (let i = 0; i < 1100; i++) {
      const day = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const id = Number(charge.run(lease, `worst-${i}`, `Amenity fee ${i + 1}`, day, day, day).lastInsertRowid);
      payment.run(lease, id, day, `WORST-${String(i).padStart(5, '0')}`);
    }
    db.prepare(
      "INSERT INTO maintenance_request (unit_id, resident_id, title, description, category, priority, reported_on) VALUES (?, ?, ?, ?, 'general', 'normal', ?)",
    ).run(
      unit.id,
      ids[0],
      'The bathroom exhaust fan above the second-floor shower rattles whenever the heating comes on overnight and again at dawn',
      'x'.repeat(40) + ' ' + 'A long description with no breaks '.repeat(8),
      today,
    );
    db.exec('COMMIT');
    return ids;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node examples/databases/lintel/worst-case.mjs <seeded.db>');
    process.exit(2);
  }
  addWorstCase(file);
}
