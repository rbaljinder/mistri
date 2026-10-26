/**
 * The Forecourt marketplace: made-up US dealers selling real makes and
 * models, each car on the lot with its photograph, and the sales desk
 * (desk.mjs): forty cars sold over six months and twelve weeks of inquiries
 * with their stages and conversations. Dated back from today, or
 * from FORECOURT_TODAY=YYYY-MM-DD, which makes the same file every time.
 *
 * The photographs are photos/ (photoSource.mjs): public-domain pictures, one
 * of each model the lot sells, which the catalog is drawn from so every car
 * looks like its listing, and the front page's hero. Without
 * photos/manifest.json every car is drawn instead by photos.mjs, three or
 * four studio renders each.
 *
 *   node --import tsx test/fixtures/databases/forecourt/seed.mjs <new-file.db>
 *
 * The schema is the migrations beside this file (migrations/V1__…sql),
 * applied as `tablewalk migrate up` applies them; the seed then writes the
 * rows. Writes the database and `<file>.json`, a writable connection named
 * `forecourt` that also says where its migrations are, so `tablewalk migrate
 * status --config <file>.json` answers: the inquiry form's command writes
 * through it, and the App's grants keep every other write off. The command
 * journal the form needs is migrated into the new file at once. Refuses an
 * existing file or config.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';
import { applyMigrations } from '@mistriwork/mistri/maintenance';
import { DEALER_RATINGS, deskRows, listingDetails } from './desk.mjs';
import { photoSource } from './photoSource.mjs';

/* A tiny deterministic generator, so every seed is the same marketplace. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const rand = random(20260912);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

/* 555-0100 to 555-0199 are reserved for fiction, and example.test addresses reach nobody. */
const DEALERS = [
  {
    name: 'Harborside Motors',
    city: 'Portland, OR',
    phone: '(503) 555-0142',
    lighting: 'gallery',
    about: 'A family-run lot by the harbor, selling hand-picked hatchbacks and wagons since 1998.',
  },
  {
    name: 'Northgate Cars',
    city: 'Columbus, OH',
    phone: '(614) 555-0188',
    lighting: 'gallery',
    about: 'Nearly new cars with the rest of their factory warranty, and a service center on site.',
  },
  {
    name: 'Riverside Autos',
    city: 'Sacramento, CA',
    phone: '(916) 555-0115',
    lighting: 'gallery',
    about: 'Hybrids and electric cars, each battery health-checked before it goes on sale.',
  },
  {
    name: 'Kingsway Auto Center',
    city: 'Denver, CO',
    phone: '(720) 555-0120',
    lighting: 'gallery',
    about: 'SUVs, pickups and vans for work and weekends, with financing arranged in-house.',
  },
  {
    name: 'Meadow Lane Motors',
    city: 'Raleigh, NC',
    phone: '(919) 555-0117',
    lighting: 'gallery',
    about: 'Affordable cars for first-time buyers, every one with a year of roadside assistance.',
  },
  {
    name: 'Castle Hill Vehicles',
    city: 'Boston, MA',
    phone: '(617) 555-0177',
    lighting: 'gallery',
    about: 'Performance and luxury cars, prepared in our own detailing studio.',
  },
];

/* What the dealers sell, as sold in the US: make, model, body, the engines
   it came with, a trim or two, fuel, transmission, drive, roughly its
   sticker price new. */
