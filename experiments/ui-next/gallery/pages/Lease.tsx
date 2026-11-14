import { ArrowRight, DotsThree, Plus } from '@phosphor-icons/react';
import { Avatar, AvatarFallback } from '@ui-sdk/react/avatar';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { toast } from '@ui-sdk/react/toast';
import { useState } from 'react';
import {
  Activity,
  type Attachment,
  Attachments,
  Breadcrumbs,
  Button,
  type Column,
  Confirm,
  DateField,
  DropMenu,
  Modal,
  MoneyField,
  SelectField,
  TextField,
  DataTable,
  Facts,
  FormGrid,
  Properties,
  RecordHeader,
  RecordLayout,
  RecordSection,
  Stages,
  Stats,
  Status,
} from '../../src';
import { CHARGES, type Charge, HISTORY, money } from '../data';
import { LeaseNotes } from './LeaseNotes';

const CHARGE_COLUMNS: Column<Charge>[] = [
  { id: 'description', header: 'Description', primary: true, cell: (charge) => charge.description },
  {
    id: 'due',
    header: 'Due',
    cell: (charge) => (charge.overdue ? <span data-tone="warning">{charge.due}</span> : charge.due),
  },
  { id: 'amount', header: 'Amount', align: 'end', cell: (charge) => money(charge.amount) },
  {
    id: 'status',
    header: 'Status',
    cell: (charge) => <Status tone={charge.status === 'Open' ? 'warning' : 'good'}>{charge.status}</Status>,
  },
];

/* The lease's files, made here so the gallery fetches nothing: a drawing, a text file, and a kind that is not
   shown. */
