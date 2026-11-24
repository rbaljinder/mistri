/** Runtime gallery page for all 16 picker primitives (`/gallery-pickers`). */
import { Card, DateNav, Stack, definePage, useState } from '@mistriwork/mistri/page';
import {
  Autocomplete,
  CalendarGrid,
  ColorPicker,
  Combobox,
  DateField,
  DatePicker,
  DateTimePicker,
  Dropdown,
  EntityPicker,
  Field,
  FormColumns,
  Listbox,
  MultiDropdown,
  MultiSelect,
  Select,
  TimeInput,
  TreeSelect,
  Typeahead,
} from '@mistriwork/mistri/primitives';
import { Icon } from '@mistriwork/mistri/ui';

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Routine scheduled inspection' },
  { value: 'medium', label: 'Standard next-day dispatch' },
  { value: 'high', label: 'Emergency containment and pressure isolation across north plant' },
];

const CREW_ENTITIES = [
  { id: 'c1', label: 'Ana Ruiz', subtitle: 'Lead Millwright · Zone North' },
  { id: 'c2', label: 'Ben Okafor', subtitle: 'Controls Specialist · Zone East' },
  { id: 'c3', label: 'Cy Marlow', subtitle: 'Hydraulics Tech · Zone South' },
];

const SITE_TREE = [
  {
    value: 'north',
    label: 'North Campus',
    children: [
      { value: 'bldg-a', label: 'Boiler House A' },
      { value: 'bldg-b', label: 'Compressor Bay B' },
    ],
  },
  {
    value: 'south',
    label: 'South Depot',
    children: [{ value: 'yard-1', label: 'Loading Dock 1' }],
  },
];

const DATE_WORDS = {
  timePattern: 'HH:MM',
  enterDateAndTime: (f: string) => `Enter ${f} HH:MM`,
  enterDate: (f: string) => `Enter ${f}`,
  dateAndTimeFormat: (f: string) => `Format ${f} HH:MM`,
  dateFormat: (f: string) => `Format ${f}`,
  openWithKeys: 'Alt+Down opens calendar.',
  chooseDate: (l?: string) => (l ? `Choose ${l}` : 'Choose date'),
  calendar: (l?: string) => l ?? 'Calendar',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  clear: 'Clear',
  today: 'Today',
};

export default definePage({
  label: 'Gallery pickers',
  nav: false,
  reads: ['deal'],
  component: GalleryPickers,
});

