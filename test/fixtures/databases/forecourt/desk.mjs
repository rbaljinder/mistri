/**
 * The sales desk's half of the Forecourt seed (migrations/V2__desk.sql): what
 * a modern listing says beyond V1 — a VIN, horsepower, economy or range, the
 * interior, the price before a reduction — the dealers' ratings, six months of
 * cars already sold, and twelve weeks of inquiries with their stage, owner and
 * conversation. Drawn from a generator of its own, so the sixty cars seed.mjs
 * draws come out exactly as they always have. Deterministic for a given day.
 */

/* A second generator: the catalog's draws in seed.mjs stay untouched. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const rand = random(20261008);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;

/* What each model and engine makes and returns: horsepower, then city and
   highway mpg, or for an electric car its EPA range in miles. Rounded figures
   of the kind a listing quotes. */
const SPECS = {
  'Corolla 2.0': [169, 32, 41],
  'Corolla 1.8 Hybrid': [138, 53, 46],
  'Camry 2.5 Hybrid': [225, 51, 53],
  'RAV4 2.5': [203, 27, 35],
  'RAV4 2.5 Hybrid': [219, 41, 38],
  'F-150 2.7 EcoBoost': [325, 19, 25],
  'F-150 3.5 PowerBoost': [430, 22, 24],
  'Escape 1.5 EcoBoost': [180, 27, 34],
  'Escape 2.5 Hybrid': [192, 42, 36],
  'Ranger 2.3 EcoBoost': [270, 20, 25],
  'Transit Connect 2.0': [162, 24, 27],
  'Mustang 2.3 EcoBoost': [315, 21, 32],
  'Mustang 5.0 V8': [480, 15, 24],
  'Golf GTI 2.0 TSI': [241, 24, 34],
  'Jetta 1.5 TSI': [158, 31, 41],
  'Tiguan 2.0 TSI': [184, 24, 31],
  'Outback 2.5': [182, 26, 32],
  'Civic 2.0': [158, 31, 40],
  'Civic 2.0 Hybrid': [200, 50, 47],
  'CR-V 1.5 Turbo': [190, 28, 34],
  'CR-V 2.0 Hybrid': [204, 43, 36],
  'Fit 1.5': [128, 33, 40],
  'Rogue 1.5 VC-Turbo': [201, 30, 37],
  'Leaf 40 kWh': [147, 149],
  'Sportage 1.6T Hybrid': [227, 42, 44],
  'Niro EV 64.8 kWh': [201, 253],
  'Tucson 1.6T Hybrid': [226, 38, 38],
  'Ioniq 5 77.4 kWh': [225, 303],
  '3 Series 330i': [255, 26, 36],
  '4 Series 430i': [255, 25, 34],
  'C-Class C 300': [255, 25, 35],
  'A3 40 TFSI': [201, 29, 38],
  'A4 allroad 45 TFSI': [261, 24, 30],
  'CX-5 2.5': [187, 26, 31],
  'MX-5 Miata 2.0': [181, 26, 34],
  'Model 3 Dual Motor': [425, 341],
  'Model Y Dual Motor': [384, 310],
  'Equinox 1.5 Turbo': [175, 26, 31],
  'Silverado 1500 5.3 V8': [355, 16, 20],
  'Silverado 1500 3.0 Duramax': [305, 23, 29],
  'Wrangler 2.0 Turbo': [270, 20, 24],
  'Wrangler 4xe Plug-in Hybrid': [375, 20, 49],
  'XC60 B5 Mild Hybrid': [247, 23, 30],
  'Cooper 1.5 Turbo': [134, 28, 38],
};

const INTERIORS = ['Black cloth', 'Black leather', 'Gray cloth', 'Gray leatherette', 'Beige leather', 'Saddle brown leather', 'Ash cloth'];
/* A VIN's first three characters say who built the car; the rest here are drawn, never a real car's. */
const WMI = {
  Toyota: '4T1',
  Ford: '1FT',
  Volkswagen: '3VW',
  Subaru: '4S4',
  Honda: '2HG',
  Nissan: '5N1',
  Kia: 'KND',
  Hyundai: 'KM8',
  BMW: 'WBA',
  'Mercedes-Benz': 'W1K',
  Audi: 'WAU',
  Mazda: 'JM3',
  Tesla: '5YJ',
  Chevrolet: '1GC',
  Jeep: '1C4',
  Volvo: 'YV4',
  Mini: 'WMW',
};
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const YEAR_CODE = { 2016: 'G', 2017: 'H', 2018: 'J', 2019: 'K', 2020: 'L', 2021: 'M', 2022: 'N', 2023: 'P', 2024: 'R', 2025: 'S' };
function vin(make, year) {
  let rest = '';
  for (let i = 0; i < 5; i++) rest += VIN_CHARS[Math.floor(rand() * VIN_CHARS.length)];
  return `${WMI[make] ?? '1XX'}${rest}${between(0, 9)}${YEAR_CODE[year] ?? 'R'}${VIN_CHARS[between(0, 22)]}${String(between(100000, 999999))}`;
}

