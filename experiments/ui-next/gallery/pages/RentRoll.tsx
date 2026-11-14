import { ArrowDown, ArrowRight, ArrowUp, Check, Plus, UploadSimple } from '@phosphor-icons/react';
import { Avatar, AvatarFallback } from '@ui-sdk/react/avatar';
import { toast } from '@ui-sdk/react/toast';
import { useCallback, useState } from 'react';
import {
  Button,
  type Column,
  download,
  ExportMenu,
  Facts,
  ImportDialog,
  type ListState,
  listStateFromWords,
  listStateToWords,
  ListView,
  Mark,
  Properties,
  SavedViews,
  SidePanel,
  Stats,
  Status,
  toCsv,
  useSavedViews,
} from '../../src';
import { money, STATUS_TONE, UNITS, type Unit } from '../data';
import { NewHome } from './NewHome';

const ABSENT = (
  <span data-slot="absent" role="img" aria-label="None">
    —
  </span>
);

const COLUMNS: Column<Unit>[] = [
  { id: 'code', header: 'Code', primary: true, cell: (unit) => <Mark>{unit.code}</Mark>, sort: (unit) => unit.code },
  { id: 'building', header: 'Building', cell: (unit) => <Mark>{unit.building}</Mark>, sort: (unit) => unit.building },
  { id: 'beds', header: 'Beds', align: 'end', cell: (unit) => (unit.beds === 0 ? 'Studio' : unit.beds), sort: (unit) => unit.beds },
  { id: 'size', header: 'Size', align: 'end', cell: (unit) => `${unit.size.toLocaleString('en-US')} sq ft`, sort: (unit) => unit.size },
  {
    id: 'rent',
    header: 'Asking rent',
    align: 'end',
    cell: (unit) => money(unit.rent),
    sort: (unit) => unit.rent,
    // Changed where it stands: a press on the cell, or F2 from the row.
    edit: {
      text: (unit) => String(unit.rent),
      check: (text) => (/^\d+$/.test(text) ? undefined : 'A whole number of dollars.'),
      inputMode: 'numeric',
    },
  },
  {
    id: 'per',
    header: 'Per sq ft',
    align: 'end',
    cell: (unit) => `$${(unit.rent / unit.size).toFixed(2)}`,
    sort: (unit) => unit.rent / unit.size,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (unit) => <Status tone={STATUS_TONE[unit.status]}>{unit.status}</Status>,
    sort: (unit) => unit.status,
  },
  {
    id: 'resident',
    header: 'Resident',
    cell: (unit) => (unit.resident ? <Mark>{unit.resident}</Mark> : ABSENT),
    sort: (unit) => unit.resident ?? '',
  },
  { id: 'available', header: 'Available', cell: (unit) => unit.available ?? ABSENT },
  {
    id: 'listed',
    header: 'Listed',
    cell: (unit) => (unit.listed ? <Check data-slot="yes" aria-label="Listed online" weight="bold" /> : ABSENT),
  },
];

const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('');

/* Where the reader stands in the list rides in the address after the room's name (`#rent-roll?tab=vacant`), as
   the real page keeps it in its params: Back from a lease, a reload and a pasted link all find the list as it was. */
const FILTERS = ['building', 'beds', 'status'];
const FIRST: Partial<ListState> = { tab: 'all', sort: { column: 'code', descending: false } };
const UNTOUCHED: ListState = { tab: 'all', search: '', filters: {}, sort: { column: 'code', descending: false }, page: 1 };
const readState = (): Partial<ListState> => {
  const said = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return listStateFromWords((word) => said.get(word) ?? undefined, FILTERS);
};
const keepState = (state: ListState): void => {
  const said = new URLSearchParams();
  for (const [word, value] of Object.entries(listStateToWords(state, FILTERS, FIRST))) if (value) said.set(word, value);
  const query = said.toString();
  window.history.replaceState(null, '', `#rent-roll${query ? `?${query}` : ''}`);
};

const LIVED = UNITS.filter((unit) => unit.resident).length;
const VACANT = UNITS.filter((unit) => unit.status === 'Vacant');
const RENT = UNITS.filter((unit) => unit.resident).reduce((sum, unit) => sum + unit.rent, 0);
const ASKING = UNITS.reduce((sum, unit) => sum + unit.rent, 0);

/* The same page Lintel runs for real (in-app/lintel/pages/rent-roll.page.tsx), on made-up homes: what the roll
   amounts to over the rows, and a home opening beside the list instead of in its place. */
