/**
 * Lintel's rent roll, drawn whole by ui-next: a free-form page at /rent-roll, beside the App's own list at /units.
 *
 * It is not that list in other clothes. What an office asks of a rent roll comes first: how full the buildings
 * are, what is empty, what the month is worth and who is behind, said as four figures over the rows. A home opens
 * beside the list rather than in its place, so reading down a building is one press a home and the list never
 * loses its place; the panel steps to the next home in the order the list stands in, and the home it shows is in
 * the address (`?home=12`), so a link opens it. The lease behind a home is one press further.
 *
 * Where the window has room the panel takes nothing from the list: the rows under it still answer, so pressing
 * another home changes what the panel shows, and J and K step it. And where the reader stands in the list (the
 * tab, the search, the filters, the order, the page, the columns chosen) is in the address too, in the App's own
 * words (`?tab=behind&building=Birchwood+Lofts&sort=-rent`), so coming Back from a lease finds the list as it was
 * left.
 *
 * It reads through the page's own reads, under the reader's grants: the homes, the leases that are current and
 * the residents. All of it is in hand at once (54 homes), so the tabs, the search, the filters and the sort are
 * the page's. A rent roll of ten thousand would ask the server those questions instead.
 */
import { definePage, useHref, useNavigate } from '@mistriwork/mistri/page';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Avatar,
  AvatarFallback,
  Button,
  Check,
  type Column,
  DownloadSimple,
  Facts,
  ListView,
  type ListState,
  listStateFromWords,
  listStateToWords,
  Mark,
  Properties,
  SidePanel,
  Stats,
  Status,
  toast,
  Toaster,
  type Tone,
} from '../ui';
import '../../../src/theme/list.css';
import '../../../src/theme/record.css';
import '../lintel.css';
import { beds, day, daysUntil, fromNow, initials, money, type Row, saveCsv, text, words } from '../format';

const page = definePage({
  label: 'Rent roll, ui-next',
  description: 'Every home, who lives in it and what it is worth, with the lease one press away.',
  icon: 'buildings',
  nav: { group: 'leasing', position: 0 },
  head: false,
  reads: ['unit', 'property', 'lease', 'resident'],
  params: {
    home: 'id',
    tab: 'text',
    search: 'text',
    sort: 'text',
    cols: 'text',
    building: 'text',
    beds: 'text',
    status: 'text',
  },
  component: RentRoll,
});
export default page;

const TONE: Record<string, Tone> = { occupied: 'good', vacant: 'warning', notice: 'info', turnover: 'neutral' };
const SAID: Record<string, string> = { notice: 'On notice' };
const status = (value: unknown) => SAID[text(value)] ?? words(value);

const ABSENT = (
  <span data-slot="absent" role="img" aria-label="None">
    —
  </span>
);

type Home = Row & { lease?: Row; person?: Row };

function Person({ home }: { home: Home }) {
  if (!home.person) return ABSENT;
  return (
    <span data-part="person">
      <Avatar data-size="sm">
        <AvatarFallback aria-hidden="true">{initials(home.person.name)}</AvatarFallback>
      </Avatar>
      <Mark>{text(home.person.name)}</Mark>
    </span>
  );
}

