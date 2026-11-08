/**
 * The storeroom's delivery board: what is on its way, what needs a look, and what came in lately.
 *
 * Lintel's first free-form room, and it reads two kinds of source at once: the deliveries are Lintel's own rows
 * (`part_receipt`, in PostgreSQL) and the parcels are Northbound Freight's API (`carrier.shipments`, read over HTTP).
 * A delivery carries its carrier's `tracking_number`, but a reference cannot cross sources yet, so the two reads are
 * matched here, on the client, by that number. The page declares both and the server holds each request to the
 * reader's grants as it does any list's; a read the carrier refuses is said in its place and the records still draw.
 *
 * The page stays hand-built for what it mixes: a `<Board>` lays out one resource's rows by a column, and here a row of
 * one source is matched to a row of another. The deliveries also stand on a month, as the list views' `<Calendar>`.
 */
import type { ReactNode } from 'react';
import {
  Calendar,
  Card,
  Cluster,
  definePage,
  Empty,
  Grid,
  Loaded,
  Panel,
  Stack,
  Stat,
  Table,
  useFormat,
  useSectionSize,
  Value,
  type TableColumn,
} from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Delivery board',
  description: 'What the carrier has on its way to the storeroom, and what has come in.',
  icon: 'truck',
  nav: { group: 'maintenance', position: 4 },
  roles: ['manager', 'admin', 'technician'],
  reads: ['part_receipt', 'carrier.shipments'],
  component: DeliveryBoard,
});
export default page;

const DAY = 86_400_000;
/** A day as `YYYY-MM-DD` in the App's zone (`ui.timezone`), so "today" turns over when the shop's day does. */
const dayKey = (at: Date, timeZone: string | undefined) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const day = (value: unknown) => String(value ?? '').slice(0, 10);

const MOVING = ['in_transit', 'out_for_delivery'];

/** The reader was refused the read itself (not a failure of it): the carrier's API is granted whole or not at all. */
const refusedBy = (query: { data: unknown; error: unknown }) =>
  query.data === undefined && [401, 403].includes((query.error as { status?: number } | null)?.status ?? 0);