/* What a listing says beyond V1, for a car the catalog drew. */
export function listingDetails(car) {
  const spec = SPECS[`${car.model} ${car.engine}`] ?? [180, 26, 33];
  const electric = car.fuel === 'Electric';
  return {
    vin: vin(car.make, car.year),
    interior: pick(INTERIORS),
    horsepower: spec[0],
    mpg_city: electric ? null : spec[1],
    mpg_highway: electric ? null : spec[2],
    range_mi: electric ? Math.round((spec[1] * (car.battery_health ?? 95)) / 100) : null,
    was_price: car.highlight === 'Price reduced' ? car.price + pick([500, 750, 1000, 1500, 2000]) : null,
  };
}

/* Each dealer's reviews, in the order seed.mjs lists them. */
export const DEALER_RATINGS = [
  [4.8, 412],
  [4.6, 238],
  [4.9, 167],
  [4.4, 529],
  [4.7, 301],
  [4.5, 96],
];

/* The desk: who works the inquiries, as the board's footers name them. */
export const DESK = ['Maya Chen', 'Luis Ortega', 'Jordan Blake', 'Priya Nair'];

const FIRST = [
  'Olivia',
  'Marcus',
  'Sofia',
  'Ethan',
  'Aaliyah',
  'Noah',
  'Grace',
  'Daniel',
  'Hannah',
  'Mateo',
  'Chloe',
  'Isaiah',
  'Emma',
  'Kevin',
  'Zoe',
  'Andre',
  'Lily',
  'Caleb',
  'Mia',
  'Ryan',
  'Ava',
  'Diego',
  'Nora',
  'Tyler',
  'Leah',
  'Jamal',
  'Ella',
  'Brandon',
  'Ruby',
  'Samuel',
  'Camila',
  'Owen',
  'Maya',
  'Nathan',
  'Elena',
  'Gabriel',
  'Ivy',
  'Malik',
  'Claire',
  'Wesley',
];
const LAST = [
  'Johnson',
  'Nguyen',
  'Garcia',
  'Patel',
  'Williams',
  'Kim',
  'Brown',
  'Martinez',
  'Davis',
  'Lopez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Hernandez',
  'Moore',
  'Jackson',
  'Lee',
  'Walker',
  'Young',
  'Allen',
  'King',
  'Wright',
  'Scott',
  'Torres',
  'Hill',
  'Green',
  'Adams',
  'Baker',
  'Rivera',
  'Campbell',
  'Mitchell',
  'Carter',
  'Roberts',
  'Phillips',
  'Evans',
  'Turner',
  'Diaz',
  'Parker',
  'Collins',
  'Reed',
];

/* What a buyer first asks, by topic: the car's name is filled in. */
const OPENERS = {
  availability: [
    'Is the {car} still available? I can come by this week.',
    'Hi, is the {car} still for sale? Any chance it is still there on Saturday?',
    'Checking the {car} is still on the lot before I drive over.',
  ],
  test_drive: [
    'I would like to test drive the {car}. Weekday evenings work best for me.',
    'Could I book a test drive of the {car} for this weekend?',
    'My partner and I would like to drive the {car} together. Is Saturday morning possible?',
  ],
  trade_in: [
    'Would you take my {trade} in part exchange for the {car}?',
    'I have a {trade} to trade. What would it be worth against the {car}?',
  ],
  financing: [
    'What financing can you arrange on the {car}? I would put about $3,000 down.',
    'Is the {car} eligible for a 72-month loan? What rate should I expect?',
  ],
  price: [
    'Is there any room on the price of the {car}? I am paying cash.',
    'Would you consider an offer on the {car}? It has been listed a while.',
  ],
};
const TRADES = [
  '2014 Honda Civic',
  '2016 Toyota Camry',
  '2013 Ford Escape',
  '2017 Nissan Sentra',
  '2015 Jeep Cherokee',
  '2012 Honda Odyssey',
];
const REPLIES = {
  availability: 'Yes, it is here and ready. I can hold a slot for you to see it; which day suits?',
  test_drive: 'Happy to set that up. Bring your license and we will have it charged and washed.',
  trade_in: 'We can appraise it when you visit; it takes about twenty minutes. Bring the title if you have it.',
  financing: 'We work with several lenders. With that down payment most buyers see between 6.9% and 8.9% APR.',
  price: 'The price is already under book, but bring your offer and we will put it to the dealer.',
};
const NOTES = [
  'Called twice, left a voicemail. Prefers text.',
  'Buyer has a pre-approval from their credit union; ask for the letter.',
  'Trade-in looks clean from the photos. Service to appraise on arrival.',
  'Wants the car detailed before delivery.',
  'Spoke with the dealer: they will meet a fair offer within $500.',
];
const LOST_SAYS = {
  bought_elsewhere: 'Buyer went with a car closer to home.',
  price: 'Could not agree on the price.',
  financing: 'Financing did not come through.',
  no_response: 'No answer after three follow-ups.',
  sold_to_another: 'The car sold to another buyer first.',
};

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (date) => `${date.toISOString().slice(0, 10)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00`;

