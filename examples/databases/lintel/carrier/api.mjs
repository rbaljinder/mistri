/**
 * Northbound Freight's tracking API, as Lintel's sample uses it: a made-up carrier, in memory, on 127.0.0.1. It
 * answers exactly what openapi.json documents — shipments with offset paging, a status filter, search and a sort —
 * and nothing else: an unknown query parameter is a 400, so a client that sends only what the spec declares is the
 * only kind that works. It needs no key (a tracking number is not a secret), and it only reads.
 *
 *   node examples/databases/lintel/carrier/api.mjs [--port 4782]
 *
 * The data is synthetic and the same on every start: one shipment for each tracking number tracking.mjs lists. The
 * first six are the storeroom's deliveries, delivered on the day data.mjs received each; the rest are still coming,
 * dated from today in Denver (or `LINTEL_TODAY=YYYY-MM-DD`, as the seed reads it). No dependencies.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { INBOUND_TRACKING, RECEIPT_TRACKING, receiptDays } from './tracking.mjs';

const DAY = 86_400_000;
const denver = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const todayMs = Date.parse(`${/^\d{4}-\d{2}-\d{2}$/.test(process.env.LINTEL_TODAY ?? '') ? process.env.LINTEL_TODAY : denver()}T00:00:00Z`);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const at = (ms, hour, minute = 0) => new Date(ms + hour * 3_600_000 + minute * 60_000).toISOString();

/* The deliveries arrived on the days data.mjs received them (receiptDays); the rest are due around today. */
const receivedOn = receiptDays(day(todayMs));
const arrived = RECEIPT_TRACKING.map((tracking_number, i) => {
  const ms = Date.parse(`${receivedOn[i]}T00:00:00Z`);
  return {
    tracking_number,
    status: 'delivered',
    service: i % 3 === 2 ? 'freight' : 'ground',
    origin_city: ['Salt Lake City', 'Kansas City', 'Omaha', 'Dallas', 'Phoenix', 'Albuquerque'][i],
    origin_state: ['UT', 'MO', 'NE', 'TX', 'AZ', 'NM'][i],
    eta: day(ms),
    last_scan_location: 'Denver, CO',
    last_scan_at: at(ms, 10, 20 + i),
    delivered_at: at(ms, 10, 20 + i),
    signed_by: 'Storeroom desk',
    exception_reason: null,
  };
});
const coming = [
  ['in_transit', 'ground', 'Salt Lake City', 'UT', 2, 'Cheyenne, WY', 5],
  ['out_for_delivery', 'expedited', 'Kansas City', 'MO', 0, 'Denver, CO', 7],
  ['exception', 'freight', 'Omaha', 'NE', -1, 'North Platte, NE', 15],
  ['label_created', 'ground', 'Phoenix', 'AZ', 5, 'Phoenix, AZ', 17],
].map(([status, service, city, state, eta, scan, hour], i) => ({
  tracking_number: INBOUND_TRACKING[i],
  status,
  service,
  origin_city: city,
  origin_state: state,
  eta: day(todayMs + eta * DAY),
  last_scan_location: scan,
  last_scan_at: at(todayMs - (status === 'label_created' ? 1 : 0) * DAY, hour, 5 + i * 11),
  delivered_at: null,
  signed_by: null,
  exception_reason: status === 'exception' ? 'Held for a missed linehaul connection, rebooked' : null,
}));
export const SHIPMENTS = [...arrived, ...coming];

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const bounded = (value, fallback, max) => {
  const n = value === null ? fallback : Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};

export function createCarrier() {
  const spec = readFileSync(new URL('./openapi.json', import.meta.url), 'utf8');
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://northbound.invalid');
    const query = url.searchParams;
    if (request.method !== 'GET') return send(response, 405, { error: 'This API only reads.' });
    if (url.pathname === '/openapi.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(spec);
    }
    if (url.pathname === '/v1/shipments') {
      const unknown = [...query.keys()].find((name) => !['offset', 'limit', 'q', 'status', 'sort'].includes(name));
      if (unknown) return send(response, 400, { error: `Unknown parameter "${unknown}".` });
      const sort = query.get('sort') ?? 'eta';
      if (!['eta', '-eta', '-last_scan_at'].includes(sort)) return send(response, 400, { error: `Cannot sort by "${sort}".` });
      const text = query.get('q')?.toLowerCase();
      const field = sort.replace(/^-/, '');
      const rows = SHIPMENTS.filter(
        (row) =>
          (!query.has('status') || query.getAll('status').includes(row.status)) &&
          (!text || [row.tracking_number, row.last_scan_location].some((value) => value.toLowerCase().includes(text))),
      ).sort(
        (a, b) => (sort.startsWith('-') ? -1 : 1) * a[field].localeCompare(b[field]) || a.tracking_number.localeCompare(b.tracking_number),
      );
      const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
      return send(response, 200, rows.slice(offset, offset + bounded(query.get('limit'), 25, 100)));
    }
    const one = /^\/v1\/shipments\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const row = SHIPMENTS.find((each) => each.tracking_number === decodeURIComponent(one[1]));
      return row ? send(response, 200, row) : send(response, 404, { error: 'No such shipment.' });
    }
    send(response, 404, { error: 'No such path.' });
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 4782;
  createCarrier().listen(port, '127.0.0.1', () => {
    console.log(`northbound api: listening on http://127.0.0.1:${port}/v1 (spec at /openapi.json)`);
  });
}
