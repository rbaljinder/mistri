import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { AppTreeList } from '../../packages/mistri/src/shared/appModel.js';
import { TreeList } from '../../packages/mistri/src/client/components/TreeList.js';
import { fixture } from '../mocks/core.js';

const account: TableMeta = {
  id: 'account',
  name: 'account',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'city', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'parent_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'account', column: 'id' } },
  ],
};

/* A company and what sits under it: each record hangs under the one its parent column names, to any depth. */
const rows = [
  { id: 1, name: 'Northwind Group', city: 'Seattle', parent_id: null },
  { id: 2, name: 'Northwind Retail', city: 'Portland', parent_id: 1 },
  { id: 3, name: 'Northwind Labs', city: 'Boise', parent_id: 1 },
  { id: 4, name: 'Labs West', city: 'San Jose', parent_id: 3 },
  { id: 5, name: 'Labs East', city: 'Boston', parent_id: 3 },
  { id: 6, name: 'Retail Outlets', city: 'Spokane', parent_id: 2 },
  { id: 7, name: 'Harborview Health', city: 'Chicago', parent_id: null },
  { id: 8, name: 'Harborview Clinics', city: 'Milwaukee', parent_id: 7 },
  { id: 9, name: 'Acme Freight', city: 'Austin', parent_id: null },
];

const spec: AppTreeList = { kind: 'tree', parent: 'parent_id', primary: 'name', lines: ['city'] };

const meta = {
  title: 'Lists/Tree',
  component: TreeList,
  args: { table: account, spec, entry: { kind: 'table', table: 'account', query: 'account' }, label: 'Account hierarchy' },
  beforeEach: () => {
    fixture({ tables: [account], answer: { '/api/run': () => ({ rows, more: false }) } });
  },
} satisfies Meta<typeof TreeList>;
export default meta;

export const AccountHierarchy: StoryObj<typeof meta> = {};
/* Without `lines` each record is its name alone. */
export const NamesOnly: StoryObj<typeof meta> = { args: { spec: { kind: 'tree', parent: 'parent_id', primary: 'name' } } };
export const Narrow: StoryObj<typeof meta> = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 380 }}>
        <Story />
      </div>
    ),
  ],
};