/**
 * Cars already sold, before the lot of today, and the desk's inquiries with
 * their conversations. `catalog` is the sixty cars seed.mjs drew, with their
 * ids; `soldCar(i)` draws one more car in the catalog's own way.
 */
export function deskRows({ catalog, soldCar, today, monthlyEstimate, firstId }) {
  const dayMs = 86_400_000;
  /* Nothing is dated after the moment the seed runs, or after the day it is pinned to. */
  const limit = Math.min(Date.now(), today.getTime() + dayMs - 60_000);
  const capped = (date) => (date.getTime() > limit ? new Date(limit - between(5, 120) * 60_000) : date);
  const at = (daysBack, hour = between(8, 18), minute = between(0, 59)) =>
    capped(new Date(today.getTime() - daysBack * dayMs + hour * 3_600_000 + minute * 60_000));
  const dayOf = (date) => date.toISOString().slice(0, 10);

  /* Forty more cars, sold over the last six months: each listed for a while,
     sold on a day, and found by the buyer through an inquiry the desk won. */
  const sold = Array.from({ length: 40 }, (_, i) => {
    const car = soldCar(catalog.length + i + 1, rand);
    const soldBack = between(2, 175);
    const listedBack = soldBack + between(9, 62);
    return {
      ...car,
      status: 'sold',
      featured: 0,
      highlight: null,
      listed_on: dayOf(at(listedBack, 0, 0)),
      soldBack,
      sold_on: dayOf(at(soldBack, 0, 0)),
    };
  });
  // The catalog's own few sold cars went within days of their listing.
  for (const car of catalog.filter((c) => c.status === 'sold')) {
    const listedBack = Math.round((today.getTime() - Date.parse(`${car.listed_on}T00:00:00Z`)) / dayMs);
    car.soldBack = Math.max(0, listedBack - between(3, Math.max(4, listedBack)));
    car.sold_on = dayOf(at(car.soldBack, 0, 0));
  }

  const inquiries = [];
  const messages = [];
  const used = new Set();
  const person = () => {
    for (;;) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  const reference = () => {
    let code = '';
    for (let i = 0; i < 12; i++) code += VIN_CHARS[Math.floor(rand() * VIN_CHARS.length)];
    return `INQ-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
  };

  /* One inquiry and its thread: the buyer's question, then as far down the
     road as `stage` says, each step dated after the last. */
  function inquire(car, { stage, receivedBack, lostReason }) {
    const name = person();
    const topic =
      stage === 'test_drive' ? 'test_drive' : pick(['availability', 'availability', 'test_drive', 'trade_in', 'financing', 'price']);
    const channel = pick(['web', 'web', 'web', 'web', 'phone', 'phone', 'walk_in']);
    const received = at(receivedBack);
    const owner = stage === 'new' && chance(0.6) ? null : pick(DESK);
    const id = inquiries.length + 1;
    const carName = `${car.year} ${car.make} ${car.model}`;
    const opener = pick(OPENERS[topic]).replace('{car}', carName).replace('{trade}', pick(TRADES));
    const thread = [];
    let clock = received;
    const later = (hours) => {
      clock = capped(new Date(clock.getTime() + hours * 3_600_000));
      return clock;
    };
    const say = (kind, author, body, when) => thread.push({ kind, author, body, sent_at: stampOf(when) });
    say('buyer', name, opener, received);
    let dealValue = car.price;
    let testDrive = null;
    const reached = ['new', 'contacted', 'test_drive', 'negotiating', 'won'];
    const depth = stage === 'lost' ? between(0, 3) : reached.indexOf(stage);
    if (depth >= 1) {
      say('reply', owner, REPLIES[topic], later(between(1, 20)));
      if (chance(0.5))
        say('buyer', name, pick(['Great, thank you.', 'Thanks! Saturday at 10 works.', 'Perfect, see you then.']), later(between(1, 6)));
      if (chance(0.35)) say('note', owner, pick(NOTES), later(between(1, 24)));
    }
    if (depth >= 2) {
      testDrive = later(between(24, 96));
      say(
        'step',
        owner,
        `Test drive booked for ${testDrive.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}.`,
        later(0.2),
      );
      clock = testDrive;
    }
    if (depth >= 3) {
      dealValue = car.price - pick([0, 250, 500, 750, 1000]);
      say('step', owner, `Offer recorded at $${dealValue.toLocaleString('en-US')}.`, later(between(2, 48)));
    }
    let closedOn = null;
    if (stage === 'won') {
      const soldAt = at(car.soldBack, between(15, 18));
      if (soldAt > clock) clock = soldAt;
      say('step', owner, `Sold at $${dealValue.toLocaleString('en-US')}. Delivered with a full tank.`, clock);
      closedOn = dayOf(clock);
    } else if (stage === 'lost') {
      say('step', owner ?? DESK[0], `Marked lost: ${LOST_SAYS[lostReason]}`, later(between(24, 120)));
      closedOn = dayOf(clock);
    }
    const phone = chance(0.6) ? `(${pick(['206', '312', '404', '512', '617', '720', '919'])}) 555-01${pad(between(0, 99))}` : null;
    inquiries.push({
      id,
      reference: reference(),
      stock_ref: car.stock_ref,
      vehicle_id: car.id,
      name,
      email: `${name.toLowerCase().replace(' ', '.')}@example.test`,
      phone,
      message: opener,
      received_at: stampOf(received),
      status: stage === 'new' ? 'new' : stage === 'won' || stage === 'lost' ? 'closed' : 'replied',
      stage,
      topic,
      channel,
      owner: owner ?? (stage === 'new' ? null : DESK[0]),
      deal_value: dealValue,
      test_drive_at: testDrive ? stampOf(testDrive) : null,
      lost_reason: stage === 'lost' ? lostReason : null,
      closed_on: closedOn,
    });
    for (const row of thread) messages.push({ inquiry_id: id, ...row, author: row.author ?? DESK[0] });
  }

  // Every sold car was won through the desk, found a week or three before it went.
  for (const car of [...catalog.filter((c) => c.status === 'sold'), ...sold])
    inquire(car, { stage: 'won', receivedBack: Math.min(car.soldBack + between(4, 24), 179) });
  const forSale = catalog.filter((c) => c.status !== 'sold');
  // The reserved cars are being negotiated.
  for (const car of forSale.filter((c) => c.status === 'reserved')) inquire(car, { stage: 'negotiating', receivedBack: between(4, 16) });
  // The open desk: newest questions to fresh offers, younger the earlier the stage.
  const open = [
    ['new', 0, 3, 7],
    ['contacted', 1, 12, 12],
    ['test_drive', 2, 16, 8],
    ['negotiating', 3, 21, 5],
  ];
  for (const [stage, lo, hi, n] of open) for (let i = 0; i < n; i++) inquire(pick(forSale), { stage, receivedBack: between(lo, hi) });
  // And the ones that went nowhere, over the last twelve weeks.
  const reasons = Object.keys(LOST_SAYS);
  for (let i = 0; i < 26; i++) {
    const reason = pick(reasons);
    const car = reason === 'sold_to_another' ? pick(sold.filter((c) => c.soldBack < 80)) : pick(forSale);
    inquire(car, { stage: 'lost', receivedBack: between(6, 84), lostReason: reason });
  }

  for (const car of sold) car.est_monthly = monthlyEstimate(car.price);
  /* Numbered in the order they came in, after the `first` rows already there. */
  inquiries.sort((a, b) => a.received_at.localeCompare(b.received_at));
  const renumber = new Map(inquiries.map((row, i) => [row.id, firstId + i]));
  for (const row of inquiries) row.id = renumber.get(row.id);
  for (const row of messages) row.inquiry_id = renumber.get(row.inquiry_id);
  messages.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  return { sold, inquiries, messages };
}
