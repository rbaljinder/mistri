/**
 * Build the demo database.
 *
 * Lives in `src/` (not `test/`) because it ships: `tablewalk --demo` builds
 * one of these at runtime so a new install has something to walk without
 * hunting for a database first. `test/make-demo-db.ts` re-exports it, so the
 * suite and `npm run demo` keep the path they have always used.
 *
 * A demo that ships as a binary file is a demo nobody can review, so this
 * writes one from source instead. The shape is chosen to exercise the parts
 * of the tool that are easy to get wrong: a self-referencing key, a composite
 * key, a view, a nullable reference, and one table that several others point
 * at so the reverse-reference panel has something to say.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { productEnv } from './product.js';

const SCHEMA = `
CREATE TABLE country (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL
);

CREATE TABLE customer (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  country_code TEXT REFERENCES country(code),
  credit_limit REAL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  signed_up   DATE
);

-- Self-referencing: an employee reports to an employee. The graph view has to
-- handle an edge whose two ends are the same table without looping forever.
CREATE TABLE employee (
  id          INTEGER PRIMARY KEY,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  title       TEXT,
  manager_id  INTEGER REFERENCES employee(id),
  hired_on    DATE
);

CREATE TABLE invoice (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  sold_by     INTEGER REFERENCES employee(id),
  invoice_date DATE NOT NULL,
  total       REAL NOT NULL DEFAULT 0,
  -- A CHECK, not a lookup table: this is how most schemas in the wild spell
  -- an enum, and to anything reading the catalog it is an untyped TEXT column
  -- unless the constraint is read too.
  status      TEXT NOT NULL DEFAULT 'issued'
                CHECK (status IN ('draft','issued','paid','void'))
);

CREATE TABLE product (
  sku         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  unit_price  REAL NOT NULL
);

-- Composite primary key AND a composite-capable child, so PRAGMA collapsing
-- and multi-column reverse lookups both get exercised.
CREATE TABLE invoice_line (
  invoice_id  INTEGER NOT NULL REFERENCES invoice(id),
  line_no     INTEGER NOT NULL,
  sku         TEXT NOT NULL REFERENCES product(sku),
  quantity    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (invoice_id, line_no)
);

CREATE TABLE shipment (
  id          INTEGER PRIMARY KEY,
  invoice_id  INTEGER NOT NULL,
  line_no     INTEGER NOT NULL,
  shipped_on  DATE,
  FOREIGN KEY (invoice_id, line_no) REFERENCES invoice_line(invoice_id, line_no)
);

CREATE VIEW customer_totals AS
  SELECT c.id, c.name, COUNT(i.id) AS invoices, COALESCE(SUM(i.total), 0) AS lifetime
    FROM customer c LEFT JOIN invoice i ON i.customer_id = c.id
   GROUP BY c.id, c.name;
`;

const DATA = `
INSERT INTO country VALUES ('AU','Australia'), ('NZ','New Zealand'), ('GB','United Kingdom');

INSERT INTO customer (id, name, email, country_code, credit_limit, active, signed_up) VALUES
  (1,'Harbour Freight','ops@harbourfreight.example','AU',5000,1,'2023-02-11'),
  (2,'Kereru Coffee','hello@kereru.example','NZ',1200,1,'2024-06-30'),
  (3,'Pennine Tools','accounts@pennine.example','GB',0,0,'2022-11-05'),
  (4,'Dry Creek Vineyards',NULL,'AU',9000,1,'2025-01-19'),
  (5,'Southerly Logistics','ap@southerly.example',NULL,2500,1,'2025-09-02');

INSERT INTO employee (id, first_name, last_name, title, manager_id, hired_on) VALUES
  (1,'Ada','Fraser','Managing Director',NULL,'2019-03-01'),
  (2,'Miles','Okonkwo','Sales Manager',1,'2020-07-15'),
  (3,'Rina','Petrova','Account Executive',2,'2022-01-10'),
  (4,'Tom','Whitfield','Account Executive',2,'2023-08-22'),
  (5,'Joan','Alvarez','Support Lead',1,'2021-05-04');

INSERT INTO product VALUES
  ('SKU-100','Bench Vice 150mm',249.00),
  ('SKU-200','Torque Wrench',389.50),
  ('SKU-300','Impact Driver',179.95),
  ('SKU-400','Socket Set 42pc',129.00);

INSERT INTO invoice (id, customer_id, sold_by, invoice_date, total) VALUES
  (1001,1,3,'2025-03-14',627.95),
  (1002,1,3,'2025-07-02',389.50),
  (1003,2,4,'2025-08-19',258.00),
  (1004,4,3,'2026-01-08',1247.40),
  (1005,4,4,'2026-05-21',179.95),
  (1006,5,NULL,'2026-07-30',908.00),
  -- Deliberately has no lines. An aggregate over no children must count 0
  -- and sum to null, and without a childless parent in the fixture that
  -- distinction cannot be tested at all.
  (1007,3,4,'2026-08-02',0);

INSERT INTO invoice_line VALUES
  (1001,1,'SKU-100',1),(1001,2,'SKU-300',2),
  (1002,1,'SKU-200',1),
  (1003,1,'SKU-400',2),
  (1004,1,'SKU-200',2),(1004,2,'SKU-300',1),(1004,3,'SKU-400',2),
  (1005,1,'SKU-300',1),
  (1006,1,'SKU-100',2),(1006,2,'SKU-200',1);

INSERT INTO shipment (id, invoice_id, line_no, shipped_on) VALUES
  (1,1001,1,'2025-03-16'),(2,1001,2,'2025-03-16'),
  (3,1002,1,'2025-07-04'),(4,1004,1,'2026-01-10'),(5,1004,2,NULL);
`;

/**
 * Where `--demo` builds its database. A fixed `$TMPDIR/tablewalk-demo.db` was
 * a machine-global path that every boot deletes and rebuilds, so two people —
 * or two test runs, or a run beside a demo someone left open — silently
 * corrupted each other. Observed as twelve browser failures that looked
 * exactly like flakes. One directory per process instead, the same move the
 * PostgreSQL fixtures already made.
 *
 * `TABLEWALK_DEMO_DB` (`MISTRI_DEMO_DB` under mistri, product.ts) names the file instead, for a caller that has to read
 * the database it served — the browser suite does — or wants one that
 * survives the process.
 */
