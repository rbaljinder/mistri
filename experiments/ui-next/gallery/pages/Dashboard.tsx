import { toast } from '@ui-sdk/react/toast';
import { useEffect, useState } from 'react';
import { BarList, Chart, DashBlock, DashGrid, Funnel, Metrics, SegmentBar, SelectField } from '../../src';
import { money } from '../data';

/* A dashboard the way Lintel's office would read one: one period for everything on the page, the figures first,
   then how they moved. The numbers are made up and add up: what is collected and what is owed are the two parts
   of what was charged. */
const MONTHS = ['Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'];
const COLLECTED = [61200, 62850, 62100, 64400, 65950, 66300, 67800, 68150, 69400, 70250, 71900, 72640];
const OWED = [3100, 2450, 3900, 2800, 2150, 2600, 1900, 2350, 2050, 1700, 2400, 2645];
const OPENED = [14, 19, 22, 17, 12, 11, 9, 13, 10, 12, 16, 18];
const CLOSED = [12, 17, 20, 21, 14, 10, 11, 12, 9, 13, 14, 15];
const OCCUPANCY = [89, 90, 90, 91, 92, 94, 94, 95, 94, 95, 96, 96];

const PERIODS = [
  { value: '12', label: 'Last 12 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '3', label: 'Last 3 months' },
];

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const moved = (values: number[]) => (values[11] as number) / (values[10] as number) - 1;

export function Dashboard() {
  const [period, setPeriod] = useState('12');
  const [reading, setReading] = useState(false);
  const months = Number(period);
  const take = (values: number[]): number[] => values.slice(-months);
  const names = MONTHS.slice(-months);

  // A change of period reads the numbers again: what was drawn stays, dimmed, until they are in.
  useEffect(() => {
    setReading(true);
    const done = window.setTimeout(() => setReading(false), 450);
    return () => window.clearTimeout(done);
  }, [period]);

  const collected = take(COLLECTED);
  const owed = take(OWED);
  const open = (what: string) => toast(`${what} would open here`);

  return (
    <div data-part="today">
      <header data-slot="list-head">
        <h1>
          Books <span data-slot="list-count">Lintel, all buildings</span>
        </h1>
      </header>
      {/* One period for the page, above everything it scopes, so every number on it agrees. */}
      <div data-part="dash-filters">
        <SelectField
          label="Period"
          labelHidden
          options={PERIODS}
          value={period}
          onValueChange={(value) => typeof value === 'string' && setPeriod(value)}
        />
      </div>
      <Metrics
        label="This month"
        loading={reading}
        items={[
          {
            label: 'Collected in November',
            value: money(COLLECTED[11] as number),
            delta: moved(COLLECTED),
            against: 'vs October',
            trend: collected,
            onOpen: () => open('Payments in November'),
          },
          {
            label: 'Owed and overdue',
            value: money(OWED[11] as number),
            delta: moved(OWED),
            against: 'vs October',
            upIsGood: false,
            trend: owed,
            onOpen: () => open('Leases behind'),
          },
          { label: 'Homes lived in', value: '96%', delta: 0, against: 'vs October', trend: take(OCCUPANCY), note: '53 of 55 homes' },
          {
            label: 'Repairs open',
            value: '9',
            delta: -0.25,
            against: 'vs October',
            upIsGood: false,
            trend: take(OPENED),
            onOpen: () => (window.location.hash = 'repairs'),
          },
        ]}
      />
      <DashGrid>
        <DashBlock wide>
          <Chart
            title="Rent charged"
            note={`Collected and still owed, by month. ${money(sum(collected))} came in.`}
            kind="stacked"
            categories={names}
            series={[
              { id: 'collected', label: 'Collected', values: collected },
              { id: 'owed', label: 'Owed', values: owed },
            ]}
            format={money}
            axisFormat={(value) => (value === 0 ? '0' : `$${value / 1000}K`)}
            loading={reading}
            onPick={(at) => open(`Charges in ${names[at]}`)}
          />
        </DashBlock>
        <DashBlock>
          <Chart
            title="Repairs"
            note="Reported and closed, by month"
            kind="line"
            categories={names}
            series={[
              { id: 'opened', label: 'Reported', values: take(OPENED) },
              { id: 'closed', label: 'Closed', values: take(CLOSED) },
            ]}
            height={200}
            loading={reading}
          />
        </DashBlock>
        <DashBlock>
          <Chart
            title="Homes lived in"
            note="Share of all homes, at month end"
            kind="area"
            categories={names}
            series={[{ id: 'occupancy', label: 'Lived in', values: take(OCCUPANCY) }]}
            format={(value) => `${value}%`}
            axisFormat={(value) => `${value}%`}
            height={200}
            loading={reading}
          />
        </DashBlock>
        <DashBlock title="Collected by building">
          <BarList
            label="Collected by building"
            format={money}
            share
            most={4}
            onPick={(row) => open(`Payments at ${row.label}`)}
            rows={[
              { id: 'ac', label: 'Alder Court', value: 21840 },
              { id: 'bh', label: 'Birch House', value: 18260 },
              { id: 'cm', label: 'Cedar Mews', value: 14900 },
              { id: 'dl', label: 'Dunlin Lofts', value: 9720 },
              { id: 'ew', label: 'Elm Walk', value: 5480 },
              { id: 'fr', label: 'Fern Row', value: 2440 },
            ]}
          />
        </DashBlock>
        <DashBlock title="From enquiry to lease">
          <Funnel
            label="From enquiry to lease"
            stages={[
              { id: 'enquiry', label: 'Enquiries', value: 184 },
              { id: 'viewing', label: 'Viewings', value: 96 },
              { id: 'application', label: 'Applications', value: 41 },
              { id: 'lease', label: 'Leases signed', value: 23 },
            ]}
          />
        </DashBlock>
        <DashBlock title="Where November's charges stand">
          <SegmentBar
            label="Where November's charges stand"
            format={money}
            parts={[
              { id: 'paid', label: 'Paid on time', value: 66180 },
              { id: 'late', label: 'Paid late', value: 6460 },
              { id: 'owed', label: 'Still owed', value: 2645 },
            ]}
          />
        </DashBlock>
      </DashGrid>
    </div>
  );
}
