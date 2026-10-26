/**
 * A deliberately large schema, for the parts of tablewalk that only break at
 * scale.
 *
 * The demo database is eleven tables, which is enough to show what walking a
 * reference *is* and not enough to test anything about it. The failures worth
 * catching all live past that: a whole-schema diagram that becomes a hairball,
 * a sidebar you have to scroll to find a table in, a dependency layout with
 * more levels than fit across a screen, and reference chains long enough that
 * the path resolver's depth cap actually engages.
 *
 * So this generates an ERP-shaped schema — sixty-odd tables across a handful
 * of subject areas, with the relationship shapes that occur in real ones:
 *
 *   - deep chains (region → country → site → building → room → asset)
 *   - fan-in hubs that half the schema points at (party, currency)
 *   - self-references (org chart, bill of materials, category tree)
 *   - composite keys, so the join builder is exercised on more than `id`
 *   - a join table with two foreign keys and no surrogate key of its own
 *   - a couple of tables with no foreign keys at all, which the diagram
 *     reports separately rather than stranding in the layout
 *
 * It is structure-first: every table gets a handful of rows so pages render,
 * but the point is the shape of the schema, not the volume of data. For
 * volume, seed the demo database instead.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/** Deterministic, so two runs produce the same database. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMA = `
-- ---------- reference data: the fan-in hubs ----------

CREATE TABLE currency (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  minor_units INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE unit_of_measure (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dimension TEXT NOT NULL
);

CREATE TABLE language (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- No foreign keys in either direction, on purpose: the diagram reports these
-- separately rather than laying them out as though they connect to something.
CREATE TABLE audit_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE feature_flag (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

-- ---------- geography: a deep chain ----------

CREATE TABLE region (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_region_id INTEGER REFERENCES region(id)
);

CREATE TABLE country (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region_id INTEGER REFERENCES region(id),
  currency_code TEXT REFERENCES currency(code),
  language_code TEXT REFERENCES language(code)
);

CREATE TABLE address (
  id INTEGER PRIMARY KEY,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT,
  postcode TEXT,
  country_code TEXT REFERENCES country(code)
);

CREATE TABLE site (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address_id INTEGER REFERENCES address(id),
  opened_on TEXT
);

CREATE TABLE building (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES site(id),
  name TEXT NOT NULL,
  floors INTEGER
);

CREATE TABLE room (
  id INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES building(id),
  number TEXT NOT NULL,
  capacity INTEGER
);

-- ---------- people and organisation ----------

CREATE TABLE party (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  address_id INTEGER REFERENCES address(id)
);

CREATE TABLE person (
  party_id INTEGER PRIMARY KEY REFERENCES party(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  born_on TEXT
);

CREATE TABLE organisation (
  party_id INTEGER PRIMARY KEY REFERENCES party(id),
  legal_name TEXT NOT NULL,
  registration_no TEXT,
  country_code TEXT REFERENCES country(code)
);

CREATE TABLE department (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_department_id INTEGER REFERENCES department(id),
  cost_centre TEXT
);

CREATE TABLE job_title (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  grade INTEGER
);

CREATE TABLE employee (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES party(id),
  department_id INTEGER REFERENCES department(id),
  job_title_id INTEGER REFERENCES job_title(id),
  manager_id INTEGER REFERENCES employee(id),
  site_id INTEGER REFERENCES site(id),
  hired_on TEXT,
  left_on TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE team (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  lead_employee_id INTEGER REFERENCES employee(id),
  department_id INTEGER REFERENCES department(id)
);

-- A join table with no surrogate key of its own: two foreign keys and a
-- composite primary key, which is the shape most tools get wrong.
CREATE TABLE team_member (
  team_id INTEGER NOT NULL REFERENCES team(id),
  employee_id INTEGER NOT NULL REFERENCES employee(id),
  joined_on TEXT,
  role TEXT,
  PRIMARY KEY (team_id, employee_id)
);

CREATE TABLE skill (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT
);

CREATE TABLE employee_skill (
  employee_id INTEGER NOT NULL REFERENCES employee(id),
  skill_id INTEGER NOT NULL REFERENCES skill(id),
  level INTEGER,
  assessed_on TEXT,
  PRIMARY KEY (employee_id, skill_id)
);

-- ---------- catalogue ----------

CREATE TABLE category (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_category_id INTEGER REFERENCES category(id)
);

CREATE TABLE brand (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner_party_id INTEGER REFERENCES party(id)
);

CREATE TABLE product (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES category(id),
  brand_id INTEGER REFERENCES brand(id),
  uom_code TEXT REFERENCES unit_of_measure(code),
  list_price REAL,
  currency_code TEXT REFERENCES currency(code),
  discontinued INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_variant (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES product(sku),
  variant_code TEXT NOT NULL,
  colour TEXT,
  size TEXT
);

-- A bill of materials: a product made of other products, self-referencing
-- through two different columns.
CREATE TABLE bom_line (
  id INTEGER PRIMARY KEY,
  parent_sku TEXT NOT NULL REFERENCES product(sku),
  component_sku TEXT NOT NULL REFERENCES product(sku),
  quantity REAL NOT NULL,
  uom_code TEXT REFERENCES unit_of_measure(code)
);

CREATE TABLE price_list (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  currency_code TEXT REFERENCES currency(code),
  valid_from TEXT,
  valid_to TEXT
);

CREATE TABLE price_list_item (
  price_list_id INTEGER NOT NULL REFERENCES price_list(id),
  sku TEXT NOT NULL REFERENCES product(sku),
  price REAL NOT NULL,
  min_quantity INTEGER,
  PRIMARY KEY (price_list_id, sku)
);

-- ---------- inventory ----------

CREATE TABLE warehouse (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  site_id INTEGER REFERENCES site(id),
  manager_employee_id INTEGER REFERENCES employee(id)
);

CREATE TABLE bin (
  id INTEGER PRIMARY KEY,
  warehouse_id INTEGER NOT NULL REFERENCES warehouse(id),
  code TEXT NOT NULL,
  aisle TEXT,
  level INTEGER
);

CREATE TABLE stock_item (
  warehouse_id INTEGER NOT NULL REFERENCES warehouse(id),
  sku TEXT NOT NULL REFERENCES product(sku),
  on_hand REAL NOT NULL DEFAULT 0,
  allocated REAL NOT NULL DEFAULT 0,
  reorder_point REAL,
  PRIMARY KEY (warehouse_id, sku)
);

CREATE TABLE stock_movement (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES product(sku),
  from_bin_id INTEGER REFERENCES bin(id),
  to_bin_id INTEGER REFERENCES bin(id),
  quantity REAL NOT NULL,
  moved_at TEXT,
  moved_by INTEGER REFERENCES employee(id),
  reason TEXT
);

CREATE TABLE lot (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES product(sku),
  lot_code TEXT NOT NULL,
  expires_on TEXT,
  received_at TEXT
);

-- ---------- sales ----------

CREATE TABLE customer (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES party(id),
  account_no TEXT NOT NULL UNIQUE,
  credit_limit REAL,
  currency_code TEXT REFERENCES currency(code),
  price_list_id INTEGER REFERENCES price_list(id),
  owner_employee_id INTEGER REFERENCES employee(id),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE contact (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  person_party_id INTEGER REFERENCES person(party_id),
  role TEXT,
  primary_contact INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE opportunity (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  owner_employee_id INTEGER REFERENCES employee(id),
  stage TEXT,
  amount REAL,
  currency_code TEXT REFERENCES currency(code),
  opened_on TEXT,
  closed_on TEXT
);

CREATE TABLE quote (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER REFERENCES opportunity(id),
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  valid_until TEXT,
  total REAL,
  currency_code TEXT REFERENCES currency(code)
);

CREATE TABLE quote_line (
  quote_id INTEGER NOT NULL REFERENCES quote(id),
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL REFERENCES product(sku),
  quantity REAL NOT NULL,
  unit_price REAL,
  PRIMARY KEY (quote_id, line_no)
);

CREATE TABLE sales_order (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  quote_id INTEGER REFERENCES quote(id),
  ship_address_id INTEGER REFERENCES address(id),
  bill_address_id INTEGER REFERENCES address(id),
  warehouse_id INTEGER REFERENCES warehouse(id),
  owner_employee_id INTEGER REFERENCES employee(id),
  currency_code TEXT REFERENCES currency(code),
  status TEXT,
  ordered_on TEXT,
  promised_on TEXT,
  total REAL
);

CREATE TABLE sales_order_line (
  order_id INTEGER NOT NULL REFERENCES sales_order(id),
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL REFERENCES product(sku),
  variant_id INTEGER REFERENCES product_variant(id),
  quantity REAL NOT NULL,
  unit_price REAL,
  discount REAL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE shipment (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_order(id),
  carrier_party_id INTEGER REFERENCES party(id),
  from_warehouse_id INTEGER REFERENCES warehouse(id),
  to_address_id INTEGER REFERENCES address(id),
  shipped_at TEXT,
  delivered_at TEXT,
  tracking_no TEXT
);

CREATE TABLE shipment_line (
  shipment_id INTEGER NOT NULL REFERENCES shipment(id),
  order_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  quantity REAL NOT NULL,
  lot_id INTEGER REFERENCES lot(id),
  PRIMARY KEY (shipment_id, order_id, line_no),
  FOREIGN KEY (order_id, line_no) REFERENCES sales_order_line(order_id, line_no)
);

CREATE TABLE invoice (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  order_id INTEGER REFERENCES sales_order(id),
  currency_code TEXT REFERENCES currency(code),
  issued_on TEXT,
  due_on TEXT,
  total REAL,
  status TEXT
);

CREATE TABLE invoice_line (
  invoice_id INTEGER NOT NULL REFERENCES invoice(id),
  line_no INTEGER NOT NULL,
  sku TEXT REFERENCES product(sku),
  description TEXT,
  quantity REAL,
  unit_price REAL,
  tax_code_id INTEGER,
  PRIMARY KEY (invoice_id, line_no)
);

CREATE TABLE payment (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  invoice_id INTEGER REFERENCES invoice(id),
  amount REAL NOT NULL,
  currency_code TEXT REFERENCES currency(code),
  paid_at TEXT,
  method TEXT
);

CREATE TABLE credit_note (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoice(id),
  amount REAL NOT NULL,
  reason TEXT,
  issued_on TEXT
);

-- ---------- purchasing ----------

CREATE TABLE supplier (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES party(id),
  account_no TEXT,
  currency_code TEXT REFERENCES currency(code),
  lead_time_days INTEGER
);

CREATE TABLE supplier_product (
  supplier_id INTEGER NOT NULL REFERENCES supplier(id),
  sku TEXT NOT NULL REFERENCES product(sku),
  supplier_sku TEXT,
  cost REAL,
  PRIMARY KEY (supplier_id, sku)
);

CREATE TABLE purchase_order (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES supplier(id),
  warehouse_id INTEGER REFERENCES warehouse(id),
  raised_by INTEGER REFERENCES employee(id),
  approved_by INTEGER REFERENCES employee(id),
  currency_code TEXT REFERENCES currency(code),
  status TEXT,
  raised_on TEXT,
  expected_on TEXT
);

CREATE TABLE purchase_order_line (
  po_id INTEGER NOT NULL REFERENCES purchase_order(id),
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL REFERENCES product(sku),
  quantity REAL NOT NULL,
  cost REAL,
  PRIMARY KEY (po_id, line_no)
);

CREATE TABLE goods_receipt (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_order(id),
  warehouse_id INTEGER REFERENCES warehouse(id),
  received_by INTEGER REFERENCES employee(id),
  received_at TEXT
);

CREATE TABLE goods_receipt_line (
  receipt_id INTEGER NOT NULL REFERENCES goods_receipt(id),
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL REFERENCES product(sku),
  quantity REAL NOT NULL,
  lot_id INTEGER REFERENCES lot(id),
  bin_id INTEGER REFERENCES bin(id),
  PRIMARY KEY (receipt_id, line_no)
);

-- ---------- service ----------

CREATE TABLE asset (
  id INTEGER PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE,
  sku TEXT REFERENCES product(sku),
  room_id INTEGER REFERENCES room(id),
  owner_employee_id INTEGER REFERENCES employee(id),
  customer_id INTEGER REFERENCES customer(id),
  parent_asset_id INTEGER REFERENCES asset(id),
  serial_no TEXT,
  installed_on TEXT,
  retired_on TEXT
);

CREATE TABLE contract (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  starts_on TEXT,
  ends_on TEXT,
  value REAL,
  currency_code TEXT REFERENCES currency(code)
);

CREATE TABLE service_level (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  response_hours INTEGER,
  resolve_hours INTEGER
);

CREATE TABLE contract_line (
  contract_id INTEGER NOT NULL REFERENCES contract(id),
  line_no INTEGER NOT NULL,
  asset_id INTEGER REFERENCES asset(id),
  service_level_id INTEGER REFERENCES service_level(id),
  PRIMARY KEY (contract_id, line_no)
);

CREATE TABLE ticket (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customer(id),
  asset_id INTEGER REFERENCES asset(id),
  contract_id INTEGER REFERENCES contract(id),
  raised_by_party_id INTEGER REFERENCES party(id),
  assigned_to INTEGER REFERENCES employee(id),
  team_id INTEGER REFERENCES team(id),
  service_level_id INTEGER REFERENCES service_level(id),
  parent_ticket_id INTEGER REFERENCES ticket(id),
  duplicate_of_id INTEGER REFERENCES ticket(id),
  status TEXT,
  priority INTEGER,
  opened_at TEXT,
  resolved_at TEXT,
  summary TEXT
);

CREATE TABLE ticket_note (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES ticket(id),
  author_employee_id INTEGER REFERENCES employee(id),
  body TEXT,
  created_at TEXT
);

CREATE TABLE ticket_part (
  ticket_id INTEGER NOT NULL REFERENCES ticket(id),
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL REFERENCES product(sku),
  quantity REAL NOT NULL,
  PRIMARY KEY (ticket_id, line_no)
);

CREATE TABLE work_log (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES ticket(id),
  employee_id INTEGER NOT NULL REFERENCES employee(id),
  hours REAL,
  logged_on TEXT,
  billable INTEGER NOT NULL DEFAULT 1
);

-- ---------- finance ----------

CREATE TABLE ledger_account (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  parent_code TEXT REFERENCES ledger_account(code)
);

CREATE TABLE journal (
  id INTEGER PRIMARY KEY,
  reference TEXT,
  posted_on TEXT,
  posted_by INTEGER REFERENCES employee(id),
  description TEXT
);

CREATE TABLE journal_line (
  journal_id INTEGER NOT NULL REFERENCES journal(id),
  line_no INTEGER NOT NULL,
  account_code TEXT NOT NULL REFERENCES ledger_account(code),
  debit REAL,
  credit REAL,
  currency_code TEXT REFERENCES currency(code),
  PRIMARY KEY (journal_id, line_no)
);

CREATE TABLE budget (
  id INTEGER PRIMARY KEY,
  department_id INTEGER REFERENCES department(id),
  account_code TEXT REFERENCES ledger_account(code),
  year INTEGER,
  amount REAL,
  currency_code TEXT REFERENCES currency(code)
);

CREATE TABLE exchange_rate (
  from_code TEXT NOT NULL REFERENCES currency(code),
  to_code TEXT NOT NULL REFERENCES currency(code),
  rate_date TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (from_code, to_code, rate_date)
);

-- ---------- a view, so the diagram has one to draw differently ----------

CREATE VIEW customer_balance AS
  SELECT c.id AS customer_id,
         c.account_no,
         COUNT(i.id) AS invoice_count,
         COALESCE(SUM(i.total), 0) AS invoiced,
         COALESCE((SELECT SUM(p.amount) FROM payment p WHERE p.customer_id = c.id), 0) AS paid
  FROM customer c
  LEFT JOIN invoice i ON i.customer_id = c.id
  GROUP BY c.id, c.account_no;
`;

const FIRST = ['Ada', 'Miles', 'Rae', 'Tomas', 'Ingrid', 'Kofi', 'Lena', 'Osman', 'Priya', 'Hugo', 'Maeve', 'Jonas'];
const LAST = ['Fraser', 'Okonkwo', 'Lindqvist', 'Moreau', 'Bianchi', 'Haddad', 'Nakamura', 'Silva', 'Novak', 'Whitfield'];
const PLACE = ['Harbour', 'Kereru', 'Pennine', 'Dry Creek', 'Southerly', 'Waikato', 'Mallee', 'Blackwood', 'Vulcan', 'Bendigo'];
const THING = ['Freight', 'Coffee', 'Tools', 'Vineyards', 'Logistics', 'Glassworks', 'Foundry', 'Bakery', 'Marine', 'Joinery'];

export function makeWideDatabase(file: string, { seed = 20260822 }: { seed?: number } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const random = rng(seed);
  const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  const day = (offset: number) => new Date(Date.UTC(2024, 0, 1 + offset)).toISOString().slice(0, 10);

  const run = (sql: string, rows: unknown[][]) => {
    const stmt = db.prepare(sql);
    for (const row of rows) stmt.run(...(row as never[]));
  };

  run('INSERT INTO currency VALUES (?, ?, ?)', [
    ['AUD', 'Australian Dollar', 2],
    ['NZD', 'New Zealand Dollar', 2],
    ['GBP', 'Pound Sterling', 2],
    ['EUR', 'Euro', 2],
    ['JPY', 'Yen', 0],
  ]);
  run('INSERT INTO language VALUES (?, ?)', [
    ['en', 'English'],
    ['fr', 'French'],
    ['ja', 'Japanese'],
  ]);
  run('INSERT INTO unit_of_measure VALUES (?, ?, ?)', [
    ['ea', 'Each', 'count'],
    ['kg', 'Kilogram', 'mass'],
    ['m', 'Metre', 'length'],
    ['hr', 'Hour', 'time'],
  ]);
  run('INSERT INTO audit_config VALUES (?, ?, ?)', [
    ['retention_days', '365', day(1)],
    ['level', 'verbose', day(2)],
  ]);
  run('INSERT INTO feature_flag VALUES (?, ?, ?)', [
    ['new_pricing', 1, 'rolled out'],
    ['beta_portal', 0, 'internal only'],
  ]);

  run('INSERT INTO region (id, name, parent_region_id) VALUES (?, ?, ?)', [
    [1, 'Global', null],
    [2, 'APAC', 1],
    [3, 'EMEA', 1],
    [4, 'Oceania', 2],
    [5, 'Northern Europe', 3],
  ]);
  run('INSERT INTO country (code, name, region_id, currency_code, language_code) VALUES (?, ?, ?, ?, ?)', [
    ['AU', 'Australia', 4, 'AUD', 'en'],
    ['NZ', 'New Zealand', 4, 'NZD', 'en'],
    ['GB', 'United Kingdom', 5, 'GBP', 'en'],
    ['FR', 'France', 5, 'EUR', 'fr'],
    ['JP', 'Japan', 2, 'JPY', 'ja'],
  ]);

  const countries = ['AU', 'NZ', 'GB', 'FR', 'JP'];
  const addresses = Array.from({ length: 40 }, (_, i) => [
    i + 1,
    `${between(1, 200)} ${pick(PLACE)} ${pick(['St', 'Rd', 'Ln', 'Ave'])}`,
    null,
    pick(PLACE),
    String(between(1000, 9999)),
    pick(countries),
  ]);
  run('INSERT INTO address (id, line1, line2, city, postcode, country_code) VALUES (?, ?, ?, ?, ?, ?)', addresses);

  const sites = Array.from({ length: 6 }, (_, i) => [i + 1, `SITE-${i + 1}`, `${pick(PLACE)} Site`, i + 1, day(between(0, 400))]);
  run('INSERT INTO site (id, code, name, address_id, opened_on) VALUES (?, ?, ?, ?, ?)', sites);

  const buildings = Array.from({ length: 12 }, (_, i) => [i + 1, (i % 6) + 1, `Building ${String.fromCharCode(65 + i)}`, between(1, 5)]);
  run('INSERT INTO building (id, site_id, name, floors) VALUES (?, ?, ?, ?)', buildings);

  const rooms = Array.from({ length: 30 }, (_, i) => [i + 1, (i % 12) + 1, `${between(1, 4)}.${between(1, 20)}`, between(2, 40)]);
  run('INSERT INTO room (id, building_id, number, capacity) VALUES (?, ?, ?, ?)', rooms);

  /* Parties come first because half the schema hangs off them: people,
     organisations, customers, suppliers and carriers are all parties. */
  const partyRows: unknown[][] = [];
  const personRows: unknown[][] = [];
  const orgRows: unknown[][] = [];
  for (let i = 1; i <= 60; i += 1) {
    const isPerson = i <= 36;
    const name = isPerson ? `${pick(FIRST)} ${pick(LAST)}` : `${pick(PLACE)} ${pick(THING)}`;
    partyRows.push([i, isPerson ? 'person' : 'organisation', name, between(1, 40)]);
    if (isPerson) {
      const [first, last] = name.split(' ');
      personRows.push([i, first, last, `${first}.${last}@example.com`.toLowerCase(), day(-between(7000, 18000))]);
    } else {
      orgRows.push([i, `${name} Pty Ltd`, `REG-${1000 + i}`, pick(countries)]);
    }
  }
  run('INSERT INTO party (id, kind, display_name, address_id) VALUES (?, ?, ?, ?)', partyRows);
  run('INSERT INTO person (party_id, first_name, last_name, email, born_on) VALUES (?, ?, ?, ?, ?)', personRows);
  run('INSERT INTO organisation (party_id, legal_name, registration_no, country_code) VALUES (?, ?, ?, ?)', orgRows);

  run('INSERT INTO department (id, name, parent_department_id, cost_centre) VALUES (?, ?, ?, ?)', [
    [1, 'Company', null, 'CC-000'],
    [2, 'Operations', 1, 'CC-100'],
    [3, 'Sales', 1, 'CC-200'],
    [4, 'Service', 2, 'CC-110'],
    [5, 'Warehouse', 2, 'CC-120'],
    [6, 'Finance', 1, 'CC-300'],
  ]);
  run('INSERT INTO job_title (id, name, grade) VALUES (?, ?, ?)', [
    [1, 'Managing Director', 9],
    [2, 'Sales Manager', 7],
    [3, 'Engineer', 5],
    [4, 'Storeperson', 3],
    [5, 'Accountant', 6],
  ]);

  const employees: unknown[][] = [];
  for (let i = 1; i <= 30; i += 1) {
    employees.push([
      i,
      i,
      between(1, 6),
      between(1, 5),
      i === 1 ? null : between(1, Math.max(1, i - 1)),
      between(1, 6),
      day(between(0, 900)),
      null,
      random() < 0.9 ? 1 : 0,
    ]);
  }
  run(
    'INSERT INTO employee (id, party_id, department_id, job_title_id, manager_id, site_id, hired_on, left_on, active)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    employees,
  );

  run(
    'INSERT INTO team (id, name, lead_employee_id, department_id) VALUES (?, ?, ?, ?)',
    Array.from({ length: 6 }, (_, i) => [i + 1, `${pick(PLACE)} Team`, between(1, 30), between(1, 6)]),
  );
  const members = new Set<string>();
  const memberRows: unknown[][] = [];
  while (memberRows.length < 40) {
    const team = between(1, 6);
    const employee = between(1, 30);
    if (members.has(`${team}:${employee}`)) continue;
    members.add(`${team}:${employee}`);
    memberRows.push([team, employee, day(between(0, 700)), pick(['member', 'lead', 'reviewer'])]);
  }
  run('INSERT INTO team_member (team_id, employee_id, joined_on, role) VALUES (?, ?, ?, ?)', memberRows);

  run(
    'INSERT INTO skill (id, name, category) VALUES (?, ?, ?)',
    ['Hydraulics', 'Electrical', 'Welding', 'Diagnostics', 'Forklift', 'SQL'].map((name, i) => [i + 1, name, i > 3 ? 'general' : 'trade']),
  );
  const skills = new Set<string>();
  const skillRows: unknown[][] = [];
  while (skillRows.length < 50) {
    const employee = between(1, 30);
    const skill = between(1, 6);
    if (skills.has(`${employee}:${skill}`)) continue;
    skills.add(`${employee}:${skill}`);
    skillRows.push([employee, skill, between(1, 5), day(between(0, 700))]);
  }
  run('INSERT INTO employee_skill (employee_id, skill_id, level, assessed_on) VALUES (?, ?, ?, ?)', skillRows);

  run('INSERT INTO category (id, name, parent_category_id) VALUES (?, ?, ?)', [
    [1, 'All', null],
    [2, 'Tools', 1],
    [3, 'Power Tools', 2],
    [4, 'Hand Tools', 2],
    [5, 'Consumables', 1],
    [6, 'Spare Parts', 1],
  ]);
  run(
    'INSERT INTO brand (id, name, owner_party_id) VALUES (?, ?, ?)',
    Array.from({ length: 8 }, (_, i) => [i + 1, `${pick(PLACE)} ${pick(['Works', 'Industries', 'Supply'])}`, between(37, 60)]),
  );

  const skus: string[] = [];
  const products: unknown[][] = [];
  for (let i = 1; i <= 80; i += 1) {
    const sku = `SKU-${1000 + i}`;
    skus.push(sku);
    products.push([
      sku,
      `${pick(THING)} ${pick(['Mk II', 'Pro', 'Standard', '250mm', 'Heavy'])}`,
      between(2, 6),
      between(1, 8),
      pick(['ea', 'kg', 'm']),
      Number((between(500, 90000) / 100).toFixed(2)),
      pick(['AUD', 'NZD', 'GBP']),
      random() < 0.08 ? 1 : 0,
    ]);
  }
  run(
    'INSERT INTO product (sku, name, category_id, brand_id, uom_code, list_price, currency_code, discontinued)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    products,
  );
  run(
    'INSERT INTO product_variant (id, sku, variant_code, colour, size) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 40 }, (_, i) => [
      i + 1,
      pick(skus),
      `V${i + 1}`,
      pick(['black', 'red', 'blue', null]),
      pick(['S', 'M', 'L', null]),
    ]),
  );
  run(
    'INSERT INTO bom_line (id, parent_sku, component_sku, quantity, uom_code) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 40 }, (_, i) => [i + 1, pick(skus), pick(skus), between(1, 8), 'ea']),
  );

  run('INSERT INTO price_list (id, name, currency_code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)', [
    [1, 'Standard AUD', 'AUD', day(0), null],
    [2, 'Trade AUD', 'AUD', day(0), null],
    [3, 'Standard GBP', 'GBP', day(0), null],
  ]);
  const priced = new Set<string>();
  const priceRows: unknown[][] = [];
  while (priceRows.length < 90) {
    const list = between(1, 3);
    const sku = pick(skus);
    if (priced.has(`${list}:${sku}`)) continue;
    priced.add(`${list}:${sku}`);
    priceRows.push([list, sku, Number((between(400, 80000) / 100).toFixed(2)), between(1, 10)]);
  }
  run('INSERT INTO price_list_item (price_list_id, sku, price, min_quantity) VALUES (?, ?, ?, ?)', priceRows);

  run(
    'INSERT INTO warehouse (id, code, site_id, manager_employee_id) VALUES (?, ?, ?, ?)',
    Array.from({ length: 4 }, (_, i) => [i + 1, `WH-${i + 1}`, between(1, 6), between(1, 30)]),
  );
  run(
    'INSERT INTO bin (id, warehouse_id, code, aisle, level) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 40 }, (_, i) => [i + 1, (i % 4) + 1, `B${i + 1}`, pick(['A', 'B', 'C']), between(1, 4)]),
  );

  const stocked = new Set<string>();
  const stockRows: unknown[][] = [];
  while (stockRows.length < 120) {
    const warehouse = between(1, 4);
    const sku = pick(skus);
    if (stocked.has(`${warehouse}:${sku}`)) continue;
    stocked.add(`${warehouse}:${sku}`);
    stockRows.push([warehouse, sku, between(0, 500), between(0, 40), between(5, 50)]);
  }
  run('INSERT INTO stock_item (warehouse_id, sku, on_hand, allocated, reorder_point) VALUES (?, ?, ?, ?, ?)', stockRows);
  run(
    'INSERT INTO lot (id, sku, lot_code, expires_on, received_at) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 30 }, (_, i) => [i + 1, pick(skus), `LOT-${2000 + i}`, day(between(400, 900)), day(between(0, 300))]),
  );
  run(
    'INSERT INTO stock_movement (id, sku, from_bin_id, to_bin_id, quantity, moved_at, moved_by, reason)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    Array.from({ length: 60 }, (_, i) => [
      i + 1,
      pick(skus),
      between(1, 40),
      between(1, 40),
      between(1, 20),
      day(between(0, 500)),
      between(1, 30),
      pick(['transfer', 'pick', 'count', 'return']),
    ]),
  );

  run(
    'INSERT INTO customer (id, party_id, account_no, credit_limit, currency_code, price_list_id, owner_employee_id, active)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    Array.from({ length: 20 }, (_, i) => [
      i + 1,
      37 + (i % 24),
      `ACC-${5000 + i}`,
      between(0, 20) * 1000,
      pick(['AUD', 'NZD', 'GBP']),
      between(1, 3),
      between(1, 30),
      random() < 0.9 ? 1 : 0,
    ]),
  );
  run(
    'INSERT INTO contact (id, customer_id, person_party_id, role, primary_contact) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 30 }, (_, i) => [i + 1, between(1, 20), between(1, 36), pick(['buyer', 'accounts', 'site']), i % 3 === 0 ? 1 : 0]),
  );

  run(
    'INSERT INTO opportunity (id, customer_id, owner_employee_id, stage, amount, currency_code, opened_on, closed_on)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    Array.from({ length: 25 }, (_, i) => [
      i + 1,
      between(1, 20),
      between(1, 30),
      pick(['qualify', 'propose', 'won', 'lost']),
      between(1000, 90000),
      'AUD',
      day(between(0, 500)),
      random() < 0.5 ? day(between(500, 700)) : null,
    ]),
  );
  run(
    'INSERT INTO quote (id, opportunity_id, customer_id, valid_until, total, currency_code) VALUES (?, ?, ?, ?, ?, ?)',
    Array.from({ length: 20 }, (_, i) => [i + 1, between(1, 25), between(1, 20), day(between(500, 800)), between(500, 50000), 'AUD']),
  );
  const quoteLines: unknown[][] = [];
  for (let q = 1; q <= 20; q += 1) {
    for (let line = 1; line <= between(1, 4); line += 1) {
      quoteLines.push([q, line, pick(skus), between(1, 10), Number((between(500, 40000) / 100).toFixed(2))]);
    }
  }
  run('INSERT INTO quote_line (quote_id, line_no, sku, quantity, unit_price) VALUES (?, ?, ?, ?, ?)', quoteLines);

  run(
    'INSERT INTO sales_order (id, reference, customer_id, quote_id, ship_address_id, bill_address_id, warehouse_id,' +
      ' owner_employee_id, currency_code, status, ordered_on, promised_on, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    Array.from({ length: 40 }, (_, i) => [
      i + 1,
      `SO-${7000 + i}`,
      between(1, 20),
      random() < 0.6 ? between(1, 20) : null,
      between(1, 40),
      between(1, 40),
      between(1, 4),
      between(1, 30),
      'AUD',
      pick(['open', 'picking', 'shipped', 'closed']),
      day(between(0, 500)),
      day(between(500, 600)),
      between(500, 60000),
    ]),
  );
  const orderLines: unknown[][] = [];
  for (let o = 1; o <= 40; o += 1) {
    for (let line = 1; line <= between(1, 5); line += 1) {
      orderLines.push([
        o,
        line,
        pick(skus),
        random() < 0.3 ? between(1, 40) : null,
        between(1, 20),
        Number((between(500, 40000) / 100).toFixed(2)),
        random() < 0.2 ? between(1, 15) : null,
      ]);
    }
  }
  run(
    'INSERT INTO sales_order_line (order_id, line_no, sku, variant_id, quantity, unit_price, discount)' + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    orderLines,
  );

  run(
    'INSERT INTO shipment (id, order_id, carrier_party_id, from_warehouse_id, to_address_id, shipped_at, delivered_at, tracking_no)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    Array.from({ length: 30 }, (_, i) => [
      i + 1,
      between(1, 40),
      between(37, 60),
      between(1, 4),
      between(1, 40),
      day(between(0, 500)),
      random() < 0.7 ? day(between(500, 560)) : null,
      `TRK-${90000 + i}`,
    ]),
  );
  /* Shipment lines reference an order line by its composite key, so the
     schema has a multi-column foreign key that is not the primary key of the
     table it points at. */
  const shipmentLines: unknown[][] = [];
  const usedShipmentLine = new Set<string>();
  for (let s = 1; s <= 30; s += 1) {
    const line = orderLines[Math.floor(random() * orderLines.length)] as [number, number, ...unknown[]];
    const key = `${s}:${line[0]}:${line[1]}`;
    if (usedShipmentLine.has(key)) continue;
    usedShipmentLine.add(key);
    shipmentLines.push([s, line[0], line[1], between(1, 10), random() < 0.5 ? between(1, 30) : null]);
  }
  run('INSERT INTO shipment_line (shipment_id, order_id, line_no, quantity, lot_id) VALUES (?, ?, ?, ?, ?)', shipmentLines);

  run(
    'INSERT INTO invoice (id, number, customer_id, order_id, currency_code, issued_on, due_on, total, status)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    Array.from({ length: 35 }, (_, i) => [
      i + 1,
      `INV-${8000 + i}`,
      between(1, 20),
      random() < 0.8 ? between(1, 40) : null,
      'AUD',
      day(between(0, 500)),
      day(between(520, 560)),
      between(500, 60000),
      pick(['draft', 'sent', 'paid', 'overdue']),
    ]),
  );
  const invoiceLines: unknown[][] = [];
  for (let inv = 1; inv <= 35; inv += 1) {
    for (let line = 1; line <= between(1, 4); line += 1) {
      invoiceLines.push([inv, line, pick(skus), null, between(1, 15), Number((between(500, 30000) / 100).toFixed(2)), null]);
    }
  }
  run(
    'INSERT INTO invoice_line (invoice_id, line_no, sku, description, quantity, unit_price, tax_code_id)' + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    invoiceLines,
  );
  run(
    'INSERT INTO payment (id, customer_id, invoice_id, amount, currency_code, paid_at, method) VALUES (?, ?, ?, ?, ?, ?, ?)',
    Array.from({ length: 30 }, (_, i) => [
      i + 1,
      between(1, 20),
      random() < 0.8 ? between(1, 35) : null,
      between(100, 40000),
      'AUD',
      day(between(0, 560)),
      pick(['card', 'transfer', 'cheque']),
    ]),
  );
  run(
    'INSERT INTO credit_note (id, invoice_id, amount, reason, issued_on) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 8 }, (_, i) => [
      i + 1,
      between(1, 35),
      between(50, 5000),
      pick(['return', 'error', 'goodwill']),
      day(between(0, 500)),
    ]),
  );

  run(
    'INSERT INTO supplier (id, party_id, account_no, currency_code, lead_time_days) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 12 }, (_, i) => [i + 1, 37 + (i % 24), `SUP-${300 + i}`, pick(['AUD', 'GBP', 'EUR']), between(2, 45)]),
  );
  const supplied = new Set<string>();
  const supplierProducts: unknown[][] = [];
  while (supplierProducts.length < 60) {
    const supplier = between(1, 12);
    const sku = pick(skus);
    if (supplied.has(`${supplier}:${sku}`)) continue;
    supplied.add(`${supplier}:${sku}`);
    supplierProducts.push([supplier, sku, `S-${sku}`, Number((between(200, 30000) / 100).toFixed(2))]);
  }
  run('INSERT INTO supplier_product (supplier_id, sku, supplier_sku, cost) VALUES (?, ?, ?, ?)', supplierProducts);

  run(
    'INSERT INTO purchase_order (id, reference, supplier_id, warehouse_id, raised_by, approved_by, currency_code, status,' +
      ' raised_on, expected_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    Array.from({ length: 25 }, (_, i) => [
      i + 1,
      `PO-${4000 + i}`,
      between(1, 12),
      between(1, 4),
      between(1, 30),
      random() < 0.7 ? between(1, 30) : null,
      'AUD',
      pick(['draft', 'sent', 'received']),
      day(between(0, 500)),
      day(between(500, 560)),
    ]),
  );
  const poLines: unknown[][] = [];
  for (let po = 1; po <= 25; po += 1) {
    for (let line = 1; line <= between(1, 4); line += 1) {
      poLines.push([po, line, pick(skus), between(1, 50), Number((between(200, 20000) / 100).toFixed(2))]);
    }
  }
  run('INSERT INTO purchase_order_line (po_id, line_no, sku, quantity, cost) VALUES (?, ?, ?, ?, ?)', poLines);
  run(
    'INSERT INTO goods_receipt (id, po_id, warehouse_id, received_by, received_at) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 20 }, (_, i) => [i + 1, between(1, 25), between(1, 4), between(1, 30), day(between(0, 560))]),
  );
  const receiptLines: unknown[][] = [];
  for (let r = 1; r <= 20; r += 1) {
    for (let line = 1; line <= between(1, 3); line += 1) {
      receiptLines.push([r, line, pick(skus), between(1, 40), random() < 0.5 ? between(1, 30) : null, between(1, 40)]);
    }
  }
  run('INSERT INTO goods_receipt_line (receipt_id, line_no, sku, quantity, lot_id, bin_id) VALUES (?, ?, ?, ?, ?, ?)', receiptLines);

  const assets: unknown[][] = [];
  for (let i = 1; i <= 45; i += 1) {
    assets.push([
      i,
      `AST-${6000 + i}`,
      pick(skus),
      between(1, 30),
      between(1, 30),
      random() < 0.6 ? between(1, 20) : null,
      i > 5 && random() < 0.3 ? between(1, i - 1) : null,
      `SN-${100000 + i}`,
      day(between(0, 700)),
      null,
    ]);
  }
  run(
    'INSERT INTO asset (id, tag, sku, room_id, owner_employee_id, customer_id, parent_asset_id, serial_no, installed_on, retired_on)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    assets,
  );

  run('INSERT INTO service_level (id, name, response_hours, resolve_hours) VALUES (?, ?, ?, ?)', [
    [1, 'Gold', 1, 8],
    [2, 'Silver', 4, 24],
    [3, 'Bronze', 8, 72],
  ]);
  run(
    'INSERT INTO contract (id, customer_id, starts_on, ends_on, value, currency_code) VALUES (?, ?, ?, ?, ?, ?)',
    Array.from({ length: 15 }, (_, i) => [
      i + 1,
      between(1, 20),
      day(between(0, 300)),
      day(between(700, 1100)),
      between(1000, 90000),
      'AUD',
    ]),
  );
  const contractLines: unknown[][] = [];
  for (let c = 1; c <= 15; c += 1) {
    for (let line = 1; line <= between(1, 3); line += 1) {
      contractLines.push([c, line, between(1, 45), between(1, 3)]);
    }
  }
  run('INSERT INTO contract_line (contract_id, line_no, asset_id, service_level_id) VALUES (?, ?, ?, ?)', contractLines);

  const tickets: unknown[][] = [];
  for (let i = 1; i <= 60; i += 1) {
    tickets.push([
      i,
      `TKT-${9000 + i}`,
      between(1, 20),
      between(1, 45),
      random() < 0.5 ? between(1, 15) : null,
      between(1, 60),
      between(1, 30),
      between(1, 6),
      between(1, 3),
      i > 5 && random() < 0.2 ? between(1, i - 1) : null,
      i > 5 && random() < 0.1 ? between(1, i - 1) : null,
      pick(['new', 'in_progress', 'waiting', 'resolved']),
      between(1, 4),
      day(between(0, 560)),
      random() < 0.6 ? day(between(560, 600)) : null,
      `${pick(THING)} ${pick(['not starting', 'leaking', 'overheating', 'needs service'])}`,
    ]);
  }
  run(
    'INSERT INTO ticket (id, reference, customer_id, asset_id, contract_id, raised_by_party_id, assigned_to, team_id,' +
      ' service_level_id, parent_ticket_id, duplicate_of_id, status, priority, opened_at, resolved_at, summary)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    tickets,
  );
  run(
    'INSERT INTO ticket_note (id, ticket_id, author_employee_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 120 }, (_, i) => [
      i + 1,
      between(1, 60),
      between(1, 30),
      pick(['Attended site.', 'Awaiting parts.', 'Customer called.', 'Replaced unit.', 'Closed with customer.']),
      day(between(0, 600)),
    ]),
  );
  const ticketParts: unknown[][] = [];
  for (let t = 1; t <= 60; t += 1) {
    for (let line = 1; line <= between(0, 3); line += 1) {
      ticketParts.push([t, line, pick(skus), between(1, 6)]);
    }
  }
  run('INSERT INTO ticket_part (ticket_id, line_no, sku, quantity) VALUES (?, ?, ?, ?)', ticketParts);
  run(
    'INSERT INTO work_log (id, ticket_id, employee_id, hours, logged_on, billable) VALUES (?, ?, ?, ?, ?, ?)',
    Array.from({ length: 90 }, (_, i) => [
      i + 1,
      between(1, 60),
      between(1, 30),
      between(1, 16) / 2,
      day(between(0, 600)),
      random() < 0.8 ? 1 : 0,
    ]),
  );

  run('INSERT INTO ledger_account (code, name, type, parent_code) VALUES (?, ?, ?, ?)', [
    ['1000', 'Assets', 'asset', null],
    ['1100', 'Cash', 'asset', '1000'],
    ['1200', 'Receivables', 'asset', '1000'],
    ['2000', 'Liabilities', 'liability', null],
    ['2100', 'Payables', 'liability', '2000'],
    ['4000', 'Revenue', 'revenue', null],
    ['5000', 'Cost of Sales', 'expense', null],
    ['6000', 'Overheads', 'expense', null],
  ]);
  const accounts = ['1000', '1100', '1200', '2000', '2100', '4000', '5000', '6000'];
  run(
    'INSERT INTO journal (id, reference, posted_on, posted_by, description) VALUES (?, ?, ?, ?, ?)',
    Array.from({ length: 25 }, (_, i) => [
      i + 1,
      `JNL-${200 + i}`,
      day(between(0, 560)),
      between(1, 30),
      pick(['Month end', 'Accrual', 'Reclass', 'Sales journal']),
    ]),
  );
  const journalLines: unknown[][] = [];
  for (let j = 1; j <= 25; j += 1) {
    for (let line = 1; line <= 2; line += 1) {
      const amount = between(100, 50000);
      journalLines.push([j, line, pick(accounts), line === 1 ? amount : null, line === 2 ? amount : null, 'AUD']);
    }
  }
  run('INSERT INTO journal_line (journal_id, line_no, account_code, debit, credit, currency_code) VALUES (?, ?, ?, ?, ?, ?)', journalLines);
  run(
    'INSERT INTO budget (id, department_id, account_code, year, amount, currency_code) VALUES (?, ?, ?, ?, ?, ?)',
    Array.from({ length: 24 }, (_, i) => [i + 1, (i % 6) + 1, pick(accounts), 2024 + (i % 2), between(10000, 400000), 'AUD']),
  );
  const rates: unknown[][] = [];
  for (const from of ['AUD', 'NZD', 'GBP']) {
    for (const to of ['AUD', 'NZD', 'GBP', 'EUR']) {
      if (from === to) continue;
      for (let d = 0; d < 3; d += 1) rates.push([from, to, day(d * 30), Number((0.5 + random()).toFixed(4))]);
    }
  }
  run('INSERT INTO exchange_rate (from_code, to_code, rate_date, rate) VALUES (?, ?, ?, ?)', rates);

  db.close();
}

if (process.argv[1]?.endsWith('make-wide-db.ts')) {
  const target = process.argv[2] ?? '.demo/wide.db';
  makeWideDatabase(target);
  const db = new DatabaseSync(target, { readOnly: true });
  const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view')").get() as { n: number };
  console.log(`wrote ${target} — ${tables.n} tables and views`);
  db.close();
}
