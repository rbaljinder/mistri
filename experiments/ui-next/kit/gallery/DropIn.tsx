import '@mistriwork/ui/style.css';
import '../kit.css';
import '../bridge.css';
import './dropin.css';
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control';
import { useRef, useState, type ReactNode } from 'react';
import { Avatar } from '@mistriwork/ui/Avatar.js';
import { Button, ButtonLink } from '@mistriwork/ui/Button.js';
import { Checkbox, ChoiceCards, Consent, YesNo } from '@mistriwork/ui/Choices.js';
import { DateField, type DateFieldWords } from '@mistriwork/ui/DateField.js';
import { Drawer } from '@mistriwork/ui/Drawer.js';
import { DropGroup, DropItem, DropMenu, DropSeparator } from '@mistriwork/ui/DropMenu.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { masks } from '@mistriwork/ui/masks.js';
import { Pagination } from '@mistriwork/ui/Pagination.js';
import { Popover } from '@mistriwork/ui/Popover.js';
import { MultiSelect, Select } from '@mistriwork/ui/Select.js';
import { SensitiveField } from '@mistriwork/ui/SensitiveField.js';
import { Slider } from '@mistriwork/ui/Slider.js';
import { Switch } from '@mistriwork/ui/Switch.js';
import { Tabs } from '@mistriwork/ui/Tabs.js';
import { MaskedField, MoneyField, TextField } from '@mistriwork/ui/TextField.js';
import { Tooltip } from '@mistriwork/ui/Tooltip.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import { UiKitProvider } from '@mistriwork/ui/UiKit.js';
import kit from '../index';

const WORDS: DateFieldWords = {
  dateTimePattern: 'YYYY-MM-DD HH:MM',
  enterDateAndTime: 'Enter a date and time.',
  enterDate: (format) => `Enter a date as ${format}.`,
  dateAndTimeFormat: 'Date and time format.',
  dateFormat: (format) => `Date format: ${format}.`,
  openWithKeys: 'Alt and Down arrow opens the calendar.',
  chooseDate: (label) => `Choose ${label ?? 'a date'}`,
  calendar: (label) => `Calendar for ${label ?? 'the date'}`,
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  clear: 'Clear',
  today: 'Today',
};

const STAGES = [
  { value: 'new', label: 'New' },
  { value: 'working', label: 'Working' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'lost', label: 'Lost' },
];

const PEOPLE = ['Ada Okafor', 'Bram Visser', 'Chen Liu', 'Divya Raman', 'Elena Sorokina'];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-part="dropin-group">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/* One page of mistri's own primitives, called exactly as a mistri screen calls them. Nothing in it knows which
   kit draws it: the page below renders it twice, once bare and once under the ui-next kit. */
