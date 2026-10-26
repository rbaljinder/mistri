#!/usr/bin/env node
/**
 * Build the Compass CRM sample database.
 *
 * A standalone seeder in the style of packages/engine/src/server/demo.ts: node:sqlite, no
 * dependencies, a fresh output file, and a fixed PRNG seed so two runs write
 * byte-for-byte the same rows. The schema is a deliberately ordinary CRM —
 * CHECK-constrained enums, self-referencing keys (rep → manager, account →
 * parent), nullable references (a task with no opportunity), and two
 * composite keys (opportunity_line, campaign_member) — the shapes the app
 * layer has to get right.
 *
 *   node test/fixtures/databases/crm/make-crm-db.mjs [new-output.db]
 */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Next to this file by default; a path on the command line to build it
   elsewhere — the browser suite builds its own copy in its temp directory
   rather than rewriting the example's under a server that has it open. */
const FILE = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), 'compass.db');

/* The demo's "today": the day the seeder runs, at UTC midnight. Anchored to
   the run rather than to a constant, because the tabs query the live clock —
   a fixed anchor guaranteed "Due this week" emptied within days of the file
   being written. Determinism holds per day: two runs on the same date are
   byte-identical. MISTRI_CRM_TODAY (an ISO date) pins the day, for a
   suite whose server clock is pinned to match. */
