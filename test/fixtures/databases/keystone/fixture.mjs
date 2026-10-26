/**
 * Keystone's rows, drawn deterministically: the same day gives the same rows,
 * byte for byte. Pure — no database, no clock read here — so the seed and any
 * test can call it.
 *
 *   buildKeystone('2026-09-26') → { tables: [[table, rows], …] } in insert order
 *
 * Every date is counted back from `today`, the way Compass dates its CRM, so a
 * list's "past due" and a dashboard's "funded this month" mean something
 * whenever the sample is seeded. The story it draws:
 *
 * - A regional lender in Pennsylvania, Keystone Auto Finance: sixteen staff,
 *   eight programs, four of them advertised on the marketplace.
 * - Twelve dealers: ten active, one on hold after a funding audit, one
 *   prospect still onboarding (no site, no applications).
 * - About 600 vehicles over thirty months of trading: sold, pending, listed,
 *   in stock and sent to wholesale.
 * - About 700 leads with their activity, 450 deals on the desk, 400
 *   applications across every underwriting status, 250 of them funded.
 * - Each loan with its schedule and payment history, behaving the way a book
 *   does: most current, some late, a few delinquent, three charged off, some
 *   paid off early; autopay, payoff quotes, statements and letters.
 * - 120 marketplace pre-qualifications, some sent on to a dealer; a handful of
 *   apply forms waiting in the lender's triage.
 *
 * Tenant-owned keys are readable text scoped by the dealer
 * (`liberty-ford-lead-1001`), and business references collide across dealers
 * on purpose: every trading dealer has an LD-1001 and a DL-1001, which is how /leads
 * shows isolation rather than asserting it.
 */
import { onePagePdf } from './pdf.mjs';

/* ---------- deterministic chance ---------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- the cast ---------- */

const FIRST = [
  'James',
  'Maria',
  'Robert',
  'Linda',
  'Michael',
  'Patricia',
  'David',
  'Jennifer',
  'William',
  'Elizabeth',
  'Joseph',
  'Susan',
  'Thomas',
  'Jessica',
  'Christopher',
  'Sarah',
  'Daniel',
  'Karen',
  'Matthew',
  'Nancy',
  'Anthony',
  'Lisa',
  'Mark',
  'Betty',
  'Steven',
  'Ashley',
  'Andrew',
  'Kimberly',
  'Joshua',
  'Emily',
  'Kevin',
  'Donna',
  'Brian',
  'Michelle',
  'Ryan',
  'Carol',
  'Jacob',
  'Amanda',
  'Nicholas',
  'Melissa',
  'Tyler',
  'Deborah',
  'Luis',
  'Stephanie',
  'Andre',
  'Rebecca',
  'Jamal',
  'Laura',
  'Carlos',
  'Sharon',
  'Wei',
  'Cynthia',
  'Priya',
  'Aaliyah',
  'Diego',
  'Mei',
  'Omar',
  'Fatima',
  'Hiroshi',
  'Grace',
  'Malik',
  'Rosa',
  'Dmitri',
  'Keisha',
  'Ethan',
  'Olivia',
  'Noah',
  'Ava',
];
const LAST = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
  'Walker',
  'Young',
  'Allen',
  'King',
  'Wright',
  'Scott',
  'Torres',
  'Nguyen',
  'Hill',
  'Flores',
  'Green',
  'Adams',
  'Nelson',
  'Baker',
  'Hall',
  'Rivera',
  'Campbell',
  'Mitchell',
  'Carter',
  'Roberts',
  'Kowalski',
  'Novak',
  'Schmidt',
  'Yoder',
  'Stoltzfus',
  "O'Brien",
  'Murphy',
  'Sullivan',
  'Patel',
  'Shah',
  'Kim',
  'Park',
  'Chen',
  'Wang',
  'Okafor',
  'Mensah',
  'Russo',
  'Esposito',
  'Petrov',
  'Brennan',
  'Fitzgerald',
  'Gallagher',
];
const EMPLOYERS = [
  'Hershey Company',
  'UPMC',
  'Penn State Health',
  'Giant Food Stores',
  'Wegmans',
  'Amazon Fulfillment',
  'Commonwealth of Pennsylvania',
  'Lancaster General Hospital',
  'U.S. Postal Service',
  'Harrisburg School District',
  'PPL Electric',
  'Rite Aid',
  'Sheetz',
  'Wawa',
  'Geisinger',
  'Lockheed Martin',
  'FedEx Ground',
  'Comcast',
  'Johns Hopkins Hospital',
  'Ohio State University',
  'Nationwide',
  'Home Depot',
  "Lowe's",
  'Target',
  'Walmart',
  'PNC Bank',
  'Highmark',
  "Dick's Sporting Goods",
  'Turkey Hill',
  'Self-employed contractor',
];
const JOBS = [
  'Registered nurse',
  'Warehouse associate',
  'Teacher',
  'Electrician',
  'Store manager',
  'Truck driver',
  'Accountant',
  'Software developer',
  'Medical assistant',
  'Mail carrier',
  'Line cook',
  'Sales associate',
  'Machinist',
  'Pharmacy technician',
  'Office manager',
  'HVAC technician',
  'Paralegal',
  'Dental hygienist',
  'Customer service representative',
  'Welder',
];
const STREETS = ['Oak', 'Maple', 'Market', 'Front', 'Church', 'Walnut', 'Chestnut', 'Ridge', 'Spring', 'Mill', 'Park', 'Hill'];

/* The lender's people. */
const LENDER_STAFF = [
  ['Margaret Hollis', 'admin', 'Chief operating officer'],
  ['Victor Amato', 'credit_manager', 'Chief credit officer'],
  ['Denise Okafor', 'credit_manager', 'Credit manager'],
  ['Paul Brennan', 'underwriter', 'Senior underwriter'],
  ['Alicia Ramos', 'underwriter', 'Underwriter'],
  ['Kenji Mori', 'underwriter', 'Underwriter'],
  ['Shannon Yoder', 'underwriter', 'Underwriter'],
  ['Marcus Bell', 'underwriter', 'Underwriter'],
  ['Teresa Novak', 'funder', 'Funding manager'],
  ['Grant Whitaker', 'funder', 'Funding analyst'],
  ['Hannah Stoltzfus', 'servicing', 'Servicing manager'],
  ['Jerome Price', 'servicing', 'Collections specialist'],
  ['Lena Petrov', 'servicing', 'Customer care specialist'],
  ['Colin Fitzgerald', 'relationship_manager', 'Dealer relationship manager, East'],
  ['Renee Gallagher', 'relationship_manager', 'Dealer relationship manager, West'],
  ['Omar Haddad', 'relationship_manager', 'Dealer relationship manager, South'],
];

/* [code, name, tier, min score, max LTV, max term, max age, max miles, base APR, max amount, advertised, words]. */
const PROGRAMS = [
  [
    'KS-SEL',
    'Keystone Select',
    'super_prime',
    720,
    125,
    84,
    7,
    100000,
    5.99,
    90000,
    true,
    'Our best rates for established credit, on new and late-model vehicles.',
  ],
  ['KS-PRM', 'Keystone Prime', 'prime', 660, 120, 75, 9, 120000, 7.49, 70000, true, 'Competitive rates for good credit, new or used.'],
  ['KS-ACC', 'Keystone Access', 'near_prime', 600, 115, 72, 10, 130000, 11.99, 45000, true, 'Financing for credit that is still building.'],
  [
    'KS-FRS',
    'Fresh Start',
    'subprime',
    520,
    110,
    60,
    12,
    150000,
    17.99,
    30000,
    true,
    'A path back to good credit, with on-time payments reported every month.',
  ],
  ['KS-EV', 'Keystone Electric', 'prime', 680, 120, 84, 5, 60000, 4.99, 80000, true, 'A rate reserved for battery-electric vehicles.'],
  [
    'KS-CPO',
    'Certified Advantage',
    'prime',
    680,
    120,
    72,
    6,
    75000,
    6.49,
    60000,
    false,
    'Dealer-only: manufacturer-certified used vehicles.',
  ],
  [
    'KS-FTB',
    'First-Time Buyer',
    'near_prime',
    580,
    110,
    60,
    8,
    100000,
    12.99,
    25000,
    false,
    'Dealer-only: a first auto loan with a thin credit file.',
  ],
  [
    'KS-P24',
    'Prime 2024',
    'prime',
    660,
    115,
    72,
    8,
    120000,
    6.99,
    65000,
    false,
    'Retired at the end of 2024; kept for the loans it funded.',
  ],
];

