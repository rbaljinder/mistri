/**
 * A lease in Lintel, drawn whole by ui-next: a free-form page at /lease?lease=1, reached from the rent roll.
 *
 * A lease is read for one of three things: where it stands, what is owed, and what happened. So the head says
 * where it stands (its stage, its dates in the reader's terms: "ends in 6 weeks"), the first thing under it is the
 * money (what is due, and of what was charged how much has come in), and what is still open is listed first with
 * the one thing to do about it on each row: record the payment. Everything else is a tab away, and one column
 * beside it holds who and where, and the last few things that happened, charges and payments in one line of time.
 *
 * Every write is one of Lintel's own commands, through mistri's own pipeline. Give notice on the lease and Record
 * payment on a charge open mistri's own form. Add a charge is asked by a form of this page's own, in a panel beside
 * the lease: ui-next's fields, checked before they are sent, and sent through the command's `run`, which the server
 * judges again. What it refuses comes back by field and is shown on that field, with the keyboard put there.
 */
import { definePage, useHref, useNavigate } from '@mistriwork/mistri/page';
import { type ReactNode, useId, useState } from 'react';
import {
  Activity,
  type ActivityEvent,
  ArrowLeft,
  Avatar,
  AvatarFallback,
  Breadcrumbs,
  Button,
  ChoiceField,
  type Column,
  DataTable,
  DateField,
  DotsThree,
  DropMenu,
  Facts,
  FormProblems,
  MoneyField,
  Plus,
  Properties,
  RecordHeader,
  RecordLayout,
  RecordSection,
  SidePanel,
  Stages,
  Stats,
  Status,
  Tabs,
  TabsIndicator,
  TabsList,
  TabsPanel,
  TabsTab,
  TextField,
  toast,
  Toaster,
  type Tone,
  useForm,
} from '../ui';
import '../../../src/theme/list.css';
import '../../../src/theme/record.css';
import '../lintel.css';
import { beds, day, daysUntil, fromNow, initials, money, type Row, text, words } from '../format';

const page = definePage({
  label: 'Lease',
  icon: 'file-text',
  nav: false,
  head: false,
  reads: ['lease', 'unit', 'property', 'resident', 'charge', 'payment'],
  commands: ['giveNotice', 'addCharge', 'recordPayment'],
  params: { lease: 'id' },
  component: Lease,
});
export default page;

const STAGES = ['draft', 'active', 'notice', 'ended'];
const STAGE_SAID: Record<string, string> = { draft: 'Draft', active: 'Active', notice: 'Notice given', ended: 'Ended' };
const STAGE_TONE: Record<string, Tone> = { draft: 'info', active: 'good', notice: 'warning', ended: 'neutral' };
const METHOD: Record<string, string> = { ach: 'Bank transfer', card: 'Card', check: 'Check', cash: 'Cash' };

const ABSENT = (
  <span data-slot="absent" role="img" aria-label="None">
    —
  </span>
);

const when = (iso: unknown) => `${day(iso)}${fromNow(iso) ? `, ${fromNow(iso)}` : ''}`;
const late = (charge: Row) => charge.status === 'open' && daysUntil(charge.due_on) < 0;

type Sent = { status: string; message?: string; fields?: Readonly<Record<string, string>> };

/* The most one charge may be, in dollars: the command's own limit, said again here. A page cannot ask a command
   what its inputs allow (it is told an input's choices and nothing else), and a `run` whose input the command's
   own check turns down does not come back refused: mistri opens its own form over the page's with the answers in
   it. So the page checks what it knows of first, and only what it cannot know reaches the server. */
const MOST = 10_000;

/* Add a charge, asked by ui-next's own fields in a panel beside the lease. The answers are checked here first, so
   the plain mistakes cost no round trip, and then sent through the command, which the server judges again: what
   it refuses comes back by field and is put on that field. The panel asks before it loses what was typed. */
