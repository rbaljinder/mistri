import { DotsSixVertical } from '@phosphor-icons/react';
import { toast } from '@ui-sdk/react/toast';
import { useState } from 'react';
import {
  Checklist,
  type ChecklistItem,
  DayPicker,
  PickList,
  Sortable,
  SortableHandle,
  SortableItem,
  Transfer,
  TransferHandle,
  TransferItem,
  TransferList,
} from '../../src';
import { Section, Specimen } from '../Specimen';

/* The behaviors on their own, before anything is composed on them: what a component gets for free by standing on
   one. The board and the column chooser elsewhere in the gallery are these with a look of their own. */

const SHADES = ['#2f5bd6', '#1d6a5a', '#6a45d1', '#a3441c', '#b8860b', '#5b6770'];

const TEAM: Record<string, string> = {
  marta: 'Marta Lindqvist',
  jonas: 'Jonas Becker',
  kofi: 'Kofi Asante',
  sara: 'Sara Whitlock',
  devi: 'Devi Raman',
};

export function Behaviors() {
  const [steps, setSteps] = useState(['Triage', 'Assign a technician', 'Book a visit', 'Do the work', 'Close']);
  const [tiles, setTiles] = useState(SHADES);
  const [rota, setRota] = useState<Record<string, string[]>>({ off: ['marta', 'jonas', 'kofi'], on: ['sara'], lead: ['devi'] });
  const [fields, setFields] = useState(['Rent', 'Deposit', 'Move-in date', 'Notice period']);
  const [crew, setCrew] = useState(['sara']);
  const [todo, setTodo] = useState<ChecklistItem[]>([
    { id: 'keys', label: 'Cut two sets of keys', done: true },
    { id: 'meter', label: 'Read the meters' },
    { id: 'clean', label: 'Book the cleaner' },
    { id: 'photos', label: 'Photograph every room' },
  ]);

  return (
    <Section
      id="behaviors"
      title="Behaviors"
      lede="Things the reader moves, as UI SDK primitives of ui-next's own: a pointer, a keyboard and a screen reader each get the whole of it."
    >
      <Specimen name="Sortable: Space picks one up, the arrows place it">
        <Sortable aria-label="Steps of a repair" value={steps} onValueChange={setSteps} data-kind="demo-list">
          {(step) => (
            <SortableItem key={step} value={step}>
              {step}
            </SortableItem>
          )}
        </Sortable>
      </Specimen>

      <Specimen name="Sortable, as a grid">
        <Sortable aria-label="Swatches" orientation="grid" value={tiles} onValueChange={setTiles} data-kind="demo-grid">
          {(shade) => <SortableItem key={shade} value={shade} aria-label={shade} style={{ background: shade }} />}
        </Sortable>
      </Specimen>

      <Specimen name="Sortable by a handle, for items with controls of their own">
        <Sortable by="handle" aria-label="Fields on the lease form" value={fields} onValueChange={setFields} data-kind="demo-list">
          {(field) => (
            <SortableItem key={field} value={field}>
              <SortableHandle aria-label={`Move ${field}`}>
                <DotsSixVertical aria-hidden="true" weight="bold" />
              </SortableHandle>
              <span>{field}</span>
              <button type="button" data-slot="more-link" onClick={() => toast(`${field} would open`)}>
                Edit
              </button>
            </SortableItem>
          )}
        </Sortable>
      </Specimen>

      <Specimen name="Composed on Sortable: a checklist">
        <Checklist label="Before the keys are handed over" items={todo} onItemsChange={setTodo} />
      </Specimen>

      <Specimen name="Composed on Transfer: some of many, in an order" wide>
        <PickList
          label="Who is on the visit"
          from="Technicians"
          to="On this visit"
          max={3}
          options={Object.entries(TEAM).map(([value, name]) => ({ value, label: name }))}
          value={crew}
          onValueChange={setCrew}
        />
      </Specimen>

      <Specimen name="Transfer: between lists, with a rule (one lead at most)" wide>
        <Transfer
          value={rota}
          order={['off', 'on', 'lead']}
          accepts={(person, list) => list !== 'lead' || (rota.lead ?? []).filter((each) => each !== person).length === 0}
          label={(person) => TEAM[person]}
          listLabel={(list) => ({ off: 'Off this week', on: 'On call', lead: 'Lead' })[list]}
          onValueChange={setRota}
          data-kind="demo-lanes"
        >
          {(
            [
              ['off', 'Off this week'],
              ['on', 'On call'],
              ['lead', 'Lead'],
            ] as const
          ).map(([list, name]) => (
            <TransferList
              key={list}
              value={list}
              render={<section />}
              aria-label={name}
              around={(items, state) => (
                <>
                  <h3>
                    {name}
                    <small>{state.refuses ? 'Has its lead' : state.takes ? 'Drop here' : state.keys.length}</small>
                  </h3>
                  <ul>{items}</ul>
                </>
              )}
            >
              {(person) => (
                <TransferItem key={person} value={person}>
                  <TransferHandle aria-label={`Carry ${TEAM[person]}`}>
                    <DotsSixVertical aria-hidden="true" weight="bold" />
                  </TransferHandle>
                  {TEAM[person]}
                </TransferItem>
              )}
            </TransferList>
          ))}
        </Transfer>
      </Specimen>
      <Specimen name="Composed on Days: a day chosen from a month (the calendar's grid, with another look)" wide>
        <VisitDay />
      </Specimen>
    </Section>
  );
}

/* The Days behavior is the month calendar's keyboard. Here it is a picker: the same arrows, Home and End, page
   keys and Enter, over days that say how many visits are free and some that cannot be had. */
function VisitDay() {
  const [day, setDay] = useState<string | null>(null);
  const free = (one: string) => (Number(one.slice(8)) * 7) % 5;
  return (
    <div data-part="visit-day">
      <DayPicker
        label="A day to visit"
        defaultMonth="2026-11"
        today="2026-11-14"
        min="2026-11-14"
        max="2027-01-31"
        value={day}
        onValueChange={setDay}
        unavailable={(one) => new Date(`${one}T00:00:00Z`).getUTCDay() === 0 || free(one) === 0}
        note={(one) => `${free(one)} free`}
      />
      <p aria-live="polite">
        {day
          ? `Visit on ${new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}.`
          : 'No day chosen yet.'}
      </p>
    </div>
  );
}
