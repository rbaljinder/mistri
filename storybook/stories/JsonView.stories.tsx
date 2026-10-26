import type { Meta, StoryObj } from '@storybook/react-vite';
import { JsonView } from '../../packages/kit/src/client/components/JsonView.js';
import { JsonPreview } from '../../packages/kit/src/client/components/JsonPreview.js';

/* A Postgres jsonb document as the record draws it: laid out by its shape,
   not printed as text. */
const order = {
  id: 'ord_7Hk2',
  placed_at: '2026-08-01T09:14:00Z',
  status: 'shipped',
  total: 1249.5,
  gift: false,
  coupon: null,
  customer: { name: 'Nia Andersen', email: 'nia@example.test', tier: 'gold' },
  lines: [
    { sku: 'BK-101', title: 'Field notebook', qty: 3, price: 12.5 },
    { sku: 'PN-220', title: 'Fountain pen', qty: 1, price: 89 },
    { sku: 'IN-003', title: 'Ink, blue-black', qty: 2, price: 14 },
  ],
  tags: ['priority', 'wholesale'],
  shipping: { carrier: 'DHL', tracking: 'JD014600003', address: { line1: '4 Harbour Row', city: 'Leith', country: 'GB' } },
};

const meta = { title: 'Values/JSON', component: JsonView } satisfies Meta<typeof JsonView>;
export default meta;

export const Document: StoryObj<typeof meta> = { args: { value: order } };

export const ListOfRecords: StoryObj<typeof meta> = { args: { value: order.lines } };

export const Preview: StoryObj<typeof JsonPreview> = {
  render: () => <JsonPreview value={order} name="payload" type="jsonb" />,
};