const COLUMNS: Column<Home>[] = [
  { id: 'code', header: 'Home', primary: true, cell: (home) => <Mark>{text(home.code)}</Mark>, sort: (home) => text(home.code) },
  {
    id: 'building',
    header: 'Building',
    cell: (home) => <Mark>{text(home['property_id.name'])}</Mark>,
    sort: (home) => text(home['property_id.name']),
  },
  {
    id: 'beds',
    header: 'Beds',
    align: 'end',
    cell: (home) => (Number(home.bedrooms) === 0 ? 'Studio' : text(home.bedrooms)),
    sort: (home) => Number(home.bedrooms),
  },
  {
    id: 'size',
    header: 'Size',
    align: 'end',
    cell: (home) => `${Number(home.sqft).toLocaleString('en-US')} sq ft`,
    sort: (home) => Number(home.sqft),
  },
  { id: 'rent', header: 'Asking rent', align: 'end', cell: (home) => money(home.market_rent), sort: (home) => Number(home.market_rent) },
  {
    id: 'status',
    header: 'Status',
    cell: (home) => <Status tone={TONE[text(home.status)] ?? 'neutral'}>{status(home.status)}</Status>,
    sort: (home) => text(home.status),
  },
  { id: 'resident', header: 'Resident', cell: (home) => <Person home={home} />, sort: (home) => text(home.person?.name) },
  {
    id: 'available',
    header: 'Available',
    cell: (home) =>
      home.available_on ? (
        <span data-part="when">
          {day(home.available_on, false)}
          <small>{fromNow(home.available_on)}</small>
        </span>
      ) : (
        ABSENT
      ),
    sort: (home) => text(home.available_on) || '9999',
  },
  {
    id: 'listed',
    header: 'Listed',
    cell: (home) => (home.listed ? <Check data-slot="yes" aria-label="Listed online" weight="bold" /> : ABSENT),
  },
];

const key = (home: Row) => text(home.id);

/* The list's state as the address says it: these words, and a filter's by its own name. */
const FILTERS = ['building', 'beds', 'status'];
const FIRST: Partial<ListState> = { tab: 'all', sort: { column: 'code', descending: false } };

/* The homes as a file, and a word that it was written: an export that says nothing leaves the reader looking for it. */
function exportHomes(homes: Home[]): void {
  saveCsv(
    'rent-roll.csv',
    ['Home', 'Building', 'Beds', 'Sq ft', 'Asking rent', 'Status', 'Resident', 'Available'],
    homes.map((one) => [
      one.code,
      one['property_id.name'],
      one.bedrooms,
      one.sqft,
      Number(one.market_rent) / 100,
      status(one.status),
      one.person?.name,
      one.available_on,
    ]),
  );
  toast.success('rent-roll.csv saved', { description: `${homes.length} ${homes.length === 1 ? 'home' : 'homes'}, as the list stood.` });
}

