/**
 * Lintel's rows: three buildings in Denver run by one small team, their 54
 * homes, the residents and leases in them, six months of rent and what was
 * paid, the storeroom, the repairs of the last four months and the viewings
 * booked on the empty homes. Everything is dated back from `today`, and the
 * same `today` makes the same rows, so a test can name them.
 *
 *   generate({ today: '2026-10-12' }) → { tables: { staff: [...], property: [...], ... } }
 *
 * Money is whole cents. A rent is posted on the first and late after the
 * fifth (late_fee rows); most of it is paid, by ACH or card, within days.
 */
import { renderBuilding } from './images.mjs';

/** The day in Denver, the buildings' own, as `YYYY-MM-DD`. */
export function lintelToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const DAY = 86_400_000;
const parse = (day) => Date.parse(`${day}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => iso(parse(day) + n * DAY);
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last)));
}
const firstOf = (day) => `${day.slice(0, 7)}-01`;
const at = (day, hour, minute = 0) => `${day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

function random(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

export const STAFF = [
  { name: 'Maya Okafor', email: 'maya.okafor@lintel.example.test', role: 'manager', title: 'Property manager', phone: '(303) 555-0110' },
  { name: 'Jordan Reyes', email: 'jordan.reyes@lintel.example.test', role: 'leasing', title: 'Leasing agent', phone: '(303) 555-0114' },
  { name: 'Elena Park', email: 'elena.park@lintel.example.test', role: 'leasing', title: 'Leasing agent', phone: '(303) 555-0117' },
  {
    name: 'Sam Whitfield',
    email: 'sam.whitfield@lintel.example.test',
    role: 'technician',
    title: 'Maintenance technician',
    phone: '(303) 555-0121',
  },
  {
    name: 'Luis Ortega',
    email: 'luis.ortega@lintel.example.test',
    role: 'technician',
    title: 'Maintenance technician',
    phone: '(303) 555-0123',
  },
  { name: 'Priya Nair', email: 'priya.nair@lintel.example.test', role: 'accountant', title: 'Accountant', phone: '(303) 555-0130' },
];

const PROPERTIES = [
  {
    name: 'Alder Court',
    address: '1420 Alder Street',
    zip: '80218',
    kind: 'apartments',
    year_built: 1998,
    floors: 4,
    perFloor: 6,
    description:
      'A courtyard building of studios to three-bedroom homes a short walk from Cheesman Park, with a bike room, a laundry on every floor and covered parking.',
  },
  {
    name: 'Birchwood Lofts',
    address: '2915 Larimer Street',
    zip: '80205',
    kind: 'lofts',
    year_built: 1924,
    floors: 3,
    perFloor: 6,
    description: 'A 1924 printworks turned into lofts: twelve-foot ceilings, steel windows and the original maple floors, in RiNo.',
  },
  {
    name: 'Cedar Row',
    address: '480 South Cedar Lane',
    zip: '80209',
    kind: 'townhomes',
    year_built: 2016,
    floors: 1,
    perFloor: 12,
    description: 'Twelve two- and three-bedroom townhomes in Washington Park, each with its own garage, patio and front door.',
  },
];

/** A home's size and asking rent, in cents, by building and bedrooms. */
const PLANS = {
  apartments: [
    { bedrooms: 0, bathrooms: 1, sqft: 480, rent: 125_000 },
    { bedrooms: 1, bathrooms: 1, sqft: 690, rent: 149_500 },
    { bedrooms: 1, bathrooms: 1, sqft: 720, rent: 154_500 },
    { bedrooms: 2, bathrooms: 2, sqft: 980, rent: 189_500 },
    { bedrooms: 2, bathrooms: 1, sqft: 940, rent: 179_500 },
    { bedrooms: 3, bathrooms: 2, sqft: 1240, rent: 235_000 },
  ],
  lofts: [
    { bedrooms: 1, bathrooms: 1, sqft: 860, rent: 165_000 },
    { bedrooms: 1, bathrooms: 1.5, sqft: 920, rent: 172_500 },
    { bedrooms: 2, bathrooms: 2, sqft: 1180, rent: 215_000 },
    { bedrooms: 0, bathrooms: 1, sqft: 640, rent: 139_500 },
    { bedrooms: 2, bathrooms: 2, sqft: 1240, rent: 225_000 },
    { bedrooms: 1, bathrooms: 1, sqft: 880, rent: 168_500 },
  ],
  townhomes: [
    { bedrooms: 2, bathrooms: 2.5, sqft: 1150, rent: 225_000 },
    { bedrooms: 3, bathrooms: 2.5, sqft: 1450, rent: 265_000 },
  ],
};

const FIRST = [
  'Ava',
  'Noah',
  'Mia',
  'Liam',
  'Sofia',
  'Ethan',
  'Isabella',
  'Lucas',
  'Amara',
  'Mateo',
  'Chloe',
  'Elijah',
  'Grace',
  'Diego',
  'Hannah',
  'Owen',
  'Zoe',
  'Caleb',
  'Lena',
  'Marcus',
  'Nora',
  'Theo',
  'Priya',
  'Julian',
  'Camila',
  'Samuel',
  'Iris',
  'Andre',
  'Valeria',
  'Felix',
  'Ruby',
  'Omar',
  'Lucia',
  'Henry',
  'Aaliyah',
  'Jonah',
  'Elena',
  'Malik',
  'Clara',
  'Rafael',
  'Maya',
  'Leo',
  'Ximena',
  'Wesley',
  'Hazel',
  'Tomas',
  'Imani',
  'Gabriel',
  'Ines',
  'Victor',
  'Paloma',
  'Darius',
  'June',
  'Emilio',
];
const LAST = [
  'Bennett',
  'Castillo',
  'Nguyen',
  'Hughes',
  'Morales',
  'Patel',
  'Foster',
  'Ramirez',
  'Kim',
  'Delgado',
  'Brooks',
  'Okoye',
  'Sullivan',
  'Herrera',
  'Chen',
  'Ward',
  'Vargas',
  'Price',
  'Mendoza',
  'Coleman',
  'Ito',
  'Romero',
  'Grant',
  'Silva',
  'Hayes',
  'Navarro',
  'Fischer',
  'Ortiz',
  'Lowe',
  'Reyes',
  'Abbott',
  'Flores',
  'Kaur',
  'Medina',
  'Stone',
  'Aguilar',
  'Wolfe',
  'Cruz',
];
/** The family names a Spanish-reading household is likelier to have here; it is a language column, not a guess at people. */
const SPANISH = new Set([
  'Castillo',
  'Morales',
  'Ramirez',
  'Delgado',
  'Herrera',
  'Vargas',
  'Mendoza',
  'Romero',
  'Navarro',
  'Ortiz',
  'Flores',
  'Medina',
  'Aguilar',
  'Cruz',
]);

export const PARTS = [
  { sku: 'PL-FLAP-01', name: 'Toilet flapper, 2 in', category: 'plumbing', on_hand: 14, reorder_at: 6, unit_cost: 699, bin: 'A1' },
  { sku: 'PL-FILL-02', name: 'Toilet fill valve', category: 'plumbing', on_hand: 6, reorder_at: 4, unit_cost: 1249, bin: 'A1' },
  {
    sku: 'PL-CART-03',
    name: 'Faucet cartridge, single handle',
    category: 'plumbing',
    on_hand: 3,
    reorder_at: 4,
    unit_cost: 2199,
    bin: 'A2',
  },
  { sku: 'PL-WAX-04', name: 'Wax ring with bolts', category: 'plumbing', on_hand: 9, reorder_at: 4, unit_cost: 549, bin: 'A2' },
  { sku: 'PL-SUPP-05', name: 'Braided supply line, 16 in', category: 'plumbing', on_hand: 20, reorder_at: 8, unit_cost: 899, bin: 'A3' },
  { sku: 'EL-GFCI-01', name: 'GFCI outlet, 15 A', category: 'electrical', on_hand: 8, reorder_at: 5, unit_cost: 1899, bin: 'B1' },
  { sku: 'EL-LED-02', name: 'LED bulb, A19 (4-pack)', category: 'electrical', on_hand: 22, reorder_at: 10, unit_cost: 1099, bin: 'B1' },
  { sku: 'EL-SMK-03', name: 'Smoke alarm, 10-year', category: 'electrical', on_hand: 2, reorder_at: 6, unit_cost: 2899, bin: 'B2' },
  { sku: 'EL-SWT-04', name: 'Light switch, decora', category: 'electrical', on_hand: 16, reorder_at: 6, unit_cost: 349, bin: 'B2' },
  { sku: 'AP-ELEM-01', name: 'Oven bake element', category: 'appliance', on_hand: 2, reorder_at: 2, unit_cost: 4599, bin: 'C1' },
  { sku: 'AP-GASK-02', name: 'Refrigerator door gasket', category: 'appliance', on_hand: 1, reorder_at: 2, unit_cost: 6499, bin: 'C1' },
  { sku: 'AP-DWP-03', name: 'Dishwasher drain pump', category: 'appliance', on_hand: 3, reorder_at: 2, unit_cost: 5899, bin: 'C2' },
  { sku: 'HV-FLT-01', name: 'Furnace filter, 16×25×1', category: 'hvac', on_hand: 36, reorder_at: 24, unit_cost: 799, bin: 'D1' },
  { sku: 'HV-TSTAT-02', name: 'Programmable thermostat', category: 'hvac', on_hand: 4, reorder_at: 2, unit_cost: 7999, bin: 'D1' },
  { sku: 'HV-CAP-03', name: 'Run capacitor, 45/5 µF', category: 'hvac', on_hand: 5, reorder_at: 3, unit_cost: 1899, bin: 'D2' },
  { sku: 'HW-LOCK-01', name: 'Entry deadbolt, rekeyable', category: 'hardware', on_hand: 6, reorder_at: 4, unit_cost: 3499, bin: 'E1' },
  { sku: 'HW-BLIND-02', name: 'Vinyl blind, 35 in', category: 'hardware', on_hand: 12, reorder_at: 6, unit_cost: 1299, bin: 'E2' },
  {
    sku: 'PT-WALL-01',
    name: 'Wall paint, eggshell white (gal)',
    category: 'paint',
    on_hand: 10,
    reorder_at: 6,
    unit_cost: 3899,
    bin: 'F1',
  },
];

/** What residents ask for, by category: a title, what they wrote and the parts a repair of it usually takes. */
const ISSUES = [
  ['plumbing', 'Toilet keeps running', 'The toilet in the main bathroom runs every few minutes, even overnight.', ['PL-FLAP-01']],
  ['plumbing', 'Kitchen faucet drips', 'The kitchen faucet drips when it is off; it is getting worse.', ['PL-CART-03']],
  ['plumbing', 'Slow bathroom sink', 'The bathroom sink drains very slowly.', []],
  ['plumbing', 'Leak under the sink', 'There is water in the cabinet under the kitchen sink.', ['PL-SUPP-05']],
  ['electrical', 'Outlet not working', 'The bathroom outlet has no power, and the reset button does nothing.', ['EL-GFCI-01']],
  ['electrical', 'Smoke alarm chirping', 'The hallway smoke alarm chirps every minute.', ['EL-SMK-03']],
  ['electrical', 'Hall light out', 'The hall light will not turn on after changing the bulb.', ['EL-SWT-04']],
  ['appliance', 'Oven not heating', 'The oven turns on but never gets hot.', ['AP-ELEM-01']],
  ['appliance', 'Dishwasher will not drain', 'Water stays in the bottom of the dishwasher after a cycle.', ['AP-DWP-03']],
  ['appliance', 'Fridge door seal torn', 'The refrigerator door seal is torn and the door does not close tight.', ['AP-GASK-02']],
  ['hvac', 'No heat', 'The furnace runs but the air from the vents is cold.', ['HV-CAP-03']],
  ['hvac', 'Thermostat blank', 'The thermostat screen is blank and the heat will not come on.', ['HV-TSTAT-02']],
  ['hvac', 'Filter change', 'Please change the furnace filter; it has been a while.', ['HV-FLT-01']],
  ['general', 'Blind broken', 'The bedroom blind will not stay up.', ['HW-BLIND-02']],
  ['general', 'Front door lock sticks', 'The deadbolt is hard to turn and sometimes will not lock.', ['HW-LOCK-01']],
  ['general', 'Patch and paint', 'A hole in the living room wall from a door handle.', ['PT-WALL-01']],
];

/* What the office says among itself about a repair: never shown to the resident. */
const INTERNAL = [
  'Second call on this unit this year. Check the shutoff valve while there.',
  'Resident asked for mornings only. Bring the long ladder for the access panel.',
  'Warranty may cover it: photograph the model plate before ordering anything.',
  'Dog in the unit. Text before going in.',
];
const PRIORITY = { hvac: 'urgent', electrical: 'normal', plumbing: 'normal', appliance: 'normal', general: 'low' };

export function generate({ today, photos = true } = {}) {
  const rand = random(Number(today.replaceAll('-', '')) % 100_000 || 7);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const month = firstOf(today);
  const tables = {
    staff: [],
    property: [],
    property_photo: [],
    unit: [],
    resident: [],
    lease: [],
    charge: [],
    payment: [],
    part: [],
    part_receipt: [],
    maintenance_request: [],
    request_part: [],
    request_note: [],
    viewing: [],
  };
  const ids = {};
  const add = (table, row) => {
    ids[table] = (ids[table] ?? 0) + 1;
    const full = { id: ids[table], ...row };
    tables[table].push(full);
    return full;
  };

  for (const s of STAFF) add('staff', { ...s, active: true });
  const manager = 1;
  const technicians = tables.staff.filter((s) => s.role === 'technician').map((s) => s.id);

  for (const [index, p] of PROPERTIES.entries()) {
    const { floors, perFloor, ...face } = p;
    const property = add('property', { ...face, city: 'Denver', state: 'CO', manager_id: manager });
    if (photos)
      for (let position = 1; position <= 2; position++) {
        const { photo, thumb } = renderBuilding(p.kind, index * 3 + position - 1);
        add('property_photo', {
          property_id: property.id,
          position,
          alt: `${p.name} from the street${position === 2 ? ', at dusk' : ''}.`,
          file_name: `${p.name.toLowerCase().replaceAll(' ', '-')}-${position}.png`,
          content_type: 'image/png',
          byte_size: photo.length,
          data: photo,
          thumbnail: thumb,
        });
      }
    for (let floor = 1; floor <= floors; floor++)
      for (let n = 1; n <= perFloor; n++) {
        const plan = PLANS[p.kind][(n - 1 + (p.kind === 'townhomes' ? floor + n : 0)) % PLANS[p.kind].length];
        const number = p.kind === 'townhomes' ? `${n}` : `${floor}${String(n).padStart(2, '0')}`;
        add('unit', {
          property_id: property.id,
          number,
          // The listing code a visitor quotes: the building's initials and the home's number.
          code: `${p.name
            .split(' ')
            .map((word) => word[0])
            .join('')}-${number}`,
          floor,
          bedrooms: plan.bedrooms,
          bathrooms: plan.bathrooms,
          sqft: plan.sqft,
          // A floor up is worth a little more, and a corner home a little more again.
          market_rent: plan.rent + (floor - 1) * 2_500 + (n === 1 || n === perFloor ? 3_500 : 0),
          status: 'occupied',
          listed: false,
          available_on: null,
          headline: null,
          description: null,
          version: 0,
        });
      }
  }

  /* Who lives where. Most homes are let; four stand empty and listed, one is
     being turned over, three residents have given notice, and one home has a
     lease waiting to be signed for a move-in next month. */
  const units = tables.unit;
  const empty = new Set([5, 17, 29, 44]);
  const turnover = 38;
  const notice = new Set([9, 23, 50]);
  const drafted = 17;
  const usedNames = new Set();
  const person = () => {
    for (;;) {
      const first = pick(FIRST),
        last = pick(LAST);
      if (usedNames.has(`${first} ${last}`)) continue;
      usedNames.add(`${first} ${last}`);
      return { first, last };
    }
  };
  const newResident = (since) => {
    const { first, last } = person();
    return add('resident', {
      name: `${first} ${last}`,
      email: `${first}.${last}@example.test`.toLowerCase(),
      phone: `(720) 555-${String(1000 + Math.floor(rand() * 8999)).slice(0, 4)}`,
      // A few have said no to mail; the App never mails them.
      email_ok: rand() > 0.12,
      language: SPANISH.has(last) && rand() < 0.7 ? 'es' : 'en',
      since,
    });
  };

  const rentCharge = (lease, period, status, paidOffset) => {
    const due = `${period}-01`;
    const charge = add('charge', {
      lease_id: lease.id,
      kind: 'rent',
      period,
      description: `Rent, ${new Date(`${due}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
      due_on: due,
      amount: lease.rent,
      status,
      posted_on: due,
      paid_on: status === 'paid' ? addDays(due, paidOffset) : null,
      waived_reason: null,
      version: 0,
    });
    if (status === 'paid') pay(lease, charge, charge.paid_on);
    return charge;
  };
  let reference = 40_000;
  const pay = (lease, charge, on) =>
    add('payment', {
      lease_id: lease.id,
      charge_id: charge.id,
      received_on: on,
      amount: charge.amount,
      method: rand() < 0.68 ? 'ach' : rand() < 0.8 ? 'card' : 'check',
      reference: `PMT-${++reference}`,
    });

  for (const unit of units) {
    if (unit.id === turnover || empty.has(unit.id)) {
      // Someone lived here until lately; their lease ended and the home is being made ready, or is listed.
      const start = addMonths(month, -14 - Math.floor(rand() * 6));
      const resident = newResident(start);
      const end = addDays(month, -Math.floor(rand() * 40) - 3);
      const lease = add('lease', {
        unit_id: unit.id,
        resident_id: resident.id,
        start_on: start,
        end_on: end,
        rent: unit.market_rent - 5_000,
        deposit: unit.market_rent,
        status: 'ended',
        signed_on: addDays(start, -12),
        notice_on: addDays(end, -30),
        ended_on: end,
        version: 0,
      });
      for (let m = -3; m < 0; m++) {
        const period = addMonths(month, m).slice(0, 7);
        if (`${period}-01` <= end) rentCharge(lease, period, 'paid', 1 + Math.floor(rand() * 3));
      }
      if (unit.id === turnover) {
        unit.status = 'turnover';
        unit.available_on = addDays(today, 18);
      } else {
        unit.status = 'vacant';
        unit.listed = true;
        unit.available_on = addDays(today, Math.floor(rand() * 10));
        const plan = unit.bedrooms === 0 ? 'Studio' : `${unit.bedrooms}-bedroom`;
        unit.headline = `${plan} on the ${['first', 'second', 'third', 'fourth'][unit.floor - 1] ?? 'ground'} floor, ${unit.sqft} sq ft`;
        unit.description =
          'Freshly painted, with new blinds and a deep-cleaned kitchen. Water, trash and recycling are in the rent; electricity and internet are yours. Cats and small dogs welcome.';
      }
      if (unit.id === drafted) {
        // A move-in on the first of next month: the lease is written and waits for its signature.
        const resident = newResident(today);
        const start = addMonths(month, 1);
        add('lease', {
          unit_id: unit.id,
          resident_id: resident.id,
          start_on: start,
          end_on: addDays(addMonths(start, 12), -1),
          rent: unit.market_rent,
          deposit: unit.market_rent,
          status: 'draft',
          signed_on: null,
          notice_on: null,
          ended_on: null,
          version: 0,
        });
        unit.listed = false;
      }
      continue;
    }
    // A lease that began one to eleven months ago, for a year, at about the asking rent.
    const start = addMonths(month, -1 - Math.floor(rand() * 11));
    const resident = newResident(start);
    const gaveNotice = notice.has(unit.id);
    const end = gaveNotice ? addDays(today, 10 + Math.floor(rand() * 35)) : addDays(addMonths(start, 12), -1);
    const lease = add('lease', {
      unit_id: unit.id,
      resident_id: resident.id,
      start_on: start,
      end_on: end,
      rent: unit.market_rent - Math.floor(rand() * 4) * 2_500,
      deposit: unit.market_rent,
      status: gaveNotice ? 'notice' : 'active',
      signed_on: addDays(start, -10 - Math.floor(rand() * 10)),
      notice_on: gaveNotice ? addDays(today, -20 - Math.floor(rand() * 10)) : null,
      ended_on: null,
      version: 0,
    });
    if (gaveNotice) unit.status = 'notice';
    // Up to six months of rent: paid within days, except the arrears a few households carry.
    const behind = rand() < 0.1;
    for (let m = -5; m <= 0; m++) {
      const due = addMonths(month, m);
      if (due < start) continue;
      const period = due.slice(0, 7);
      const current = m === 0;
      const late = behind && m >= -1;
      const unpaid = late || (current && parse(today) - parse(month) < 4 * DAY && rand() < 0.5) || (current && rand() < 0.25);
      const charge = rentCharge(lease, period, unpaid ? 'open' : 'paid', 1 + Math.floor(rand() * 4));
      // Rent still open after the fifth carries a late fee.
      if (unpaid && addDays(charge.due_on, 5) < today)
        add('charge', {
          lease_id: lease.id,
          kind: 'late_fee',
          period,
          description: `Late fee, ${charge.description.replace('Rent, ', '')}`,
          due_on: addDays(charge.due_on, 6),
          amount: 7_500,
          status: 'open',
          posted_on: addDays(charge.due_on, 6),
          paid_on: null,
          waived_reason: null,
          version: 0,
        });
    }
  }

  for (const p of PARTS) add('part', { ...p, version: 0 });
  const partBySku = new Map(tables.part.map((p) => [p.sku, p]));
  for (const [i, sku] of ['HV-FLT-01', 'PL-FLAP-01', 'EL-LED-02', 'PL-SUPP-05', 'PT-WALL-01', 'EL-GFCI-01'].entries())
    add('part_receipt', {
      part_id: partBySku.get(sku).id,
      quantity: [24, 12, 12, 10, 6, 6][i],
      received_on: addDays(today, -80 + i * 13),
      vendor: i % 2 ? 'Front Range Supply' : 'Mile High Hardware',
    });

  /* Four months of repairs. Older ones are done; the newest wait to be
     triaged, scheduled or finished. Each step the request took is stamped. */
  const leased = tables.lease.filter((l) => l.status === 'active' || l.status === 'notice');
  const states = ['new', 'new', 'new', 'triaged', 'triaged', 'scheduled', 'scheduled', 'in_progress', 'in_progress', 'on_hold'];
  for (let i = 0; i < 52; i++) {
    const lease = leased[Math.floor(rand() * leased.length)];
    /* A repair begun and still on site (in progress or on hold) has used a part, whatever today's draw: an issue
       that needs none gives way to the next one that does, without another draw, so every other row is the same and
       a test can always find a part logged on an open repair. */
    const drawnIssue = Math.floor(rand() * ISSUES.length);
    const begun = i < states.length && (states[i] === 'in_progress' || states[i] === 'on_hold');
    let issue = drawnIssue;
    while (begun && !ISSUES[issue][3].length) issue = (issue + 1) % ISSUES.length;
    const [category, title, description, partSkus] = ISSUES[issue];
    const age = i < states.length ? Math.floor(rand() * 9) : 10 + Math.floor(rand() * 110);
    let reported = addDays(today, -age);
    const status = i < states.length ? states[i] : rand() < 0.08 ? 'cancelled' : rand() < 0.6 ? 'closed' : 'completed';
    /* The open visits (the states above) are the first technician's, booked
       ahead when scheduled and already begun when in progress or on hold, so
       on any day the seed is made one technician has both a visit to come and
       one past due. Drawn at random they could all land behind today, or all
       ahead. The draws still happen, so every other row is the same. */
    const open = i >= 5 && i < states.length;
    const drawn = ['new', 'triaged', 'cancelled'].includes(status) ? null : pick(technicians);
    const assigned = open ? technicians[0] : drawn;
    const offset = assigned ? 1 + Math.floor(rand() * 3) : 0;
    const scheduled = !assigned
      ? null
      : open
        ? status === 'scheduled'
          ? addDays(today, offset)
          : addDays(today, -offset)
        : addDays(reported, offset);
    // A visit begun on a day is reported no later than that day.
    if (scheduled && scheduled < reported) reported = scheduled;
    const done = status === 'completed' || status === 'closed';
    const completed = done ? addDays(scheduled, Math.floor(rand() * 2)) : null;
    const resident = tables.resident.find((r) => r.id === lease.resident_id);
    const request = add('maintenance_request', {
      unit_id: lease.unit_id,
      resident_id: resident.id,
      title,
      description,
      category,
      priority: i % 9 === 0 ? 'urgent' : PRIORITY[category] === 'urgent' && rand() < 0.5 ? 'urgent' : rand() < 0.2 ? 'low' : 'normal',
      status,
      assigned_to: assigned,
      entry_ok: rand() < 0.7,
      reported_on: reported,
      scheduled_on: scheduled,
      completed_on: completed,
      resolution: done ? `Fixed: ${title.toLowerCase()}. Tested with the resident's OK.` : null,
      status_since: at(completed ?? (status === 'scheduled' ? reported : scheduled) ?? reported, 9 + (i % 8), (i * 7) % 60),
      version: 0,
    });
    add('request_note', {
      request_id: request.id,
      kind: 'resident',
      author: resident.name,
      body: description,
      sent_at: at(reported, 8 + (i % 10), (i * 13) % 60),
    });
    if (assigned)
      add('request_note', {
        request_id: request.id,
        kind: 'staff',
        author: tables.staff.find((s) => s.id === assigned).name,
        body: `Thanks, ${resident.name.split(' ')[0]}. I'll be by on ${new Date(`${scheduled}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}${request.entry_ok ? '; I have your OK to let myself in' : ''}.`,
        sent_at: at(addDays(reported, 1), 10, (i * 11) % 60),
      });
    // The office's own word on a third of the booked repairs: kept from the resident by the row policy.
    if (assigned && i % 3 === 0)
      add('request_note', {
        request_id: request.id,
        kind: 'internal',
        author: tables.staff.find((s) => s.id === assigned).name,
        body: INTERNAL[i % INTERNAL.length],
        sent_at: at(addDays(reported, 1), 11, (i * 17) % 60),
      });
    if ((done || begun) && partSkus.length)
      add('request_part', { request_id: request.id, part_id: partBySku.get(partSkus[0]).id, quantity: 1, used_on: completed ?? today });
  }

  /* Viewings booked on the listed homes, from the public site. */
  const listed = units.filter((u) => u.listed);
  for (let i = 0; i < 9; i++) {
    const unit = listed[i % listed.length];
    const { first, last } = person();
    const preferred = addDays(today, -6 + i * 2);
    add('viewing', {
      unit_id: unit.id,
      // The public form's shape (publicReference('VW')): random, so it says nothing about how many came before.
      reference: `VW-${[0, 1, 2].map(() => Array.from({ length: 4 }, () => pick([...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'])).join('')).join('-')}`,
      name: `${first} ${last}`,
      email: `${first}.${last}@example.test`.toLowerCase(),
      phone: rand() < 0.6 ? `(720) 555-${String(2000 + i * 113).slice(0, 4)}` : null,
      preferred_on: preferred,
      message: i % 3 === 0 ? 'Is parking included? I work from home most days.' : null,
      status: preferred < today ? (i % 4 === 0 ? 'cancelled' : 'completed') : i % 2 ? 'confirmed' : 'requested',
      received_at: at(addDays(preferred, -3), 19, i * 5),
      version: 0,
    });
  }

  return { tables };
}