let chosen: string | undefined;
export function demoDatabaseFile(): string {
  const named = productEnv('DEMO_DB')?.trim();
  if (named) return named;
  if (chosen) return chosen;
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-demo-'));
  // The demo is disposable by definition: nothing here outlives the process
  // that built it, and leaving a directory per run in $TMPDIR would be litter.
  process.on('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* going away anyway */
    }
  });
  return (chosen = join(directory, 'demo.db'));
}

export function makeDemoDatabase(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.exec(DATA);
  db.close();
}

/* ---------- bulk seeding ----------

   Opt-in, and deterministic. The small fixture above is what the test suite
   asserts against — `customer` has exactly five rows and several tests say so
   — so bulk data is layered on top by request rather than by default.

   Determinism comes from a seeded generator rather than Math.random: the same
   scale always produces the same database, so a screenshot, a row count or a
   reported bug can be reproduced exactly. */

/** mulberry32 — small, fast, and good enough for plausible-looking data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'Ada',
  'Miles',
  'Rina',
  'Tom',
  'Joan',
  'Priya',
  'Hugo',
  'Wren',
  'Kofi',
  'Ines',
  'Bo',
  'Yuki',
  'Omar',
  'Lena',
  'Fitz',
  'Nadia',
  'Ravi',
  'Signe',
  'Cormac',
  'Tess',
];
const LAST = [
  'Fraser',
  'Okonkwo',
  'Petrova',
  'Whitfield',
  'Alvarez',
  'Nair',
  'Lindqvist',
  'Baptiste',
  'Mensah',
  'Duarte',
  'Kirby',
  'Tanaka',
  'Haddad',
  'Vogel',
  'Moss',
  'Rahman',
  'Iyer',
  'Bergen',
  'Doyle',
  'Whelan',
];
const NOUN = [
  'Freight',
  'Coffee',
  'Tools',
  'Vineyards',
  'Logistics',
  'Foundry',
  'Provisions',
  'Marine',
  'Timber',
  'Electrics',
  'Joinery',
  'Bakery',
  'Optics',
  'Fabrication',
  'Roasters',
  'Surveying',
  'Plumbing',
  'Glassworks',
];
const PLACE = [
  'Harbour',
  'Pennine',
  'Dry Creek',
  'Southerly',
  'Kereru',
  'Otway',
  'Blackwood',
  'Fitzroy',
  'Kaimai',
  'Torrens',
  'Mallee',
  'Waikato',
  'Bendigo',
  'Arthurs',
  'Nullarbor',
  'Kimberley',
];
const TITLES = [
  'Account Executive',
  'Sales Manager',
  'Support Lead',
  'Field Technician',
  'Operations Analyst',
  'Warehouse Lead',
  'Credit Controller',
  'Regional Manager',
];
/* The countries a seeded demo spreads its customers over, beyond the three the
   fixture declares. Real places with real names, because a column of `CC-07`
   teaches nothing about what a grouped answer looks like. */