const MODELS = [
  [
    'Toyota',
    'Corolla',
    'Sedan',
    [
      ['2.0', 'Gas', 'Automatic'],
      ['1.8 Hybrid', 'Hybrid', 'Automatic'],
    ],
    ['LE', 'SE', 'XSE'],
    'FWD',
    24000,
  ],
  ['Toyota', 'Camry', 'Sedan', [['2.5 Hybrid', 'Hybrid', 'Automatic']], ['LE', 'SE', 'XLE'], 'FWD', 30000],
  [
    'Toyota',
    'RAV4',
    'SUV',
    [
      ['2.5', 'Gas', 'Automatic'],
      ['2.5 Hybrid', 'Hybrid', 'Automatic'],
    ],
    ['XLE', 'Limited'],
    'AWD',
    34000,
  ],
  [
    'Ford',
    'F-150',
    'Pickup',
    [
      ['2.7 EcoBoost', 'Gas', 'Automatic'],
      ['3.5 PowerBoost', 'Hybrid', 'Automatic'],
    ],
    ['XLT', 'Lariat'],
    'AWD',
    48000,
  ],
  [
    'Ford',
    'Escape',
    'SUV',
    [
      ['1.5 EcoBoost', 'Gas', 'Automatic'],
      ['2.5 Hybrid', 'Hybrid', 'Automatic'],
    ],
    ['Active', 'ST-Line'],
    'FWD',
    30000,
  ],
  ['Ford', 'Ranger', 'Pickup', [['2.3 EcoBoost', 'Gas', 'Automatic']], ['XLT', 'Lariat'], 'AWD', 36000],
  ['Ford', 'Transit Connect', 'Van', [['2.0', 'Gas', 'Automatic']], ['XL', 'XLT'], 'FWD', 32000],
  [
    'Ford',
    'Mustang',
    'Coupe',
    [
      ['2.3 EcoBoost', 'Gas', 'Automatic'],
      ['5.0 V8', 'Gas', 'Manual'],
    ],
    ['EcoBoost', 'GT'],
    'RWD',
    38000,
  ],
  ['Volkswagen', 'Golf GTI', 'Hatchback', [['2.0 TSI', 'Gas', 'Manual']], ['S', 'SE', 'Autobahn'], 'FWD', 32000],
  ['Volkswagen', 'Jetta', 'Sedan', [['1.5 TSI', 'Gas', 'Automatic']], ['S', 'SE', 'SEL'], 'FWD', 23000],
  ['Volkswagen', 'Tiguan', 'SUV', [['2.0 TSI', 'Gas', 'Automatic']], ['SE', 'SEL'], 'AWD', 32000],
  ['Subaru', 'Outback', 'Wagon', [['2.5', 'Gas', 'Automatic']], ['Premium', 'Limited', 'Touring'], 'AWD', 33000],
  [
    'Honda',
    'Civic',
    'Hatchback',
    [
      ['2.0', 'Gas', 'Automatic'],
      ['2.0 Hybrid', 'Hybrid', 'Automatic'],
    ],
    ['Sport', 'EX-L', 'Touring'],
    'FWD',
    28000,
  ],
  [
    'Honda',
    'CR-V',
    'SUV',
    [
      ['1.5 Turbo', 'Gas', 'Automatic'],
      ['2.0 Hybrid', 'Hybrid', 'Automatic'],
    ],
    ['EX', 'EX-L', 'Sport Touring'],
    'AWD',
    33000,
  ],
  ['Honda', 'Fit', 'Hatchback', [['1.5', 'Gas', 'Automatic']], ['LX', 'EX'], 'FWD', 18000],
  ['Nissan', 'Rogue', 'SUV', [['1.5 VC-Turbo', 'Gas', 'Automatic']], ['S', 'SV', 'SL'], 'AWD', 30000],
  ['Nissan', 'Leaf', 'Hatchback', [['40 kWh', 'Electric', 'Automatic']], ['S', 'SV Plus'], 'FWD', 30000],
  ['Kia', 'Sportage', 'SUV', [['1.6T Hybrid', 'Hybrid', 'Automatic']], ['LX', 'EX', 'SX'], 'AWD', 31000],
  ['Kia', 'Niro EV', 'SUV', [['64.8 kWh', 'Electric', 'Automatic']], ['Wind', 'Wave'], 'FWD', 40000],
  ['Hyundai', 'Tucson', 'SUV', [['1.6T Hybrid', 'Hybrid', 'Automatic']], ['SEL', 'Limited'], 'AWD', 33000],
  ['Hyundai', 'Ioniq 5', 'SUV', [['77.4 kWh', 'Electric', 'Automatic']], ['SE', 'SEL', 'Limited'], 'RWD', 45000],
  ['BMW', '3 Series', 'Sedan', [['330i', 'Gas', 'Automatic']], ['Sport', 'M Sport'], 'RWD', 45000],
  ['BMW', '4 Series', 'Coupe', [['430i', 'Gas', 'Automatic']], ['M Sport'], 'RWD', 50000],
  ['Mercedes-Benz', 'C-Class', 'Sedan', [['C 300', 'Gas', 'Automatic']], ['Premium', 'AMG Line'], 'RWD', 47000],
  ['Audi', 'A3', 'Sedan', [['40 TFSI', 'Gas', 'Automatic']], ['Premium', 'Premium Plus'], 'FWD', 36000],
  ['Audi', 'A4 allroad', 'Wagon', [['45 TFSI', 'Gas', 'Automatic']], ['Premium', 'Premium Plus'], 'AWD', 47000],
  ['Mazda', 'CX-5', 'SUV', [['2.5', 'Gas', 'Automatic']], ['Select', 'Preferred', 'Turbo'], 'AWD', 30000],
  ['Mazda', 'MX-5 Miata', 'Coupe', [['2.0', 'Gas', 'Manual']], ['Sport', 'Club', 'Grand Touring'], 'RWD', 30000],
  ['Tesla', 'Model 3', 'Sedan', [['Dual Motor', 'Electric', 'Automatic']], ['Long Range', 'Performance'], 'AWD', 47000],
  ['Tesla', 'Model Y', 'SUV', [['Dual Motor', 'Electric', 'Automatic']], ['Long Range', 'Performance'], 'AWD', 50000],
  ['Chevrolet', 'Equinox', 'SUV', [['1.5 Turbo', 'Gas', 'Automatic']], ['LT', 'RS', 'Premier'], 'FWD', 29000],
  [
    'Chevrolet',
    'Silverado 1500',
    'Pickup',
    [
      ['5.3 V8', 'Gas', 'Automatic'],
      ['3.0 Duramax', 'Diesel', 'Automatic'],
    ],
    ['LT', 'RST', 'LTZ'],
    'AWD',
    50000,
  ],
  [
    'Jeep',
    'Wrangler',
    'SUV',
    [
      ['2.0 Turbo', 'Gas', 'Automatic'],
      ['4xe Plug-in Hybrid', 'Hybrid', 'Automatic'],
    ],
    ['Sport', 'Sahara', 'Rubicon'],
    'AWD',
    42000,
  ],
  ['Volvo', 'XC60', 'SUV', [['B5 Mild Hybrid', 'Hybrid', 'Automatic']], ['Plus', 'Ultimate'], 'AWD', 48000],
  ['Mini', 'Cooper', 'Hatchback', [['1.5 Turbo', 'Gas', 'Manual']], ['Classic', 'Signature'], 'FWD', 26000],
];

