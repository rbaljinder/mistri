import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { AppCardsList } from '../../packages/engine/src/shared/appCards.js';
import { CardsList } from '../../packages/kit/src/client/components/CardsList.js';
import { fixture } from '../mocks/core.js';
import { photo } from './photos.js';

const column = (name: string, type: string, nullable = false) => ({ name, type, nullable, primaryKey: name === 'id' });
const vehicle: TableMeta = {
  id: 'vehicle',
  name: 'vehicle',
  schema: '',
  isView: false,
  columns: [
    column('id', 'INTEGER'),
    column('title', 'TEXT'),
    column('price', 'INTEGER'),
    column('year', 'INTEGER'),
    column('mileage', 'INTEGER'),
    column('fuel', 'TEXT'),
    column('highlight', 'TEXT', true),
    column('photo', 'TEXT', true),
  ],
};

const cars: Array<[string, number, number, number, string, string | null]> = [
  ['2021 Toyota Corolla 1.8 Hybrid', 14995, 2021, 31200, 'Hybrid', 'One owner'],
  ['2019 Ford Escape 1.5 SE', 9495, 2019, 48750, 'Gas', null],
  ['2022 Volkswagen Jetta 1.5 SE', 18750, 2022, 21400, 'Gas', 'Price reduced'],
  ['2020 BMW 330i M Sport', 21990, 2020, 39800, 'Gas', null],
  ['2023 Kia Niro EV 4', 27495, 2023, 8900, 'Electric', 'Low mileage'],
  ['2018 Honda Fit 1.5 EX', 8250, 2018, 52300, 'Gas', null],
  ['2021 Tesla Model 3 Long Range', 26990, 2021, 34100, 'Electric', 'Just arrived'],
  ['2022 Mazda CX-5 2.5 Preferred', 22495, 2022, 17600, 'Gas', null],
];
const rows = cars.map(([title, price, year, mileage, fuel, highlight], i) => ({
  id: i + 1,
  title,
  price,
  year,
  mileage,
  fuel,
  highlight,
  photo: photo(`car-${i}`),
}));

const spec: AppCardsList = {
  kind: 'cards',
  primary: 'title',
  value: 'price',
  badge: 'highlight',
  lines: ['year', 'mileage', 'fuel'],
  image: 'photo',
};

const meta = {
  title: 'Lists/Cards',
  component: CardsList,
  args: { table: vehicle, rows, spec, label: 'Vehicles' },
  beforeEach: () => {
    fixture({ tables: [vehicle] });
  },
} satisfies Meta<typeof CardsList>;
export default meta;

/* One to four columns by the room's width; the whole card opens the record. */
export const Grid: StoryObj<typeof meta> = {};
/* A row without a picture keeps its 4:3 place, so the grid never moves. */
export const WithoutPhotos: StoryObj<typeof meta> = { args: { rows: rows.slice(0, 4).map((row) => ({ ...row, photo: null })) } };
export const Narrow: StoryObj<typeof meta> = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
};

/* A people directory uses the shared avatar cards vocabulary: the person is
 * primary, with role and team facts doing the hierarchy work. */
const person: TableMeta = {
  id: 'person',
  name: 'person',
  schema: '',
  isView: false,
  columns: [
    column('id', 'INTEGER'),
    column('name', 'TEXT'),
    column('role', 'TEXT'),
    column('team', 'TEXT'),
    column('location', 'TEXT'),
    column('status', 'TEXT'),
  ],
};
const people = [
  { id: 1, name: 'Maya Chen', role: 'Product designer', team: 'Design', location: 'New York', status: 'Active' },
  { id: 2, name: 'Owen Brooks', role: 'Staff engineer', team: 'Platform', location: 'Austin', status: 'On leave' },
  { id: 3, name: 'Priya Shah', role: 'People partner', team: 'People', location: 'Chicago', status: 'Active' },
  { id: 4, name: 'Noah Williams', role: 'Account executive', team: 'Sales', location: 'Denver', status: 'Active' },
];
const peopleSpec: AppCardsList = { kind: 'cards', primary: 'name', media: 'avatar', badge: 'team', facts: ['role'], lines: ['location'] };

export const PeopleDirectory: StoryObj<typeof meta> = {
  args: { table: person, rows: people, spec: peopleSpec, label: 'People' },
  beforeEach: () => {
    fixture({ tables: [person] });
  },
};
