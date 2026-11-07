/**
 * The bare App's disposable SQLite fixture (test/fixtures/apps/bare): a small
 * HVAC, plumbing and electrical service company. Customers and their sites,
 * forty technicians, jobs moving through a status, the visits that work them,
 * their billable lines in US dollars, and the notes left on them, dated back
 * from today (or `BARE_TODAY`, `YYYY-MM-DD`), so some work is always due
 * today, some overdue and some next week.
 *
 *   node test/fixtures/databases/bare/seed.mjs <new-file.db>
 *
 * Deterministic for a given day. Refuses an existing file or companion config,
 * and writes `<file>.json` with a writable connection named `bare`.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = `
  CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('residential','commercial')), email TEXT, phone TEXT,
    city TEXT NOT NULL, state TEXT NOT NULL, created_at TIMESTAMP NOT NULL);
  CREATE TABLE site(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), name TEXT NOT NULL,
    street TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL, access_notes TEXT);
  CREATE TABLE technician(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT,
    trade TEXT NOT NULL CHECK(trade IN ('hvac','plumbing','electrical','general')),
    hourly_rate NUMERIC(8,2) NOT NULL CHECK(hourly_rate > 0), active BOOLEAN NOT NULL DEFAULT 1);
  CREATE TABLE job(id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customer(id), site_id INTEGER NOT NULL REFERENCES site(id),
    technician_id INTEGER REFERENCES technician(id),
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','scheduled','in_progress','on_hold','completed','cancelled')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
    opened_at TIMESTAMP NOT NULL, due_on DATE, completed_at TIMESTAMP, description TEXT);
  CREATE TABLE visit(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id),
    technician_id INTEGER NOT NULL REFERENCES technician(id), starts_at TIMESTAMP NOT NULL, ends_at TIMESTAMP NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed','missed','cancelled')), summary TEXT);
  CREATE TABLE line_item(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id),
    kind TEXT NOT NULL CHECK(kind IN ('labor','part','trip')), description TEXT NOT NULL,
    quantity NUMERIC(10,2) NOT NULL CHECK(quantity > 0), unit_price NUMERIC(10,2) NOT NULL CHECK(unit_price >= 0));
  CREATE TABLE note(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id),
    technician_id INTEGER REFERENCES technician(id), body TEXT NOT NULL, created_at TIMESTAMP NOT NULL);
`;

const FIRST = [
  'Maria',
  'James',
  'Aisha',
  'Robert',
  'Linda',
  'Carlos',
  'Priya',
  'David',
  'Grace',
  'Marcus',
  'Elena',
  'Tyrone',
  'Hannah',
  'Kevin',
  'Sofia',
  'Andre',
  'Megan',
  'Luis',
  'Rachel',
  'Owen',
  'Naomi',
  'Victor',
  'Jasmine',
  'Ethan',
  'Chloe',
  'Darnell',
  'Lauren',
  'Mateo',
  'Brianna',
  'Sean',
];
const LAST = [
  'Alvarez',
  'Bennett',
  'Chen',
  'Dawson',
  'Ellis',
  'Foster',
  'Garcia',
  'Hughes',
  'Iverson',
  'Jackson',
  'Kim',
  'Lopez',
  'Morales',
  'Nguyen',
  'Okafor',
  'Patel',
  'Quinn',
  'Reyes',
  'Sullivan',
  'Thompson',
  'Underwood',
  'Vasquez',
  'Washington',
  'Young',
  'Zimmerman',
  'Brooks',
  'Castillo',
  'Murphy',
  'Ramirez',
  'Shah',
];
const BUSINESSES = [
  'Maple Street Dental',
  'Harborview Apartments',
  'Cedar Ridge Elementary',
  'Bluebird Bakery',
  'Summit Fitness',
  'Riverside Medical Group',
  'Oak & Iron Brewing',
  'Lakeshore Property Management',
  'Northgate Self Storage',
  'Pine Valley Veterinary',
  'Copper Kettle Diner',
  'Westfield Auto Body',
  'Greenleaf Grocers',
  'Union Station Lofts',
  'Hillcrest Senior Living',
  'Bright Path Daycare',
  'Granite Peak Offices',
  'Sunset Laundromat',
  'Main Street Hardware',
  'Evergreen Church',
];
const CITIES = [
  ['Sacramento', 'CA', '958'],
  ['Elk Grove', 'CA', '957'],
  ['Roseville', 'CA', '956'],
  ['Folsom', 'CA', '956'],
  ['Davis', 'CA', '956'],
  ['Rancho Cordova', 'CA', '957'],
  ['Citrus Heights', 'CA', '956'],
];
const STREETS = [
  'Oak Ave',
  'J St',
  'Fair Oaks Blvd',
  'Sunrise Blvd',
  'Elm Way',
  'Folsom Blvd',
  'Riverside Dr',
  'Laguna Blvd',
  'Douglas Blvd',
  'Watt Ave',
  'Madison Ave',
  'Cypress Ln',
  'Greenback Ln',
  'Bidwell St',
  'Arden Way',
];
const SITE_NAMES = ['Main building', 'Warehouse', 'Annex', 'Rental unit', 'North office', 'Clinic', 'Storefront', 'Garage'];
const TRADES = ['hvac', 'plumbing', 'electrical', 'general'];
const WORK = {
  hvac: [
    'No cooling upstairs',
    'Furnace short-cycling',
    'Annual AC tune-up',
    'Replace condenser fan motor',
    'Thermostat not responding',
    'Rooftop unit leaking',
    'Install mini-split',
    'Heat pump making noise',
  ],
  plumbing: [
    'Water heater leaking',
    'Clogged kitchen drain',
    'Replace shut-off valve',
    'Low water pressure',
    'Toilet running constantly',
    'Sewer line camera inspection',
    'Install garbage disposal',
    'Burst pipe under sink',
  ],
  electrical: [
    'Breaker keeps tripping',
    'Install EV charger',
    'Outlets dead in garage',
    'Replace panel',
    'Flickering lights',
    'Add GFCI outlets',
    'Exterior lighting repair',
    'Generator transfer switch',
  ],
  general: [
    'Door closer replacement',
    'Drywall patch after leak',
    'Gutter cleaning',
    'Ceiling tile replacement',
    'Fix sticking door',
    'Install grab bars',
  ],
};
const PARTS = [
  ['Capacitor 45/5 MFD', 38.5],
  ['Condenser fan motor', 214],
  ['Programmable thermostat', 129],
  ['Ball valve 3/4"', 22.75],
  ['40-gal water heater', 865],
  ['Wax ring and bolts', 12.4],
  ['20A breaker', 18.9],
  ['GFCI outlet', 24.5],
  ['LED fixture', 89],
  ['Air filter 16x25', 14.25],
  ['PEX fittings kit', 31],
  ['Door closer', 76],
];
const NOTE_LINES = [
  'Customer asked for a call 30 minutes before arrival.',
  'Gate code changed, see site notes.',
  'Parts on order, ETA two days.',
  'Tenant not home, left a door tag.',
  'Quoted replacement, customer thinking it over.',
  'Unit is 18 years old; recommended replacement.',
  'Confirmed appointment by phone.',
  'Dog on premises, friendly.',
  'Finished early, tested twice, all good.',
  'Need a second tech for the lift next visit.',
  'Warranty claim filed with manufacturer.',
  'Customer approved the estimate by email.',
];
const VISIT_SUMMARIES = [
  'Diagnosed and repaired.',
  'Replaced part, tested system.',
  'Inspection complete, report sent.',
  'Partial fix; return visit needed.',
  'Could not access unit.',
  'Installed and walked customer through it.',
];

/* A seeded generator: the same rows for the same day, every run. */
function generator(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(next() * list.length)];
  const weighted = (pairs) => {
    let r = next() * pairs.reduce((sum, [, w]) => sum + w, 0);
    for (const [value, w] of pairs) if ((r -= w) < 0) return value;
    return pairs[pairs.length - 1][0];
  };
  return { next, int, pick, weighted };
}