const COLORS = ['White', 'Black', 'Silver', 'Gray', 'Blue', 'Red', 'Green', 'Orange', 'Beige', 'Navy', 'Teal'];
/* Which silhouette each body is drawn with: the renderer's own names. */
const SILHOUETTE = { Hatchback: 'hatchback', Sedan: 'saloon', Wagon: 'estate', SUV: 'suv', Coupe: 'coupe', Pickup: 'pickup', Van: 'van' };
const DOORS = { Hatchback: 5, Sedan: 4, Wagon: 5, SUV: 5, Coupe: 2, Pickup: 4, Van: 4 };
const SEATS = { Hatchback: 5, Sedan: 5, Wagon: 5, SUV: 5, Coupe: 4, Pickup: 5, Van: 2 };

const COMMON = [
  'Apple CarPlay and Android Auto',
  'SiriusXM satellite radio',
  'Bluetooth',
  'Air conditioning',
  'Alloy wheels',
  'Cruise control',
  'Rear parking sensors',
  'Lane keeping assist',
];
const UPPER = [
  'Adaptive cruise control',
  'Heated front seats',
  'Backup camera',
  'LED headlights',
  'Keyless entry',
  'Dual-zone climate control',
  'Wireless phone charging',
  'Blind spot monitoring',
  'Navigation',
  'Panoramic sunroof',
  'Heated steering wheel',
];
const BY_BODY = {
  SUV: ['Tow hitch', 'Roof rails', 'Power liftgate'],
  Wagon: ['Roof rails', 'Power liftgate'],
  Pickup: ['Tow package', 'Spray-in bedliner'],
  Van: ['Cargo area liner', 'Cargo partition'],
  Coupe: ['Sport seats'],
};
const BY_FUEL = { Electric: ['Heat pump', 'Level 2 charging cable', 'DC fast charging (CCS)'], Hybrid: ['Regenerative braking'] };