/* [id, name, legal, kind, make, status, tier, street, city, state, zip, area code, vehicles, relationship manager, stock prefix]. */
const DEALERS = [
  [
    'liberty-ford',
    'Liberty Ford of Harrisburg',
    'Liberty Motor Sales, LLC',
    'franchise',
    'Ford',
    'active',
    'gold',
    '4501 Jonestown Rd',
    'Harrisburg',
    'PA',
    '17109',
    '717',
    80,
    0,
    'LF',
  ],
  [
    'susquehanna-toyota',
    'Susquehanna Toyota',
    'Susquehanna Automotive Group, Inc.',
    'franchise',
    'Toyota',
    'active',
    'gold',
    '1880 Lincoln Hwy E',
    'Lancaster',
    'PA',
    '17602',
    '717',
    75,
    0,
    'ST',
  ],
  [
    'three-rivers-honda',
    'Three Rivers Honda',
    'Three Rivers Imports, Inc.',
    'franchise',
    'Honda',
    'active',
    'gold',
    '7200 McKnight Rd',
    'Pittsburgh',
    'PA',
    '15237',
    '412',
    70,
    1,
    'TR',
  ],
  [
    'lehigh-valley-motors',
    'Lehigh Valley Motors',
    'LVM Auto Sales, LLC',
    'independent',
    null,
    'active',
    'silver',
    '2200 Union Blvd',
    'Allentown',
    'PA',
    '18109',
    '610',
    55,
    0,
    'LV',
  ],
  [
    'main-line-auto',
    'Main Line Auto Gallery',
    'Main Line Pre-Owned, LLC',
    'independent',
    null,
    'active',
    'silver',
    '39 E Lancaster Ave',
    'Ardmore',
    'PA',
    '19003',
    '610',
    45,
    0,
    'ML',
  ],
  [
    'erie-shores-chevrolet',
    'Erie Shores Chevrolet',
    'Erie Shores Motors, Inc.',
    'franchise',
    'Chevrolet',
    'active',
    'silver',
    '5700 Peach St',
    'Erie',
    'PA',
    '16509',
    '814',
    60,
    1,
    'ES',
  ],
  [
    'buckeye-auto-outlet',
    'Buckeye Auto Outlet',
    'Buckeye Outlet Holdings, LLC',
    'independent',
    null,
    'active',
    'bronze',
    '3950 Morse Rd',
    'Columbus',
    'OH',
    '43219',
    '614',
    40,
    1,
    'BA',
  ],
  [
    'garden-state-hyundai',
    'Garden State Hyundai',
    'GSH Motors, LLC',
    'franchise',
    'Hyundai',
    'active',
    'silver',
    '2111 Route 70 W',
    'Cherry Hill',
    'NJ',
    '08002',
    '856',
    55,
    2,
    'GS',
  ],
  [
    'chesapeake-subaru',
    'Chesapeake Subaru',
    'Chesapeake Automotive, Inc.',
    'franchise',
    'Subaru',
    'active',
    'gold',
    '1100 York Rd',
    'Towson',
    'MD',
    '21204',
    '410',
    55,
    2,
    'CS',
  ],
  [
    'finger-lakes-kia',
    'Finger Lakes Kia',
    'Finger Lakes Auto Group, LLC',
    'franchise',
    'Kia',
    'active',
    'bronze',
    '3500 W Henrietta Rd',
    'Rochester',
    'NY',
    '14623',
    '585',
    35,
    0,
    'FL',
  ],
  [
    'scranton-preowned',
    'Scranton Pre-Owned',
    'Electric City Auto, LLC',
    'independent',
    null,
    'on_hold',
    'bronze',
    '1520 Main Ave',
    'Scranton',
    'PA',
    '18508',
    '570',
    20,
    0,
    'SP',
  ],
  [
    'allegheny-truck-van',
    'Allegheny Truck & Van',
    'Allegheny Commercial Vehicles, Inc.',
    'independent',
    null,
    'prospect',
    'bronze',
    '3401 Pleasant Valley Blvd',
    'Altoona',
    'PA',
    '16602',
    '814',
    10,
    1,
    'AT',
  ],
];
const TAX = { PA: 6.0, OH: 5.75, NJ: 6.625, MD: 6.0, NY: 8.0 };
const BRAND = {
  'liberty-ford': ['#1d3f8c', '#e8a33d'],
  'susquehanna-toyota': ['#b3121f', '#2b2b2b'],
  'three-rivers-honda': ['#23303f', '#d4a017'],
  'lehigh-valley-motors': ['#2f6b3b', '#f2c14e'],
  'main-line-auto': ['#1f1f1f', '#b08d57'],
  'erie-shores-chevrolet': ['#0e5a8a', '#f3c300'],
  'buckeye-auto-outlet': ['#9e1b32', '#8a8d8f'],
  'garden-state-hyundai': ['#002c5f', '#00aad2'],
  'chesapeake-subaru': ['#13294b', '#6cace4'],
  'finger-lakes-kia': ['#5b2c6f', '#e5e5e5'],
  'scranton-preowned': ['#3a3a3a', '#e07a1f'],
  'allegheny-truck-van': ['#4a5a2a', '#f0b429'],
};

/* ---------- the catalog: [make, model, body, fuel, drivetrain, msrp, trims] ---------- */

const T = {
  ford: ['XL', 'XLT', 'Lariat', 'Platinum'],
  fordSuv: ['S', 'SE', 'ST-Line', 'Platinum'],
  toyota: ['LE', 'SE', 'XLE', 'Limited'],
  honda: ['LX', 'Sport', 'EX-L', 'Touring'],
  chevy: ['LS', 'LT', 'RS', 'Premier'],
  hyundai: ['SE', 'SEL', 'N Line', 'Limited'],
  subaru: ['Base', 'Premium', 'Sport', 'Limited'],
  kia: ['LX', 'S', 'EX', 'SX'],
  nissan: ['S', 'SV', 'SL'],
  jeep: ['Sport', 'Latitude', 'Limited'],
  ram: ['Tradesman', 'Big Horn', 'Laramie'],
  tesla: ['Standard Range', 'Long Range'],
  mazda: ['Select', 'Preferred', 'Premium'],
  vw: ['S', 'SE', 'SEL'],
  bmw: ['330i', '330i xDrive'],
  gmc: ['SLE', 'SLT', 'AT4'],
};
const MODELS = [
  ['Ford', 'F-150', 'truck', 'gas', '4wd', 44000, T.ford],
  ['Ford', 'Escape', 'suv', 'gas', 'awd', 30500, T.fordSuv],
  ['Ford', 'Explorer', 'suv', 'gas', 'awd', 40500, T.fordSuv],
  ['Ford', 'Maverick', 'truck', 'hybrid', 'fwd', 27500, T.ford],
  ['Ford', 'Mustang', 'coupe', 'gas', 'rwd', 33500, ['EcoBoost', 'GT']],
  ['Ford', 'Bronco Sport', 'suv', 'gas', '4wd', 32000, ['Big Bend', 'Outer Banks', 'Badlands']],
  ['Toyota', 'Camry', 'sedan', 'hybrid', 'fwd', 29000, T.toyota],
  ['Toyota', 'Corolla', 'sedan', 'gas', 'fwd', 23000, T.toyota],
  ['Toyota', 'RAV4', 'suv', 'hybrid', 'awd', 32500, T.toyota],
  ['Toyota', 'Highlander', 'suv', 'gas', 'awd', 41000, T.toyota],
  ['Toyota', 'Tacoma', 'truck', 'gas', '4wd', 36500, ['SR', 'SR5', 'TRD Off-Road']],
  ['Toyota', 'Sienna', 'van', 'hybrid', 'fwd', 40500, T.toyota],
  ['Honda', 'Civic', 'sedan', 'gas', 'fwd', 25000, T.honda],
  ['Honda', 'Accord', 'sedan', 'hybrid', 'fwd', 29500, T.honda],
  ['Honda', 'CR-V', 'suv', 'gas', 'awd', 32000, T.honda],
  ['Honda', 'Pilot', 'suv', 'gas', 'awd', 41500, T.honda],
  ['Honda', 'Odyssey', 'van', 'gas', 'fwd', 39500, T.honda],
  ['Honda', 'HR-V', 'suv', 'gas', 'fwd', 26000, T.honda],
  ['Chevrolet', 'Silverado 1500', 'truck', 'gas', '4wd', 44500, T.chevy],
  ['Chevrolet', 'Equinox', 'suv', 'gas', 'fwd', 29500, T.chevy],
  ['Chevrolet', 'Malibu', 'sedan', 'gas', 'fwd', 26000, T.chevy],
  ['Chevrolet', 'Traverse', 'suv', 'gas', 'awd', 39000, T.chevy],
  ['Chevrolet', 'Tahoe', 'suv', 'gas', '4wd', 59000, T.chevy],
  ['Chevrolet', 'Bolt EUV', 'suv', 'electric', 'fwd', 29000, ['LT', 'Premier']],
  ['Hyundai', 'Elantra', 'sedan', 'gas', 'fwd', 22500, T.hyundai],
  ['Hyundai', 'Tucson', 'suv', 'hybrid', 'awd', 30000, T.hyundai],
  ['Hyundai', 'Santa Fe', 'suv', 'gas', 'awd', 34000, T.hyundai],
  ['Hyundai', 'Ioniq 5', 'suv', 'electric', 'awd', 45500, ['SE', 'SEL', 'Limited']],
  ['Hyundai', 'Kona', 'suv', 'gas', 'fwd', 25500, T.hyundai],
  ['Subaru', 'Outback', 'wagon', 'gas', 'awd', 31500, T.subaru],
  ['Subaru', 'Forester', 'suv', 'gas', 'awd', 30500, T.subaru],
  ['Subaru', 'Crosstrek', 'hatchback', 'gas', 'awd', 27000, T.subaru],
  ['Subaru', 'Impreza', 'hatchback', 'gas', 'awd', 23500, T.subaru],
  ['Subaru', 'Ascent', 'suv', 'gas', 'awd', 38500, T.subaru],
  ['Kia', 'Telluride', 'suv', 'gas', 'awd', 40500, T.kia],
  ['Kia', 'Sportage', 'suv', 'hybrid', 'awd', 29500, T.kia],
  ['Kia', 'Forte', 'sedan', 'gas', 'fwd', 21500, T.kia],
  ['Kia', 'Sorento', 'suv', 'gas', 'awd', 33500, T.kia],
  ['Kia', 'Soul', 'hatchback', 'gas', 'fwd', 21000, T.kia],
  ['Nissan', 'Rogue', 'suv', 'gas', 'awd', 30000, T.nissan],
  ['Nissan', 'Altima', 'sedan', 'gas', 'fwd', 27000, T.nissan],
  ['Jeep', 'Grand Cherokee', 'suv', 'gas', '4wd', 42000, T.jeep],
  ['Jeep', 'Wrangler', 'suv', 'gas', '4wd', 36000, ['Sport', 'Sahara', 'Rubicon']],
  ['Ram', '1500', 'truck', 'gas', '4wd', 45000, T.ram],
  ['Tesla', 'Model 3', 'sedan', 'electric', 'rwd', 42000, T.tesla],
  ['Mazda', 'CX-5', 'suv', 'gas', 'awd', 30000, T.mazda],
  ['Volkswagen', 'Jetta', 'sedan', 'gas', 'fwd', 23500, T.vw],
  ['BMW', '3 Series', 'sedan', 'gas', 'rwd', 46000, T.bmw],
  ['GMC', 'Sierra 1500', 'truck', 'gas', '4wd', 47000, T.gmc],
];
/* The photo renderer's colours (forecourt/photos.mjs), weighted the way lots look. */
const COLORS = [
  'White',
  'White',
  'Black',
  'Black',
  'Silver',
  'Silver',
  'Gray',
  'Gray',
  'Blue',
  'Red',
  'Navy',
  'Green',
  'Beige',
  'Teal',
  'Orange',
];
const INTERIORS = ['Black', 'Black', 'Gray', 'Beige', 'Brown'];
const FEATURES = [
  'Adaptive cruise control',
  'Apple CarPlay and Android Auto',
  'Backup camera',
  'Blind-spot monitoring',
  'Heated front seats',
  'Heated steering wheel',
  'Keyless entry',
  'Lane-keeping assist',
  'Leather seats',
  'Navigation',
  'Power liftgate',
  'Remote start',
  'Sunroof',
  'Third-row seating',
  'Tow package',
  'Wireless charging',
];
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

