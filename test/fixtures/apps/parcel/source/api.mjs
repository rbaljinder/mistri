/**
 * The Parcel sample's API: a made-up carrier network's tracking service, in
 * memory, on 127.0.0.1. It answers exactly what openapi.json documents —
 * shipments with offset paging, filters, search and a sort; carriers with a
 * cursor — and nothing else: an unknown query parameter is a 400, so a
 * client that sends only what the spec declares is the only kind that works.
 *
 *   PARCEL_API_TOKEN=… node test/fixtures/apps/parcel/source/api.mjs [--port 4781]
 *
 * Every request needs `Authorization: Bearer $PARCEL_API_TOKEN`. The data is
 * synthetic and the same on every start: six carriers and 140 shipments
 * between US cities, dated around the day the server starts. No dependencies.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const token = process.env.PARCEL_API_TOKEN;
if (!token) {
  console.error('parcel api: set PARCEL_API_TOKEN to the bearer token clients must send.');
  process.exit(1);
}
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 4781;
const spec = readFileSync(new URL('./openapi.json', import.meta.url), 'utf8');

/* A small seeded generator, so every start serves the same shipments. */
let seed = 20260912;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];

export const CARRIERS = [
  {
    id: 'car-01',
    name: 'Bluebird Freight',
    headquarters: 'Memphis, TN',
    phone: '(901) 555-0142',
    website: 'https://bluebird.example',
    on_time_rate: 96.2,
    active: true,
  },
  {
    id: 'car-02',
    name: 'Keystone Express',
    headquarters: 'Pittsburgh, PA',
    phone: '(412) 555-0188',
    website: 'https://keystone.example',
    on_time_rate: 94.1,
    active: true,
  },
  {
    id: 'car-03',
    name: 'Prairie Parcel',
    headquarters: 'Omaha, NE',
    phone: '(402) 555-0107',
    website: 'https://prairie.example',
    on_time_rate: 91.8,
    active: true,
  },
  {
    id: 'car-04',
    name: 'Harbor Line Logistics',
    headquarters: 'Long Beach, CA',
    phone: '(562) 555-0163',
    website: 'https://harborline.example',
    on_time_rate: 88.7,
    active: true,
  },
  {
    id: 'car-05',
    name: 'Summit Ground',
    headquarters: 'Denver, CO',
    phone: '(303) 555-0129',
    website: 'https://summit.example',
    on_time_rate: 93.4,
    active: true,
  },
  {
    id: 'car-06',
    name: 'Lone Star Courier',
    headquarters: 'Austin, TX',
    phone: '(512) 555-0176',
    website: 'https://lonestar.example',
    on_time_rate: 85.3,
    active: false,
  },
];
const CITIES = [
  ['Seattle', 'WA'],
  ['Portland', 'OR'],
  ['San Francisco', 'CA'],
  ['Los Angeles', 'CA'],
  ['Phoenix', 'AZ'],
  ['Denver', 'CO'],
  ['Dallas', 'TX'],
  ['Houston', 'TX'],
  ['Chicago', 'IL'],
  ['Minneapolis', 'MN'],
  ['Atlanta', 'GA'],
  ['Miami', 'FL'],
  ['Charlotte', 'NC'],
  ['Boston', 'MA'],
  ['New York', 'NY'],
  ['Philadelphia', 'PA'],
];
const SIGNERS = ['J. Alvarez', 'M. Chen', 'R. Okafor', 'S. Patel', 'T. Nguyen', 'A. Johnson', 'Front desk', 'Left at door'];
const REASONS = [
  'Address could not be found',
  'Recipient unavailable, second attempt tomorrow',
  'Held at customs',
  'Damaged in transit, under inspection',
  'Weather delay',
];
const DAY = 86_400_000;
const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/* Status by where a shipment is in its trip: older ones are delivered, this
   week's are on the way, a few are held. The days move with the start date;
   the statuses and every other field do not. */