const TODAY = new Date(`${process.env.MISTRI_CRM_TODAY ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);

/* mulberry32 — small, seedable, good enough for sample data. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20260830);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;

/** ISO date offset from TODAY by whole days. */
function daysFromToday(n) {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE industry (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE sales_rep (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  title       TEXT NOT NULL,
  region      TEXT NOT NULL CHECK (region IN ('amer','emea','apac')),
  manager_id  INTEGER REFERENCES sales_rep(id),
  hired_on    DATE NOT NULL,
  quota       REAL NOT NULL
);

CREATE TABLE account (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  industry_id        INTEGER NOT NULL REFERENCES industry(id),
  owner_id           INTEGER NOT NULL REFERENCES sales_rep(id),
  parent_account_id  INTEGER REFERENCES account(id),
  rating             TEXT NOT NULL DEFAULT 'warm' CHECK (rating IN ('hot','warm','cold')),
  annual_revenue     REAL,
  employees          INTEGER,
  website            TEXT,
  city               TEXT NOT NULL,
  country            TEXT NOT NULL,
  created_on         DATE NOT NULL
);

CREATE TABLE contact (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  owner_id    INTEGER NOT NULL REFERENCES sales_rep(id),
  title       TEXT,
  email       TEXT NOT NULL,
  phone       TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_on  DATE NOT NULL
);

CREATE TABLE lead (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,
  company               TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT,
  status                TEXT NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','working','qualified','converted','lost')),
  source                TEXT NOT NULL
                          CHECK (source IN ('web','referral','event','outbound','partner')),
  owner_id              INTEGER NOT NULL REFERENCES sales_rep(id),
  converted_contact_id  INTEGER REFERENCES contact(id),
  created_on            DATE NOT NULL
);

CREATE TABLE opportunity (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  owner_id    INTEGER NOT NULL REFERENCES sales_rep(id),
  stage       TEXT NOT NULL DEFAULT 'prospecting'
                CHECK (stage IN ('prospecting','qualification','proposal','negotiation','closed_won','closed_lost')),
  amount      REAL NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  close_date  DATE NOT NULL,
  created_on  DATE NOT NULL,
  team        TEXT
);

CREATE TABLE product (
  sku         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  family      TEXT NOT NULL CHECK (family IN ('platform','analytics','integrations','services','support')),
  list_price  REAL NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

CREATE TABLE opportunity_line (
  opportunity_id  INTEGER NOT NULL REFERENCES opportunity(id),
  line_no         INTEGER NOT NULL,
  product_sku     TEXT NOT NULL REFERENCES product(sku),
  qty             INTEGER NOT NULL,
  unit_price      REAL NOT NULL,
  PRIMARY KEY (opportunity_id, line_no)
);

CREATE TABLE activity (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('call','email','meeting','demo')),
  subject         TEXT NOT NULL,
  account_id      INTEGER NOT NULL REFERENCES account(id),
  contact_id      INTEGER REFERENCES contact(id),
  opportunity_id  INTEGER REFERENCES opportunity(id),
  owner_id        INTEGER NOT NULL REFERENCES sales_rep(id),
  happened_on     DATE NOT NULL,
  minutes         INTEGER NOT NULL
);

CREATE TABLE task (
  id              INTEGER PRIMARY KEY,
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  priority        INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  is_urgent       INTEGER NOT NULL DEFAULT 0 CHECK (is_urgent IN (0,1)),
  due_on          DATE NOT NULL,
  owner_id        INTEGER NOT NULL REFERENCES sales_rep(id),
  account_id      INTEGER REFERENCES account(id),
  opportunity_id  INTEGER REFERENCES opportunity(id),
  created_on      DATE NOT NULL
);

CREATE TABLE campaign (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('email','webinar','conference','content','ads')),
  starts_on  DATE NOT NULL,
  ends_on    DATE NOT NULL,
  budget     REAL NOT NULL
);

CREATE TABLE campaign_member (
  campaign_id  INTEGER NOT NULL REFERENCES campaign(id),
  lead_id      INTEGER NOT NULL REFERENCES lead(id),
  responded    INTEGER NOT NULL DEFAULT 0 CHECK (responded IN (0,1)),
  added_on     DATE NOT NULL,
  PRIMARY KEY (campaign_id, lead_id)
);

-- The references a record's lists find their rows by (mistri check names each).
CREATE INDEX account_parent ON account(parent_account_id);
CREATE INDEX contact_account ON contact(account_id);
CREATE INDEX opportunity_account ON opportunity(account_id);
CREATE INDEX task_account ON task(account_id);
CREATE INDEX task_opportunity ON task(opportunity_id);
CREATE INDEX activity_account ON activity(account_id);
CREATE INDEX activity_contact ON activity(contact_id);
CREATE INDEX activity_opportunity ON activity(opportunity_id);
CREATE INDEX campaign_member_lead ON campaign_member(lead_id);
`;

/* ---------- vocabulary ---------- */

const FIRST = [
  'Ava',
  'Noah',
  'Mia',
  'Liam',
  'Zoe',
  'Ethan',
  'Isla',
  'Lucas',
  'Ruby',
  'Mason',
  'Priya',
  'Arjun',
  'Wei',
  'Mei',
  'Hiro',
  'Yuki',
  'Omar',
  'Layla',
  'Diego',
  'Lucia',
  'Ingrid',
  'Lars',
  'Freya',
  'Henrik',
  'Amara',
  'Kofi',
  'Nia',
  'Tariq',
  'Elena',
  'Marco',
  'Claire',
  'Hugo',
  'Margot',
  'Felix',
  'Saoirse',
  'Declan',
  'Bronwyn',
  'Callum',
  'Anika',
  'Stefan',
];
const LAST = [
  'Bennett',
  'Okafor',
  'Lindqvist',
  'Tanaka',
  'Moreau',
  'Castillo',
  'Novak',
  'Reddy',
  'Fitzgerald',
  'Haugen',
  'Kaur',
  'Nakamura',
  'Vargas',
  'Sorensen',
  'Achebe',
  'Duval',
  'Kowalski',
  'Mbeki',
  'Ferreira',
  'Lindgren',
  'Osei',
  'Petrov',
  'Quinn',
  'Rahman',
  'Santos',
  'Takahashi',
  'Ueda',
  'Visser',
  'Whitfield',
  'Yamada',
  'Zhang',
  'Andersen',
  'Bishop',
  'Chowdhury',
  'Delacroix',
  'Eriksen',
  'Fontaine',
  'Gallagher',
  'Hansen',
  'Iyer',
];
const COMPANY_A = [
  'Northwind',
  'Beacon',
  'Cascade',
  'Harbourline',
  'Silverbirch',
  'Redgate',
  'Bluepeak',
  'Ironwood',
  'Longford',
  'Meridian',
  'Kestrel',
  'Stonebridge',
  'Fairview',
  'Larkspur',
  'Copperfield',
  'Windrose',
  'Greywacke',
  'Halcyon',
  'Riverstone',
  'Summit',
  'Vantage',
  'Westerly',
  'Oakhurst',
  'Pinnacle',
  'Clearwater',
  'Foxglove',
  'Granite',
  'Heron',
];
const COMPANY_B = [
  'Logistics',
  'Analytics',
  'Foods',
  'Robotics',
  'Energy',
  'Health',
  'Media',
  'Freight',
  'Systems',
  'Materials',
  'Biotech',
  'Insurance',
  'Retail',
  'Aerospace',
  'Marine',
  'Packaging',
  'Textiles',
  'Dynamics',
  'Labs',
  'Networks',
];
const COMPANY_C = ['Ltd', 'Group', 'Co', 'Holdings', 'Partners', 'Inc', 'plc', 'AG'];
const CITIES = [
  ['Auckland', 'New Zealand'],
  ['Wellington', 'New Zealand'],
  ['Sydney', 'Australia'],
  ['Melbourne', 'Australia'],
  ['Singapore', 'Singapore'],
  ['Tokyo', 'Japan'],
  ['London', 'United Kingdom'],
  ['Manchester', 'United Kingdom'],
  ['Dublin', 'Ireland'],
  ['Amsterdam', 'Netherlands'],
  ['Berlin', 'Germany'],
  ['Munich', 'Germany'],
  ['Stockholm', 'Sweden'],
  ['Copenhagen', 'Denmark'],
  ['Paris', 'France'],
  ['Toronto', 'Canada'],
  ['Vancouver', 'Canada'],
  ['New York', 'United States'],
  ['Chicago', 'United States'],
  ['Austin', 'United States'],
  ['Denver', 'United States'],
  ['Sao Paulo', 'Brazil'],
  ['Mumbai', 'India'],
  ['Cape Town', 'South Africa'],
];
const CONTACT_TITLES = [
  'CEO',
  'CFO',
  'CTO',
  'COO',
  'VP Engineering',
  'VP Sales',
  'VP Marketing',
  'Head of Procurement',
  'Head of IT',
  'Operations Manager',
  'Finance Manager',
  'IT Manager',
  'Product Manager',
  'Data Lead',
  'Solutions Architect',
  'Procurement Specialist',
  'Office Manager',
];
const INDUSTRIES = [
  'Manufacturing',
  'Logistics & Transport',
  'Financial Services',
  'Healthcare',
  'Retail & E-commerce',
  'Energy & Utilities',
  'Software',
  'Construction',
  'Agriculture',
  'Education',
  'Hospitality',
  'Media & Entertainment',
];
const REGIONS = ['amer', 'emea', 'apac'];

/* Enough names for every rep, contact and lead without repeats reading as
   copies: 40 x 40 combinations, drawn without replacement. */
const personNames = (() => {
  const combos = [];
  for (const f of FIRST) for (const l of LAST) combos.push(`${f} ${l}`);
  // Fisher-Yates with the seeded PRNG, so the draw order is deterministic.
  for (let i = combos.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }
  return combos;
})();
let nextPerson = 0;
const personName = () => personNames[nextPerson++ % personNames.length];
const emailFor = (name, domain) => `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${domain}`;
const phone = () => `+64 ${between(20, 29)} ${between(100, 999)} ${between(1000, 9999)}`;

/* ---------- build ---------- */

// Reserve the new path exclusively, including against existing symlinks.
try {
  closeSync(openSync(FILE, 'wx', 0o600));
} catch (error) {
  if (error.code === 'EEXIST') throw new Error(`Refusing to replace ${FILE}. Choose a new file.`);
  throw error;
}
const db = new DatabaseSync(FILE);
db.exec(SCHEMA);

const run = (sql, ...args) => db.prepare(sql).run(...args);

// One transaction around the ~4,300 inserts: without it SQLite journals and
// syncs per statement, and the seeder takes seconds instead of milliseconds.
db.exec('BEGIN');

for (const [i, name] of INDUSTRIES.entries()) {
  run('INSERT INTO industry (id, name) VALUES (?, ?)', i + 1, name);
}

/* Reps: 3 regional directors reporting to the VP, everyone else reporting to
   a director — a two-level self-reference the org-chart walk can follow. */
const REP_COUNT = 20;
const reps = [];
for (let id = 1; id <= REP_COUNT; id += 1) {
  const name = personName();
  const region = id === 1 ? 'amer' : REGIONS[(id - 2) % 3];
  const title =
    id === 1
      ? 'VP Sales'
      : id <= 4
        ? `Sales Director, ${region.toUpperCase()}`
        : chance(0.3)
          ? 'Senior Account Executive'
          : 'Account Executive';
  const managerId = id === 1 ? null : id <= 4 ? 1 : 2 + ((id - 5) % 3);
  run(
    'INSERT INTO sales_rep (id, name, email, title, region, manager_id, hired_on, quota) VALUES (?,?,?,?,?,?,?,?)',
    id,
    name,
    emailFor(name, 'compasscrm.example'),
    title,
    region,
    managerId,
    daysFromToday(-between(200, 2600)),
    id <= 4 ? 0 : between(6, 16) * 100_000,
  );
  reps.push(id);
}
const sellers = reps.filter((id) => id > 4); // directors carry no book

const ACCOUNT_COUNT = 150;
const accounts = [];
const accountCreated = new Map();
for (let id = 1; id <= ACCOUNT_COUNT; id += 1) {
  const name = `${pick(COMPANY_A)} ${pick(COMPANY_B)} ${pick(COMPANY_C)}`;
  const [city, country] = pick(CITIES);
  /* A tenth of accounts are subsidiaries of an earlier one — enough for the
     self-reference to appear without the graph turning into a forest. */
  const parent = id > 15 && chance(0.1) ? between(1, id - 1) : null;
  const accountAge = -between(30, 1400);
  run(
    `INSERT INTO account (id, name, industry_id, owner_id, parent_account_id, rating,
       annual_revenue, employees, website, city, country, created_on)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    name,
    between(1, INDUSTRIES.length),
    pick(sellers),
    parent,
    chance(0.2) ? 'hot' : chance(0.75) ? 'warm' : 'cold',
    between(2, 900) * 100_000,
    between(8, 4000),
    `https://${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
    city,
    country,
    daysFromToday(accountAge),
  );
  accounts.push(id);
  accountCreated.set(id, accountAge);
}

const CONTACT_COUNT = 400;
const contactsByAccount = new Map();
for (let id = 1; id <= CONTACT_COUNT; id += 1) {
  const accountId = id <= ACCOUNT_COUNT ? id : pick(accounts); // every account gets one
  const name = personName();
  const first = !contactsByAccount.has(accountId);
  run(
    `INSERT INTO contact (id, name, account_id, owner_id, title, email, phone, is_primary, created_on)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    name,
    accountId,
    pick(sellers),
    pick(CONTACT_TITLES),
    emailFor(name, 'example.com'),
    chance(0.85) ? phone() : null,
    first ? 1 : 0,
    daysFromToday(-between(10, 1300)),
  );
  if (first) contactsByAccount.set(accountId, id);
}

const LEAD_COUNT = 300;
const LEAD_SOURCES = ['web', 'referral', 'event', 'outbound', 'partner'];
for (let id = 1; id <= LEAD_COUNT; id += 1) {
  const name = personName();
  const r = rand();
  const status = r < 0.28 ? 'new' : r < 0.52 ? 'working' : r < 0.68 ? 'qualified' : r < 0.82 ? 'converted' : 'lost';
  run(
    `INSERT INTO lead (id, name, company, email, phone, status, source, owner_id, converted_contact_id, created_on)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    name,
    `${pick(COMPANY_A)} ${pick(COMPANY_B)} ${pick(COMPANY_C)}`,
    emailFor(name, 'example.org'),
    chance(0.7) ? phone() : null,
    status,
    pick(LEAD_SOURCES),
    pick(sellers),
    status === 'converted' ? between(1, CONTACT_COUNT) : null,
    daysFromToday(-between(1, 400)),
  );
}

const PRODUCTS = [
  ['CMP-CORE', 'Compass Core Platform', 'platform', 24_000],
  ['CMP-CORE-ENT', 'Compass Core Enterprise', 'platform', 68_000],
  ['CMP-EDGE', 'Compass Edge Gateway', 'platform', 15_500],
  ['ANL-DASH', 'Insight Dashboards', 'analytics', 8_400],
  ['ANL-FORE', 'Forecasting Engine', 'analytics', 12_900],
  ['ANL-ML', 'Anomaly Detection Add-on', 'analytics', 18_000],
  ['INT-ERP', 'ERP Connector Pack', 'integrations', 6_200],
  ['INT-API', 'API Gateway Seats (10)', 'integrations', 3_800],
  ['INT-EDI', 'EDI Bridge', 'integrations', 9_600],
  ['SRV-IMPL', 'Implementation Package', 'services', 22_000],
  ['SRV-MIGR', 'Data Migration Sprint', 'services', 14_500],
  ['SRV-TRAIN', 'Admin Training (3 days)', 'services', 4_800],
  ['SUP-STD', 'Standard Support (annual)', 'support', 5_000],
  ['SUP-PREM', 'Premium Support (annual)', 'support', 15_000],
  ['SUP-247', '24/7 Mission-Critical Support', 'support', 32_000],
  ['CMP-LEGACY', 'Compass Classic (retired)', 'platform', 9_000],
];
for (const [sku, name, family, price] of PRODUCTS) {
  run(
    'INSERT INTO product (sku, name, family, list_price, is_active) VALUES (?,?,?,?,?)',
    sku,
    name,
    family,
    price,
    sku === 'CMP-LEGACY' ? 0 : 1,
  );
}
const activeSkus = PRODUCTS.filter(([sku]) => sku !== 'CMP-LEGACY');

const OPP_COUNT = 350;
const OPP_KINDS = ['New business', 'Renewal', 'Expansion', 'Upsell', 'Pilot'];
const oppIds = [];
const oppAccount = new Map();
for (let id = 1; id <= OPP_COUNT; id += 1) {
  const accountId = pick(accounts);
  const r = rand();
  /* Realistic funnel: about half closed, the open half thickest at the top. */
  const stage =
    r < 0.3
      ? 'closed_won'
      : r < 0.48
        ? 'closed_lost'
        : r < 0.63
          ? 'prospecting'
          : r < 0.76
            ? 'qualification'
            : r < 0.89
              ? 'proposal'
              : 'negotiation';
  const closed = stage.startsWith('closed');
  const probability = { prospecting: 10, qualification: 25, proposal: 55, negotiation: 80, closed_won: 100, closed_lost: 0 }[stage];
  /* Closed deals closed in the past; open deals close in the future — with a
     sliver of open ones past due, because every real pipeline has those. */
  const closeOffset = closed ? -between(5, 420) : chance(0.12) ? -between(1, 25) : between(3, 240);
  const closeDate = daysFromToday(closeOffset);
  /* Created strictly before it closes — drawn independently, a third of the
     closed deals were "won" before they existed. */
  const createdOn = daysFromToday(Math.min(closeOffset, 0) - between(30, 150));

  /* Lines drawn first so the header's amount is their sum — the way a CRM
     that validates itself would have it — but written after it, for the
     foreign key's sake. */
  const lineCount = between(1, 4);
  const lines = [];
  let amount = 0;
  for (let n = 1; n <= lineCount; n += 1) {
    const [sku, , , listPrice] = pick(activeSkus);
    const qty = between(1, 6);
    const unit = Math.round(listPrice * (0.85 + rand() * 0.15));
    lines.push([id, n, sku, qty, unit]);
    amount += qty * unit;
  }
  const account = db.prepare('SELECT name, owner_id FROM account WHERE id = ?').get(accountId);
  run(
    `INSERT INTO opportunity (id, name, account_id, owner_id, stage, amount, probability, close_date, created_on)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    `${account.name} — ${pick(OPP_KINDS)}`,
    accountId,
    account.owner_id,
    stage,
    amount,
    probability,
    closeDate,
    createdOn,
  );
  for (const line of lines) {
    run('INSERT INTO opportunity_line (opportunity_id, line_no, product_sku, qty, unit_price) VALUES (?,?,?,?,?)', ...line);
  }
  oppIds.push(id);
  oppAccount.set(id, accountId);
}

/* Each deal's team, by name, the owner first: one to four sellers, chosen by
   the deal's id rather than drawn, so the rest of the data stays as it was. */
{
  const names = new Map(
    db
      .prepare('SELECT id, name FROM sales_rep')
      .all()
      .map((rep) => [rep.id, rep.name]),
  );
  const setTeam = db.prepare('UPDATE opportunity SET team = ? WHERE id = ?');
  for (const { id, owner_id: owner } of db.prepare('SELECT id, owner_id FROM opportunity').all()) {
    const team = [owner];
    for (const step of [3, 7, 11]) {
      if (team.length > id % 4) break;
      const other = sellers[(id * step) % sellers.length];
      if (!team.includes(other)) team.push(other);
    }
    setTeam.run(team.map((rep) => names.get(rep)).join(', '), id);
  }
}

const ACTIVITY_COUNT = 1500;
const ACTIVITY_KINDS = ['call', 'email', 'meeting', 'demo'];
const SUBJECTS = {
  call: ['Discovery call', 'Pricing follow-up', 'Renewal check-in', 'Intro call', 'Objection handling call', 'Procurement call'],
  email: [
    'Sent proposal',
    'Follow-up on trial',
    'Contract redlines',
    'Shared case study',
    'Security questionnaire answers',
    'Scheduling note',
  ],
  meeting: ['On-site workshop', 'Quarterly business review', 'Stakeholder alignment', 'Kick-off meeting', 'Executive briefing'],
  demo: ['Platform walkthrough', 'Analytics deep dive', 'Integration demo', 'Sandbox session'],
};
for (let id = 1; id <= ACTIVITY_COUNT; id += 1) {
  const kind = pick(ACTIVITY_KINDS);
  /* Two thirds hang off an opportunity (and inherit its account); the rest
     are plain account touches. */
  const oppId = chance(0.66) ? pick(oppIds) : null;
  const accountId = oppId ? oppAccount.get(oppId) : pick(accounts);
  const contactId = chance(0.62) ? (contactsByAccount.get(accountId) ?? null) : null;
  run(
    `INSERT INTO activity (id, kind, subject, account_id, contact_id, opportunity_id, owner_id, happened_on, minutes)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    kind,
    pick(SUBJECTS[kind]),
    accountId,
    contactId,
    oppId,
    pick(sellers),
    // No activity before its account existed.
    daysFromToday(-between(0, Math.min(365, -accountCreated.get(accountId)))),
    kind === 'email' ? between(2, 10) : kind === 'call' ? between(5, 45) : between(30, 120),
  );
}

const TASK_COUNT = 600;
const TASK_SUBJECTS = [
  'Send updated quote',
  'Book discovery call',
  'Chase signature',
  'Prepare QBR deck',
  'Update close date',
  'Confirm legal review',
  'Send onboarding plan',
  'Log meeting notes',
  'Check renewal terms',
  'Escalate support ticket',
  'Draft proposal',
  'Verify billing details',
  'Schedule demo environment',
  'Call procurement',
  'Review security questionnaire',
];
for (let id = 1; id <= TASK_COUNT; id += 1) {
  const oppId = chance(0.5) ? pick(oppIds) : null;
  const accountId = oppId ? oppAccount.get(oppId) : chance(0.8) ? pick(accounts) : null;
  const dueOn = daysFromToday(between(-60, 45));
  /* Past-due tasks are mostly done — but not all, so "Overdue" has teeth. */
  const status = dueOn < daysFromToday(0) ? (chance(0.72) ? 'done' : 'open') : chance(0.15) ? 'done' : 'open';
  run(
    `INSERT INTO task (id, subject, status, priority, is_urgent, due_on, owner_id, account_id, opportunity_id, created_on)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    pick(TASK_SUBJECTS),
    status,
    between(1, 3),
    chance(0.12) ? 1 : 0,
    dueOn,
    pick(sellers),
    accountId,
    oppId,
    daysFromToday(-between(5, 200)),
  );
}

const CAMPAIGNS = [
  ['Q3 Pipeline Accelerator', 'email', -70, -10, 18_000],
  ['Compass Summit 2026', 'conference', -40, -38, 120_000],
  ['Freight & Logistics Webinar Series', 'webinar', -120, -30, 22_000],
  ['Manufacturing Playbook Launch', 'content', -90, 30, 15_000],
  ['APAC Search Ads H2', 'ads', -60, 60, 45_000],
  ['Renewal Nurture Stream', 'email', -200, 165, 9_000],
  ['Data Migration Masterclass', 'webinar', 12, 13, 8_000],
  ['Analyst Report Syndication', 'content', -150, -60, 30_000],
  ['EMEA Field Events Spring', 'conference', -170, -110, 85_000],
  ['Win-back Outreach', 'email', -30, 20, 6_500],
  ['Partner Co-marketing Pilot', 'ads', 20, 110, 27_000],
  ['Year-end Trade Show Circuit', 'conference', 60, 120, 95_000],
];
for (const [i, [name, kind, from, to, budget]] of CAMPAIGNS.entries()) {
  run(
    'INSERT INTO campaign (id, name, kind, starts_on, ends_on, budget) VALUES (?,?,?,?,?,?)',
    i + 1,
    name,
    kind,
    daysFromToday(from),
    daysFromToday(to),
    budget,
  );
}
for (let leadId = 1; leadId <= LEAD_COUNT; leadId += 1) {
  if (!chance(0.75)) continue; // a quarter of leads came in untouched by marketing
  const count = between(1, 3);
  const joined = new Set();
  for (let n = 0; n < count; n += 1) {
    const campaignId = between(1, CAMPAIGNS.length);
    if (joined.has(campaignId)) continue;
    joined.add(campaignId);
    run(
      'INSERT INTO campaign_member (campaign_id, lead_id, responded, added_on) VALUES (?,?,?,?)',
      campaignId,
      leadId,
      chance(0.3) ? 1 : 0,
      daysFromToday(-between(1, 180)),
    );
  }
}

db.exec('COMMIT');

for (const table of [
  'industry',
  'sales_rep',
  'account',
  'contact',
  'lead',
  'opportunity',
  'product',
  'opportunity_line',
  'activity',
  'task',
  'campaign',
  'campaign_member',
]) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  console.log(`${table.padEnd(18)} ${n}`);
}
db.close();
console.log(`\nWrote ${FILE}`);