const HIGHLIGHTS = ['Just arrived', 'Price reduced', 'One owner', 'Low mileage', 'Full service records'];

/* The renderer's angles and what each photo is called. The mirrored side
   is the passenger's on a left-hand-drive car. */
const ANGLES = [
  ['three-quarter', 'Front three-quarter'],
  ['side', 'Driver-side profile'],
  ['rear-quarter', 'Rear three-quarter'],
  ['offside', 'Passenger-side profile'],
  ['detail', 'Wheel and lamp detail'],
];

/* The monthly estimate a car's page shows, on terms the page says out loud
   (vehicle.ts): 10% down, the rest over 60 months at 7.9% APR, before tax,
   title and registration. Whole dollars. */
export const ESTIMATE = { down: 0.1, months: 60, apr: 0.079 };
export function monthlyEstimate(price) {
  const principal = price * (1 - ESTIMATE.down);
  const rate = ESTIMATE.apr / 12;
  return Math.round((principal * rate) / (1 - (1 + rate) ** -ESTIMATE.months));
}

/* Dated back from today, so the desk's week and the lot's ages read as now;
   FORECOURT_TODAY=YYYY-MM-DD pins the day for a reproducible file. Today is
   New York's, the App's `ui.timezone`: its times are that wall clock, and a
   UTC day after 8 PM there wrote this evening's inquiries as tomorrow's. */
const DAY = process.env.FORECOURT_TODAY ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(DAY)) throw new Error('FORECOURT_TODAY is a day: YYYY-MM-DD.');
export const TODAY = new Date(`${DAY}T00:00:00Z`);
const isoDay = (date) => date.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return isoDay(d);
};

/* Depreciation as the used market prices it today: about 15% off the
   sticker in the first year, 9% a year after that, and up to a fifth more
   for the miles; rounded the way dealers price, to $495 or $995. */
export function askingPrice(newPrice, age, mileage) {
  const value = newPrice * 0.85 * 0.91 ** Math.max(0, age - 1) * (1 - Math.min(0.2, mileage / 500000));
  return Math.max(5995, Math.round(value / 500) * 500 - 5);
}

/* The photos, and with them the range: a photo set (photoSource.mjs) lists
   only the models it pictures, each in a colour it was shot in. */
const PHOTOS = photoSource();
const RANGE = PHOTOS.pictures ? MODELS.filter(([make, model]) => PHOTOS.pictures.has(`${make}|${model}`)) : MODELS;
for (const [key, [shot]] of PHOTOS.pictures ?? []) {
  const listed = MODELS.find(([make, model]) => `${make}|${model}` === key);
  if (!listed) throw new Error(`photos/manifest.json pictures a ${shot.make} ${shot.model}, which the seed does not sell.`);
  if (listed[2] !== shot.body)
    throw new Error(`photos/manifest.json calls the ${shot.model} a ${shot.body}; the seed sells it as a ${listed[2]}.`);
}

