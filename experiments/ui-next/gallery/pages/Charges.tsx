import { toast } from '@ui-sdk/react/toast';
import { type Column, ListView, Mark, Status } from '../../src';
import { money, UNITS } from '../data';

/* Ten thousand charges in one table, to see what a long list costs: it is not paged, it scrolls in its own box
   under a head and over a total that stay, and only the rows in view are drawn. The rows are made, not random,
   so the room is the same every time. */
type Charge = { id: string; home: string; what: string; due: string; amount: number; status: 'Open' | 'Paid' | 'Late' };
const WHAT = ['Rent', 'Late fee', 'Water', 'Parking', 'Key fob', 'Repair recharge', 'Storage', 'Pet rent'];
const AMOUNT = [1285, 75, 42, 60, 25, 180, 35, 50];
const CHARGES: Charge[] = Array.from({ length: 10_000 }, (_, at) => {
  const unit = UNITS[(at * 7) % UNITS.length]!;
  const kind = (at * 5 + (at % 3)) % WHAT.length;
  const month = (at * 11) % 24;
  const due = new Date(Date.UTC(2025, month, 1 + ((at * 3) % 27)));
  return {
    id: `CH-${String(at + 1).padStart(5, '0')}`,
    home: unit.code,
    what: WHAT[kind]!,
    due: due.toISOString().slice(0, 10),
    amount: kind === 0 ? unit.rent : AMOUNT[kind]! + (at % 4) * 5,
    status: at % 17 === 0 ? 'Late' : at % 5 === 0 ? 'Open' : 'Paid',
  };
});
const said = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const COLUMNS: Column<Charge>[] = [
  { id: 'id', header: 'Charge', primary: true, cell: (charge) => <Mark>{charge.id}</Mark>, sort: (charge) => charge.id },
  { id: 'home', header: 'Home', cell: (charge) => <Mark>{charge.home}</Mark>, sort: (charge) => charge.home },
  { id: 'what', header: 'For', cell: (charge) => <Mark>{charge.what}</Mark>, sort: (charge) => charge.what },
  { id: 'due', header: 'Due', cell: (charge) => said(charge.due), sort: (charge) => charge.due },
  {
    id: 'amount',
    header: 'Amount',
    align: 'end',
    cell: (charge) => money(charge.amount),
    sort: (charge) => charge.amount,
    total: (rows) => money(rows.reduce((sum, charge) => sum + charge.amount, 0)),
  },
  {
    id: 'status',
    header: 'Status',
    cell: (charge) => (
      <Status tone={charge.status === 'Paid' ? 'good' : charge.status === 'Late' ? 'critical' : 'warning'}>{charge.status}</Status>
    ),
    sort: (charge) => charge.status,
  },
];

export function Charges() {
  return (
    <ListView
      title="Charges"
      columns={COLUMNS}
      rows={CHARGES}
      rowKey={(charge) => charge.id}
      rowName={(charge) => charge.id}
      searchText={(charge) => `${charge.id} ${charge.home} ${charge.what}`}
      defaultSort={{ column: 'id', descending: false }}
      height="62dvh"
      pinFirst
      tabs={[
        { value: 'all', label: 'All' },
        { value: 'open', label: 'Open', match: (charge) => charge.status === 'Open' },
        { value: 'late', label: 'Late', match: (charge) => charge.status === 'Late' },
        { value: 'paid', label: 'Paid', match: (charge) => charge.status === 'Paid' },
      ]}
      filters={[
        { id: 'what', label: 'For', value: (charge) => charge.what },
        { id: 'home', label: 'Home', value: (charge) => charge.home },
      ]}
      bulkActions={[{ value: 'remind', label: 'Send a reminder' }]}
      onBulkAction={(_action, keys) => toast(`A reminder would go out for ${keys.length.toLocaleString()} charges`)}
      onOpen={(charge) => toast(`${charge.id} would open here`)}
    />
  );
}