function GalleryPickers() {
  const [priority, setPriority] = useState('high');
  const [multi, setMulti] = useState<string[]>(['low', 'medium']);
  const [drop, setDrop] = useState('medium');
  const [multiDrop, setMultiDrop] = useState<string[]>(['high']);
  const [combo, setCombo] = useState<string | null>('high');
  const [comboMulti, setComboMulti] = useState<string[]>(['low', 'high']);
  const [auto, setAuto] = useState('Check relief valve');
  const [typed, setTyped] = useState('Ana');
  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [listbox, setListbox] = useState<string | null>('c1');
  const [entity, setEntity] = useState<string | null>('c1');
  const [tree, setTree] = useState<string | null>('bldg-a');
  const [day, setDay] = useState('2026-09-04');
  const [singleDate, setSingleDate] = useState<string | null>('2026-09-04');
  const [rangeDate, setRangeDate] = useState<[string, string] | null>(['2026-09-01', '2026-09-08']);
  const [time, setTime] = useState('09:30');
  const [dateTime, setDateTime] = useState<string | null>('2026-09-04T09:30');
  const [navDay, setNavDay] = useState('2026-09-04');
  const [color, setColor] = useState('#2563eb');

  return (
    <Stack>
      <Card title="Menu, combobox, entity, and tree pickers">
        <FormColumns columns={2}>
          <div>
            <Select label="Dispatch priority" options={PRIORITY_OPTIONS} value={priority} onValueChange={setPriority} />
          </div>
          <div>
            <MultiSelect label="Escalation tiers" options={PRIORITY_OPTIONS} value={multi} onValueChange={setMulti} />
          </div>
          <div>
            <Dropdown ariaLabel="Stage filter" items={PRIORITY_OPTIONS} value={drop} onValueChange={setDrop} />
          </div>
          <div>
            <MultiDropdown ariaLabel="Included queues" items={PRIORITY_OPTIONS} value={multiDrop} onValueChange={setMultiDrop} />
          </div>
          <div data-gallery-field="combobox-single">
            <Combobox
              label="Searchable priority"
              options={PRIORITY_OPTIONS}
              value={combo}
              clearable
              onValueChange={(v) => setCombo(v as string | null)}
            />
          </div>
          <div data-gallery-field="combobox-multi">
            <Combobox
              label="Assigned tags"
              multiple
              options={PRIORITY_OPTIONS}
              value={comboMulti}
              onValueChange={(v) => setComboMulti(v as string[])}
            />
          </div>
          <div data-gallery-field="autocomplete">
            <Autocomplete
              label="Standard procedure"
              suggestions={['Check relief valve', 'Inspect coupling alignment', 'Purge condensate line']}
              value={auto}
              clearable
              onValueChange={setAuto}
            />
          </div>
          <div>
            <Field label="Technician lookup">
              <Typeahead
                text={typed}
                onText={(next) => setTyped(next)}
                open={typeaheadOpen}
                onOpenChange={(next) => setTypeaheadOpen(next)}
                items={CREW_ENTITIES}
                itemKey={(item) => item.id}
                itemLabel={(item) => item.label}
                itemClassName={() => ''}
                renderItem={(item) => item.label}
                onPick={(item) => setTyped(item.label)}
                inputProps={{ ariaLabel: 'Technician lookup', placeholder: 'Search technician' }}
                popupClassName=""
                listClassName=""
              />
            </Field>
          </div>
          <div>
            <EntityPicker label="Primary technician" entities={CREW_ENTITIES} value={entity} onValueChange={setEntity} />
          </div>
          <div>
            <TreeSelect label="Facility location" nodes={SITE_TREE} value={tree} onValueChange={setTree} />
          </div>
        </FormColumns>
        <Listbox
          label="Inline crew roster"
          options={CREW_ENTITIES.map((c) => ({ value: c.id, label: c.label, description: c.subtitle }))}
          value={listbox}
          onValueChange={(v) => setListbox(v as string | null)}
        />
      </Card>

      <Card title="Date, time, range, and swatch pickers">
        <FormColumns columns={2}>
          <div data-gallery-field="date-field">
            <Field label="Scheduled date">
              <DateField
                id="gallery-scheduled-date"
                ariaLabel="Scheduled date"
                words={DATE_WORDS}
                calendarIcon={<Icon name="calendar-blank" />}
                value={day}
                onValueChange={(next) => setDay(next)}
              />
            </Field>
          </div>
          <div data-gallery-field="date-picker-single">
            <DatePicker
              label="Target completion"
              mode="single"
              clearable
              value={singleDate}
              onValueChange={(v) => setSingleDate(v as string | null)}
            />
          </div>
          <div data-gallery-field="date-picker-range">
            <DatePicker
              label="Maintenance window"
              mode="range"
              clearable
              value={rangeDate}
              onValueChange={(v) => setRangeDate(v as [string, string] | null)}
            />
          </div>
          <div data-gallery-field="date-picker-disabled">
            <DatePicker label="Locked audit date" mode="single" disabled clearable value="2026-09-04" onValueChange={() => {}} />
          </div>
          <div data-gallery-field="time-input">
            <TimeInput label="Arrival time" hourCycle={12} value={time} onValueChange={(v) => setTime(v ?? '')} />
          </div>
          <div data-gallery-field="time-input-invalid">
            <TimeInput
              label="Invalid shift start"
              hourCycle={12}
              value="11:45"
              invalid
              error="Outside permitted plant access window."
              onValueChange={() => {}}
            />
          </div>
          <div data-gallery-field="datetime-picker">
            <DateTimePicker label="Dispatch timestamp" value={dateTime} onValueChange={setDateTime} />
          </div>
          <div>
            <ColorPicker label="Route marker color" value={color} onValueChange={setColor} />
          </div>
        </FormColumns>

        <DateNav label="Schedule day" value={navDay} onValueChange={setNavDay} />
        <CalendarGrid bordered ariaLabel="Monthly dispatch calendar" defaultValue="2026-09-04" />
      </Card>
    </Stack>
  );
}