function vehicles() {
  // Every model once, then the rest of the sixty drawn from the range.
  return Array.from({ length: 60 }, (_, i) => drawCar(i, rand));
}

/* One car, the catalog's way, from generator `r`: the sixty above from the
   seed's own, the desk's sold cars (desk.mjs) from its. Car `i` past the
   sixty is sold. */
function drawCar(i, r) {
  const pick = (list) => list[Math.floor(r() * list.length)];
  const between = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const rand = r;
  {
    const [make, model, body, engines, trims, drive, newPrice] = RANGE[i < RANGE.length ? i : between(0, RANGE.length - 1)];
    const [engine, fuel, transmission] = pick(engines);
    const trim = pick(trims);
    /* A photographed model is listed in the years its picture passes for. */
    const shots = PHOTOS.pictures?.get(`${make}|${model}`);
    const [first, last] = shots?.[0].years ?? [2016, 2025];
    const year = between(first, last);
    const age = 2026 - year;
    const mileage = Math.max(900, Math.round((age * between(8000, 13500) + between(0, 4000)) / 10) * 10);
    const price = askingPrice(newPrice, age, mileage);
    const drawn = pick(COLORS);
    const color = shots ? (shots.find((shot) => shot.colour === drawn) ?? shots[0]).colour : drawn;
    const dealer = (i * 7 + 3) % DEALERS.length;
    const features = [
      ...COMMON.filter(() => rand() > 0.35),
      ...UPPER.filter(() => rand() > (trim === trims.at(-1) ? 0.35 : 0.7)),
      ...(BY_BODY[body] ?? []).filter(() => rand() > 0.3),
      ...(BY_FUEL[fuel] ?? []),
    ];
    const owners = age <= 2 ? 1 : between(1, 3);
    const status = i >= 60 ? 'sold' : i % 11 === 5 ? 'reserved' : i % 13 === 7 ? 'sold' : 'listed';
    /* Drawn in the order the description always drew them, so the rest of
       the marketplace comes out exactly as before: the history is stored now
       as well as told. */
    const highlight = status === 'listed' && rand() > 0.55 ? (age <= 2 && mileage < 15000 ? 'Low mileage' : pick(HIGHLIGHTS)) : null;
    const serviceRecords = rand() > 0.3 ? 'Full' : 'Partial';
    const keys = between(1, 2);
    const batteryHealth = fuel === 'Electric' ? between(89, 97) : null;
    const warranty = between(3, 12);
    return {
      // Year, make, model and trim, as a listing says it; the engine is in the specs.
      id: i + 1,
      stock_ref: `FC-${1001 + i}`,
      title: `${year} ${make} ${model} ${trim}`,
      make,
      model,
      trim,
      engine,
      year,
      price,
      mileage,
      body_type: body,
      fuel,
      transmission,
      drivetrain: drive,
      color,
      doors: DOORS[body],
      seats: SEATS[body],
      owners,
      status,
      featured: i % 7 === 2 && status !== 'sold' ? 1 : 0,
      highlight,
      service_records: serviceRecords,
      keys,
      battery_health: batteryHealth,
      est_monthly: monthlyEstimate(price),
      description: [
        `${owners === 1 ? 'One owner since new' : `${owners} owners`}, with ${serviceRecords === 'Full' ? 'full service records' : 'service records up to date'} and ${keys} ${keys === 1 ? 'key' : 'keys'}.`,
        `This ${color.toLowerCase()} ${model} ${trim} has ${mileage.toLocaleString('en-US')} miles on it${batteryHealth ? ` and its battery was health-checked at ${batteryHealth}%` : ''}.`,
        `${DEALERS[dealer].name} has prepared it with a fresh ${fuel === 'Electric' ? 'inspection' : 'service'} and a ${warranty}-month warranty.`,
      ].join(' '),
      features: [...new Set(features)].join('\n'),
      listed_on: daysAgo((i * 5 + 1) % 45),
      dealer_id: dealer + 1,
      silhouette: SILHOUETTE[body],
      lighting: DEALERS[dealer].lighting,
    };
  }
}