function DeliveryBoard(): ReactNode {
  const format = useFormat();
  // A phone has room for one column: each row then says all of itself in its first cell, and nothing scrolls sideways.
  const { compact } = useSectionSize();
  const shipments = page.useRows('carrier.shipments', {
    show: ['tracking_number', 'status', 'eta', 'last_scan_location', 'last_scan_at', 'delivered_at', 'exception_reason'],
    sort: 'eta',
    limit: 100,
  });
  const receipts = page.useRows('part_receipt', {
    show: ['part_id.name', 'quantity', 'vendor', 'received_on', 'tracking_number'],
    sort: 'received_on desc',
    limit: 50,
  });
  type Parcel = NonNullable<typeof shipments.data>[number];
  type Delivery = NonNullable<typeof receipts.data>[number];

  const today = dayKey(new Date(), format.timezone);
  const since = dayKey(new Date(Date.parse(`${today}T00:00:00Z`) - 30 * DAY), format.timezone);
  const refused = refusedBy(shipments);
  const parcels = shipments.data ?? [];
  const received = receipts.data ?? [];
  const byTracking = new Map(parcels.map((parcel) => [parcel.tracking_number, parcel]));
  const booked = new Set(received.map((delivery) => delivery.tracking_number));

  const onItsWay = parcels
    .filter((parcel) => parcel.status === 'label_created' || MOVING.includes(parcel.status))
    .sort((a, b) => String(a.eta).localeCompare(String(b.eta)));
  const dueToday = onItsWay.filter((parcel) => MOVING.includes(parcel.status) && day(parcel.eta) === today);
  const looks: { parcel: Parcel; why: string }[] = [
    ...parcels
      .filter((parcel) => parcel.status === 'exception')
      .map((parcel) => ({ parcel, why: parcel.exception_reason ?? 'The carrier reports an exception.' })),
    ...onItsWay
      .filter((parcel) => day(parcel.eta) < today)
      .map((parcel) => ({ parcel, why: `Due ${format.relative(day(parcel.eta)) ?? format.date(day(parcel.eta))}, not here yet.` })),
    // Handed over at the dock, and nobody has booked it in yet.
    ...parcels
      .filter((parcel) => parcel.status === 'delivered' && !booked.has(parcel.tracking_number) && day(parcel.delivered_at) >= since)
      .map((parcel) => ({ parcel, why: 'Delivered to the dock and not booked in.' })),
  ];
  const lately = received.filter((delivery) => day(delivery.received_on) >= since);

  const status = (parcel: Parcel) => <Value value={parcel.status} resource="carrier.shipments" column="status" compact />;
  const eta = (parcel: Parcel) => <Value value={parcel.eta} resource="carrier.shipments" column="eta" compact />;
  const scan = (parcel: Parcel) =>
    `${parcel.last_scan_location ?? 'No scan yet'}${parcel.last_scan_at ? ` · ${format.dateTime(parcel.last_scan_at)}` : ''}`;
  const carrierSays = (row: Delivery) => {
    const parcel = row.tracking_number ? byTracking.get(row.tracking_number) : undefined;
    return parcel ? status(parcel) : <span>{refused ? 'Not available' : row.tracking_number ? 'No such parcel' : '—'}</span>;
  };
  const none = <Empty title="No parcels on file" description="The carrier has none to report for the storeroom." />;

  const lookColumns: TableColumn<(typeof looks)[number]>[] = [
    {
      key: 'tracking',
      label: 'Shipment',
      render: (row) => (
        <Stack gap="tight">
          <strong>{row.parcel.tracking_number}</strong>
          <span>{row.why}</span>
          {compact && status(row.parcel)}
        </Stack>
      ),
    },
    ...(compact ? [] : [{ key: 'status', label: 'Status', render: (row: (typeof looks)[number]) => status(row.parcel) }]),
  ];
  const wayColumns: TableColumn<Parcel>[] = [
    {
      key: 'tracking_number',
      label: 'Shipment',
      render: (row) => (
        <Stack gap="tight">
          <strong>{row.tracking_number}</strong>
          <span>{scan(row)}</span>
          {compact && (
            <span>
              {status(row)} · {eta(row)}
            </span>
          )}
        </Stack>
      ),
    },
    ...(compact
      ? []
      : [
          { key: 'status', label: 'Status', render: status },
          { key: 'eta', label: 'Estimated', render: eta },
        ]),
  ];
  const arrivedColumns: TableColumn<Delivery>[] = [
    {
      key: 'part_id.name',
      label: 'Part',
      render: (row) => (
        <Stack gap="tight">
          <strong>{String(row['part_id.name'])}</strong>
          {compact && (
            <span>
              {row.quantity} from {row.vendor} · {format.date(day(row.received_on))}
            </span>
          )}
          {compact && carrierSays(row)}
        </Stack>
      ),
    },
    ...(compact
      ? []
      : [
          { key: 'quantity', label: 'Qty', align: 'right' as const },
          { key: 'vendor', label: 'From' },
          { key: 'received_on', label: 'Received', resource: 'part_receipt', column: 'received_on' },
          { key: 'tracking_number', label: 'Carrier says', render: carrierSays },
        ]),
  ];

  return (
    <Stack gap="section">
      <Cluster min="9rem">
        <Stat label="On its way" value={shipments.data ? onItsWay.length : '–'} />
        <Stat label="Arriving today" value={shipments.data ? dueToday.length : '–'} />
        <Stat label="Needs a look" value={shipments.data ? looks.length : '–'} />
        <Stat label="Received, 30 days" value={receipts.data ? lately.length : '–'} />
      </Cluster>
      <Grid>
        <Panel title="Needs a look" width="full">
          {refused ? (
            <CarrierRefused />
          ) : (
            <Loaded query={shipments} height={96} empty={none}>
              {() =>
                looks.length === 0 ? (
                  <Empty title="Nothing late or held" description="Every parcel the carrier lists is moving or has been booked in." />
                ) : (
                  <Table label="Parcels that need a look" rows={looks} rowKey={(row) => row.parcel.tracking_number} columns={lookColumns} />
                )
              }
            </Loaded>
          )}
        </Panel>
        <Panel title="On its way" width="full">
          {refused ? (
            <CarrierRefused />
          ) : (
            <Loaded query={shipments} height={160} empty={none}>
              {() =>
                onItsWay.length === 0 ? (
                  <Empty title="Nothing on its way" description="Every parcel the carrier lists has been delivered." />
                ) : (
                  <Table label="Parcels on their way" rows={onItsWay} rowKey={(row) => row.tracking_number} columns={wayColumns} />
                )
              }
            </Loaded>
          )}
        </Panel>
        <Panel title="Recently received" width="full">
          <Loaded
            query={receipts}
            height={160}
            empty={<Empty title="No deliveries yet" description="Book a delivery in under Parts deliveries and it shows here." />}
          >
            {() =>
              lately.length === 0 ? (
                <Empty title="Nothing received in 30 days" description="Older deliveries are under Parts deliveries." />
              ) : (
                <Table
                  label="Deliveries received lately"
                  rows={lately}
                  rowKey={(row) => `${row.tracking_number ?? ''}${row.received_on}${row['part_id.name']}`}
                  columns={arrivedColumns}
                />
              )
            }
          </Loaded>
        </Panel>
        {/* The same deliveries on the month they fell in: the list views' calendar, asked of the one read the page already holds. */}
        <Panel title="Deliveries by day" width="full">
          <Calendar from="part_receipt" date="received_on" primary="part_id.name" lines={['vendor']} label="Deliveries by day" />
        </Panel>
      </Grid>
    </Stack>
  );
}

/** A reader without the carrier's grant still has the records: only the parcels are said to be closed. */
function CarrierRefused(): ReactNode {
  return (
    <Card>
      <Empty title="The carrier’s tracking is not open to you" description="Deliveries booked in are still listed below." />
    </Card>
  );
}
