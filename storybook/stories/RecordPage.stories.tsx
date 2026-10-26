import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { PageDef } from '../../packages/kit/src/client/components/pageModel.js';
import { PageView } from '../../packages/kit/src/client/components/Page.js';
import { applicationFixture } from '../mocks/core.js';

const table: TableMeta = {
  id: 'person',
  name: 'person',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    ...['name', 'email', 'team', 'role', 'location', 'status', 'started', 'notes'].map((name) => ({
      name,
      type: name === 'started' ? 'DATE' : 'TEXT',
      primaryKey: false,
      nullable: true,
    })),
  ],
};
const row = {
  id: 1,
  name: 'Maya Chen',
  email: 'maya.chen@example.test',
  team: 'Customer experience',
  role: 'Implementation specialist',
  location: 'Toronto',
  status: 'Active',
  started: '2025-04-14',
  notes: 'Coordinates new customer onboarding and keeps the team’s handover documentation up to date.',
};
const app = {
  id: 'studio',
  name: 'Fieldwork',
  ui: {},
  views: { people: { table: 'person', label: 'People' } },
  nav: [],
  resources: {
    person: {
      table: 'person',
      label: 'Person',
      plural: 'People',
      labels: { started: 'Start date', email: 'Email address' },
      display: { name: { avatar: true } },
    },
  },
};
const standard: PageDef = {
  id: 'person-profile',
  name: 'Person',
  base: 'person',
  source: 'config',
  sections: [
    { kind: 'fields', title: 'Contact details', paths: ['name', 'email', 'location'], presentation: 'properties' },
    { kind: 'fields', title: 'Employment', paths: ['team', 'role', 'status', 'started'], presentation: 'properties' },
  ],
};
async function setup(values = row, failure = false) {
  await applicationFixture({
    app,
    tables: [table],
    writable: false,
    answer: {
      '/api/view/run': ({ view }: { view: { columns: Array<{ path: string }> } }) => {
        if (failure) throw new Error('This record could not be loaded. Try again in a moment.');
        return {
          view,
          columns: view.columns.map((column) => column.path),
          rows: [values],
          resolved: [],
          errors: [],
          joinCount: 0,
          ms: 1,
          more: false,
          limit: 1,
          offset: 0,
        };
      },
    },
  });
}
const meta = {
  title: 'Records/Complete page',
  beforeEach: async () => {
    await setup();
  },
} satisfies Meta;
export default meta;
function Record({ page = standard }: { page?: PageDef }) {
  const [label, onLabel] = useState(row.name);
  const [tab, onTab] = useState<string | undefined>();
  return (
    <PageView
      entry={{ kind: 'page', pageId: page.id, table: table.id, key: { id: 1 }, label, tab }}
      page={page}
      base={table}
      plans={[]}
      others={[]}
      onLabel={onLabel}
      onTab={onTab}
      onLayout={() => {}}
    />
  );
}
export const Profile: StoryObj = { render: () => <Record /> };
export const MainAndContext: StoryObj = {
  render: () => (
    <Record
      page={{
        ...standard,
        sections: [
          ...standard.sections,
          { kind: 'fields', title: 'Working with Maya', paths: ['notes'], region: 'aside', presentation: 'properties' },
        ],
      }}
    />
  ),
};
export const Tabbed: StoryObj = {
  render: () => (
    <Record
      page={{
        ...standard,
        sections: standard.sections.map((section, index) => ({ ...section, tab: index ? 'Employment & responsibilities' : 'Overview' })),
      }}
    />
  ),
};
export const LongValues: StoryObj = {
  beforeEach: async () => {
    await setup({
      ...row,
      name: 'Alexandria Montgomery-Wellington',
      email: 'alexandria.montgomery-wellington@customer-experience.example.test',
      role: 'Senior implementation specialist for international customer operations',
    });
  },
  render: () => <Record />,
};
export const Unavailable: StoryObj = {
  beforeEach: async () => {
    await setup(row, true);
  },
  render: () => <Record />,
};

export const SummaryAndContext: StoryObj = {
  render: () => (
    <Record
      page={{
        ...standard,
        sections: [
          { kind: 'fields', title: 'Employment summary', paths: ['status', 'team', 'started', 'location'], presentation: 'summary' },
          { kind: 'fields', title: 'Contact', paths: ['email', 'role'], region: 'aside', presentation: 'properties' },
        ],
      }}
    />
  ),
};