/* The three questions the marketplace has always opened with: the car, who asked, what, its status, its topic. */
const OPENING_INQUIRIES = [
  [3, 'Priya Shah', 'Is it still available for a test drive this Saturday?', 'new', 'test_drive'],
  [11, 'Tom Hughes', 'Would you take my 2015 Civic as a trade-in?', 'replied', 'trade_in'],
  [24, 'Alex Morgan', 'What financing do you offer on this one?', 'new', 'financing'],
];

const MIGRATIONS = fileURLToPath(new URL('./migrations/', import.meta.url));

/** The tables in foreign-key order, as both seeds write them. */
export const TABLES = ['dealer', 'vehicle', 'vehicle_photo', 'site_image', 'inquiry', 'inquiry_message'];

/**
 * Every row of the marketplace, table by table, with its id: what seed()
 * writes into SQLite and seed-postgres.mjs into PostgreSQL. Flags are 0 or 1
 * and photos Buffers; each seed dresses them for its engine.
 */
export function marketplace() {
  const rows = Object.fromEntries(TABLES.map((table) => [table, []]));
  DEALERS.forEach((d, i) => {
    const [rating, reviews] = DEALER_RATINGS[i];
    rows.dealer.push({
      id: i + 1,
      name: d.name,
      city: d.city,
      phone: d.phone,
      email: `sales@${d.name.toLowerCase().replace(/[^a-z]+/g, '-')}.example.test`,
      about: d.about,
      rating,
      reviews,
    });
  });
  /* The sixty cars on the lot, each with what a listing says beyond V1, then
     the desk (desk.mjs): forty cars already sold, and the inquiries. */
  const catalog = vehicles().map((v) => ({ ...v, ...listingDetails(v) }));
  const desk = deskRows({
    catalog,
    soldCar: (id, r) => {
      const car = drawCar(id - 1, r);
      return { ...car, ...listingDetails(car) };
    },
    today: TODAY,
    monthlyEstimate,
    firstId: OPENING_INQUIRIES.length + 1,
  });
  for (const v of [...catalog, ...desk.sold]) {
    rows.vehicle.push(Object.fromEntries(VEHICLE_COLUMNS.map((column) => [column, v[column] ?? null])));
    /* Three or four photos a car on the lot, always opening on the front
       three-quarter; a sold car keeps its lead photo for the desk's records.
       A drawn photo comes with its thumbnail, what a card and the gallery
       strip draw: a quarter of the pixels at about half the bytes. */
    let position = 0;
    for (const [angle, caption] of ANGLES.slice(0, v.id > catalog.length ? 1 : 3 + (v.id % 2))) {
      const shot = PHOTOS.photo(v, angle);
      if (!shot) continue;
      position += 1;
      rows.vehicle_photo.push({
        id: rows.vehicle_photo.length + 1,
        vehicle_id: v.id,
        position,
        caption: PHOTOS.manifest ? 'Exterior' : caption,
        file_name: `${v.stock_ref.toLowerCase()}-${position}-${angle}${shot.ext}`,
        content_type: shot.type,
        byte_size: shot.bytes.byteLength,
        data: shot.bytes,
        thumbnail: shot.thumb,
      });
    }
  }
  // The front page's photo: three cars in the studio, 16:7, or the photo set's own.
  const hero = PHOTOS.hero();
  rows.site_image.push({
    id: 1,
    name: 'Front page',
    file_name: `forecourt-front${hero.ext}`,
    content_type: hero.type,
    byte_size: hero.bytes.byteLength,
    data: hero.bytes,
  });
  /* The questions the marketplace opened with, then the desk's twelve weeks.
     Each inquiry's conversation starts with the buyer's own words. */
  const price = new Map(catalog.map((v) => [v.id, v.price]));
  const said = (inquiry_id, kind, author, body, sent_at) =>
    rows.inquiry_message.push({ id: rows.inquiry_message.length + 1, inquiry_id, kind, author, body, sent_at, account_id: null });
  OPENING_INQUIRIES.forEach(([id, name, text, status, topic], i) => {
    const received = `${daysAgo(3 - i)} 10:${10 + i * 7}:00`;
    rows.inquiry.push({
      id: i + 1,
      reference: `INQ-2026-${String(100231 + i * 7919).padStart(6, '0')}`,
      stock_ref: `FC-${1000 + id}`,
      vehicle_id: id,
      name,
      email: `${name.split(' ')[0].toLowerCase()}@example.test`,
      phone: null,
      message: text,
      received_at: received,
      status,
      stage: status === 'new' ? 'new' : 'contacted',
      topic,
      channel: 'web',
      owner: status === 'new' ? null : 'Luis Ortega',
      deal_value: price.get(id),
      test_drive_at: null,
      lost_reason: null,
      closed_on: null,
    });
    said(i + 1, 'buyer', name, text, received);
    if (status === 'replied')
      said(
        i + 1,
        'reply',
        'Luis Ortega',
        'We would. Bring it by for a twenty-minute appraisal and we will put a figure on it.',
        `${daysAgo(3 - i)} 14:05:00`,
      );
  });
  for (const q of desk.inquiries) rows.inquiry.push(Object.fromEntries(INQUIRY_COLUMNS.map((column) => [column, q[column] ?? null])));
  for (const m of desk.messages) said(m.inquiry_id, m.kind, m.author, m.body, m.sent_at);
  return rows;
}

