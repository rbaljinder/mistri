import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import { PageLayout } from '../../packages/kit/src/client/components/PageLayout.js';
import { SectionBox } from '../../packages/kit/src/client/components/PageSectionBox.js';
import { Grid } from '../../packages/kit/src/client/components/Grid.js';
import { CardsList } from '../../packages/kit/src/client/components/CardsList.js';
import { RecordSummaries } from '../../packages/kit/src/client/components/RecordSummaries.js';
import { ListEmpty } from '../../packages/kit/src/client/components/ListEmpty.js';
import { GridSkeleton, RecordSkeleton } from '../../packages/kit/src/client/components/Skeleton.js';
import { applicationFixture } from '../mocks/core.js';

const table: TableMeta = {
  id: 'project',
  name: 'project',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    ...['name', 'owner', 'status', 'due_date'].map((name) => ({
      name,
      type: name === 'due_date' ? 'DATE' : 'TEXT',
      primaryKey: false,
      nullable: true,
    })),
  ],
};
const rows = [
  { id: 1, name: 'Customer onboarding', owner: 'Maya Chen', status: 'In progress', due_date: '2026-10-02' },
  { id: 2, name: 'Knowledge base refresh', owner: 'Owen Brooks', status: 'Ready for review', due_date: '2026-10-09' },
  { id: 3, name: 'Quarterly planning', owner: 'Priya Shah', status: 'Planned', due_date: null },
];
const data = { rows, columns: ['name', 'owner', 'status', 'due_date'] };
const meta = {
  title: 'Layouts/Content',
  beforeEach: async () => {
    await applicationFixture({
      tables: [table],
      app: {
        id: 'studio',
        name: 'Fieldwork',
        ui: {},
        nav: [],
        views: { projects: { table: 'project', label: 'Projects' } },
        resources: { project: { table: 'project', label: 'Project', plural: 'Projects', labels: { due_date: 'Due date' } } },
      },
    });
  },
} satisfies Meta;
export default meta;
const Table = () => <Grid table={table} data={data} interactive={false} />;
const Cards = () => (
  <CardsList
    table={table}
    rows={rows}
    spec={{ kind: 'cards', primary: 'name', badge: 'status', facts: ['owner', 'due_date'] }}
    label="Projects"
  />
);
export const TableOnly: StoryObj = { render: Table };
export const CardsOnly: StoryObj = { render: Cards };
export const MobileRecordCards: StoryObj = {
  render: () => (
    <div className="responsive-results show-records">
      <div className="result-table">
        <Table />
      </div>
      <RecordSummaries table={table} data={data} columns={data.columns} />
    </div>
  ),
};
export const CardsAndTable: StoryObj = {
  render: () => (
    <PageLayout>
      <SectionBox section={{ kind: 'list', title: 'Current projects' }} foldable={false} body={<Cards />} />
      <SectionBox section={{ kind: 'list', title: 'All project details' }} foldable={false} body={<Table />} />
    </PageLayout>
  ),
};
export const MainAndContext: StoryObj = {
  render: () => (
    <PageLayout
      aside={
        <SectionBox
          section={{ kind: 'fields', title: 'Project owner' }}
          foldable={false}
          body={
            <dl className="page-properties">
              <div className="page-field">
                <dt>Name</dt>
                <dd>Maya Chen</dd>
              </div>
              <div className="page-field">
                <dt>Team</dt>
                <dd>Customer experience</dd>
              </div>
            </dl>
          }
        />
      }
    >
      <SectionBox section={{ kind: 'list', title: 'Work in progress' }} foldable={false} body={<Table />} />
    </PageLayout>
  ),
};
export const Empty: StoryObj = {
  render: () => <ListEmpty spec={{ title: 'No projects yet', message: 'Projects assigned to your team will appear here.' }} />,
};
export const LoadingTable: StoryObj = { render: () => <GridSkeleton columns={4} rows={5} /> };
export const LoadingRecord: StoryObj = {
  render: () => (
    <RecordSkeleton
      sections={[
        { title: 'Overview', count: 4 },
        { title: 'Details', count: 6 },
      ]}
    />
  ),
};
export const UnavailableSection: StoryObj = {
  render: () => (
    <PageLayout>
      <SectionBox
        section={{ kind: 'list', title: 'Related tasks' }}
        body={null}
        foldable={false}
        broken="These tasks could not be loaded. Try again in a moment."
      />
    </PageLayout>
  ),
};