const sheet = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 480'><rect width='640' height='480' fill='hsl(${hue} 30% 94%)'/><rect x='120' y='60' width='400' height='360' rx='8' fill='white' stroke='hsl(${hue} 20% 70%)' stroke-width='3'/><g fill='hsl(${hue} 20% 60%)'><rect x='160' y='110' width='220' height='14' rx='4'/><rect x='160' y='150' width='320' height='10' rx='4'/><rect x='160' y='176' width='300' height='10' rx='4'/><rect x='160' y='202' width='320' height='10' rx='4'/><rect x='160' y='330' width='120' height='30' rx='6'/></g></svg>`,
  )}`;
const FILES: Attachment[] = [
  {
    id: 'f1',
    name: 'Signed lease, page 1.svg',
    href: sheet(220),
    type: 'image/svg+xml',
    size: 184_320,
    when: 'Nov 1, 2025',
    by: 'Maya Lin',
  },
  {
    id: 'f2',
    name: 'Move-in photo, hallway.svg',
    href: sheet(30),
    type: 'image/svg+xml',
    size: 96_100,
    when: 'Nov 1, 2025',
    by: 'Jonas Weber',
  },
  {
    id: 'f3',
    name: 'Meter readings.txt',
    href: `data:text/plain,${encodeURIComponent('Alder Court #101, meter readings at move-in\n\nElectric   004 812 kWh\nWater      000 391 m3\nHeat       001 204 units\n\nRead by Jonas Weber with the resident present.')}`,
    type: 'text/plain',
    size: 212,
    when: 'Nov 1, 2025',
    by: 'Jonas Weber',
  },
  { id: 'f4', name: 'Deposit protection certificate.docx', href: '#lease', size: 48_200, when: 'Nov 3, 2025', by: 'Maya Lin' },
];

export function Lease() {
  const [charging, setCharging] = useState(false);
  const [ending, setEnding] = useState(false);
  const [files, setFiles] = useState(FILES);
  const [contact, setContact] = useState({ email: 'andre.okoye@example.test', phone: '(720) 555-2013' });
  /* The gallery's one refusal, so a save that does not go through can be seen: an address on another lease. */
  const saveContact = async (change: Partial<typeof contact>) => {
    await new Promise((settle) => window.setTimeout(settle, 500));
    if (change.email?.endsWith('@taken.test')) throw new Error('That address is on another lease.');
    setContact((now) => ({ ...now, ...change }));
  };
  return (
    <article data-slot="record">
      <Modal
        open={charging}
        onOpenChange={setCharging}
        title="Add charge"
        description="It is due from Andre Okoye and shows on the next statement."
        footer={
          <>
            <Button intent="quiet" onClick={() => setCharging(false)}>
              Cancel
            </Button>
            <Button
              intent="primary"
              onClick={() => {
                setCharging(false);
                toast.success('Charge added', { description: 'Repair call-out, $120, due Oct 1.' });
              }}
            >
              Add charge
            </Button>
          </>
        }
      >
        <form data-slot="form" onSubmit={(event) => event.preventDefault()}>
          <SelectField
            label="Kind"
            name="kind"
            defaultValue="fee"
            options={[
              { value: 'rent', label: 'Rent' },
              { value: 'fee', label: 'Fee' },
              { value: 'deposit', label: 'Deposit' },
            ]}
          />
          <TextField label="Description" name="description" defaultValue="Repair call-out" required />
          <FormGrid>
            <MoneyField label="Amount" name="amount" defaultValue={120} />
            <DateField label="Due" name="due" defaultValue="2026-10-01" />
          </FormGrid>
        </form>
      </Modal>
      <Confirm
        open={ending}
        onOpenChange={setEnding}
        title="End this lease?"
        description="Alder Court #101 becomes vacant today and the $2,645 still open stays due from Andre Okoye."
        confirm="End lease"
        cancel="Keep it"
        danger
        onConfirm={() => toast('Lease ended')}
      />
      <Breadcrumbs items={[{ label: 'Leases', href: '#rent-roll' }, { label: 'Alder Court #101' }]} />
      <RecordHeader
        kind="Lease"
        title="Alder Court #101"
        status={<Status tone="good">Active</Status>}
        actions={
          <>
            <Button onClick={() => setCharging(true)}>
              <Plus aria-hidden="true" weight="bold" />
              Add charge
            </Button>
            <Button intent="primary" onClick={() => toast('Give notice would open here')}>
              Give notice
            </Button>
            <DropMenu
              label="More actions"
              trigger={<DotsThree aria-hidden="true" weight="bold" />}
              onAction={(value) => (value === 'end' ? setEnding(true) : toast(value))}
              items={[
                { value: 'Renew lease', label: 'Renew lease' },
                { value: 'Print statement', label: 'Print statement' },
                { value: 'end', label: 'End lease', danger: true, separated: true },
              ]}
            />
          </>
        }
      >
        <Facts
          items={[
            { label: 'Starts', value: 'Nov 1, 2025' },
            { label: 'Ends', value: 'Oct 31, 2026' },
            { label: 'Rent', value: '$1,285 / month' },
            { label: 'Deposit', value: '$1,285' },
          ]}
        />
      </RecordHeader>

      <Tabs defaultValue="overview">
        <TabsList aria-label="Lease">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="charges">
            Charges <span data-slot="tab-count">{CHARGES.length}</span>
          </TabsTab>
          <TabsTab value="history">
            History <span data-slot="tab-count">{HISTORY.length}</span>
          </TabsTab>
          <TabsTab value="files">
            Files <span data-slot="tab-count">{files.length}</span>
          </TabsTab>
          <TabsIndicator />
        </TabsList>

        <TabsPanel value="overview">
          <RecordLayout
            aside={
              <>
                <Properties
                  title="Home"
                  name="Alder Court #101"
                  items={[
                    { label: 'Building', value: 'Alder Court' },
                    { label: 'Beds', value: 'Studio' },
                    { label: 'Size', value: '480 sq ft' },
                    { label: 'Floor', value: '1st' },
                  ]}
                  link={
                    <a href="#rent-roll" data-slot="more-link">
                      View home <ArrowRight aria-hidden="true" />
                    </a>
                  }
                />
                <Properties
                  title="Resident"
                  name="Andre Okoye"
                  avatar={
                    <Avatar data-size="sm">
                      <AvatarFallback>AO</AvatarFallback>
                    </Avatar>
                  }
                  items={[
                    {
                      label: 'Email',
                      value: contact.email,
                      edit: {
                        value: contact.email,
                        inputMode: 'email',
                        check: (text) => (/^\S+@\S+\.\S+$/.test(text) ? undefined : 'That is not an email address.'),
                        onSave: (email) => saveContact({ email }),
                      },
                    },
                    {
                      label: 'Phone',
                      value: contact.phone,
                      edit: {
                        value: contact.phone,
                        inputMode: 'tel',
                        placeholder: 'Add a phone',
                        onSave: (phone) => saveContact({ phone }),
                      },
                    },
                    { label: 'Since', value: 'Nov 2025' },
                  ]}
                  link={
                    <a href="#rent-roll" data-slot="more-link">
                      View resident <ArrowRight aria-hidden="true" />
                    </a>
                  }
                />
                <section data-slot="properties" aria-label="History">
                  <h2>History</h2>
                  <Activity label="Lease history" events={HISTORY} />
                </section>
              </>
            }
          >
            <Stages label="Lease stage" stages={['Draft', 'Active', 'Notice given', 'Ended']} current="Active" />
            <Stats
              items={[
                { label: 'Balance due', value: '$2,645', note: '3 charges open', tone: 'warning' },
                { label: 'Charged', value: '$7,785', note: 'Since Nov 2025' },
                { label: 'Paid', value: '$5,140', note: 'Last on Jul 1' },
              ]}
            />
            <RecordSection
              title="Charges"
              count={CHARGES.length}
              action={
                <Button size="sm" intent="quiet" onClick={() => setCharging(true)}>
                  <Plus aria-hidden="true" />
                  Add
                </Button>
              }
            >
              <DataTable
                label="Charges"
                columns={CHARGE_COLUMNS}
                rows={CHARGES}
                rowKey={(charge) => charge.id}
                rowName={(charge) => charge.description}
              />
            </RecordSection>
          </RecordLayout>
        </TabsPanel>

        <TabsPanel value="charges">
          <DataTable
            label="Charges"
            columns={CHARGE_COLUMNS}
            rows={CHARGES}
            rowKey={(charge) => charge.id}
            rowName={(charge) => charge.description}
          />
        </TabsPanel>

        <TabsPanel value="history">
          <LeaseNotes />
        </TabsPanel>

        <TabsPanel value="files">
          <div data-part="lease-notes">
            <Attachments
              label="Files on this lease"
              files={files}
              onRemove={(file) => {
                setFiles((now) => now.filter((each) => each.id !== file.id));
                toast.success(`${file.name} removed`, { action: { label: 'Undo', onAction: () => setFiles((now) => [...now, file]) } });
              }}
            />
          </div>
        </TabsPanel>
      </Tabs>
    </article>
  );
}