const VEHICLE_COLUMNS = [
  'id',
  'stock_ref',
  'title',
  'make',
  'model',
  'trim',
  'engine',
  'year',
  'price',
  'mileage',
  'body_type',
  'fuel',
  'transmission',
  'drivetrain',
  'color',
  'doors',
  'seats',
  'owners',
  'status',
  'featured',
  'highlight',
  'description',
  'features',
  'service_records',
  'keys',
  'battery_health',
  'est_monthly',
  'listed_on',
  'dealer_id',
  'vin',
  'interior',
  'horsepower',
  'mpg_city',
  'mpg_highway',
  'range_mi',
  'was_price',
  'sold_on',
];
const INQUIRY_COLUMNS = [
  'id',
  'reference',
  'stock_ref',
  'vehicle_id',
  'name',
  'email',
  'phone',
  'message',
  'received_at',
  'status',
  'stage',
  'topic',
  'channel',
  'owner',
  'deal_value',
  'test_drive_at',
  'lost_reason',
  'closed_on',
];

export async function seed(file) {
  file = resolve(file);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new database path.`);
  mkdirSync(dirname(file), { recursive: true });
  await applyMigrations({ sqlite: file }, MIGRATIONS);
  const rows = marketplace();
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN');
    for (const table of TABLES) {
      const columns = Object.keys(rows[table][0]);
      const insert = db.prepare(`INSERT INTO ${table}(${columns.join(', ')}) VALUES(${columns.map(() => '?').join(',')})`);
      for (const row of rows[table]) insert.run(...columns.map((column) => row[column]));
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  writeFileSync(
    `${file}.json`,
    /* Both Forecourt fixtures open sign-up, which a server serves only with a mail service to prove the address
       (open-sign-up-unproven); the development one writes each message, the confirmation link among them, to the log. */
    `${JSON.stringify(
      {
        connections: [
          { name: 'forecourt', url: file, writable: true, migrations: { dir: MIGRATIONS } },
          { name: 'mail', kind: 'email', url: 'log:', from: 'Forecourt <no-reply@example.test>' },
        ],
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx test/fixtures/databases/forecourt/seed.mjs <new-file.db>');
  console.log(await seed(process.argv[2]));
}
