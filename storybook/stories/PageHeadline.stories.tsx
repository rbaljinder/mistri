import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ColumnMeta, TableMeta } from '../../packages/engine/src/shared/schema.js';
import { PageHeadline } from '../../packages/kit/src/client/components/PageHeadline.js';
import { applicationFixture } from '../mocks/core.js';

const columns: ColumnMeta[] = [
  { name: 'price', type: 'INTEGER', nullable: false, primaryKey: false },
  { name: 'year', type: 'INTEGER', nullable: false, primaryKey: false },
  { name: 'mileage', type: 'INTEGER', nullable: false, primaryKey: false },
  { name: 'fuel', type: 'TEXT', nullable: false, primaryKey: false },
  { name: 'transmission', type: 'TEXT', nullable: false, primaryKey: false },
];
const vehicle: TableMeta = {
  id: 'vehicle',
  name: 'vehicle',
  schema: '',
  isView: false,
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, ...columns],
};

const meta = {
  title: 'Records/Headline',
  component: PageHeadline,
  args: {
    tableId: 'vehicle',
    row: { price: 24995, year: 2025, mileage: 8610, fuel: 'Hybrid', transmission: 'Automatic' },
    paths: ['price', 'year', 'mileage', 'fuel', 'transmission'],
    column: (path: string) => columns.find((item) => item.name === path),
    actions: [{ label: 'Inquire about this car', view: 'inquire' }],
  },
  /* The Inquire button opens the App's public form, found among its forms; the
     price is the App's money, as Forecourt's is — a bare 24,995 said no currency. */
  beforeEach: async () => {
    await applicationFixture({
      tables: [vehicle],
      answer: { '/api/forms': () => ({ forms: [{ id: 'inquire' }] }) },
      app: {
        id: 'forecourt',
        name: 'Forecourt',
        ui: { currency: 'USD' },
        nav: [],
        views: {},
        resources: {
          vehicle: {
            table: 'vehicle',
            display: { price: { format: 'money', currency: 'USD' }, mileage: { format: 'number', unit: 'mi' } },
          },
        },
      },
    });
  },
} satisfies Meta<typeof PageHeadline>;
export default meta;

/* The figure large, the facts in a row, the call to action beside it (under it on a phone). */
export const Price: StoryObj<typeof meta> = {};
export const TwoActions: StoryObj<typeof meta> = {
  args: {
    actions: [
      { label: 'Inquire about this car', view: 'inquire' },
      { label: 'Book a test drive', view: 'inquire', kind: 'secondary' },
    ],
  },
};

/* In a page's side panel a headline is the offer card, beside the photos (Forecourt's vehicle page). */
export const OfferCard: StoryObj<typeof meta> = {
  decorators: [
    (Story) => (
      <div className="page-layout">
        <div className="page-body page-main">
          <div className="page-section" style={{ height: 360, borderRadius: 'var(--radius)', background: 'var(--raised)' }} />
        </div>
        <aside className="page-body page-aside" aria-label="Record context">
          <div className="page-section">
            <Story />
          </div>
        </aside>
      </div>
    ),
  ],
};