/* ---------- dates, all UTC days ---------- */

const DAY = 86_400_000;
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const moment = (ms, minutes) => new Date(ms + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const addMonths = (ms, months, dayOfMonth) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, dayOfMonth);
};
const money = (n) => Math.round(n * 100) / 100;
const fixed2 = (n) => money(n).toFixed(2);
const slugOf = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function amortize(principal, apr, term) {
  const r = apr / 1200;
  const payment = money(r === 0 ? principal / term : (principal * r) / (1 - (1 + r) ** -term));
  let balance = principal;
  const rows = [];
  for (let n = 1; n <= term; n++) {
    const interest = money(balance * r);
    const toPrincipal = n === term ? money(balance) : money(Math.min(balance, payment - interest));
    rows.push({ n, principal: toPrincipal, interest, amount: money(toPrincipal + interest) });
    balance = money(balance - toPrincipal);
  }
  return { payment, rows };
}

export function buildKeystone(todayIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayIso)) throw new Error(`Not a day: ${todayIso}`);
  const TODAY = Date.parse(`${todayIso}T00:00:00Z`);
  const daysAgo = (n) => TODAY - n * DAY;
  const rand = mulberry32(20260926);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chance = (p) => rand() < p;
  const weighted = (pairs) => {
    const total = pairs.reduce((sum, [, w]) => sum + w, 0);
    let roll = rand() * total;
    for (const [value, w] of pairs) if ((roll -= w) < 0) return value;
    return pairs[pairs.length - 1][0];
  };
  const workMinutes = () => int(9 * 60, 19 * 60);
  const phone = (area) => `(${area}) 555-01${String(int(0, 99)).padStart(2, '0')}`;

  const emailsUsed = new Set();
  const emailFor = (first, last, domain = 'example.com') => {
    const base = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');
    let email = `${base}@${domain}`;
    for (let n = 2; emailsUsed.has(email); n++) email = `${base}${n}@${domain}`;
    emailsUsed.add(email);
    return email;
  };
  const vinsUsed = new Set();
  const vin = () => {
    for (;;) {
      let v = '';
      for (let i = 0; i < 17; i++) v += VIN_CHARS[int(0, VIN_CHARS.length - 1)];
      if (!vinsUsed.has(v)) {
        vinsUsed.add(v);
        return v;
      }
    }
  };

  /* ---------- the lender ---------- */

  const lenderUsers = LENDER_STAFF.map(([name, role, title], i) => {
    const [first, last] = name.split(' ');
    return {
      id: i + 1,
      name,
      email: emailFor(first, last, 'keystone.example'),
      account_id: null,
      role,
      title,
      active: true,
      hired_on: toDay(daysAgo(int(200, 3000))),
    };
  });
  const staff = (role) => lenderUsers.filter((u) => u.role === role);
  const underwriters = [...staff('underwriter'), ...staff('credit_manager')];
  const rms = staff('relationship_manager');

  const programs = PROGRAMS.map(([code, name, tier, minScore, ltv, maxTerm, age, miles, apr, max, advertised, description], i) => ({
    id: i + 1,
    code,
    name,
    tier,
    min_score: minScore,
    max_ltv_pct: ltv.toFixed(1),
    max_term: maxTerm,
    max_vehicle_age: age,
    max_mileage: miles,
    base_apr: apr.toFixed(3),
    max_amount: fixed2(max),
    advertised,
    active: code !== 'KS-P24',
    description,
  }));
  const programFor = (score, vehicle) => {
    if (vehicle.fuel === 'electric' && score >= 680) return programs[4];
    if (vehicle.condition === 'certified' && score >= 680 && score < 720) return programs[5];
    if (score >= 720) return programs[0];
    if (score >= 660) return programs[1];
    if (score >= 600) return programs[2];
    return programs[3];
  };
  const aprFor = (program, score, term) =>
    Math.round((Number(program.base_apr) + Math.max(0, (program.min_score + 60 - score) / 30) + (term > 72 ? 0.5 : 0)) * 100) / 100;

  /* ---------- dealers, their sites and their people ---------- */

  const dealers = [],
    sites = [],
    dealerUsers = [],
    visits = [];
  const info = new Map();
  for (const [id, name, legal, kind, make, status, tier, street, city, state, zip, area, , rm, prefix] of DEALERS) {
    const joined = status === 'prospect' ? daysAgo(12) : daysAgo(int(950, 2400));
    dealers.push({
      id,
      name,
      legal_name: legal,
      kind,
      franchise_make: make,
      status,
      tier,
      street,
      city,
      state,
      zip,
      phone: phone(area),
      email: `sales@${id}.example`,
      relationship_manager_id: rms[rm].id,
      reserve_pct: tier === 'gold' ? '2.00' : tier === 'silver' ? '1.50' : '1.00',
      monthly_goal: { gold: 14, silver: 9, bronze: 5 }[tier],
      joined_on: toDay(joined),
      on_hold_reason:
        status === 'on_hold'
          ? 'Funding audit found two contracts with unsigned stipulations; new submissions paused pending review.'
          : null,
      intake_address: null,
      version: 0,
    });
    info.set(id, {
      area,
      prefix,
      tax: TAX[state],
      status,
      city,
      state,
      zip,
      name,
      users: 0,
      leads: 1000,
      deals: 1000,
      people: 0,
      trades: 0,
    });
    const [brand, accent] = BRAND[id];
    const published = status === 'active' || status === 'on_hold';
    sites.push({
      id: `${id}-site`,
      dealer_id: id,
      published,
      headline:
        status === 'prospect'
          ? name
          : pick([
              `Drive home from ${name}`,
              `${city}'s neighborhood dealer`,
              `Find your next car at ${name}`,
              'Straight answers, fair prices',
            ]),
      tagline: make ? `New ${make} and quality pre-owned vehicles in ${city}, ${state}` : `Quality pre-owned vehicles in ${city}, ${state}`,
      about: `${name} has served drivers around ${city} since ${new Date(joined).getUTCFullYear() - int(3, 30)}. Financing through Keystone Auto Finance, with an answer in minutes.`,
      brand_color: brand,
      accent_color: accent,
      logo_text: name
        .split(/\s+/)
        .filter((w) => /^[A-Z]/.test(w))
        .slice(0, 2)
        .map((w) => w[0])
        .join(''),
      custom_domain: published && tier === 'gold' ? `www.${id.replace(/-/g, '')}.example` : null,
      show_prices: id !== 'main-line-auto',
      contact_email: `hello@${id}.example`,
      contact_phone: phone(area),
      hours: 'Mon–Fri 9 am–8 pm, Sat 9 am–6 pm, Sun closed',
      published_on: published ? toDay(joined + int(5, 40) * DAY) : null,
      version: 0,
    });
    const team =
      status === 'prospect'
        ? [
            ['owner', 'invited'],
            ['finance_manager', 'invited'],
          ]
        : [
            ['owner', 'active'],
            ['sales_manager', 'active'],
            ['finance_manager', 'active'],
            ...(tier === 'gold' ? [['finance_manager', 'active']] : []),
            ...Array.from({ length: tier === 'gold' ? 4 : tier === 'silver' ? 3 : 2 }, () => ['salesperson', 'active']),
            ...(chance(0.5) ? [['viewer', 'active']] : []),
            ...(chance(0.4) ? [['salesperson', 'invited']] : []),
            ...(chance(0.3) ? [['salesperson', 'deactivated']] : []),
          ];
    for (const [role, userStatus] of team) {
      const first = pick(FIRST),
        last = pick(LAST);
      const invited =
        status === 'prospect' ? daysAgo(int(1, 10)) : userStatus === 'invited' ? daysAgo(int(1, 6)) : joined + int(0, 600) * DAY;
      dealerUsers.push({
        id: `${id}-user-${++info.get(id).users}`,
        dealer_id: id,
        name: `${first} ${last}`,
        email: emailFor(first, last, `${id}.example`),
        phone: phone(area),
        account_id: null,
        dealer_account_id: null,
        role,
        status: userStatus,
        invited_on: toDay(Math.min(invited, daysAgo(1))),
        joined_on: userStatus === 'invited' ? null : toDay(Math.min(invited + int(0, 3) * DAY, daysAgo(1))),
        version: 0,
      });
    }
    const visitCount = status === 'prospect' ? 0 : int(4, 8);
    for (let v = 0; v < visitCount; v++) {
      visits.push({
        id: 0,
        dealer_id: id,
        lender_user_id: rms[rm].id,
        happened_on: toDay(daysAgo(int(2, 360))),
        kind: pick(['visit', 'visit', 'call', 'call', 'review', 'training']),
        summary: pick([
          'Walked the lot with the finance manager; stipulation turnaround is the sticking point.',
          'Quarterly review: approval rate steady, funding times down to two days.',
          'Trained two new finance managers on the submission checklist.',
          'Discussed the Fresh Start program for credit-challenged customers.',
          'Reviewed contracts returned for missing signatures.',
          'Called about the drop in submissions this month; they lost a finance manager.',
          'Presented the Keystone Electric rate for their EV inventory.',
        ]),
        next_step: chance(0.6)
          ? pick([
              'Send the stipulation checklist',
              'Follow up in two weeks',
              'Schedule funding audit walkthrough',
              'Share program rate sheet',
            ])
          : null,
      });
    }
    if (status === 'prospect') {
      visits.push({
        id: 0,
        dealer_id: id,
        lender_user_id: rms[rm].id,
        happened_on: toDay(daysAgo(9)),
        kind: 'visit',
        summary: 'Onboarding visit: dealer agreement signed, users invited, website not yet set up.',
        next_step: 'Complete onboarding checklist',
      });
    }
  }
  // One finance manager works both Liberty Ford and Susquehanna Toyota (the same
  // owner group): one email, a row in each, and in /leads a membership at each.
  const floater = dealerUsers.find((u) => u.dealer_id === 'liberty-ford' && u.role === 'finance_manager');
  dealerUsers.push({
    ...floater,
    id: `susquehanna-toyota-user-${++info.get('susquehanna-toyota').users}`,
    dealer_id: 'susquehanna-toyota',
    invited_on: toDay(daysAgo(200)),
    joined_on: toDay(daysAgo(199)),
  });
  visits.sort((a, b) => a.happened_on.localeCompare(b.happened_on) || a.dealer_id.localeCompare(b.dealer_id));
  visits.forEach((v, i) => {
    v.id = i + 1;
  });
  const usersOf = (dealerId, ...roles) =>
    dealerUsers.filter((u) => u.dealer_id === dealerId && u.status === 'active' && roles.includes(u.role));

  /* ---------- inventory ---------- */

  const vehicles = [];
  for (const [dealerId, , , kind, make, , , , , , , , count] of DEALERS) {
    const d = info.get(dealerId);
    for (let n = 0; n < count; n++) {
      const isNew = kind === 'franchise' && chance(0.45);
      const [mk, model, body, fuel, drive, msrp, trims] =
        isNew || (kind === 'franchise' && chance(0.4)) ? pick(MODELS.filter((m) => m[0] === make)) : pick(MODELS);
      const age = isNew
        ? 0
        : weighted([
            [1, 3],
            [2, 4],
            [3, 4],
            [4, 3],
            [5, 3],
            [6, 2],
            [7, 2],
            [8, 1],
            [10, 1],
          ]);
      const modelYear = new Date(TODAY).getUTCFullYear() + (isNew ? int(0, 1) : -age);
      const mileage = isNew ? int(3, 60) : Math.max(1500, Math.round(age * int(9000, 14500) + int(-4000, 4000)));
      const condition = isNew
        ? 'new'
        : kind === 'franchise' && mk === make && age <= 5 && mileage < 70000 && chance(0.6)
          ? 'certified'
          : 'used';
      const trimIndex = int(0, trims.length - 1);
      const base = msrp * (1 + 0.09 * trimIndex);
      const price = isNew
        ? base * (0.97 + rand() * 0.05)
        : base * 0.84 ** age * (1 - Math.min(0.25, mileage / 600000)) * (condition === 'certified' ? 1.05 : 1);
      const list = Math.round(price / 100) * 100 - (isNew ? 0 : 5);
      const stock = `${d.prefix}${1001 + n}`;
      vehicles.push({
        id: slugOf(`${modelYear} ${mk} ${model} ${trims[trimIndex]} ${stock}`),
        dealer_id: dealerId,
        stock_number: stock,
        vin: vin(),
        year: modelYear,
        make: mk,
        model,
        trim: trims[trimIndex],
        body,
        fuel,
        drivetrain: drive,
        mileage,
        exterior_color: pick(COLORS),
        interior_color: pick(INTERIORS),
        condition,
        cost: fixed2(list * (isNew ? 0.93 : 0.86 + rand() * 0.06)),
        list_price: fixed2(list),
        est_payment: null,
        featured: false,
        status: 'listed',
        received_on: null,
        listed_on: null,
        sold_on: null,
        description: null,
        features: null,
        version: 0,
      });
    }
  }
  const free = new Set(vehicles.map((v) => v.id));
  const takeVehicle = (dealerId) => {
    const options = vehicles.filter((v) => v.dealer_id === dealerId && free.has(v.id));
    const v = options[Math.floor(rand() * options.length)];
    free.delete(v.id);
    return v;
  };

  /* ---------- the funnel: leads, applicants, deals, applications ---------- */

  const leads = [],
    activity = [],
    applicants = [],
    deals = [],
    tradeIns = [],
    scenarios = [],
    applications = [],
    stips = [];
  const files = [],
    uwNotes = [],
    alerts = [],
    fundings = [];
  const leadSource = () =>
    weighted([
      ['website', 30],
      ['marketplace', 20],
      ['walk_in', 20],
      ['phone', 10],
      ['referral', 10],
      ['third_party', 10],
    ]);

  const newLead = (dealerId, vehicle, created, status, extra = {}) => {
    const d = info.get(dealerId);
    const source = extra.source ?? leadSource();
    const first = pick(FIRST),
      last = pick(LAST);
    const sales = usersOf(dealerId, 'salesperson', 'sales_manager');
    const n = ++d.leads;
    const lead = {
      id: `${dealerId}-lead-${n}`,
      dealer_id: dealerId,
      reference: `LD-${n}`,
      source,
      status,
      first_name: first,
      last_name: last,
      email: chance(0.9) || extra.applies ? emailFor(first, last) : null,
      phone: phone(d.area),
      vehicle_id: vehicle?.id ?? null,
      salesperson_id: status === 'new' && chance(0.5) ? null : pick(sales).id,
      message:
        vehicle && (source === 'website' || source === 'marketplace')
          ? pick([
              `Is the ${vehicle.year} ${vehicle.make} ${vehicle.model} still available?`,
              `What would my payment be on the ${vehicle.model} with $2,000 down?`,
              `I'd like to test drive the ${vehicle.make} ${vehicle.model} this weekend.`,
              `Do you take trade-ins? I have a ${int(2012, 2020)} sedan.`,
              'Can I get pre-approved before I come in?',
            ])
          : null,
      marketplace_account_id: null,
      created_at: moment(created, workMinutes()),
      last_contact_at: status === 'new' ? null : moment(created + int(0, 3) * DAY, workMinutes()),
      next_follow_up_on: ['contacted', 'desking'].includes(status) ? toDay(TODAY + int(-2, 6) * DAY) : null,
      lost_reason: extra.lost_reason ?? null,
      resume_token_hash: null,
      resume_expires_at: null,
      resume_progress: null,
      version: 0,
    };
    if (!lead.email) lead.email = null;
    leads.push(lead);
    // Its timeline: first touch, then what the salesperson did.
    const steps = status === 'new' ? 0 : status === 'contacted' ? int(1, 2) : int(2, 4);
    let at = Date.parse(`${lead.created_at.replace(' ', 'T')}Z`);
    for (let s = 0; s < steps; s++) {
      at = Math.min(at + int(30, 60 * 48) * 60_000, TODAY - 3600_000);
      const kind = s === 0 ? pick(['call', 'email', 'text']) : pick(['call', 'text', 'visit', 'test_drive', 'note']);
      activity.push({
        id: `${lead.id}-${s + 1}`,
        dealer_id: dealerId,
        lead_id: lead.id,
        kind,
        body: {
          call: 'Called; talked through the vehicle and financing.',
          email: 'Sent pricing and a link to apply.',
          text: 'Texted to confirm the appointment.',
          visit: 'Came in; walked the lot together.',
          test_drive: `Test drove the ${vehicle ? vehicle.model : 'vehicle'}.`,
          note: 'Wants the payment under $450.',
        }[kind],
        author_id: lead.salesperson_id,
        created_at: moment(at, 0),
      });
    }
    if (status === 'lost') {
      activity.push({
        id: `${lead.id}-lost`,
        dealer_id: dealerId,
        lead_id: lead.id,
        kind: 'status',
        body: `Marked lost: ${lead.lost_reason.replace(/_/g, ' ')}.`,
        author_id: lead.salesperson_id,
        created_at: moment(Math.min(at + DAY, TODAY - 3600_000), 0),
      });
    }
    return lead;
  };

  const newApplicant = (lead, role, score, created) => {
    const d = info.get(lead.dealer_id);
    const first = role === 'primary' ? lead.first_name : pick(FIRST);
    const last = role === 'primary' ? lead.last_name : lead.last_name;
    const income = Math.round((2400 + (score - 480) * 22 + rand() * 3500) / 50) * 50;
    const housing = weighted([
      ['own', 4],
      ['rent', 5],
      ['family', 1],
    ]);
    const employment = weighted([
      ['full_time', 14],
      ['part_time', 2],
      ['self_employed', 2],
      ['retired', 1],
    ]);
    const a = {
      id: `${lead.dealer_id}-person-${++d.people}`,
      dealer_id: lead.dealer_id,
      lead_id: lead.id,
      role,
      first_name: first,
      last_name: last,
      email: role === 'primary' && lead.email ? lead.email : emailFor(first, last),
      phone: role === 'primary' ? lead.phone : phone(d.area),
      date_of_birth: toDay(daysAgo(int(21 * 365, 72 * 365))),
      ssn_last4: String(int(0, 9999)).padStart(4, '0'),
      street: `${int(10, 9800)} ${pick(STREETS)} ${pick(['St', 'Ave', 'Rd', 'Ln', 'Dr'])}`,
      city: d.city,
      state: d.state,
      zip: d.zip.slice(0, 3) + String(int(0, 99)).padStart(2, '0'),
      housing,
      monthly_housing: fixed2(housing === 'family' ? int(0, 400) : int(850, 2400)),
      years_at_address: (int(3, 180) / 10).toFixed(1),
      employer: employment === 'retired' ? null : pick(EMPLOYERS),
      job_title: employment === 'retired' ? null : pick(JOBS),
      employment_type: employment,
      years_employed: employment === 'retired' ? '0.0' : (int(3, 250) / 10).toFixed(1),
      monthly_income: fixed2(income),
      created_at: moment(created, workMinutes()),
    };
    if (!lead.email && role === 'primary') lead.email = a.email;
    applicants.push(a);
    return a;
  };

  const structureDeal = (dealerId, vehicle, score, created, lead, applicant, program, status) => {
    const d = info.get(dealerId);
    const sale = money(Number(vehicle.list_price) * (1 - rand() * 0.04));
    const hasTrade = chance(0.35);
    // A trade is worth at most half the car it goes toward, so the loan is never negative.
    const tradeAllowance = hasTrade ? Math.min(Math.round(int(1500, 14000) / 100) * 100, Math.floor(sale / 200) * 100) : 0;
    const tradePayoff = hasTrade && chance(0.45) ? Math.round((tradeAllowance * (0.4 + rand() * 0.7)) / 10) * 10 : 0;
    const cashDown =
      Math.round(
        (sale *
          weighted([
            [0, 2],
            [0.05, 3],
            [0.1, 3],
            [0.15, 1],
            [0.2, 1],
          ])) /
          100,
      ) * 100;
    const rebate = vehicle.condition === 'new' && chance(0.4) ? pick([500, 750, 1000, 1500]) : 0;
    const serviceContract = chance(0.3) ? 1895 : 0;
    const gap = chance(0.4) ? 795 : 0;
    const docFee = 449,
      titleFees = 245;
    const tax = money(((sale - tradeAllowance) * d.tax) / 100);
    const financed = money(sale + docFee + tax + titleFees + serviceContract + gap - tradeAllowance + tradePayoff - cashDown - rebate);
    const term = weighted([
      [48, 1],
      [60, 4],
      [66, 1],
      [72, 5],
      [75, 1],
      [84, program.max_term >= 84 ? 2 : 0],
    ]);
    const apr = aprFor(program, score, term);
    const n = ++d.deals;
    const deal = {
      id: `${dealerId}-deal-${n}`,
      dealer_id: dealerId,
      reference: `DL-${n}`,
      lead_id: lead.id,
      applicant_id: applicant.id,
      co_applicant_id: null,
      vehicle_id: vehicle.id,
      salesperson_id: lead.salesperson_id,
      finance_manager_id: pick(usersOf(dealerId, 'finance_manager')).id,
      program_id: program.id,
      status,
      sale_price: fixed2(sale),
      doc_fee: fixed2(docFee),
      tax_rate: d.tax.toFixed(3),
      sales_tax: fixed2(tax),
      title_fees: fixed2(titleFees),
      trade_allowance: fixed2(tradeAllowance),
      trade_payoff: fixed2(tradePayoff),
      cash_down: fixed2(cashDown),
      rebate: fixed2(rebate),
      service_contract: fixed2(serviceContract),
      gap: fixed2(gap),
      amount_financed: fixed2(financed),
      term_months: term,
      apr: apr.toFixed(3),
      monthly_payment: fixed2(amortize(financed, apr, term).payment),
      created_on: toDay(created),
      updated_at: moment(created + int(0, 2) * DAY, workMinutes()),
      version: 0,
    };
    deals.push(deal);
    if (hasTrade) {
      const [mk, model] = pick(MODELS);
      tradeIns.push({
        id: `${dealerId}-trade-${++d.trades}`,
        dealer_id: dealerId,
        deal_id: deal.id,
        vin: vin(),
        year: new Date(TODAY).getUTCFullYear() - int(3, 14),
        make: mk,
        model,
        mileage: int(40000, 190000),
        condition: pick(['excellent', 'good', 'good', 'fair', 'fair', 'rough']),
        allowance: fixed2(tradeAllowance),
        acv: fixed2(Math.round((tradeAllowance * (0.85 + rand() * 0.15)) / 50) * 50),
        payoff: fixed2(tradePayoff),
        lienholder:
          tradePayoff > 0
            ? pick(['Ally Financial', 'Capital One Auto', 'Chase Auto', 'Santander Consumer', 'PSECU', 'Members 1st FCU'])
            : null,
        version: 0,
      });
    }
    for (const [label, t, down] of [
      ['A', term, cashDown],
      ['B', term === 72 ? 60 : 72, cashDown],
      ['C', term, cashDown + 2000],
    ]) {
      const f = money(financed - (down - cashDown));
      const a = aprFor(program, score, t);
      scenarios.push({
        id: `${deal.id}-${label.toLowerCase()}`,
        dealer_id: dealerId,
        deal_id: deal.id,
        label,
        term_months: t,
        apr: a.toFixed(3),
        cash_down: fixed2(down),
        amount_financed: fixed2(f),
        monthly_payment: fixed2(amortize(f, a, t).payment),
        selected: label === 'A',
      });
    }
    return deal;
  };

  /* The four hundred applications, by where they ended up. */
  const OUTCOMES = [
    ['funded', 250],
    ['approved', 20],
    ['countered', 10],
    ['conditioned', 22],
    ['in_review', 18],
    ['submitted', 15],
    ['declined', 50],
    ['withdrawn', 15],
  ];
  const plan = OUTCOMES.flatMap(([outcome, n]) => Array.from({ length: n }, () => outcome));
  const active = dealers.filter((d) => d.status === 'active').map((d) => d.id);
  const onHold = dealers.find((d) => d.status === 'on_hold').id;
  const dealerWeights = [...active.map((id) => [id, vehicles.filter((v) => v.dealer_id === id).length]), [onHold, 8]];
  // An on-hold dealer submits nothing new: its open work is from before the hold.
  const dealerFor = (outcome) => {
    for (;;) {
      const id = weighted(dealerWeights);
      if (id === onHold && !['funded', 'declined', 'in_review'].includes(outcome)) continue;
      return id;
    }
  };
  const scoreFor = (outcome) => {
    const base = outcome === 'declined' ? 560 : outcome === 'countered' ? 620 : outcome === 'conditioned' ? 650 : 690;
    return Math.max(480, Math.min(835, Math.round(base + (rand() + rand() + rand() - 1.5) * 110)));
  };
  const funded = [];
  let appSeq = 104000;

  for (const outcome of plan) {
    const dealerId = dealerFor(outcome);
    const score = scoreFor(outcome);
    const isOpen = ['approved', 'countered', 'conditioned', 'in_review', 'submitted'].includes(outcome);
    const fundedOn = outcome === 'funded' ? daysAgo(int(3, 900)) : null;
    const submitted =
      outcome === 'funded'
        ? fundedOn - int(2, 9) * DAY
        : outcome === 'submitted'
          ? daysAgo(int(0, 2))
          : outcome === 'in_review'
            ? daysAgo(int(1, 5))
            : outcome === 'conditioned'
              ? daysAgo(int(3, 14))
              : isOpen
                ? daysAgo(int(2, 20))
                : daysAgo(int(5, 150));
    const leadCreated = submitted - int(0, 12) * DAY - int(1, 600) * 60_000;
    const vehicle = takeVehicle(dealerId);
    vehicle.received_on = toDay(leadCreated - int(8, 90) * DAY);
    vehicle.listed_on = toDay(Date.parse(vehicle.received_on) + int(2, 6) * DAY);
    const leadStatus = outcome === 'funded' ? 'sold' : isOpen ? 'submitted' : 'lost';
    const lead = newLead(dealerId, vehicle, leadCreated, leadStatus, {
      applies: true,
      ...(leadStatus === 'lost' ? { lost_reason: outcome === 'declined' ? 'credit' : pick(['bought_elsewhere', 'price', 'other']) } : {}),
    });
    const applicant = newApplicant(lead, 'primary', score, leadCreated + int(0, 2) * DAY);
    const program = programFor(score, vehicle);
    const dealStatus =
      outcome === 'funded'
        ? 'funded'
        : ['approved', 'countered'].includes(outcome)
          ? 'approved'
          : ['declined', 'withdrawn'].includes(outcome)
            ? 'cancelled'
            : 'submitted';
    const deal = structureDeal(dealerId, vehicle, score, leadCreated + int(0, 3) * DAY, lead, applicant, program, dealStatus);
    if (chance(0.1)) deal.co_applicant_id = newApplicant(lead, 'co_applicant', Math.min(835, score + int(-40, 60)), leadCreated).id;
    // What the dealer submitted, and what the lender measured it by.
    const financed = Number(deal.amount_financed);
    const value = money(Number(vehicle.list_price) * (0.9 + rand() * 0.08));
    const income = Number(applicant.monthly_income);
    const monthlyDebt = money(income * (0.08 + rand() * 0.22));
    const pti = (Number(deal.monthly_payment) / income) * 100;
    const dti = ((monthlyDebt + Number(applicant.monthly_housing) + Number(deal.monthly_payment)) / income) * 100;
    const uw = pick(underwriters);
    const decided = ['funded', 'approved', 'countered', 'declined'].includes(outcome);
    const decidedAt = decided ? submitted + int(40, 60 * 30) * 60_000 : null;
    let approvedAmount = null,
      approvedApr = null,
      approvedTerm = null,
      approvedPayment = null;
    if (['funded', 'approved', 'countered'].includes(outcome)) {
      approvedAmount = outcome === 'countered' ? Math.round((financed * (0.82 + rand() * 0.1)) / 100) * 100 : financed;
      approvedApr = Number(deal.apr) + (outcome === 'countered' ? 1.5 : 0);
      approvedTerm = outcome === 'countered' ? Math.min(deal.term_months, 60) : deal.term_months;
      approvedPayment = amortize(approvedAmount, approvedApr, approvedTerm).payment;
    }
    const reference = `KA-${++appSeq}`;
    const app = {
      id: `${dealerId}-${reference.toLowerCase()}`,
      dealer_id: dealerId,
      reference,
      deal_id: deal.id,
      applicant_id: applicant.id,
      co_applicant_id: deal.co_applicant_id,
      vehicle_id: vehicle.id,
      program_id: program.id,
      status: outcome,
      requested_amount: deal.amount_financed,
      requested_term: deal.term_months,
      down_payment: deal.cash_down,
      vehicle_value: fixed2(value),
      ltv_pct: ((financed / value) * 100).toFixed(1),
      dti_pct: dti.toFixed(1),
      pti_pct: pti.toFixed(1),
      dealer_note: chance(0.3)
        ? pick([
            'Customer has been with the same employer eleven years.',
            'Co-signer available if needed.',
            'Prior auto loan paid as agreed.',
            'Customer is flexible on term.',
            'Repeat customer.',
          ])
        : null,
      submitted_at: moment(submitted, workMinutes()),
      decided_at: decided ? moment(decidedAt, 0) : null,
      approved_amount: approvedAmount === null ? null : fixed2(approvedAmount),
      approved_apr: approvedApr === null ? null : approvedApr.toFixed(3),
      approved_term: approvedTerm,
      approved_payment: approvedPayment === null ? null : fixed2(approvedPayment),
      decline_reason:
        outcome === 'declined'
          ? weighted([
              ['credit_history', 5],
              ['debt_to_income', 3],
              ['loan_to_value', 2],
              ['income_unverified', 1],
              ['collateral', 1],
            ])
          : null,
      withdrawn_reason:
        outcome === 'withdrawn'
          ? pick([
              'Customer bought elsewhere.',
              'Customer paid cash.',
              'Customer changed vehicles; resubmitting.',
              'Customer no longer interested.',
            ])
          : null,
      version: 0,
    };
    applications.push(app);
    // The lender's own file: the bureau, who has it, who decided, when the answer is owed.
    const submittedMs = Date.parse(`${app.submitted_at.replace(' ', 'T')}Z`);
    const due = submittedMs + 4 * 3600_000;
    files.push({
      id: files.length + 1,
      application_id: app.id,
      dealer_id: dealerId,
      underwriter_id: outcome === 'submitted' ? null : uw.id,
      assigned_at: outcome === 'submitted' ? null : moment(submittedMs, int(5, 90)),
      decided_by: decided ? (outcome === 'funded' && chance(0.2) ? staff('credit_manager')[0].id : uw.id) : null,
      bureau: pick(['Equifax', 'Experian', 'TransUnion']),
      score,
      pulled_at: moment(submittedMs, 2),
      open_tradelines: int(2, 24),
      auto_tradelines: int(0, 3),
      revolving_utilization_pct: (score > 700 ? int(2, 35) : int(20, 95)).toFixed(1),
      delinquencies_24m: score > 700 ? int(0, 1) : score > 620 ? int(0, 3) : int(1, 8),
      public_records: score < 580 && chance(0.3) ? 1 : 0,
      inquiries_6m: int(0, score > 680 ? 3 : 7),
      monthly_debt: fixed2(monthlyDebt),
      decision_due_at: moment(due, 0),
      version: 0,
    });
    if (['submitted', 'in_review'].includes(outcome) && due < TODAY - 3600_000) {
      alerts.push({
        id: 0,
        application_id: app.id,
        dealer_id: dealerId,
        raised_at: moment(due + DAY, 0),
        due_at: moment(due, 0),
        resolved_at: null,
      });
    }
    // Stipulations: asked on a conditioned file, collected and cleared on the way to funding.
    if (['conditioned', 'approved', 'countered', 'funded'].includes(outcome)) {
      const kinds = ['proof_of_income', 'proof_of_residence', 'proof_of_insurance', 'references', 'drivers_license']
        .map((k) => [k, rand()])
        .sort((a, b) => a[1] - b[1])
        .slice(0, int(1, 3))
        .map(([k]) => k);
      if (outcome === 'funded' || outcome === 'approved') kinds.push('signed_contract');
      for (const kind of kinds) {
        const askedAt = (decidedAt ?? submittedMs) + int(10, 90) * 60_000;
        const state =
          outcome === 'funded'
            ? chance(0.08)
              ? 'waived'
              : 'cleared'
            : outcome === 'conditioned'
              ? weighted([
                  ['requested', 5],
                  ['received', 3],
                  ['cleared', 1],
                ])
              : weighted([
                  ['received', 3],
                  ['cleared', 4],
                  ['requested', 1],
                ]);
        const received = state === 'received' || state === 'cleared' ? Math.min(askedAt + int(1, 4) * DAY, TODAY - 3600_000) : null;
        const cleared =
          state === 'cleared' || state === 'waived' ? Math.min((received ?? askedAt) + int(2, 30) * 3600_000, TODAY - 1800_000) : null;
        stips.push({
          id: `${app.id}-${kind.replace(/_/g, '-')}`,
          dealer_id: dealerId,
          application_id: app.id,
          kind,
          status: state,
          requested_at: moment(askedAt, 0),
          received_at: received && moment(received, 0),
          cleared_at: cleared && moment(cleared, 0),
          note: state === 'waived' ? 'Waived: employment verified by phone.' : null,
          version: 0,
        });
      }
    }
    if (outcome !== 'submitted') {
      const notes =
        outcome === 'declined'
          ? [
              `Score ${score}; ${app.decline_reason.replace(/_/g, ' ')} outside ${program.name} guidelines.`,
              'No compensating factors; declined.',
            ]
          : outcome === 'countered'
            ? [
                `Requested $${deal.amount_financed} over ${deal.term_months} months exceeds the LTV guideline; countered lower on a shorter term.`,
              ]
            : outcome === 'in_review'
              ? ['Income on the application does not match the stated employer; asked the dealer for pay stubs.']
              : [`Score ${score}, PTI ${pti.toFixed(1)}%, DTI ${dti.toFixed(1)}%. Within ${program.name}.`];
      notes.forEach((body, i) =>
        uwNotes.push({
          id: 0,
          application_id: app.id,
          author_id: uw.id,
          created_at: moment(submittedMs + (i + 1) * int(20, 240) * 60_000, 0),
          body,
        }),
      );
    }
    // The vehicle, and the money.
    if (outcome === 'funded') {
      vehicle.status = 'sold';
      vehicle.sold_on = toDay(fundedOn - int(1, 3) * DAY);
      const reserve = (financed * Number(dealers.find((x) => x.id === dealerId).reserve_pct)) / 100;
      fundings.push({
        id: 0,
        application_id: app.id,
        dealer_id: dealerId,
        status: 'funded',
        contract_received_on: toDay(fundedOn - int(0, 2) * DAY),
        audited_by: pick(staff('funder')).id,
        funded_on: toDay(fundedOn),
        amount: fixed2(financed + reserve),
        dealer_reserve: fixed2(reserve),
        reject_reason: null,
        version: 0,
      });
      funded.push({ app, deal, applicant, vehicle, dealerId, fundedOn, score });
    } else if (isOpen) {
      vehicle.status = 'pending';
      if (outcome === 'approved') {
        const state = weighted([
          ['awaiting_contract', 8],
          ['in_audit', 6],
          ['ready', 4],
          ['rejected', 2],
        ]);
        if (state !== 'awaiting_contract') deal.status = 'contracted';
        const reserve = (financed * Number(dealers.find((x) => x.id === dealerId).reserve_pct)) / 100;
        fundings.push({
          id: 0,
          application_id: app.id,
          dealer_id: dealerId,
          status: state,
          contract_received_on: state === 'awaiting_contract' ? null : toDay(daysAgo(int(0, 3))),
          audited_by: ['ready', 'rejected'].includes(state) ? pick(staff('funder')).id : null,
          funded_on: null,
          amount: fixed2(financed + reserve),
          dealer_reserve: fixed2(reserve),
          reject_reason:
            state === 'rejected' ? pick(['Contract APR does not match the approval.', 'Missing co-applicant signature on page 3.']) : null,
          version: 0,
        });
      }
    } else if (chance(0.3)) {
      vehicle.status = 'sold';
      vehicle.sold_on = toDay(submitted + int(3, 20) * DAY);
    } else {
      free.add(vehicle.id);
    }
  }

  // Deals still being structured, and the leads that have no deal yet.
  for (const dealerId of active) {
    const size = vehicles.filter((v) => v.dealer_id === dealerId).length;
    for (let n = 0; n < Math.round(size / 12); n++) {
      const created = daysAgo(int(0, 10));
      const score = scoreFor('approved');
      const vehicle = takeVehicle(dealerId);
      const lead = newLead(dealerId, vehicle, created, 'desking', { applies: true });
      const applicant = newApplicant(lead, 'primary', score, created);
      structureDeal(dealerId, vehicle, score, created, lead, applicant, programFor(score, vehicle), 'structuring');
      // On the desk, still on the lot: listed until a deal is signed.
      vehicle.received_on = toDay(created - int(8, 90) * DAY);
      vehicle.listed_on = toDay(Date.parse(vehicle.received_on) + int(2, 6) * DAY);
      vehicle.status = 'listed';
    }
    for (let n = 0; n < Math.round(size / 3); n++) {
      const status = weighted([
        ['new', 4],
        ['contacted', 6],
        ['lost', 9],
      ]);
      const created = status === 'new' ? daysAgo(int(0, 3)) : status === 'contacted' ? daysAgo(int(1, 20)) : daysAgo(int(20, 400));
      const mine = vehicles.filter((v) => v.dealer_id === dealerId);
      newLead(
        dealerId,
        chance(0.8) ? mine[int(0, mine.length - 1)] : null,
        created,
        status,
        status === 'lost'
          ? {
              lost_reason: weighted([
                ['no_response', 5],
                ['bought_elsewhere', 3],
                ['price', 2],
                ['credit', 1],
                ['other', 1],
              ]),
            }
          : {},
      );
    }
  }

  // What is left on each lot: listed, in stock, sent to auction, sold for cash.
  for (const v of vehicles) {
    if (!free.has(v.id)) continue;
    const status = info.get(v.dealer_id).status;
    if (status === 'prospect') {
      v.status = 'in_stock';
      v.received_on = toDay(daysAgo(int(1, 12)));
      continue;
    }
    v.received_on ??= toDay(daysAgo(int(1, 120)));
    const next = weighted([
      ['listed', 80],
      ['in_stock', 9],
      ['wholesale', 4],
      ['sold', 7],
    ]);
    v.status = status === 'on_hold' && next === 'listed' && chance(0.3) ? 'in_stock' : next;
    if (v.status === 'in_stock') {
      v.received_on = toDay(daysAgo(int(0, 6)));
      v.listed_on = null;
    } else v.listed_on ??= toDay(Math.min(Date.parse(v.received_on) + int(2, 6) * DAY, TODAY));
    if (v.status === 'sold') v.sold_on = toDay(Math.min(Date.parse(v.listed_on) + int(5, 60) * DAY, daysAgo(1)));
  }
  for (const v of vehicles) {
    if (v.status !== 'listed' && v.status !== 'pending') continue;
    v.description = `${v.condition === 'new' ? 'New' : v.condition === 'certified' ? 'Certified pre-owned' : 'Pre-owned'} ${v.year} ${v.make} ${v.model} ${v.trim} in ${v.exterior_color.toLowerCase()} with a ${v.interior_color.toLowerCase()} interior. ${v.mileage.toLocaleString('en-US')} miles, ${v.drivetrain.toUpperCase()}, ${v.fuel}.`;
    v.features = FEATURES.map((f) => [f, rand()])
      .sort((a, b) => a[1] - b[1])
      .slice(0, int(3, 7))
      .map(([f]) => f)
      .sort()
      .join('\n');
    // The advertised payment: 10% down over 72 months at the Prime rate.
    v.est_payment = fixed2(amortize(Number(v.list_price) * 0.9, 7.49, 72).payment);
  }
  // Each active dealer features its four newest listings.
  for (const id of active) {
    vehicles
      .filter((v) => v.dealer_id === id && v.status === 'listed')
      .sort((a, b) => b.listed_on.localeCompare(a.listed_on) || a.id.localeCompare(b.id))
      .slice(0, 4)
      .forEach((v) => {
        v.featured = true;
      });
  }

  // Apply forms the server could not place: the lender's triage.
  const intake = [];
  for (let n = 0; n < 6; n++) {
    const first = pick(FIRST),
      last = pick(LAST);
    const created = TODAY - int(0, 20) * DAY;
    const status = n < 2 ? 'open' : n < 4 ? 'followed_up' : 'closed';
    intake.push({
      id: `intake-${n + 1}`,
      reference: `KI-${7001 + n}`,
      status,
      first_name: first,
      last_name: last,
      email: emailFor(first, last),
      phone: phone(pick(['717', '412', '610'])),
      street: `${int(10, 9800)} ${pick(STREETS)} St`,
      city: pick(['Harrisburg', 'York', 'Reading', 'Altoona']),
      state: 'PA',
      zip: `17${String(int(0, 999)).padStart(3, '0')}`,
      employer: pick(EMPLOYERS),
      monthly_income: fixed2(int(30, 90) * 100),
      vehicle_interest: pick(['A used SUV under $25,000', 'Something reliable for commuting', 'A pickup truck']),
      dealer_hint: pick(['Saw an ad for a dealer near York', 'The Ford dealer on Jonestown Rd', null]),
      created_at: moment(created, workMinutes()),
      closed_at: status === 'closed' ? moment(Math.min(created + int(1, 5) * DAY, TODAY - 3600_000), 0) : null,
      outcome_note:
        status === 'closed'
          ? 'Sent the applicant the Liberty Ford apply link; they applied there.'
          : status === 'followed_up'
            ? 'Emailed to ask which dealer they are working with.'
            : null,
      resume_token_hash: null,
      resume_expires_at: null,
      resume_progress: null,
      version: 0,
    });
  }

  /* ---------- servicing: customers, loans, schedules, payments ---------- */

  funded.sort((a, b) => a.fundedOn - b.fundedOn || a.app.reference.localeCompare(b.app.reference));
  const customers = [],
    loans = [],
    installments = [],
    payments = [],
    autopays = [],
    quotes = [],
    documents = [],
    servicingNotes = [];
  let loanSeq = 200000,
    paymentSeq = 5000000;
  const servicers = staff('servicing');
  const repeatPool = [];

  for (const { app, applicant, vehicle, dealerId, fundedOn, score } of funded) {
    // A few borrowers come back for a second car: one customer, two applicants.
    let customer = repeatPool.length > 3 && chance(0.04) ? repeatPool.splice(int(0, repeatPool.length - 1), 1)[0] : null;
    if (!customer) {
      customer = {
        id: customers.length + 1,
        applicant_id: applicant.id,
        account_id: null,
        first_name: applicant.first_name,
        last_name: applicant.last_name,
        email: applicant.email,
        phone: applicant.phone,
        street: applicant.street,
        city: applicant.city,
        state: applicant.state,
        zip: applicant.zip,
        paperless: chance(0.7),
        preferred_contact: weighted([
          ['email', 6],
          ['phone', 2],
          ['text', 3],
        ]),
        customer_since: toDay(fundedOn),
        version: 0,
      };
      customers.push(customer);
      if (fundedOn < daysAgo(200)) repeatPool.push(customer);
    }
    const principal = Number(app.approved_amount),
      apr = Number(app.approved_apr),
      term = app.approved_term;
    const { payment, rows } = amortize(principal, apr, term);
    const dueDay = Math.min(28, new Date(fundedOn).getUTCDate());
    const firstDue = addMonths(fundedOn, 1, dueDay);
    const dueOn = (n) => addMonths(firstDue, n - 1, dueDay);
    const pastDues = rows.filter((r) => dueOn(r.n) < TODAY).length;
    const age = TODAY - fundedOn;
    const profile =
      age > 420 * DAY && chance(0.12)
        ? 'paid_off'
        : age > 400 * DAY && loans.filter((l) => l.status === 'charged_off').length < 3 && chance(0.03)
          ? 'charged_off'
          : pastDues >= 3 && chance(score < 620 ? 0.2 : 0.06)
            ? 'delinquent'
            : pastDues >= 1 && chance(score < 640 ? 0.16 : 0.06)
              ? 'past_due'
              : 'current';
    const hasAutopay = chance(0.55);
    const loan = {
      id: loans.length + 1,
      loan_number: `KL-${++loanSeq}`,
      application_id: app.id,
      customer_id: customer.id,
      dealer_id: dealerId,
      vehicle_description: `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}`,
      vin: vehicle.vin,
      principal: fixed2(principal),
      apr: apr.toFixed(3),
      term_months: term,
      payment_amount: fixed2(payment),
      funded_on: toDay(fundedOn),
      first_due_on: toDay(firstDue),
      maturity_on: toDay(dueOn(term)),
      principal_balance: '0.00',
      interest_paid: '0.00',
      next_due_on: null,
      amount_due: '0.00',
      days_past_due: 0,
      status: 'current',
      paid_off_on: null,
      charged_off_on: null,
      version: 0,
    };
    loans.push(loan);

    let stopAt = Infinity,
      payoffAfter = null;
    if (profile === 'delinquent') stopAt = pastDues - int(2, Math.min(4, pastDues)) + 1;
    if (profile === 'past_due') stopAt = pastDues;
    if (profile === 'charged_off') stopAt = Math.max(2, rows.filter((r) => dueOn(r.n) + 150 * DAY < TODAY).length - int(0, 3));
    if (profile === 'paid_off') payoffAfter = int(Math.min(6, pastDues - 1), pastDues - 1);
    let balance = principal,
      interestPaid = 0,
      lastPaidDue = fundedOn,
      closed = false;
    const post = (row) => payments.push({ id: 0, customer_id: customer.id, loan_id: loan.id, reference: `PMT-${++paymentSeq}`, ...row });
    for (const row of rows) {
      const due = dueOn(row.n);
      const inst = {
        id: 0,
        customer_id: customer.id,
        loan_id: loan.id,
        number: row.n,
        due_on: toDay(due),
        amount: fixed2(row.amount),
        principal: fixed2(row.principal),
        interest: fixed2(row.interest),
        status: 'upcoming',
        paid_on: null,
      };
      installments.push(inst);
      if (closed) {
        inst.status = 'closed';
        continue;
      }
      if (payoffAfter !== null && row.n > payoffAfter) {
        const payoffDay = Math.min(lastPaidDue + int(3, 25) * DAY, TODAY - DAY);
        const perDiem = money((balance * apr) / 36500);
        const accrued = money(perDiem * Math.round((payoffDay - lastPaidDue) / DAY));
        post({
          received_on: toDay(payoffDay),
          amount: fixed2(balance + accrued),
          principal: fixed2(balance),
          interest: fixed2(accrued),
          late_fee: '0.00',
          method: pick(['ach', 'check']),
          channel: pick(['customer_portal', 'mail', 'phone']),
          status: 'posted',
          returned_reason: null,
        });
        quotes.push({
          id: 0,
          customer_id: customer.id,
          loan_id: loan.id,
          requested_on: toDay(payoffDay - int(2, 8) * DAY),
          good_through: toDay(payoffDay + int(2, 8) * DAY),
          amount: fixed2(balance + accrued + perDiem * 5),
          per_diem: fixed2(perDiem),
          requested_via: pick(['customer_portal', 'phone', 'dealer']),
          status: 'paid',
          version: 0,
        });
        interestPaid += accrued;
        balance = 0;
        loan.status = 'paid_off';
        loan.paid_off_on = toDay(payoffDay);
        inst.status = 'closed';
        closed = true;
        continue;
      }
      if (due >= TODAY) continue;
      if (row.n >= stopAt) {
        if (profile === 'charged_off' && row.n > stopAt && dueOn(stopAt) + 120 * DAY < TODAY) {
          loan.status = 'charged_off';
          loan.charged_off_on = toDay(dueOn(stopAt) + 120 * DAY);
          closed = true;
        }
        inst.status = 'past_due';
        continue;
      }
      // Paid: on the draft day by autopay; by hand usually on time, sometimes late with a fee.
      const recent = due > TODAY - 25 * DAY;
      const late = !hasAutopay && !recent && chance(score < 640 ? 0.18 : 0.06);
      const paidOn = hasAutopay ? due : late ? due + int(11, 20) * DAY : due - int(0, 6) * DAY;
      if (hasAutopay && !recent && chance(0.012)) {
        post({
          received_on: toDay(due),
          amount: fixed2(row.amount),
          principal: '0.00',
          interest: '0.00',
          late_fee: '0.00',
          method: 'autopay',
          channel: 'autopay',
          status: 'returned',
          returned_reason: 'Insufficient funds (R01)',
        });
        const retry = due + int(4, 9) * DAY;
        post({
          received_on: toDay(retry),
          amount: fixed2(row.amount + 25),
          principal: fixed2(row.principal),
          interest: fixed2(row.interest),
          late_fee: '25.00',
          method: 'ach',
          channel: 'phone',
          status: 'posted',
          returned_reason: null,
        });
        inst.paid_on = toDay(retry);
      } else {
        post({
          received_on: toDay(paidOn),
          amount: fixed2(row.amount + (late ? 25 : 0)),
          principal: fixed2(row.principal),
          interest: fixed2(row.interest),
          late_fee: late ? '25.00' : '0.00',
          method: hasAutopay
            ? 'autopay'
            : weighted([
                ['ach', 5],
                ['card', 3],
                ['check', 2],
              ]),
          channel: hasAutopay ? 'autopay' : pick(['customer_portal', 'customer_portal', 'phone', 'mail']),
          status: 'posted',
          returned_reason: null,
        });
        inst.paid_on = toDay(paidOn);
      }
      inst.status = 'paid';
      balance = money(balance - row.principal);
      interestPaid += row.interest;
      lastPaidDue = due;
    }
    const mine = installments.filter((i) => i.loan_id === loan.id);
    if (loan.status === 'charged_off') {
      for (const inst of mine) if (inst.status === 'past_due' || inst.status === 'upcoming') inst.status = 'closed';
    } else if (loan.status !== 'paid_off') {
      const unpaid = mine.filter((i) => i.status === 'past_due');
      const next = mine.find((i) => i.status === 'upcoming');
      if (next) next.status = 'due';
      const oldest = unpaid[0];
      loan.days_past_due = oldest ? Math.round((TODAY - Date.parse(oldest.due_on)) / DAY) : 0;
      loan.status = loan.days_past_due >= 30 ? 'delinquent' : loan.days_past_due > 0 ? 'past_due' : 'current';
      loan.next_due_on = (oldest ?? next)?.due_on ?? null;
      loan.amount_due = fixed2(unpaid.reduce((sum, i) => sum + Number(i.amount), 0) + (next ? Number(next.amount) : 0));
      // Someone behind who has just paid online: pending until it posts.
      if (unpaid.length && chance(0.3)) {
        post({
          received_on: toDay(TODAY - DAY),
          amount: unpaid[0].amount,
          principal: '0.00',
          interest: '0.00',
          late_fee: '0.00',
          method: 'card',
          channel: 'customer_portal',
          status: 'pending',
          returned_reason: null,
        });
      }
    }
    loan.principal_balance = fixed2(Math.max(0, balance));
    loan.interest_paid = fixed2(interestPaid);

    if (hasAutopay) {
      const cancelled = loan.status === 'paid_off' || loan.status === 'charged_off' || (profile !== 'current' && chance(0.5));
      autopays.push({
        id: 0,
        customer_id: customer.id,
        loan_id: loan.id,
        bank_name: pick(['PNC Bank', 'Wells Fargo', 'Citizens Bank', 'M&T Bank', 'Fulton Bank', 'PSECU', 'Chase', 'Truist']),
        account_type: chance(0.9) ? 'checking' : 'savings',
        account_last4: String(int(0, 9999)).padStart(4, '0'),
        draft_day: dueDay,
        status: cancelled ? 'cancelled' : chance(0.05) ? 'paused' : 'active',
        enrolled_on: toDay(fundedOn + int(0, 20) * DAY),
        cancelled_on: cancelled ? (loan.paid_off_on ?? loan.charged_off_on ?? toDay(TODAY - int(10, 60) * DAY)) : null,
        version: 0,
      });
    }
    if (['current', 'past_due'].includes(loan.status) && chance(0.1)) {
      const asked = TODAY - int(0, 40) * DAY;
      const perDiem = money((Number(loan.principal_balance) * apr) / 36500);
      quotes.push({
        id: 0,
        customer_id: customer.id,
        loan_id: loan.id,
        requested_on: toDay(asked),
        good_through: toDay(asked + 10 * DAY),
        amount: fixed2(Number(loan.principal_balance) + perDiem * 10),
        per_diem: fixed2(perDiem),
        requested_via: pick(['customer_portal', 'customer_portal', 'phone', 'dealer']),
        status: asked + 10 * DAY >= TODAY ? 'issued' : 'expired',
        version: 0,
      });
    }
    // Documents.
    const who = `${customer.first_name} ${customer.last_name}`;
    const doc = (kind, title, issued, lines) => {
      const data = onePagePdf(title, [who, `Loan ${loan.loan_number}`, `${loan.vehicle_description}, VIN ${loan.vin}`, '', ...lines]);
      documents.push({
        id: 0,
        customer_id: customer.id,
        loan_id: loan.id,
        kind,
        title,
        issued_on: toDay(issued),
        file_name: `${loan.loan_number.toLowerCase()}-${kind.replace(/_/g, '-')}-${toDay(issued)}.pdf`,
        content_type: 'application/pdf',
        byte_size: data.byteLength,
        data,
      });
    };
    const dealerName = info.get(dealerId).name;
    doc('contract', 'Retail installment contract', fundedOn, [
      `Amount financed $${loan.principal}`,
      `APR ${apr.toFixed(2)}%`,
      `${term} monthly payments of $${loan.payment_amount}`,
      `First payment due ${loan.first_due_on}`,
      `Sold by ${dealerName}`,
    ]);
    doc('truth_in_lending', 'Truth in Lending disclosure', fundedOn, [
      `Annual percentage rate ${apr.toFixed(2)}%`,
      `Finance charge $${fixed2(rows.reduce((s, r) => s + r.interest, 0))}`,
      `Amount financed $${loan.principal}`,
      `Total of payments $${fixed2(rows.reduce((s, r) => s + r.amount, 0))}`,
    ]);
    doc('welcome_letter', 'Welcome to Keystone Auto Finance', fundedOn + 2 * DAY, [
      `Your first payment of $${loan.payment_amount} is due ${loan.first_due_on}.`,
      'Sign in to your account to set up autopay, see your balance and download documents.',
    ]);
    if (['current', 'past_due', 'delinquent'].includes(loan.status)) {
      for (let m = 2; m >= 0; m--) {
        const first = addMonths(TODAY, -m, 1);
        if (first <= fundedOn) continue;
        doc(
          'statement',
          `Statement for ${new Date(first).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
          first,
          [`Principal balance $${loan.principal_balance}`, `Payment amount $${loan.payment_amount}`, `Next due ${loan.next_due_on ?? '-'}`],
        );
      }
    }
    if (loan.status === 'paid_off') {
      doc('payoff_letter', 'Paid-in-full letter', Date.parse(loan.paid_off_on) + 3 * DAY, ['Your loan is paid in full. Thank you.']);
      doc('title_release', 'Lien release', Date.parse(loan.paid_off_on) + 10 * DAY, [
        `Keystone Auto Finance releases its lien on VIN ${loan.vin}.`,
      ]);
    }
    // Servicing's notes on the loans that need them.
    const noteCount =
      loan.status === 'delinquent'
        ? int(2, 4)
        : loan.status === 'charged_off'
          ? 4
          : loan.status === 'past_due'
            ? int(1, 2)
            : chance(0.08)
              ? 1
              : 0;
    for (let n = 0; n < noteCount; n++) {
      const when = loan.status === 'charged_off' ? Date.parse(loan.charged_off_on) - (4 - n) * 20 * DAY : TODAY - int(1, 25) * DAY;
      const kind =
        loan.status === 'current' ? pick(['call', 'email', 'note']) : pick(['call', 'call', 'promise_to_pay', 'email', 'hardship']);
      servicingNotes.push({
        id: 0,
        loan_id: loan.id,
        author_id: pick(servicers).id,
        created_at: moment(when, workMinutes()),
        kind,
        body:
          kind === 'promise_to_pay'
            ? 'Customer promised to pay the past-due amount on payday.'
            : kind === 'hardship'
              ? 'Customer reports reduced hours at work; discussed a due-date change.'
              : kind === 'call'
                ? pick([
                    'Left voicemail about the past-due installment.',
                    'Spoke with customer; payment going out this week.',
                    'No answer; number rings through.',
                  ])
                : kind === 'email'
                  ? 'Sent a past-due reminder with a link to pay online.'
                  : 'Customer asked how to add a co-borrower; referred to the dealer.',
        promise_amount: kind === 'promise_to_pay' ? loan.amount_due : null,
        promise_on: kind === 'promise_to_pay' ? toDay(Math.max(when + int(3, 10) * DAY, TODAY + int(1, 7) * DAY)) : null,
      });
    }
  }

  /* ---------- the marketplace ---------- */

  const prequals = [];
  const marketLeads = leads.filter((l) => l.source === 'marketplace' && ['new', 'contacted'].includes(l.status));
  const listed = vehicles.filter((v) => v.status === 'listed');
  const advertised = programs.filter((p) => p.advertised);
  for (let n = 0; n < 120; n++) {
    const first = pick(FIRST),
      last = pick(LAST);
    const band = weighted([
      ['excellent', 3],
      ['good', 5],
      ['fair', 4],
      ['rebuilding', 2],
      ['unsure', 2],
    ]);
    const income = int(28, 140) * 100;
    const payment = Math.round((income * (0.08 + rand() * 0.07)) / 10) * 10;
    const created = TODAY - int(0, 90) * DAY;
    const matched =
      band === 'rebuilding' && chance(0.5)
        ? null
        : ({ excellent: advertised[0], good: advertised[1], fair: advertised[2] }[band] ?? advertised[3]);
    const age = (TODAY - created) / DAY;
    const lead = matched && age < 30 && chance(0.35) ? (marketLeads.shift() ?? null) : null;
    const status = lead ? 'sent_to_dealer' : !matched ? 'no_match' : age > 60 ? 'expired' : chance(0.3) ? 'new' : 'matched';
    const perDollar = matched ? amortize(1, Number(matched.base_apr), 72).payment : 0;
    const estimate = matched ? Math.min(Number(matched.max_amount), Math.floor(payment / perDollar / 500) * 500) : null;
    prequals.push({
      id: 0,
      reference: '',
      first_name: lead?.first_name ?? first,
      last_name: lead?.last_name ?? last,
      email: lead?.email ?? emailFor(first, last),
      phone: chance(0.6) ? phone(pick(['717', '412', '610', '215', '814'])) : null,
      zip: pick(dealers).zip,
      credit_band: band,
      monthly_income: fixed2(income),
      desired_payment: fixed2(payment),
      vehicle_id: lead?.vehicle_id ?? (chance(0.6) ? pick(listed).id : null),
      program_id: matched?.id ?? null,
      estimated_amount: matched ? fixed2(estimate) : null,
      estimated_apr: matched?.base_apr ?? null,
      status,
      lead_id: lead?.id ?? null,
      account_id: null,
      created_at: moment(created, workMinutes()),
      version: 0,
    });
  }
  prequals.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.email.localeCompare(b.email));
  prequals.forEach((p, i) => {
    p.id = i + 1;
    p.reference = `PQ-${30001 + i}`;
  });

  /* ---------- numbering ---------- */

  const number = (rows) =>
    rows.forEach((row, i) => {
      row.id = i + 1;
    });
  uwNotes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.application_id.localeCompare(b.application_id));
  servicingNotes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.loan_id - b.loan_id);
  payments.sort((a, b) => a.received_on.localeCompare(b.received_on) || a.reference.localeCompare(b.reference));
  for (const rows of [uwNotes, alerts, fundings, installments, payments, autopays, quotes, documents, servicingNotes]) number(rows);

  return {
    today: todayIso,
    tables: [
      ['lender_user', lenderUsers],
      ['dealer', dealers],
      ['dealer_visit', visits],
      ['program', programs],
      ['dealer_site', sites],
      ['dealer_user', dealerUsers],
      ['vehicle', vehicles],
      ['lead', leads],
      ['lead_activity', activity],
      ['applicant', applicants],
      ['deal', deals],
      ['trade_in', tradeIns],
      ['deal_scenario', scenarios],
      ['loan_application', applications],
      ['stipulation', stips],
      ['underwriting_file', files],
      ['underwriting_note', uwNotes],
      ['decision_alert', alerts],
      ['funding', fundings],
      ['intake_submission', intake],
      ['customer', customers],
      ['loan', loans],
      ['installment', installments],
      ['payment', payments],
      ['autopay', autopays],
      ['payoff_quote', quotes],
      ['loan_document', documents],
      ['servicing_note', servicingNotes],
      ['prequalification', prequals],
      ['saved_vehicle', []],
    ],
  };
}