function AddCharge({
  open,
  onOpenChange,
  name,
  kinds,
  send,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  kinds: { value: string; label: string }[];
  send: (input: { kind: string; description: string; amount: string; due_on: string }) => Promise<Sent>;
}): ReactNode {
  const id = useId();
  const hold = useForm({
    validate: (said) => ({
      description: said.description?.trim() ? undefined : 'Say what the charge is for.',
      amount: !(Number(said.amount) > 0)
        ? 'Say how much.'
        : Number(said.amount) > MOST
          ? `No more than ${money(MOST * 100)} in one charge.`
          : undefined,
      due_on: said.due_on ? undefined : 'Choose the day it is due.',
    }),
    submit: async (said) => {
      const sent = await send({
        kind: said.kind ?? '',
        description: said.description ?? '',
        amount: said.amount ?? '',
        due_on: said.due_on ?? '',
      });
      if (sent.status === 'applied') {
        toast.success(sent.message ?? 'Charge added');
        onOpenChange(false);
        return undefined;
      }
      // What the server refused, by field where it says which, else as it said it.
      const fields = sent.fields && Object.keys(sent.fields).length ? sent.fields : undefined;
      return { fields, message: fields ? undefined : (sent.message ?? 'The charge was not added.') };
    },
  });
  return (
    <SidePanel
      open={open}
      onOpenChange={(next) => {
        if (!next) hold.reset();
        onOpenChange(next);
      }}
      title="Add a charge"
      description={name}
      unsaved={hold.touched}
      footer={
        <>
          <Button intent="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button intent="primary" type="submit" form={id} busy={hold.busy}>
            Add charge
          </Button>
        </>
      }
    >
      <form id={id} data-slot="form" {...hold.form}>
        <FormProblems hold={hold} labels={{ kind: 'What for', description: 'Description', amount: 'Amount', due_on: 'Due' }} />
        <ChoiceField label="What for" name="kind" options={kinds} defaultValue={kinds[0]?.value} />
        <TextField label="Description" name="description" required maxLength={120} error={hold.problem('description')} />
        <MoneyField label="Amount" name="amount" required error={hold.problem('amount')} />
        <DateField label="Due" name="due_on" required error={hold.problem('due_on')} />
      </form>
    </SidePanel>
  );
}