export const SHIPMENTS = Array.from({ length: 140 }, (_, i) => {
  const [originCity, originState] = pick(CITIES);
  let [destinationCity, destinationState] = pick(CITIES);
  if (destinationCity === originCity)
    [destinationCity, destinationState] = CITIES[(CITIES.indexOf(CITIES.find(([c]) => c === originCity)) + 5) % CITIES.length];
  const service = pick(['ground', 'ground', 'ground', 'two_day', 'two_day', 'overnight']);
  const transit = service === 'overnight' ? 1 : service === 'two_day' ? 2 : 3 + Math.floor(random() * 3);
  // About ten a day over the last two weeks, so a good share is still on the way.
  const shippedDaysAgo = Math.floor(i / 10);
  const shipped = today - shippedDaysAgo * DAY - Math.floor(random() * 10) * 3_600_000 - 8 * 3_600_000;
  const eta = today - shippedDaysAgo * DAY + transit * DAY;
  const roll = random();
  const status =
    roll < 0.07
      ? 'exception'
      : eta < today
        ? 'delivered'
        : eta === today
          ? roll < 0.5
            ? 'out_for_delivery'
            : 'delivered'
          : shippedDaysAgo === 0 && roll < 0.4
            ? 'label_created'
            : 'in_transit';
  const delivered = status === 'delivered' ? Math.min(eta, today) + (9 + Math.floor(random() * 9)) * 3_600_000 : null;
  return {
    tracking_number: `PX${String(4_100_000_000 + i * 7_919_133).padStart(10, '0')}`,
    status,
    carrier_id: CARRIERS[i % 5 === 4 && random() < 0.5 ? 5 : Math.floor(random() * 5)].id,
    service,
    origin_city: originCity,
    origin_state: originState,
    destination_city: destinationCity,
    destination_state: destinationState,
    weight_lb: Math.round((0.4 + random() * 48) * 10) / 10,
    declared_value: Math.round(15 + random() * 1_400) + 0.99,
    shipped_at: new Date(shipped).toISOString(),
    eta: day(eta),
    delivered_at: delivered === null ? null : new Date(delivered).toISOString(),
    signed_by: delivered === null ? null : pick(SIGNERS),
    exception_reason: status === 'exception' ? pick(REASONS) : null,
  };
});

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const allowed = (query, names) => [...query.keys()].find((name) => !names.includes(name));
const bounded = (value, fallback, max) => {
  const n = value === null ? fallback : Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://parcel.invalid');
  const query = url.searchParams;
  if (request.method !== 'GET') return send(response, 405, { error: 'This API only reads.' });
  if (url.pathname === '/openapi.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(spec);
  }
  if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: 'A bearer token is required.' });

  if (url.pathname === '/v1/shipments') {
    const unknown = allowed(query, ['offset', 'limit', 'q', 'status', 'carrier_id', 'destination_state', 'sort']);
    if (unknown) return send(response, 400, { error: `Unknown parameter "${unknown}".` });
    const text = query.get('q')?.toLowerCase();
    let rows = SHIPMENTS.filter(
      (row) =>
        (!query.has('status') || query.getAll('status').includes(row.status)) &&
        (!query.has('carrier_id') || query.getAll('carrier_id').includes(row.carrier_id)) &&
        (!query.has('destination_state') || query.getAll('destination_state').includes(row.destination_state)) &&
        (!text || [row.tracking_number, row.origin_city, row.destination_city].some((value) => value.toLowerCase().includes(text))),
    );
    const sort = query.get('sort') ?? '-shipped_at';
    if (!['-shipped_at', 'shipped_at', 'eta'].includes(sort)) return send(response, 400, { error: `Cannot sort by "${sort}".` });
    const field = sort.replace(/^-/, '');
    rows = [...rows].sort(
      (a, b) => (sort.startsWith('-') ? -1 : 1) * a[field].localeCompare(b[field]) || a.tracking_number.localeCompare(b.tracking_number),
    );
    const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
    return send(response, 200, rows.slice(offset, offset + bounded(query.get('limit'), 25, 100)));
  }
  const shipment = /^\/v1\/shipments\/([^/]+)$/.exec(url.pathname);
  if (shipment) {
    const row = SHIPMENTS.find((each) => each.tracking_number === decodeURIComponent(shipment[1]));
    return row ? send(response, 200, row) : send(response, 404, { error: 'No such shipment.' });
  }
  if (url.pathname === '/v1/carriers') {
    const unknown = allowed(query, ['cursor', 'limit']);
    if (unknown) return send(response, 400, { error: `Unknown parameter "${unknown}".` });
    const start = Number(query.get('cursor') ?? 0) || 0;
    const limit = bounded(query.get('limit'), 10, 50);
    const next = start + limit < CARRIERS.length ? String(start + limit) : null;
    return send(response, 200, { data: CARRIERS.slice(start, start + limit), next_cursor: next });
  }
  const carrier = /^\/v1\/carriers\/([^/]+)$/.exec(url.pathname);
  if (carrier) {
    const row = CARRIERS.find((each) => each.id === decodeURIComponent(carrier[1]));
    return row ? send(response, 200, row) : send(response, 404, { error: 'No such carrier.' });
  }
  send(response, 404, { error: 'No such path.' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`parcel api: listening on http://127.0.0.1:${port}/v1 (spec at /openapi.json)`);
});