function Screen() {
  const [company, setCompany] = useState('Stonebridge Supply');
  const [phone, setPhone] = useState('7205550100');
  const [amount, setAmount] = useState('48200');
  const [tax, setTax] = useState('123456789');
  const [email, setEmail] = useState('ada@stonebridge');
  const [stage, setStage] = useState('working');
  const [tags, setTags] = useState(['new']);
  const [owner, setOwner] = useState('');
  const [listed, setListed] = useState(false);
  const [due, setDue] = useState('2026-11-20');
  const [urgent, setUrgent] = useState<'yes' | 'no' | ''>('no');
  const [size, setSize] = useState(['working']);
  const [channels, setChannels] = useState(['new']);
  const [copy, setCopy] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [notify, setNotify] = useState(true);
  const [budget, setBudget] = useState(40);
  const [page, setPage] = useState(2);
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [busy, setBusy] = useState(false);
  const handle = useRef<ModalHandle>(null);
  const matches = PEOPLE.filter((person) => person.toLowerCase().includes(owner.toLowerCase()));

  return (
    <div data-part="dropin-screen">
      <Group title="Buttons">
        <div data-part="row">
          <Button intent="primary">Save lead</Button>
          <Button>Export</Button>
          <Button intent="quiet">Cancel</Button>
          <Button intent="danger">Delete</Button>
          <Button
            intent="primary"
            busy={busy}
            busyLabel="Saving…"
            onClick={() => {
              setBusy(true);
              setTimeout(() => setBusy(false), 1500);
            }}
          >
            Save, slowly
          </Button>
          <ButtonLink href="#kit">A link</ButtonLink>
        </div>
      </Group>

      <Group title="Text">
        <TextField
          label="Company"
          hint="As it appears on invoices."
          value={company}
          onChange={setCompany}
          required
          valid={company.length > 3}
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          problem="Enter a complete address, like ada@stonebridge.co."
        />
        <MaskedField label="Phone" mask={masks.phone} value={phone} onChange={setPhone} optional="Optional" />
        <MoneyField label="Deal value" value={amount} onChange={setAmount} />
        <SensitiveField
          label="Tax number"
          mask={masks.ssn}
          value={tax}
          onChange={setTax}
          showLabel="Show"
          hideLabel="Hide"
          note="Kept encrypted."
        />
      </Group>

      <Group title="Lists and dates">
        <Select label="Stage" options={STAGES} value={stage} onChange={setStage} />
        <MultiSelect label="Tags" options={STAGES} value={tags} onChange={setTags} placeholder="Choose" />
        <div data-part="dropin-bare">
          <span>Owner</span>
          <Typeahead
            text={owner}
            onText={(next) => {
              setOwner(next);
              setListed(true);
            }}
            items={matches}
            itemKey={(person) => person}
            itemLabel={(person) => person}
            itemClassName={(_person, lit) => (lit ? 'dd-option is-active' : 'dd-option')}
            renderItem={(person) => person}
            onPick={(person) => {
              setOwner(person);
              setListed(false);
            }}
            open={listed}
            onOpenChange={setListed}
            inputProps={{ 'aria-label': 'Owner', placeholder: 'Search people', className: 'field-control' }}
            popupClassName="dd-list"
            listClassName="dd-options"
            empty="No one by that name"
          />
        </div>
        <div data-part="dropin-bare">
          <span>Follow up on</span>
          <DateField
            id="dropin-due"
            aria-label="Follow up on"
            words={WORDS}
            calendarIcon={null}
            value={due}
            onChange={setDue}
            locale="en-US"
          />
        </div>
      </Group>

      <Group title="Choices">
        <YesNo label="Is it urgent?" value={urgent} onChange={setUrgent} yes="Yes" no="No" />
        <ChoiceCards label="Stage" options={STAGES.slice(0, 3)} value={size} onChange={setSize} />
        <ChoiceCards
          label="Tell me by"
          multiple
          options={STAGES.slice(0, 2).map((s, i) => ({ value: s.value, label: ['Email', 'Text message'][i]! }))}
          value={channels}
          onChange={setChannels}
        />
        <Checkbox label="Send me a copy" checked={copy} onChange={setCopy} />
        <Consent label="I agree to the terms of service and the privacy notice." checked={agreed} onChange={setAgreed} />
        <Switch label="Notify the owner" description="One message per change." checked={notify} onCheckedChange={setNotify} />
        <Slider label="Budget" value={budget} onChange={setBudget} min={0} max={100} />
      </Group>

      <Group title="Overlays">
        <div data-part="row">
          <Button onClick={() => setModal(true)}>Open a modal</Button>
          <Button onClick={() => setDrawer(true)}>Open a drawer</Button>
          <Popover trigger={<Button>Popover</Button>} ariaLabel="Share">
            <p>Anyone on the team with the link sees the same filters.</p>
          </Popover>
          <Tooltip trigger={<Button>Tooltip</Button>}>Anyone with the link can view</Tooltip>
          <DropMenu label="Row actions">
            <DropGroup label="Change">
              <DropItem onClick={() => {}}>Edit row</DropItem>
              <DropItem disabled onClick={() => {}}>
                Lock row
              </DropItem>
            </DropGroup>
            <DropSeparator />
            <DropItem onClick={() => {}}>Remove row</DropItem>
          </DropMenu>
        </div>
        {modal && (
          <Modal ref={handle} onClose={() => setModal(false)} className="confirm" fullscreen={false}>
            <h2>Rename lead</h2>
            <p>The new name shows everywhere this lead is listed.</p>
            <TextField label="Name" value={company} onChange={setCompany} />
            <div data-part="row">
              <Button intent="quiet" onClick={() => handle.current?.close()}>
                Cancel
              </Button>
              <Button intent="primary" onClick={() => handle.current?.close()}>
                Rename
              </Button>
            </div>
          </Modal>
        )}
        <Drawer open={drawer} onOpenChange={setDrawer} title="Filters" closeLabel="Close filters">
          <p>Narrow the list to the leads you are working.</p>
          <Select label="Stage" options={STAGES} value={stage} onChange={setStage} />
        </Drawer>
      </Group>

      <Group title="Tabs, pages, people">
        <Tabs
          ariaLabel="Lead sections"
          defaultValue="details"
          tabs={[
            { value: 'details', label: 'Details', children: <p>Owner, stage and the next step.</p> },
            { value: 'activity', label: 'Activity', children: <p>Calls, emails and notes, newest first.</p> },
            { value: 'files', label: 'Files', children: <p>Quotes and contracts.</p>, disabled: true },
          ]}
        />
        <Pagination page={page} pages={9} onPageChange={setPage} ariaLabel="Leads, pages" />
        <div data-part="row">
          <Avatar name="Ada Okafor" size="sm" />
          <Avatar name="Bram Visser" />
          <Avatar name="Chen Liu" size="lg" />
        </div>
      </Group>
    </div>
  );
}

export default function DropIn() {
  const [look, setLook] = useState<string | null>('own');
  return (
    <div data-part="dropin">
      <header data-slot="list-head">
        <h1>Drop-in</h1>
      </header>
      <p data-part="dropin-lede">
        One screen written against <code>@mistriwork/ui</code>, drawn twice. On the left nothing is installed, so each control is today’s,
        over Base UI. On the right the same code runs under the ui-next kit, which fills all thirty of the slots mistri declares (
        <code>defineUiKit</code>) over UI SDK and passes mistri’s own conformance suite. No line of the screen differs.
      </p>
      <div data-part="dropin-look">
        <span id="dropin-look">The kit wears</span>
        <SegmentedControl aria-labelledby="dropin-look" value={look} onValueChange={(next) => next !== null && setLook(String(next))}>
          <SegmentedControlIndicator />
          <SegmentedControlItem value="own">ui-next’s own tokens</SegmentedControlItem>
          <SegmentedControlItem value="app">the App’s look</SegmentedControlItem>
        </SegmentedControl>
      </div>
      <div data-part="dropin-columns">
        <div data-part="dropin-column" data-kit="today">
          <h2>
            Today <span>@mistriwork/ui over Base UI</span>
          </h2>
          <Screen />
        </div>
        <div data-part="dropin-column" data-kit="next" data-m-look={look === 'app' ? 'app' : undefined}>
          <h2>
            ui-next kit <span>the same code over UI SDK</span>
          </h2>
          <UiKitProvider kit={kit}>
            <Screen />
          </UiKitProvider>
        </div>
      </div>
    </div>
  );
}
