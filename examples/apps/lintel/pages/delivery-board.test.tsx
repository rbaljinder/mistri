/**
 * The delivery board's reads, drawn as the storeroom sees them: parcels from the carrier's API matched to the
 * deliveries booked in, what needs a look, and a reader the carrier refuses, who still has the records.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test, vi } from 'vitest';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import { state } from '@mistriwork/kit/client/core.js';
import page from './delivery-board.page.tsx';

/* The blocks read the App's catalog, which a rendered page has none of: the one table the calendar reads. */
const column = (name: string, primaryKey = false) => ({ name, type: 'TEXT', nullable: !primaryKey, primaryKey });
(state as { schema: unknown }).schema = {
  tables: [
    {
      id: 'part_receipt',
      name: 'part_receipt',
      schema: '',
      isView: false,
      columns: ['id', 'received_on', 'vendor', 'part_id', 'quantity', 'tracking_number'].map((name) => column(name, name === 'id')),
    },
  ],
  /* None of its columns points anywhere; the calendar's question still asks which do, to name them. */
  foreignKeys: [],
};

/* The calendar is the list views' own room, which reads through the shell this test does not have: stood in for, to see what it is asked. */
const room = vi.hoisted(() => vi.fn());
vi.mock('@mistriwork/kit/client/components/TableRoom.js', () => ({
  TableRoom: (props: object) => {
    room(props);
    return <p>The calendar room</p>;
  },
}));

const viewer = { signedIn: true, account: 'storeroom' };
const DAY = 86_400_000;
const zone = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + offset * DAY),
  );
const parcel = (tracking_number: string, status: string, eta: number, extra: Record<string, unknown> = {}) => ({
  tracking_number,
  status,
  eta: zone(eta),
  last_scan_location: 'Cheyenne, WY',
  last_scan_at: new Date().toISOString(),
  delivered_at: null,
  exception_reason: null,
  ...extra,
});
const shipments = [
  parcel('NB1000000001', 'in_transit', 2),
  parcel('NB1000000002', 'out_for_delivery', 0),
  parcel('NB1000000003', 'exception', -1, { exception_reason: 'Held for a missed connection' }),
  parcel('NB1000000004', 'delivered', -3, { delivered_at: new Date(Date.now() - 3 * DAY).toISOString() }),
  parcel('NB1000000005', 'delivered', -5, { delivered_at: new Date(Date.now() - 5 * DAY).toISOString() }),
];
const receipts = [
  { 'part_id.name': 'GFCI outlet', quantity: 6, vendor: 'Front Range Supply', received_on: zone(-5), tracking_number: 'NB1000000005' },
];

/** Fixtures whose named table cannot be read, as the server's 403 for a role without the grant would reject it. */
function refused(good: ReturnType<typeof fixtures>, table: string) {
  const tables = new Proxy(good.tables, {
    get(target, name) {
      if (name === table) throw Object.assign(new Error('Not yours to read.'), { status: 403 });
      return Reflect.get(target, name);
    },
  });
  return { ...good, tables };
}

test('says what is on its way, soonest first, with the last scan', async () => {
  const view = renderPage(page, { viewer, data: fixtures({ 'carrier.shipments': shipments, part_receipt: receipts }) });
  const way = await view.findByRole('table', { name: 'Parcels on their way' });
  const rows = way.querySelectorAll('tbody tr');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('NB1000000002');
  expect(rows[1]).toHaveTextContent('NB1000000001');
  expect(rows[0]).toHaveTextContent('Cheyenne, WY');
});

test('a held parcel and a delivery nobody booked in need a look, with the carrier’s words', async () => {
  const view = renderPage(page, { viewer, data: fixtures({ 'carrier.shipments': shipments, part_receipt: receipts }) });
  const look = await view.findByRole('table', { name: 'Parcels that need a look' });
  expect(look).toHaveTextContent('Held for a missed connection');
  expect(look).toHaveTextContent('NB1000000004');
  expect(look).toHaveTextContent('Delivered to the dock and not booked in.');
  expect(look).not.toHaveTextContent('NB1000000005');
});

test('a delivery is matched to its shipment by tracking number', async () => {
  const view = renderPage(page, { viewer, data: fixtures({ 'carrier.shipments': shipments, part_receipt: receipts }) });
  const arrived = await view.findByRole('table', { name: 'Deliveries received lately' });
  expect(arrived).toHaveTextContent('GFCI outlet');
  expect(arrived).toHaveTextContent('delivered');
});

test('with nothing to report, each part says so', async () => {
  const view = renderPage(page, { viewer, data: fixtures({ 'carrier.shipments': [], part_receipt: [] }) });
  expect(await view.findAllByText('No parcels on file')).toHaveLength(2);
  expect(view.getByText('No deliveries yet')).toBeInTheDocument();
});

test('a reader the carrier refuses still has the records, and is told why the parcels are missing', async () => {
  const data = refused(fixtures({ 'carrier.shipments': shipments, part_receipt: receipts }), 'carrier.shipments');
  const view = renderPage(page, { viewer, data });
  expect(await view.findByRole('table', { name: 'Deliveries received lately' })).toHaveTextContent('Front Range Supply');
  expect(view.getAllByText('The carrier’s tracking is not open to you')).toHaveLength(2);
  expect(view.getByText('Not available')).toBeInTheDocument();
});

test('records that cannot be read offer Try again, not "No deliveries yet"', async () => {
  const data = refused(fixtures({ 'carrier.shipments': shipments, part_receipt: receipts }), 'part_receipt');
  const view = renderPage(page, { viewer, data });
  expect(await view.findAllByRole('button', { name: 'Try again' })).not.toHaveLength(0);
  expect(view.queryByText('No deliveries yet')).toBeNull();
});

test('the deliveries also stand on a calendar, the list views’ own, asked of the read the page already holds', async () => {
  const view = renderPage(page, { viewer, data: fixtures({ 'carrier.shipments': shipments, part_receipt: receipts }) });
  expect(await view.findByText('The calendar room')).toBeInTheDocument();
  expect(room).toHaveBeenCalledWith(
    expect.objectContaining({
      /* The read asks for what the calendar draws — its date, its title through the part, its line — and the id it opens by. */
      entry: { kind: 'table', table: 'part_receipt', query: 'part_receipt show received_on, part_id.name, vendor, id' },
      presentation: { kind: 'calendar', date: 'received_on', primary: 'part_id.name', lines: ['vendor'] },
      listLabel: 'Deliveries by day',
    }),
  );
});