const pad = (n) => String(n).padStart(2, '0');
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const at = (day, hour, minute = 0) => `${day} ${pad(hour)}:${pad(minute)}:00`;
const money = (n) => Math.round(n * 100) / 100;
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

export function seed(file, { today = process.env.BARE_TODAY } = {}) {
  file = resolve(file);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new database path.`);
  const TODAY = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : localToday();
  const { next, int, pick, weighted } = generator(20261106);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=ON; ${SCHEMA} BEGIN;`);
    const prepared = new Map();
    const put = (table, row) => {
      const cols = Object.keys(row);
      const key = `${table}:${cols.join(',')}`;
      if (!prepared.has(key))
        prepared.set(key, db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`));
      return prepared.get(key).run(...cols.map((c) => row[c] ?? null));
    };
    const person = () => `${pick(FIRST)} ${pick(LAST)}`;
    const phone = () => `(916) ${int(200, 989)}-${pad(int(0, 99))}${pad(int(0, 99))}`;
    const slug = (name) =>
      name
        .toLowerCase()
        .replace(/[^a-z]+/g, '.')
        .replace(/^\.|\.$/g, '');

    // Technicians: forty, a trade each, a few inactive.
    const techs = [];
    for (let id = 1; id <= 40; id++) {
      const name = `${FIRST[(id * 7) % FIRST.length]} ${LAST[(id * 11) % LAST.length]}`;
      const trade = TRADES[id % 4 === 0 ? 3 : id % 3];
      techs.push({ id, trade, active: id % 13 !== 0 });
      put('technician', {
        id,
        name,
        email: `${slug(name)}${id}@northvalleyservice.com`,
        phone: phone(),
        trade,
        hourly_rate: money(68 + int(0, 12) * 4.5),
        active: id % 13 !== 0 ? 1 : 0,
      });
    }
    const activeTechs = techs.filter((t) => t.active);

    // Customers: sixty, a third of them businesses.
    const customers = [];
    for (let id = 1; id <= 60; id++) {
      const commercial = id % 3 === 0;
      const name = commercial ? BUSINESSES[(id / 3 - 1) % BUSINESSES.length] : person();
      const [city, state] = pick(CITIES);
      customers.push({ id, commercial });
      put('customer', {
        id,
        name,
        kind: commercial ? 'commercial' : 'residential',
        email: next() < 0.85 ? `${slug(name)}@${commercial ? 'example.com' : 'mail.example'}` : null,
        phone: phone(),
        city,
        state,
        created_at: at(addDays(TODAY, -int(30, 900)), int(8, 17), int(0, 59)),
      });
    }

    // Sites: one per home, two to four per business.
    const sites = [];
    let siteId = 0;
    for (const customer of customers) {
      const count = customer.commercial ? int(2, 4) : 1;
      for (let n = 0; n < count; n++) {
        const [city, state, zip] = pick(CITIES);
        sites.push({ id: ++siteId, customer: customer.id });
        put('site', {
          id: siteId,
          customer_id: customer.id,
          name: customer.commercial ? SITE_NAMES[n % SITE_NAMES.length] : 'Home',
          street: `${int(100, 9899)} ${pick(STREETS)}`,
          city,
          state,
          zip: `${zip}${pad(int(10, 99))}`,
          access_notes:
            next() < 0.3
              ? pick([
                  'Gate code 4417#',
                  'Key in lockbox by side door',
                  'Check in at front desk',
                  'Use alley entrance',
                  'Call tenant on arrival',
                ])
              : null,
        });
      }
    }

    // Jobs: 180 over the last 120 days; older ones mostly finished, recent ones open.
    let visitId = 0,
      lineId = 0,
      noteId = 0;
    for (let id = 1; id <= 180; id++) {
      const age = Math.floor(((180 - id) / 180) * 120) + int(0, 3);
      const opened = addDays(TODAY, -age);
      const site = pick(sites);
      const status =
        age > 60
          ? weighted([
              ['completed', 85],
              ['cancelled', 10],
              ['on_hold', 5],
            ])
          : age > 14
            ? weighted([
                ['completed', 30],
                ['in_progress', 25],
                ['scheduled', 20],
                ['on_hold', 10],
                ['cancelled', 5],
                ['new', 10],
              ])
            : weighted([
                ['new', 40],
                ['scheduled', 35],
                ['in_progress', 20],
                ['completed', 5],
              ]);
      const tech = status === 'new' && next() < 0.7 ? null : pick(activeTechs);
      const trade = tech?.trade ?? pick(TRADES);
      const priority = weighted([
        ['low', 15],
        ['normal', 55],
        ['high', 22],
        ['urgent', 8],
      ]);
      const due = addDays(opened, priority === 'urgent' ? 1 : priority === 'high' ? int(2, 5) : int(5, 21));
      const completedAt = status === 'completed' ? at(addDays(opened, Math.min(age, int(1, 12))), int(10, 17), int(0, 59)) : null;
      put('job', {
        id,
        number: `J-${String(2400 + id)}`,
        title: pick(WORK[trade]),
        customer_id: site.customer,
        site_id: site.id,
        technician_id: tech?.id ?? null,
        status,
        priority,
        opened_at: at(opened, int(7, 18), int(0, 59)),
        due_on: due,
        completed_at: completedAt,
        description: next() < 0.6 ? `${pick(NOTE_LINES)} ${pick(NOTE_LINES)}` : null,
      });

      // Visits: finished work has one or two done; scheduled work has one ahead; some went missed.
      if (tech && status !== 'new') {
        const visits = status === 'completed' ? int(1, 2) : status === 'cancelled' ? 0 : 1;
        for (let v = 0; v < visits; v++) {
          const day =
            status === 'scheduled' || (status === 'in_progress' && v === visits - 1 && next() < 0.5)
              ? addDays(TODAY, int(0, 9))
              : addDays(opened, Math.min(age, v * 3 + int(0, 2)));
          const hour = int(8, 15);
          const future = day >= TODAY;
          put('visit', {
            id: ++visitId,
            job_id: id,
            technician_id: tech.id,
            starts_at: at(day, hour, pick([0, 30])),
            ends_at: at(day, hour + int(1, 3), pick([0, 30])),
            status: future
              ? 'scheduled'
              : weighted([
                  ['completed', 88],
                  ['missed', 8],
                  ['cancelled', 4],
                ]),
            summary: future ? null : pick(VISIT_SUMMARIES),
          });
        }
      }

      // Lines: work that has been done is billed — labor, a part or two, sometimes a trip charge.
      if ((status === 'completed' || status === 'in_progress') && lineId < 200) {
        put('line_item', {
          id: ++lineId,
          job_id: id,
          kind: 'labor',
          description: 'Labor',
          quantity: pick([1, 1.5, 2, 2.5, 3, 4]),
          unit_price: 95,
        });
        if (next() < 0.6) {
          const [part, price] = pick(PARTS);
          put('line_item', { id: ++lineId, job_id: id, kind: 'part', description: part, quantity: int(1, 2), unit_price: price });
        }
        if (next() < 0.25)
          put('line_item', { id: ++lineId, job_id: id, kind: 'trip', description: 'Trip charge', quantity: 1, unit_price: 49 });
      }

      // Notes: most open work has one; a few have a thread.
      if (noteId < 140 && next() < 0.7) {
        for (let n = int(1, 2); n > 0; n--)
          put('note', {
            id: ++noteId,
            job_id: id,
            technician_id: tech && next() < 0.8 ? tech.id : null,
            body: pick(NOTE_LINES),
            created_at: at(addDays(opened, Math.min(age, int(0, 4))), int(8, 18), int(0, 59)),
          });
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'bare', url: file, writable: true }] }, null, 2)}\n`);
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!target) throw new Error('Usage: node test/fixtures/databases/bare/seed.mjs <new-file.db>');
  console.log(seed(target));
}
