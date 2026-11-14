import { CalendarCheck, Key, ShieldCheck, Sparkle } from '@phosphor-icons/react';
import { toast } from '@ui-sdk/react/toast';
import { useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Carousel,
  CheckCardsField,
  Columns,
  ConsentField,
  DateField,
  DateTimeField,
  FileField,
  HelpTip,
  IconRows,
  LookupField,
  MaskedField,
  PhotoTiles,
  Popover,
  ProgressBar,
  ReviewList,
  SchemaForm,
  ScrollArea,
  SelectField,
  SensitiveField,
  SliderField,
  Split,
  StepHeader,
  SwitchField,
  TextAreaField,
  Tabs,
  TextField,
  YesNoField,
} from '../../src';
import { Section, Specimen } from '../Specimen';

/* A picture with no network behind it: two tones and a horizon, drawn as an SVG in the address itself. */
const scene = (sky: string, land: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><rect width="400" height="300" fill="${sky}"/><path d="M0 210 Q100 150 200 200 T400 180 V300 H0Z" fill="${land}"/><circle cx="310" cy="80" r="26" fill="#fff" opacity=".7"/></svg>`,
  )}`;

/* A day so many days from today, as the date field takes one. */
const day = (ahead: number): string => {
  const at = new Date(Date.now() + ahead * 86_400_000);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};

const RESIDENTS = [
  'Andre Okoye',
  'Lucas Mendes',
  'Iris Bennett',
  'Owen Kim',
  'Ethan Cruz',
  'Liam Chen',
  'Omar Ramirez',
  'Elena Ito',
  'Mateo Colón',
  'Valeria Huang',
  'Andre Lowe',
  'Imani Medina',
];

/* A search that takes a moment, as one over a network does, and is dropped when a newer one replaces it. */
const findResident = (query: string, { signal }: { signal: AbortSignal }) =>
  new Promise<{ value: string; label: string; hint?: string }[]>((resolve, reject) => {
    const wait = setTimeout(() => {
      const words = query.trim().toLowerCase();
      resolve(
        RESIDENTS.filter((name) => name.toLowerCase().includes(words))
          .slice(0, 6)
          .map((name) => ({ value: name, label: name, hint: 'Resident' })),
      );
    }, 450);
    signal.addEventListener('abort', () => {
      clearTimeout(wait);
      reject(signal.reason);
    });
  });

const NOTES = Array.from({ length: 18 }, (_, at) => `Entry ${18 - at}: meter read, no change since the last visit.`);

/* What @mistriwork/ui has that the pages here had not needed yet, each with the behavior it was given. */
export function More() {
  const [pets, setPets] = useState<boolean | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [tried, setTried] = useState(false);
  const [form, setForm] = useState({
    name: 'Camila Nguyen',
    beds: '1' as string | null,
    move: '2026-12-01' as string | null,
    furnished: false,
  });
  const [locked, setLocked] = useState(false);
  return (
    <Section
      id="more"
      title="More parts"
      lede="The rest of @mistriwork/ui's list: masks, answers that are a choice, the furniture of a form and of a landing page, and the things that hold other things."
    >
      <Specimen name="Masked fields: the caret stays put, and a whole value says so">
        <div data-part="stack">
          <MaskedField label="Phone" name="phone" mask="phone" defaultValue="7205550142" />
          <MaskedField label="Card number" name="card" mask="card" hint="Try editing in the middle, or deleting across a space." />
          <MaskedField label="Move-in date" name="move" mask="date" optional />
        </div>
      </Specimen>

      <Specimen name="A yes or a no, several of a few, an agreement">
        <div data-part="stack">
          <YesNoField
            label="Will anyone bring a pet?"
            name="pets"
            value={pets}
            onValueChange={setPets}
            hint="It changes the deposit, not the decision."
          />
          <CheckCardsField
            label="What should the rent include?"
            name="included"
            max={2}
            hint="Up to two."
            exclusive="none"
            options={[
              { value: 'water', label: 'Water', hint: 'Metered monthly' },
              { value: 'heat', label: 'Heating', hint: 'October to April' },
              { value: 'parking', label: 'Parking', hint: 'One bay' },
              { value: 'none', label: 'Nothing', hint: 'Rent only' },
            ]}
            defaultValue={['water']}
          />
          <ConsentField
            name="terms"
            checked={agreed}
            onCheckedChange={setAgreed}
            error={tried && !agreed ? 'The application cannot be sent without this.' : undefined}
          >
            I agree that Lintel may check my references and credit history for this application.
          </ConsentField>
          <Button
            intent="primary"
            onClick={() => {
              setTried(true);
              if (agreed) toast.success('Sent');
            }}
          >
            Send application
          </Button>
        </div>
      </Specimen>

      <Specimen name="A form that holds its answers: each field controlled, the review live" wide>
        <Columns min="16rem">
          <div data-part="stack">
            <TextField
              label="Full name"
              required
              disabled={locked}
              value={form.name}
              onValueChange={(name) => setForm({ ...form, name: String(name) })}
              error={form.name.trim() === '' ? 'A name is needed to hold the home.' : undefined}
            />
            <SelectField
              label="Bedrooms"
              tip="Studios count as none. The list of homes is narrowed to this."
              disabled={locked}
              options={[
                { value: '0', label: 'Studio' },
                { value: '1', label: '1 bedroom' },
                { value: '2', label: '2 bedrooms' },
              ]}
              value={form.beds}
              onValueChange={(beds) => setForm({ ...form, beds: beds === null ? null : String(beds) })}
            />
            <DateField label="Move-in date" disabled={locked} value={form.move} onValueChange={(move) => setForm({ ...form, move })} />
            <SwitchField
              label="Furnished"
              hint="Adds the furnished homes only."
              disabled={locked}
              checked={form.furnished}
              onCheckedChange={(furnished) => setForm({ ...form, furnished })}
            />
          </div>
          <div data-part="stack">
            <ReviewList
              label="What the form holds"
              items={[
                { label: 'Name', value: form.name || '—' },
                { label: 'Bedrooms', value: form.beds === null ? '—' : form.beds === '0' ? 'Studio' : form.beds },
                { label: 'Move-in', value: form.move ?? '—' },
                { label: 'Furnished', value: form.furnished ? 'Yes' : 'No' },
              ]}
            />
            <SwitchField label="Lock the form" hint="Every field stands down at once." checked={locked} onCheckedChange={setLocked} />
            <Button onClick={() => setForm({ name: '', beds: null, move: null, furnished: false })}>Clear the answers</Button>
          </div>
        </Columns>
      </Specimen>

      <Specimen name="Fields that say more: a count, a cross to clear, bounds, limits, and why a file was turned away" wide>
        <Columns min="16rem">
          <div data-part="stack">
            <TextField label="Reference" clearable defaultValue="LN-2026-0142" hint="Type, then clear it with the cross." />
            <TextField label="Postcode" valid defaultValue="80205" hint="Found: Denver, Colorado." />
            <TextAreaField
              label="Notes for the technician"
              maxLength={160}
              defaultValue="Boiler loses pressure overnight. Tenant is home after four."
              hint="It grows as you type."
            />
            <SliderField label="Notice period" defaultValue={30} min={0} max={90} step={15} format={(days) => `${days} days`} />
          </div>
          <div data-part="stack">
            <SelectField
              label="Building"
              placeholder="Choose a building"
              options={[
                { value: 'ac', label: 'Alder Court', hint: '18 homes, Five Points' },
                { value: 'bh', label: 'Birch House', hint: '12 homes, Baker' },
                { value: 'cm', label: 'Cedar Mews', hint: 'Closed for works', disabled: true },
              ]}
              actions={[{ label: 'New building…', onAction: () => toast('A New building form would open') }]}
            />
            <DateField label="Viewing" hint="Weekdays, in the next month." min={day(0)} max={day(30)} unavailable={{ weekday: [0, 6] }} />
            <DateTimeField label="Visit" defaultValue={`${day(2)}T09:30`} min={day(0)} hint="A day and a time, one answer." />
            <LookupField
              label="Resident"
              noun="resident"
              placeholder="Type a name"
              load={findResident}
              onCreate={(name) => toast(`A New resident form would open for ${name}`)}
              hint="Looked up as you type; a name not found can be added."
            />
            <SensitiveField label="Door code" defaultValue="4821#" copyable hint="Copy it without showing it." />
            <FileField
              label="Photos of the room"
              accept="image/*"
              multiple
              maxFiles={3}
              maxSize={2 * 1024 * 1024}
              prompt="Drop pictures here, or"
            />
          </div>
        </Columns>
      </Specimen>

      <Specimen name="A form drawn from a description: steps, a question that depends on an answer, a review, a refusal" wide>
        <div data-part="apply">
          <SchemaForm
            label="Apply for a home"
            review
            send="Send application"
            steps={[
              {
                id: 'you',
                title: 'About you',
                lead: 'So we can reach you about the home.',
                fields: [
                  { name: 'name', label: 'Full name', kind: 'text', required: true },
                  { name: 'phone', label: 'Phone', kind: 'masked', mask: 'phone' },
                  {
                    name: 'email',
                    label: 'Email',
                    kind: 'text',
                    required: true,
                    hint: 'Try taken@example.test to see a refusal come back to this step.',
                    check: (answer) => (answer.includes('@') ? undefined : 'That is not an address.'),
                  },
                ],
              },
              {
                id: 'home',
                title: 'The home',
                fields: [
                  {
                    name: 'beds',
                    label: 'Bedrooms',
                    kind: 'choice',
                    initial: '1',
                    options: [
                      { value: '0', label: 'Studio' },
                      { value: '1', label: '1 bed' },
                      { value: '2', label: '2 beds' },
                    ],
                  },
                  { name: 'move_in', label: 'Move-in date', kind: 'date', required: true, min: day(0) },
                  { name: 'pets', label: 'Will anyone bring a pet?', kind: 'yesno', required: true },
                  {
                    name: 'pet_kind',
                    label: 'What kind of pet?',
                    kind: 'text',
                    required: true,
                    when: (answers) => answers.pets === 'yes',
                    hint: 'Asked only when the answer above is yes.',
                  },
                ],
              },
              {
                id: 'money',
                title: 'Money',
                lead: 'Rent is usually no more than a third of income.',
                fields: [
                  { name: 'income', label: 'Monthly income', kind: 'money', required: true, min: 1 },
                  { name: 'notes', label: 'Anything else', kind: 'textarea', maxLength: 200 },
                ],
              },
            ]}
            submit={async (answers) => {
              await new Promise((done) => setTimeout(done, 800));
              if (answers.email === 'taken@example.test') return { fields: { email: 'That address already has an application.' } };
              toast.success('Application sent', { description: `${answers.name}, we will be in touch.` });
              return undefined;
            }}
          />
        </div>
      </Specimen>

      <Specimen name="One step of a longer form, and the review before it is sent">
        <div data-part="stack">
          <StepHeader
            step={3}
            of={4}
            title="Check your answers"
            lead="Nothing is sent until you press Send. Each answer can still be changed."
          />
          <ReviewList
            label="Your answers"
            items={[
              { label: 'Name', value: 'Camila Nguyen', onChange: () => toast('Step 1 would open') },
              { label: 'Phone', value: '(720) 555-0142', onChange: () => toast('Step 1 would open') },
              { label: 'Move-in', value: 'December 1, 2026', onChange: () => toast('Step 2 would open') },
              { label: 'Pets', value: 'None' },
            ]}
          />
          <ProgressBar label="Documents uploaded" value={2} max={3} />
        </div>
      </Specimen>

      <Specimen name="People, badges, a link as a button, help behind a mark">
        <div data-part="stack">
          <div data-part="row">
            <Avatar name="Marta Lindqvist" size="sm" alone />
            <Avatar name="Jonas Becker" alone />
            <Avatar name="Kofi Asante" size="lg" alone />
            <Badge>Draft</Badge>
            <Badge tone="good" icon={<ShieldCheck weight="bold" />}>
              Verified
            </Badge>
            <Badge tone="warning">Due soon</Badge>
            <Badge tone="info">New</Badge>
          </div>
          <div data-part="row">
            <ButtonLink href="#rent-roll" intent="primary">
              Open the rent roll
            </ButtonLink>
            <Popover trigger={<Button>Filters</Button>} title="Filters">
              <p data-part="pop-note">A popover holds something to read or set beside what opened it.</p>
            </Popover>
            <span>
              Notice period <HelpTip>How long before leaving a resident must say so. Thirty days unless the lease says otherwise.</HelpTip>
            </span>
          </div>
        </div>
      </Specimen>

      <Specimen name="Tabs as data">
        <Tabs
          label="A lease's books"
          items={[
            { value: 'charges', label: 'Charges', count: 12, content: <p data-part="pop-note">Twelve charges, three open.</p> },
            { value: 'payments', label: 'Payments', count: 9, content: <p data-part="pop-note">Nine payments, the last on November 2.</p> },
            { value: 'notes', label: 'Notes', content: <p data-part="pop-note">No notes yet.</p> },
          ]}
        />
      </Specimen>

      <Specimen name="A landing page's blocks">
        <Columns min="14rem">
          <PhotoTiles
            tiles={[
              { src: scene('#9db8e8', '#2f5bd6'), alt: 'A blue hill at midday', caption: 'Alder Court' },
              { src: scene('#f0c9a8', '#a3441c'), alt: 'A clay hill at dusk' },
              { src: scene('#b9dccf', '#1d6a5a'), alt: 'A green hill in the morning' },
            ]}
          />
          <IconRows
            rows={[
              { icon: <Key />, title: 'Apply in ten minutes', text: 'One form, saved as you go.' },
              { icon: <CalendarCheck />, title: 'Book a viewing', text: 'Pick a time; we confirm by email.' },
              { icon: <Sparkle />, title: 'Move in', text: 'Sign online and collect your keys.' },
            ]}
          />
        </Columns>
      </Specimen>

      <Specimen name="Slides">
        <Carousel
          label="Homes to let"
          slides={[
            { id: 'a', label: 'Alder Court', content: <img data-part="slide" src={scene('#9db8e8', '#2f5bd6')} alt="Alder Court" /> },
            { id: 'b', label: 'Birch House', content: <img data-part="slide" src={scene('#f0c9a8', '#a3441c')} alt="Birch House" /> },
            { id: 'c', label: 'Cedar Mews', content: <img data-part="slide" src={scene('#b9dccf', '#1d6a5a')} alt="Cedar Mews" /> },
          ]}
        />
      </Specimen>

      <Specimen name="Panes the reader sizes, and a region that scrolls" wide>
        <div data-part="panes">
          <Split
            label="the panes"
            remember="gallery-split"
            panes={[
              {
                id: 'list',
                size: 35,
                min: 20,
                content: (
                  <p data-part="pane-note">Homes. Drag the bar, or focus it and use the arrows. The layout is kept for next time.</p>
                ),
              },
              {
                id: 'detail',
                min: 30,
                content: (
                  <ScrollArea label="Meter readings" maxHeight="11rem">
                    <ul data-part="notes">
                      {NOTES.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </ScrollArea>
                ),
              },
            ]}
          />
        </div>
      </Specimen>
    </Section>
  );
}
