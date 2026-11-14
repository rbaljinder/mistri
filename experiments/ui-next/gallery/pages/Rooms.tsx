import { toast } from '@ui-sdk/react/toast';
import { useMemo, useState } from 'react';
import { type Card, Cards, Facts, FilterRail, ListDetail, Queue, Status, TextField } from '../../src';
import { SearchWords } from '../../src/Mark';
import { money, STATUS_TONE, UNITS } from '../data';

/* Three more of Lintel's rooms, each a list read another way than as a table: the homes to let as cards, the
   residents as a list with the picked one beside it, and the applications as a queue worked one at a time. */

/* A drawing in place of a photograph, so the gallery fetches nothing: a sky, a block of flats, its windows. */
const picture = (seed: number): string => {
  const hue = (seed * 47) % 360;
  const windows = Array.from({ length: 12 }, (_, at) => {
    const x = 96 + (at % 4) * 34;
    const y = 70 + Math.floor(at / 4) * 36;
    const lit = (seed + at * 7) % 3 === 0;
    return `<rect x='${x}' y='${y}' width='20' height='24' rx='2' fill='hsl(${lit ? 45 : hue} ${lit ? 90 : 25}% ${lit ? 78 : 38}%)'/>`;
  }).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 240'><rect width='320' height='240' fill='hsl(${hue} 45% 88%)'/><rect x='80' y='50' width='160' height='190' rx='4' fill='hsl(${hue} 22% 52%)'/>${windows}<rect y='214' width='320' height='26' fill='hsl(${hue} 18% 34%)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const TO_LET = UNITS.filter((unit) => unit.status === 'Vacant' || unit.status === 'Turnover');
const bedsOf = (unit: (typeof UNITS)[number]): string => (unit.beds === 0 ? 'Studio' : `${unit.beds} bed`);
const READS: Record<string, (unit: (typeof UNITS)[number]) => string> = {
  building: (unit) => unit.building,
  beds: bedsOf,
  listed: (unit) => (unit.listed ? 'Listed' : 'Not listed'),
};

export function Homes() {
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const asked = search.trim().toLowerCase();
  /* A group's counts are of what the other groups and the search leave, so a count is what choosing it would show. */
  const passes = (unit: (typeof UNITS)[number], but?: string): boolean =>
    `${unit.code} ${unit.building}`.toLowerCase().includes(asked) &&
    Object.entries(chosen).every(([id, values]) => id === but || values.length === 0 || values.includes(READS[id]?.(unit) ?? ''));
  const facet = (id: string, label: string, options: string[]) => ({
    id,
    label,
    options: options.map((value) => ({
      value,
      label: value,
      count: TO_LET.filter((unit) => passes(unit, id) && READS[id]?.(unit) === value).length,
    })),
  });
  const cards = useMemo<Card[]>(
    () =>
      TO_LET.filter((unit) => passes(unit)).map((unit) => {
        const at = TO_LET.indexOf(unit);
        return {
          id: unit.code,
          title: `${unit.building} ${unit.code}`,
          figure: `${money(unit.rent)} a month`,
          facts: [
            { label: 'Beds', value: unit.beds === 0 ? 'Studio' : unit.beds },
            { label: 'Size', value: `${unit.size} sq ft` },
            { label: 'Free', value: unit.available ?? 'Now' },
          ],
          badge: { label: unit.listed ? 'Listed' : 'Not listed', tone: unit.listed ? 'good' : 'warning' },
          picture: at % 5 === 3 ? null : picture(at + 3),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, chosen],
  );
  return (
    <div data-part="today">
      <header data-slot="list-head">
        <h1>
          Homes to let <span data-slot="list-count">{cards.length}</span>
        </h1>
      </header>
      <div data-part="railed">
        <FilterRail
          label="Filters"
          value={chosen}
          onValueChange={setChosen}
          facets={[
            facet('building', 'Building', [...new Set(TO_LET.map((unit) => unit.building))]),
            facet('beds', 'Beds', ['Studio', '1 bed', '2 bed', '3 bed']),
            facet('listed', 'Advertised', ['Listed', 'Not listed']),
          ]}
        />
        <div data-part="railed-main">
          <div data-part="dash-filters">
            <TextField label="Search homes" labelHidden placeholder="Search homes" value={search} onValueChange={setSearch} clearable />
          </div>
          <SearchWords value={search}>
            <Cards
              label="Homes to let"
              cards={cards}
              onOpen={(card) => toast(`${card.title} would open here`)}
              empty="No home matches that."
            />
          </SearchWords>
        </div>
      </div>
    </div>
  );
}

const LIVING = UNITS.filter((unit) => unit.resident).slice(0, 14);

export function Residents() {
  const [pick, setPick] = useState<string | null>(null);
  return (
    <div data-part="today">
      <header data-slot="list-head">
        <h1>
          Residents <span data-slot="list-count">{LIVING.length}</span>
        </h1>
      </header>
      <ListDetail
        label="Residents"
        items={LIVING}
        keyOf={(unit) => unit.code}
        titleOf={(unit) => unit.resident ?? unit.code}
        pick={pick}
        onPickChange={setPick}
        row={(unit) => (
          <span data-part="resident-row">
            <b>{unit.resident}</b>
            <span>
              {unit.building} {unit.code}
            </span>
          </span>
        )}
        detail={(unit) => (
          <div data-part="resident">
            <h2>{unit.resident}</h2>
            <p>
              <Status tone={STATUS_TONE[unit.status]}>{unit.status}</Status>
            </p>
            <Facts
              items={[
                { label: 'Home', value: `${unit.building} ${unit.code}` },
                { label: 'Rent', value: `${money(unit.rent)} a month` },
                { label: 'Beds', value: unit.beds === 0 ? 'Studio' : String(unit.beds) },
                { label: 'Size', value: `${unit.size} sq ft` },
              ]}
            />
            <p data-part="resident-note">
              Up and Down read down the list and this pane keeps up. Enter comes in here, Escape goes back to the row.
            </p>
          </div>
        )}
      />
    </div>
  );
}

type Application = { id: string; name: string; home: string; income: number; rent: number; pets: string; moveIn: string; flag?: string };
const APPLICATIONS: Application[] = [
  { id: 'a1', name: 'Camila Nguyen', home: 'Alder Court AC-204', income: 5200, rent: 1385, pets: 'None', moveIn: 'Dec 1' },
  {
    id: 'a2',
    name: 'Tomasz Baran',
    home: 'Birch House BH-102',
    income: 3100,
    rent: 1290,
    pets: 'One cat',
    moveIn: 'Dec 15',
    flag: 'Income is under three times the rent.',
  },
  { id: 'a3', name: 'Ifeoma Chukwu', home: 'Cedar Mews CM-201', income: 6400, rent: 1610, pets: 'None', moveIn: 'Jan 1' },
  {
    id: 'a4',
    name: 'Leon Fischer',
    home: 'Alder Court AC-103',
    income: 4800,
    rent: 1285,
    pets: 'A dog, 30 lb',
    moveIn: 'Dec 8',
    flag: 'The building takes cats only.',
  },
  { id: 'a5', name: 'Sana Qureshi', home: 'Dunlin Lofts DL-004', income: 7100, rent: 1750, pets: 'None', moveIn: 'Dec 20' },
];

export function Applications() {
  return (
    <div data-part="today">
      <header data-slot="list-head">
        <h1>
          Applications <span data-slot="list-count">{APPLICATIONS.length} to review</span>
        </h1>
      </header>
      <Queue
        label="Applications to review"
        items={APPLICATIONS}
        keyOf={(application) => application.id}
        titleOf={(application) => `${application.name}, ${application.home}`}
        verbs={[
          { value: 'approve', label: 'Approve', intent: 'primary', shortcut: 'a' },
          { value: 'more', label: 'Ask for more', shortcut: 'm' },
          { value: 'decline', label: 'Decline', intent: 'danger', shortcut: 'd' },
        ]}
        onVerb={async (application, verb) => {
          await new Promise((settle) => window.setTimeout(settle, 350));
          if (verb === 'approve' && application.flag) throw new Error(`Not approved: ${application.flag}`);
        }}
        done="Every application has an answer."
      >
        {(application) => (
          <>
            {application.flag && (
              <p>
                <Status tone="warning">{application.flag}</Status>
              </p>
            )}
            <Facts
              items={[
                { label: 'Income', value: `${money(application.income)} a month` },
                { label: 'Rent', value: `${money(application.rent)} a month` },
                { label: 'Pets', value: application.pets },
                { label: 'Moves in', value: application.moveIn },
              ]}
            />
          </>
        )}
      </Queue>
    </div>
  );
}