export function RentRoll({ onOpen }: { onOpen: (unit: Unit) => void }) {
  const [peek, setPeek] = useState<string>();
  const [shown, setShown] = useState<Unit[]>([]);
  const heard = useCallback((rows: Unit[]) => setShown(rows), []);
  const home = UNITS.find((unit) => unit.code === peek);
  const at = shown.findIndex((unit) => unit.code === peek);
  const [adding, setAdding] = useState(false);
  const [units, setUnits] = useState(UNITS);
  const [importing, setImporting] = useState(false);
  /* The list is drawn afresh from a view when one is chosen, and tells where it stands as the reader moves it. */
  const [start, setStart] = useState(readState);
  const [turn, setTurn] = useState(0);
  const [state, setState] = useState<ListState>({ ...UNTOUCHED, ...start });
  const [views, setViews] = useSavedViews('gallery-rent-roll');
  const moved = useCallback((next: ListState) => {
    setState(next);
    keepState(next);
  }, []);
  return (
    <>
      <NewHome open={adding} onOpenChange={setAdding} />
      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        title="Import homes"
        fields={[
          {
            id: 'code',
            label: 'Code',
            required: true,
            check: (value) => (/^[A-Z]{2}-\d{3}$/.test(value) ? undefined : 'two letters, a dash and three digits'),
          },
          { id: 'building', label: 'Building', required: true },
          { id: 'beds', label: 'Beds', check: (value) => (/^\d$/.test(value) ? undefined : 'a number from 0 to 9') },
          {
            id: 'rent',
            label: 'Asking rent',
            required: true,
            check: (value) => (/^\d+$/.test(value) ? undefined : 'a whole number of dollars'),
          },
        ]}
        onImport={async (rows) => {
          await new Promise((settle) => window.setTimeout(settle, 600));
          // A code already on the roll is refused by the list itself, after the sheet has passed its own checks.
          const have = new Set(units.map((unit) => unit.code));
          const fresh = rows.filter((row) => !have.has(row.code ?? ''));
          setUnits((now) => [
            ...fresh.map((row) => ({
              code: row.code ?? '',
              building: row.building ?? '',
              beds: Number(row.beds || 1),
              size: 700,
              rent: Number(row.rent),
              status: 'Vacant' as const,
              resident: null,
              available: null,
              listed: false,
            })),
            ...now,
          ]);
          return {
            taken: fresh.length,
            refused: rows.flatMap((row, at) =>
              have.has(row.code ?? '') ? [{ index: at, why: `${row.code} is already on the roll.` }] : [],
            ),
          };
        }}
      />
      <ListView
        title="Rent roll"
        columns={COLUMNS}
        rows={units}
        rowKey={(unit) => unit.code}
        rowName={(unit) => unit.code}
        searchText={(unit) => `${unit.code} ${unit.building} ${unit.resident ?? ''} ${unit.status}`}
        defaultSort={{ column: 'code', descending: false }}
        key={turn}
        initialState={start}
        onStateChange={moved}
        tabs={[
          { value: 'all', label: 'All' },
          { value: 'vacant', label: 'Vacant', match: (unit) => unit.status === 'Vacant' },
          { value: 'turnover', label: 'Turnover', match: (unit) => unit.status === 'Turnover' },
          { value: 'notice', label: 'On notice', match: (unit) => unit.status === 'On notice' },
          { value: 'advertised', label: 'Advertised', match: (unit) => unit.listed },
        ]}
        filters={[
          { id: 'building', label: 'Building', value: (unit) => unit.building },
          { id: 'beds', label: 'Beds', value: (unit) => (unit.beds === 0 ? 'Studio' : `${unit.beds} bed`) },
          { id: 'status', label: 'Status', value: (unit) => unit.status },
        ]}
        actions={
          <>
            <SavedViews
              views={views}
              onViewsChange={setViews}
              state={state}
              first={UNTOUCHED}
              onApply={(next) => {
                setStart(next);
                setState(next);
                keepState(next);
                setTurn((now) => now + 1);
              }}
            />
            <ExportMenu
              items={[
                { value: 'shown', label: `These ${shown.length} rows, as CSV` },
                { value: 'all', label: `All ${units.length} homes, as CSV` },
              ]}
              onAction={(which) => {
                const rows = which === 'shown' ? shown : units;
                download(
                  'rent-roll.csv',
                  toCsv(
                    ['Code', 'Building', 'Beds', 'Size', 'Asking rent', 'Status', 'Resident'],
                    rows.map((unit) => [unit.code, unit.building, unit.beds, unit.size, unit.rent, unit.status, unit.resident]),
                  ),
                );
                toast.success(`rent-roll.csv, ${rows.length} rows`);
              }}
            />
            <Button onClick={() => setImporting(true)}>
              <UploadSimple aria-hidden="true" />
              Import
            </Button>
            <Button intent="primary" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" weight="bold" />
              New home
            </Button>
          </>
        }
        onCellEdit={async (unit, _column, text) => {
          await new Promise((settle) => window.setTimeout(settle, 500));
          // The gallery's one rule, so a refused save can be seen: nothing over the ceiling.
          if (Number(text) > 5000) throw new Error('Over the ceiling of $5,000.');
          setUnits((now) => now.map((each) => (each.code === unit.code ? { ...each, rent: Number(text) } : each)));
        }}
        hrefOf={() => '#lease'}
        onOpen={(unit) => setPeek(unit.code)}
        current={peek}
        onShownChange={heard}
        summary={
          <Stats
            items={[
              {
                label: 'Occupancy',
                value: `${Math.round((LIVED / UNITS.length) * 100)}%`,
                share: LIVED / UNITS.length,
                note: `${LIVED} of ${UNITS.length} homes lived in`,
              },
              {
                label: 'Vacant',
                value: VACANT.length,
                tone: 'warning',
                note: `${VACANT.filter((unit) => unit.listed).length} listed online, ${VACANT.filter((unit) => !unit.listed).length} not yet`,
              },
              { label: 'Rent this month', value: money(RENT), share: RENT / ASKING, note: `of ${money(ASKING)} if every home were let` },
              { label: 'Balance due', value: '$2,645', tone: 'warning', note: '1 lease is behind' },
            ]}
          />
        }
        rowActions={[
          { value: 'Open', label: 'Open' },
          { value: 'Advertise', label: 'Advertise online' },
          { value: 'Schedule a viewing', label: 'Schedule a viewing' },
          { value: 'Archive', label: 'Archive', separated: true },
        ]}
        onRowAction={(action, unit) => (action === 'Open' ? setPeek(unit.code) : toast(`${action}: ${unit.code}`))}
        bulkActions={[
          { value: 'Advertise', label: 'Advertise' },
          { value: 'Export', label: 'Export' },
        ]}
        onBulkAction={(action, keys) => toast(`${action}: ${keys.length} ${keys.length === 1 ? 'home' : 'homes'}`)}
      />
      <SidePanel
        beside
        open={home !== undefined}
        onOpenChange={(next) => {
          if (!next) setPeek(undefined);
        }}
        title={home?.code ?? 'Home'}
        description={home?.building}
        footer={
          <>
            <span data-part="stepper">
              <Button aria-label="Previous home" disabled={at <= 0} onClick={() => setPeek(shown[at - 1]?.code)}>
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button aria-label="Next home" disabled={at < 0 || at >= shown.length - 1} onClick={() => setPeek(shown[at + 1]?.code)}>
                <ArrowDown aria-hidden="true" />
              </Button>
              {at >= 0 && (
                <small>
                  {at + 1} of {shown.length}
                </small>
              )}
            </span>
            {home?.resident && (
              <Button intent="primary" onClick={() => onOpen(home)}>
                Open lease
                <ArrowRight aria-hidden="true" />
              </Button>
            )}
          </>
        }
      >
        {home && (
          <div data-part="peek">
            <Status tone={STATUS_TONE[home.status]}>{home.status}</Status>
            <Facts
              items={[
                { label: 'Beds', value: home.beds === 0 ? 'Studio' : `${home.beds} bed` },
                { label: 'Size', value: `${home.size.toLocaleString('en-US')} sq ft` },
                { label: 'Asking rent', value: money(home.rent) },
                { label: 'Per sq ft', value: `$${(home.rent / home.size).toFixed(2)}` },
              ]}
            />
            {home.resident ? (
              <Properties
                title="Resident"
                name={home.resident}
                avatar={
                  <Avatar data-size="sm">
                    <AvatarFallback aria-hidden="true">{initials(home.resident)}</AvatarFallback>
                  </Avatar>
                }
                items={[
                  { label: 'Rent', value: `${money(home.rent)} a month` },
                  { label: 'Balance', value: 'Paid up' },
                ]}
              />
            ) : (
              <Properties
                title="Letting"
                items={[
                  { label: 'Available', value: home.available ?? 'Not set' },
                  { label: 'Listed', value: home.listed ? 'Online now' : 'Not yet' },
                ]}
              />
            )}
          </div>
        )}
      </SidePanel>
    </>
  );
}