const MORE_COUNTRIES: Array<[string, string]> = [
  ['IE', 'Ireland'],
  ['CA', 'Canada'],
  ['US', 'United States'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['NL', 'Netherlands'],
  ['SE', 'Sweden'],
  ['NO', 'Norway'],
  ['JP', 'Japan'],
  ['SG', 'Singapore'],
  ['ZA', 'South Africa'],
  ['BR', 'Brazil'],
  ['IN', 'India'],
];

const GEAR = [
  'Bench Vice',
  'Torque Wrench',
  'Impact Driver',
  'Socket Set',
  'Angle Grinder',
  'Circular Saw',
  'Air Compressor',
  'Bandsaw',
  'Drill Press',
  'Welder',
  'Lathe Chuck',
  'Caliper Set',
];

/* A deliberately awkward table, created only when seeding.

   Everything here is something that is easy to get wrong and easy to miss:
   twenty-seven columns so the grid has to scroll and the column chooser has
   to be usable; *two* self-references, because code that handles one often
   assumes there is only one; eight outgoing keys and two incoming, so the
   neighbourhood diagram has to lay out both directions at once; and three
   separate references to the same table, which a naive reverse-reference
   count collapses into one.

   It is kept out of the base fixture on purpose — several tests assert the
   exact table list, and that assertion is worth keeping honest. */
const WIDE_SCHEMA = `
CREATE TABLE work_order (
  id              INTEGER PRIMARY KEY,
  reference       TEXT NOT NULL,
  parent_id       INTEGER REFERENCES work_order(id),
  supersedes_id   INTEGER REFERENCES work_order(id),
  customer_id     INTEGER NOT NULL REFERENCES customer(id),
  raised_by       INTEGER REFERENCES employee(id),
  assigned_to     INTEGER REFERENCES employee(id),
  approved_by     INTEGER REFERENCES employee(id),
  country_code    TEXT REFERENCES country(code),
  product_sku     TEXT REFERENCES product(sku),
  invoice_id      INTEGER REFERENCES invoice(id),
  -- A CHECK rather than a bare TEXT column, because that is how most SQLite
  -- and Postgres schemas actually spell an enum -- and it is the vocabulary
  -- the table tool reports and the insert form offers.
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','scheduled','in_progress','awaiting_parts','on_hold','completed','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 3,
  is_urgent       INTEGER NOT NULL DEFAULT 0,
  is_billable     INTEGER NOT NULL DEFAULT 1,
  opened_on       DATE NOT NULL,
  due_on          DATE,
  closed_on       DATE,
  estimated_hours REAL,
  actual_hours    REAL,
  labour_cost     REAL NOT NULL DEFAULT 0,
  parts_cost      REAL NOT NULL DEFAULT 0,
  total_cost      REAL NOT NULL DEFAULT 0,
  site_address    TEXT,
  external_ref    TEXT,
  notes           TEXT,
  sys_updated_at  TIMESTAMP NOT NULL
);

CREATE INDEX work_order_customer_idx ON work_order (customer_id, status);
CREATE INDEX work_order_opened_idx   ON work_order (opened_on);

CREATE TABLE work_order_note (
  id            INTEGER PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_order(id),
  author_id     INTEGER REFERENCES employee(id),
  written_on    DATE NOT NULL,
  body          TEXT NOT NULL
);

CREATE TABLE work_order_part (
  work_order_id INTEGER NOT NULL REFERENCES work_order(id),
  line_no       INTEGER NOT NULL,
  sku           TEXT NOT NULL REFERENCES product(sku),
  quantity      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (work_order_id, line_no)
);
`;

const STATUSES = ['open', 'scheduled', 'in_progress', 'awaiting_parts', 'on_hold', 'completed', 'cancelled'];
const STREETS = ['Wharf Rd', 'Kembla St', 'Beach Pde', 'Rundle Ml', 'Flinders Ln', 'Cuba St', 'Vulcan Ln'];
const NOTE_TEXT = [
  'Attended site, isolated the unit and confirmed the fault reported by the customer.',
  'Parts ordered from the supplier. Lead time quoted as five working days.',
  'Customer requested the visit be rescheduled to the following week.',
  'Work completed and signed off on site. No further action required.',
];

interface SeedOptions {
  /** Roughly the number of customers; everything else scales from it. */
  scale?: number;
  seed?: number;
}

export function seedDemoDatabase(file: string, { scale = 1000, seed = 20260822 }: SeedOptions = {}): void {
  const db = new DatabaseSync(file);
  const random = rng(seed);
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));

  /* More countries, but only when seeding.

     The small fixture has three, which is right for it — several tests count
     that table. It is wrong for a demo: "which countries have the most
     customers" is one of the questions `breakdown` exists to answer and one
     of the examples in the README, and three groups does not show what a
     breakdown is for. Inserted here rather than in the fixture so the tests
     that assert three keep asserting three.

     `INSERT OR IGNORE`, so seeding a database twice is not an error. */
  const insertCountry = db.prepare('INSERT OR IGNORE INTO country (code, name) VALUES (?, ?)');
  for (const [code, name] of MORE_COUNTRIES) insertCountry.run(code, name);

  const countries = (db.prepare('SELECT code FROM country').all() as unknown as Array<{ code: string }>).map((r) => r.code);

  /* One transaction for the whole load. Without it SQLite commits per
     statement and a hundred thousand rows takes minutes instead of seconds. */
  db.exec('BEGIN');
  try {
    const employees = Math.max(8, Math.round(scale / 12));
    const insertEmployee = db.prepare('INSERT INTO employee (first_name, last_name, title, manager_id, hired_on) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < employees; i++) {
      // Managers are drawn from employees already inserted, so the
      // self-reference always points backwards and never dangles.
      const managerId = i < 3 ? null : between(1, 3 + Math.floor(i / 4));
      insertEmployee.run(
        pick(FIRST),
        pick(LAST),
        pick(TITLES),
        managerId,
        `${between(2018, 2026)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
      );
    }
    const employeeCount = Number((db.prepare('SELECT COUNT(*) AS n FROM employee').get() as { n: number }).n);

    const insertProduct = db.prepare('INSERT INTO product (sku, name, unit_price) VALUES (?, ?, ?)');
    const products = Math.max(20, Math.round(scale / 4));
    const skus: string[] = [];
    for (let i = 0; i < products; i++) {
      const sku = `SKU-${String(1000 + i)}`;
      skus.push(sku);
      insertProduct.run(sku, `${pick(GEAR)} ${between(50, 900)}mm`, Math.round(random() * 90000) / 100);
    }

    const insertCustomer = db.prepare(
      'INSERT INTO customer (name, email, country_code, credit_limit, active, signed_up) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < scale; i++) {
      const name = `${pick(PLACE)} ${pick(NOUN)}`;
      // Roughly one in nine has no email and one in eleven no country, so the
      // null rendering and `is empty` filters have something to find.
      const email = random() < 0.11 ? null : `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
      insertCustomer.run(
        name,
        email,
        random() < 0.09 ? null : pick(countries),
        between(0, 40) * 250,
        random() < 0.18 ? 0 : 1,
        `${between(2021, 2026)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
      );
    }
    const customerCount = Number((db.prepare('SELECT COUNT(*) AS n FROM customer').get() as { n: number }).n);

    const insertInvoice = db.prepare('INSERT INTO invoice (customer_id, sold_by, invoice_date, total, status) VALUES (?, ?, ?, ?, ?)');
    /* A spread of statuses, weighted the way a ledger actually looks: mostly
       settled, a working set outstanding, a few never finished.

       Without this every seeded invoice took the column default and the demo
       answered `invoice count by status` — the first example in the README —
       with a single group of eighteen thousand. The CHECK constraint on the
       column lists four values; a demo that only ever shows one of them
       teaches nothing about the column, the constraint, or the breakdown. */
    const STATUSES: Array<[string, number]> = [
      ['paid', 0.62],
      ['issued', 0.24],
      ['draft', 0.11],
      ['void', 0.03],
    ];
    const statusFor = (): string => {
      let r = random();
      for (const [name, share] of STATUSES) {
        if (r < share) return name;
        r -= share;
      }
      return 'issued';
    };
    const insertLine = db.prepare('INSERT INTO invoice_line (invoice_id, line_no, sku, quantity) VALUES (?, ?, ?, ?)');
    const insertShipment = db.prepare('INSERT INTO shipment (invoice_id, line_no, shipped_on) VALUES (?, ?, ?)');

    const invoices = scale * 6;
    let nextInvoiceId = Number((db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM invoice').get() as { n: number }).n);
    for (let i = 0; i < invoices; i++) {
      const id = nextInvoiceId++;
      const date = `${between(2023, 2026)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`;
      let total = 0;
      const lines = between(1, 6);
      insertInvoice.run(between(1, customerCount), random() < 0.08 ? null : between(1, employeeCount), date, 0, statusFor());
      for (let line = 1; line <= lines; line++) {
        const quantity = between(1, 12);
        insertLine.run(id, line, pick(skus), quantity);
        total += quantity * between(50, 900);
        // Most lines ship; some are pending, and a few shipped rows carry a
        // null date so the date column has nulls to render.
        if (random() < 0.72) {
          insertShipment.run(id, line, random() < 0.1 ? null : date);
        }
      }
      db.prepare('UPDATE invoice SET total = ? WHERE id = ?').run(total, id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }

  seedWorkOrders(db, random, pick, between, scale);

  /* ANALYZE so the planner has statistics, and so anything reading row
     estimates sees real numbers rather than zeros. */
  db.exec('ANALYZE');
  db.close();
}

/**
 * The wide table, its notes and its parts.
 *
 * Split out because it is a different shape of data from the invoice chain
 * above, and because the interesting part is the reference pattern rather
 * than the volume.
 */
function seedWorkOrders(
  db: DatabaseSync,
  random: () => number,
  pick: <T>(list: T[]) => T,
  between: (lo: number, hi: number) => number,
  scale: number,
): void {
  db.exec(WIDE_SCHEMA);

  const customers = Number((db.prepare('SELECT COUNT(*) AS n FROM customer').get() as { n: number }).n);
  const employees = Number((db.prepare('SELECT COUNT(*) AS n FROM employee').get() as { n: number }).n);
  const invoices = Number((db.prepare('SELECT MAX(id) AS n FROM invoice').get() as { n: number }).n);
  const skus = (db.prepare('SELECT sku FROM product').all() as unknown as Array<{ sku: string }>).map((r) => r.sku);
  const countries = (db.prepare('SELECT code FROM country').all() as unknown as Array<{ code: string }>).map((r) => r.code);

  const orders = Math.max(50, scale * 3);
  const date = (fromYear: number) =>
    `${between(fromYear, 2026)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`;

  db.exec('BEGIN');
  const insert = db.prepare(`
    INSERT INTO work_order (
      reference, parent_id, supersedes_id, customer_id, raised_by, assigned_to, approved_by,
      country_code, product_sku, invoice_id, status, priority, is_urgent, is_billable,
      opened_on, due_on, closed_on, estimated_hours, actual_hours,
      labour_cost, parts_cost, total_cost, site_address, external_ref, notes, sys_updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (let i = 1; i <= orders; i++) {
    const status = pick(STATUSES);
    const closed = status === 'completed' || status === 'cancelled';
    const estimated = Math.round(random() * 400) / 10;
    const actual = closed ? Math.round(estimated * (0.6 + random()) * 10) / 10 : null;
    const labour = Math.round((actual ?? 0) * between(80, 190) * 100) / 100;
    const parts = Math.round(random() * 250000) / 100;
    /* Parents and predecessors point only at rows already inserted, so both
       self-references stay acyclic — a cycle here would be legal SQL and a
       trap for anything that walks the graph. */
    const parent = i > 10 && random() < 0.22 ? between(1, i - 1) : null;
    const supersedes = i > 20 && random() < 0.1 ? between(1, i - 1) : null;

    insert.run(
      `WO-${String(100000 + i)}`,
      parent,
      supersedes,
      between(1, customers),
      random() < 0.05 ? null : between(1, employees),
      random() < 0.15 ? null : between(1, employees),
      closed && random() < 0.8 ? between(1, employees) : null,
      random() < 0.12 ? null : pick(countries),
      random() < 0.3 ? null : pick(skus),
      random() < 0.55 && invoices ? between(1001, invoices) : null,
      status,
      between(1, 5),
      random() < 0.18 ? 1 : 0,
      random() < 0.85 ? 1 : 0,
      date(2023),
      random() < 0.9 ? date(2024) : null,
      closed ? date(2024) : null,
      estimated,
      actual,
      labour,
      parts,
      Math.round((labour + parts) * 100) / 100,
      `${between(1, 400)} ${pick(STREETS)}`,
      random() < 0.4 ? `EXT-${between(10000, 99999)}` : null,
      random() < 0.5 ? pick(NOTE_TEXT) : null,
      `${date(2025)}T${String(between(0, 23)).padStart(2, '0')}:${String(between(0, 59)).padStart(2, '0')}:00`,
    );
  }

  const insertNote = db.prepare('INSERT INTO work_order_note (work_order_id, author_id, written_on, body) VALUES (?,?,?,?)');
  const insertPart = db.prepare('INSERT INTO work_order_part (work_order_id, line_no, sku, quantity) VALUES (?,?,?,?)');
  for (let id = 1; id <= orders; id++) {
    for (let n = 0; n < between(0, 4); n++) {
      insertNote.run(id, random() < 0.1 ? null : between(1, employees), date(2024), pick(NOTE_TEXT));
    }
    const parts = between(0, 5);
    for (let line = 1; line <= parts; line++) {
      insertPart.run(id, line, pick(skus), between(1, 20));
    }
  }
  db.exec('COMMIT');
}