function RentRoll(): ReactNode {
  const nav = useNavigate();
  const href = useHref();
  const [open, setOpen] = page.useParam('home');
  const [shown, setShown] = useState<Home[]>([]);

  /* Each word of the list's state is a param of the page, asked for once each as a hook must be. The list starts
     from what the address says and tells every change back; only a word that changed is written. A page may have
     eight params, and the home, four words and three filters are eight, so the page of the list is the one word
     left out: a list reopened starts at its first page, unless a home is open, which turns the list to its row. */
  const words = {
    tab: page.useParam('tab'),
    search: page.useParam('search'),
    sort: page.useParam('sort'),
    cols: page.useParam('cols'),
    building: page.useParam('building'),
    beds: page.useParam('beds'),
    status: page.useParam('status'),
  };
  const said = useRef(words);
  said.current = words;
  const [first] = useState(() => listStateFromWords((word) => words[word as keyof typeof words]?.[0], FILTERS));
  const keep = useCallback((state: ListState) => {
    const next = listStateToWords(state, FILTERS, FIRST);
    for (const [word, [now, set]] of Object.entries(said.current)) if (now !== next[word]) set(next[word]);
  }, []);

  const units = page.useRows('unit', {
    show: [
      'code',
      'number',
      'floor',
      'property_id.name',
      'bedrooms',
      'bathrooms',
      'sqft',
      'market_rent',
      'status',
      'available_on',
      'listed',
    ],
    sort: 'code',
    limit: 500,
  });
  const leases = page.useRows('lease', {
    query: 'current',
    show: ['unit_id', 'resident_id', 'rent', 'start_on', 'end_on', 'status', 'balance'],
    limit: 500,
  });
  const residents = page.useRows('resident', { show: ['name', 'email', 'phone', 'since'], limit: 500 });

  const homes = useMemo<Home[]>(() => {
    const byHome = new Map((leases.data ?? []).map((lease: Row) => [text(lease.unit_id), lease]));
    const people = new Map((residents.data ?? []).map((person: Row) => [text(person.id), person]));
    return (units.data ?? []).map((unit: Row) => {
      const lease = byHome.get(text(unit.id));
      return { ...unit, lease, person: lease ? people.get(text(lease.resident_id)) : undefined };
    });
  }, [units.data, leases.data, residents.data]);

  const figures = useMemo(() => {
    const lived = homes.filter((home) => home.lease).length;
    const vacant = homes.filter((home) => home.status === 'vacant');
    const behind = homes.filter((home) => Number(home.lease?.balance) > 0);
    return {
      lived,
      vacant: vacant.length,
      listed: vacant.filter((home) => home.listed).length,
      rent: homes.reduce((sum, home) => sum + Number(home.lease?.rent ?? 0), 0),
      asking: homes.reduce((sum, home) => sum + Number(home.market_rent ?? 0), 0),
      owed: behind.reduce((sum, home) => sum + Number(home.lease?.balance), 0),
      behind: behind.length,
    };
  }, [homes]);

  const at = shown.findIndex((home) => key(home) === text(open));
  const home = homes.find((one) => key(one) === text(open));
  const step = (by: number) => {
    const next = shown[at + by];
    if (next) setOpen(Number(next.id));
  };
  const heard = useCallback((rows: Home[]) => setShown(rows), []);

  const waiting = units.isPending;

  return (
    <div data-part="lintel-page">
      <ListView<Home>
        heading="h2"
        title="Rent roll"
        columns={COLUMNS}
        rows={homes}
        rowKey={key}
        rowName={(one) => text(one.code)}
        searchText={(one) => `${text(one.code)} ${text(one['property_id.name'])} ${text(one.person?.name)} ${status(one.status)}`}
        defaultSort={{ column: 'code', descending: false }}
        pageSize={18}
        loading={waiting}
        initialState={first}
        onStateChange={keep}
        current={home ? key(home) : undefined}
        onShownChange={heard}
        onOpen={(one) => setOpen(Number(one.id))}
        summary={
          <Stats
            loading={waiting}
            items={[
              {
                label: 'Occupancy',
                value: homes.length ? `${Math.round((figures.lived / homes.length) * 100)}%` : '0%',
                share: homes.length ? figures.lived / homes.length : 0,
                note: `${figures.lived} of ${homes.length} homes lived in`,
              },
              {
                label: 'Vacant',
                value: figures.vacant,
                tone: figures.vacant > figures.listed ? 'warning' : undefined,
                note: figures.vacant ? `${figures.listed} listed online, ${figures.vacant - figures.listed} not yet` : 'Nothing is empty',
              },
              {
                label: 'Rent this month',
                value: money(figures.rent),
                share: figures.asking ? figures.rent / figures.asking : 0,
                note: `of ${money(figures.asking)} if every home were let`,
              },
              {
                label: 'Balance due',
                value: money(figures.owed),
                tone: figures.owed > 0 ? 'warning' : undefined,
                note: figures.behind
                  ? `${figures.behind} ${figures.behind === 1 ? 'lease is' : 'leases are'} behind`
                  : 'Every lease is paid up',
              },
            ]}
          />
        }
        tabs={[
          { value: 'all', label: 'All' },
          { value: 'vacant', label: 'Vacant', match: (one) => one.status === 'vacant' },
          { value: 'turnover', label: 'Turnover', match: (one) => one.status === 'turnover' },
          { value: 'notice', label: 'On notice', match: (one) => one.status === 'notice' },
          { value: 'behind', label: 'Behind on rent', match: (one) => Number(one.lease?.balance) > 0 },
          { value: 'soon', label: 'Free within 30 days', match: (one) => Boolean(one.available_on) && daysUntil(one.available_on) <= 30 },
        ]}
        filters={[
          { id: 'building', label: 'Building', value: (one) => text(one['property_id.name']) },
          { id: 'beds', label: 'Beds', value: (one) => beds(one.bedrooms) },
          { id: 'status', label: 'Status', value: (one) => status(one.status) },
        ]}
        bulkActions={[{ value: 'export', label: 'Export' }]}
        onBulkAction={(_action, keys) => exportHomes(homes.filter((one) => keys.includes(key(one))))}
        actions={
          <Button onClick={() => exportHomes(shown.length ? shown : homes)}>
            <DownloadSimple aria-hidden="true" />
            Export
          </Button>
        }
      />

      <SidePanel
        beside
        open={home !== undefined}
        onOpenChange={(next) => {
          if (!next) setOpen(undefined);
        }}
        title={home ? text(home.code) : 'Home'}
        description={home ? `${text(home['property_id.name'])}, floor ${text(home.floor)}` : undefined}
        footer={
          <>
            <span data-part="stepper">
              <Button aria-label="Previous home" disabled={at <= 0} onClick={() => step(-1)}>
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button aria-label="Next home" disabled={at < 0 || at >= shown.length - 1} onClick={() => step(1)}>
                <ArrowDown aria-hidden="true" />
              </Button>
              {at >= 0 && (
                <small>
                  {at + 1} of {shown.length}
                </small>
              )}
            </span>
            {home?.lease ? (
              <Button intent="primary" onClick={() => nav.openPage('lease', { lease: text(home.lease?.id) })}>
                Open lease
                <ArrowRight aria-hidden="true" />
              </Button>
            ) : null}
          </>
        }
      >
        {home && (
          <div data-part="peek">
            <Status tone={TONE[text(home.status)] ?? 'neutral'}>{status(home.status)}</Status>
            <Facts
              items={[
                { label: 'Beds', value: beds(home.bedrooms) },
                { label: 'Baths', value: String(Number(home.bathrooms)) },
                { label: 'Size', value: `${Number(home.sqft).toLocaleString('en-US')} sq ft` },
                { label: 'Asking rent', value: money(home.market_rent) },
              ]}
            />
            {home.lease && home.person ? (
              <>
                <Properties
                  title="Resident"
                  name={text(home.person.name)}
                  avatar={
                    <Avatar data-size="sm">
                      <AvatarFallback aria-hidden="true">{initials(home.person.name)}</AvatarFallback>
                    </Avatar>
                  }
                  items={[
                    { label: 'Email', value: text(home.person.email) },
                    { label: 'Phone', value: text(home.person.phone) || ABSENT },
                    { label: 'Since', value: day(home.person.since) },
                  ]}
                />
                <Properties
                  title="Lease"
                  items={[
                    { label: 'Rent', value: `${money(home.lease.rent)} a month` },
                    {
                      label: 'Ends',
                      value: `${day(home.lease.end_on)}${fromNow(home.lease.end_on) ? `, ${fromNow(home.lease.end_on)}` : ''}`,
                    },
                    {
                      label: 'Balance',
                      value: Number(home.lease.balance) > 0 ? <span data-tone="warning">{money(home.lease.balance)} due</span> : 'Paid up',
                    },
                  ]}
                />
              </>
            ) : (
              <Properties
                title="Letting"
                items={[
                  {
                    label: 'Available',
                    value: home.available_on
                      ? `${day(home.available_on)}${fromNow(home.available_on) ? `, ${fromNow(home.available_on)}` : ''}`
                      : ABSENT,
                  },
                  { label: 'Listed', value: home.listed ? 'Online now' : 'Not yet' },
                ]}
              />
            )}
            <a href={href.record('units', { id: home.id })} data-slot="more-link">
              Open the home’s own page <ArrowRight aria-hidden="true" />
            </a>
          </div>
        )}
      </SidePanel>
      <Toaster />
    </div>
  );
}