function Lease(): ReactNode {
  const nav = useNavigate();
  const href = useHref();
  const [id] = page.useParam('lease');
  const lease = page.useRecord('lease', id === undefined ? undefined : { id }, [
    'unit_id',
    'resident_id',
    'start_on',
    'end_on',
    'rent',
    'deposit',
    'status',
    'notice_on',
    'balance',
    'charged',
    'paid',
  ]);
  const record = lease.data as Row | null | undefined;
  const home = page.useRecord('unit', record ? { id: record.unit_id } : undefined, [
    'code',
    'number',
    'floor',
    'bedrooms',
    'sqft',
    'property_id.name',
  ]).data as Row | null | undefined;
  const person = page.useRecord('resident', record ? { id: record.resident_id } : undefined, ['name', 'email', 'phone', 'since']).data as
    | Row
    | null
    | undefined;
  const charges = (page.useRows('charge', {
    where: { lease_id: id ?? -1 },
    show: ['description', 'kind', 'due_on', 'amount', 'status', 'paid_on', 'posted_on'],
    sort: 'due_on desc',
    limit: 200,
    enabled: id !== undefined,
  }).data ?? []) as Row[];
  const payments = (page.useRows('payment', {
    where: { lease_id: id ?? -1 },
    show: ['received_on', 'amount', 'method', 'reference'],
    sort: 'received_on desc',
    limit: 200,
    enabled: id !== undefined,
  }).data ?? []) as Row[];

  const notice = page.useCommand('giveNotice');
  const charge = page.useCommand('addCharge');
  const pay = page.useCommand('recordPayment');
  const [charging, setCharging] = useState(false);

  const back = (
    <a
      href={nav.pageHref('rent-roll')}
      data-slot="more-link"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        nav.openPage('rent-roll');
      }}
    >
      <ArrowLeft aria-hidden="true" /> Rent roll
    </a>
  );

  if (id === undefined || record === null)
    return (
      <div data-part="lintel-page" data-kind="empty">
        <h2>{id === undefined ? 'No lease chosen' : 'There is no such lease'}</h2>
        <p>A lease opens from its home on the rent roll.</p>
        {back}
      </div>
    );
  if (!record) return <p data-part="waiting">Reading the lease…</p>;

  const name = home ? `${text(home['property_id.name'])} #${text(home.number)}` : 'Lease';
  const open = charges.filter((one) => one.status === 'open');
  const oldest = open.at(-1);
  const charged = Number(record.charged ?? 0);
  const paid = Number(record.paid ?? 0);
  const due = Number(record.balance ?? 0);

  const CHARGES: Column<Row>[] = [
    { id: 'description', header: 'Charge', primary: true, cell: (one) => text(one.description) },
    {
      id: 'due',
      header: 'Due',
      cell: (one) => (
        <span data-part="when" data-tone={late(one) ? 'warning' : undefined}>
          {day(one.due_on)}
          {one.status === 'open' && <small>{fromNow(one.due_on)}</small>}
        </span>
      ),
    },
    { id: 'amount', header: 'Amount', align: 'end', cell: (one) => money(one.amount, 2) },
    {
      id: 'status',
      header: 'Status',
      cell: (one) => (
        <Status tone={one.status === 'open' ? 'warning' : one.status === 'paid' ? 'good' : 'neutral'}>{words(one.status)}</Status>
      ),
    },
  ];
  const PAYMENTS: Column<Row>[] = [
    { id: 'received', header: 'Received', primary: true, cell: (one) => day(one.received_on) },
    { id: 'amount', header: 'Amount', align: 'end', cell: (one) => money(one.amount, 2) },
    { id: 'method', header: 'Paid by', cell: (one) => METHOD[text(one.method)] ?? words(one.method) },
    { id: 'reference', header: 'Reference', cell: (one) => <code data-part="reference">{text(one.reference)}</code> },
  ];

  const chargeTable = (rows: Row[]) => (
    <DataTable
      label="Charges"
      columns={CHARGES}
      rows={rows}
      rowKey={(one) => text(one.id)}
      rowName={(one) => text(one.description)}
      rowActions={pay.granted ? [{ value: 'pay', label: 'Record payment' }] : undefined}
      onRowAction={(_action, one) => void pay.open(one)}
      empty="No charges."
    />
  );

  /* Charges and payments as one line of time, newest first: what was asked for and what came in. */
  const events: ActivityEvent[] = [
    ...charges.map((one) => ({
      id: `c${text(one.id)}`,
      title: text(one.description),
      dateTime: text(one.posted_on ?? one.due_on),
      time: day(one.posted_on ?? one.due_on, false),
      description: `${money(one.amount, 2)} charged, due ${day(one.due_on, false)}.`,
    })),
    ...payments.map((one) => ({
      id: `p${text(one.id)}`,
      title: 'Payment received',
      dateTime: text(one.received_on),
      time: day(one.received_on, false),
      description: `${money(one.amount, 2)} by ${(METHOD[text(one.method)] ?? words(one.method)).toLowerCase()}.`,
    })),
  ].sort((a, b) => b.dateTime.localeCompare(a.dateTime));

  return (
    <article data-slot="record" data-part="lintel-page">
      <Breadcrumbs items={[{ label: 'Rent roll', href: nav.pageHref('rent-roll') }, { label: name }]} />
      <RecordHeader
        heading="h2"
        kind="Lease"
        title={name}
        status={
          <Status tone={STAGE_TONE[text(record.status)] ?? 'neutral'}>{STAGE_SAID[text(record.status)] ?? words(record.status)}</Status>
        }
        actions={
          <>
            {charge.granted && (
              <Button onClick={() => setCharging(true)}>
                <Plus aria-hidden="true" weight="bold" />
                Add charge
              </Button>
            )}
            {notice.granted && notice.available(record) !== false && (
              <Button intent="primary" onClick={() => void notice.open(record)}>
                Give notice
              </Button>
            )}
            <DropMenu
              label="More"
              trigger={<DotsThree aria-hidden="true" weight="bold" />}
              onAction={(to) => {
                window.location.href = to;
              }}
              items={[
                { value: href.record('leases', { id: record.id }), label: 'Open in Lintel’s own lease page' },
                { value: href.record('units', { id: record.unit_id }), label: 'Open the home' },
                { value: href.record('residents', { id: record.resident_id }), label: 'Open the resident' },
              ]}
            />
          </>
        }
      >
        <Facts
          items={[
            { label: 'Started', value: day(record.start_on) },
            { label: record.status === 'ended' ? 'Ended' : 'Ends', value: when(record.end_on) },
            { label: 'Rent', value: `${money(record.rent)} a month` },
            { label: 'Deposit', value: money(record.deposit) },
          ]}
        />
      </RecordHeader>

      <Tabs defaultValue="overview">
        <TabsList aria-label="Lease">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="charges">
            Charges <span data-slot="tab-count">{charges.length}</span>
          </TabsTab>
          <TabsTab value="payments">
            Payments <span data-slot="tab-count">{payments.length}</span>
          </TabsTab>
          <TabsIndicator />
        </TabsList>

        <TabsPanel value="overview">
          <RecordLayout
            aside={
              <>
                {home && (
                  <Properties
                    title="Home"
                    name={text(home.code)}
                    items={[
                      { label: 'Building', value: text(home['property_id.name']) },
                      { label: 'Floor', value: text(home.floor) },
                      { label: 'Beds', value: beds(home.bedrooms) },
                      { label: 'Size', value: `${Number(home.sqft).toLocaleString('en-US')} sq ft` },
                    ]}
                  />
                )}
                {person && (
                  <Properties
                    title="Resident"
                    name={text(person.name)}
                    avatar={
                      <Avatar data-size="sm">
                        <AvatarFallback aria-hidden="true">{initials(person.name)}</AvatarFallback>
                      </Avatar>
                    }
                    items={[
                      { label: 'Email', value: text(person.email) },
                      { label: 'Phone', value: text(person.phone) || ABSENT },
                      { label: 'Since', value: day(person.since) },
                    ]}
                  />
                )}
                <section data-slot="properties" aria-label="Lately">
                  <h2>Lately</h2>
                  <Activity label="Charges and payments, newest first" events={events.slice(0, 6)} />
                </section>
              </>
            }
          >
            <Stages
              label="Where the lease stands"
              stages={STAGES.map((stage) => STAGE_SAID[stage]!)}
              current={STAGE_SAID[text(record.status)] ?? 'Draft'}
            />
            <Stats
              items={[
                {
                  label: 'Balance due',
                  value: money(due, 2),
                  tone: due > 0 ? 'warning' : undefined,
                  note: open.length
                    ? `${open.length} ${open.length === 1 ? 'charge' : 'charges'} open, the oldest due ${day(oldest?.due_on, false)}`
                    : 'Nothing is owed',
                },
                { label: 'Collected', value: money(paid, 2), share: charged ? paid / charged : 0, note: `of ${money(charged, 2)} charged` },
                {
                  label: 'Last payment',
                  value: payments[0] ? money(payments[0].amount, 2) : '—',
                  note: payments[0] ? when(payments[0].received_on) : 'None yet',
                },
              ]}
            />
            <RecordSection title={open.length ? 'Open charges' : 'Charges'} count={open.length || charges.length}>
              {chargeTable(open.length ? open : charges.slice(0, 6))}
            </RecordSection>
          </RecordLayout>
        </TabsPanel>

        <TabsPanel value="charges">{chargeTable(charges)}</TabsPanel>

        <TabsPanel value="payments">
          <DataTable
            label="Payments"
            columns={PAYMENTS}
            rows={payments}
            rowKey={(one) => text(one.id)}
            rowName={(one) => text(one.reference)}
            empty="No payments yet."
          />
        </TabsPanel>
      </Tabs>
      <AddCharge
        open={charging}
        onOpenChange={setCharging}
        name={name}
        kinds={(charge.choices('kind') ?? []).map((one) => ({ value: String(one.value), label: one.label }))}
        send={(input) => charge.run(record, input, { quiet: true })}
      />
      <Toaster />
    </article>
  );
}
