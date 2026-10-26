import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { SlotProps } from '../../packages/kit/src/client/components/pageContext.js';
import type { PageSection, SectionPlan, ViewDef } from '../../packages/kit/src/client/components/pageModel.js';
import { MetricSection, BreakdownSection } from '../../packages/kit/src/client/components/PageMetrics.js';
import { TimelineSection } from '../../packages/kit/src/client/components/PageTimeline.js';
import { RecordHistory } from '../../packages/kit/src/client/components/PageHistory.js';
import { SectionBox } from '../../packages/kit/src/client/components/PageSectionBox.js';
import { api } from '../../packages/kit/src/client/core.js';
import { fixture } from '../mocks/core.js';

const table: TableMeta = {
  id: 'project',
  name: 'project',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['active', 'on_hold', 'done'] },
    { name: 'due_on', type: 'DATE', nullable: true, primaryKey: false },
    { name: 'budget', type: 'NUMERIC', nullable: true, primaryKey: false },
    { name: 'owner_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'person', column: 'id' } },
  ],
};
const person: TableMeta = {
  id: 'person',
  name: 'person',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
/* A record's writes as the server answers them for a reader: an action by
   name, a reassignment said by the people's names, a field the App redacts
   and one this reader may not read, and the record's creation. */
const changes = () => [
  {
    at: ago(1),
    kind: 'update',
    via: 'app',
    by: 'maya.chen@example.com',
    action: 'Put on hold',
    fields: [{ column: 'status', before: 'active', after: 'on_hold' }],
  },
  {
    at: ago(5),
    kind: 'update',
    via: 'app',
    by: 'owen.brooks@example.com',
    fields: [
      { column: 'owner_id', before: 1, after: 2 },
      { column: 'due_on', before: '2026-10-01', after: '2026-10-15' },
      { column: 'budget', redacted: true },
    ],
  },
  {
    at: ago(30),
    kind: 'update',
    via: 'agent',
    fields: [
      { column: 'name', before: 'Workspace refresh', after: 'Customer workspace refresh' },
      { column: 'margin', hidden: true, label: 'Margin' },
    ],
  },
  {
    at: ago(52),
    kind: 'insert',
    via: 'app',
    by: 'maya.chen@example.com',
    fields: [
      { column: 'name', after: 'Workspace refresh' },
      { column: 'status', after: 'active' },
      { column: 'owner_id', after: 1 },
    ],
  },
];
/* Written against the page's own clock, not a date: the matrix pins the
   clock to the seeded Apps' day, which put fixed dates weeks in the future
   ("in 3 weeks"). Two hours and a day ago read the same on any clock. */
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const activity = () => [
  { at: ago(2), body: 'Confirmed the implementation plan with the customer experience team.', by: 'Maya Chen', detail: 'Planning' },
  {
    at: ago(26),
    body: 'Shared the handover notes and accessibility requirements for the new workspace.',
    by: 'Owen Brooks',
    detail: 'Handover',
  },
];
/* A ticket's conversation, oldest first once drawn: messages, an internal note, and the system's lines between. */
const conversation = () => [
  { at: ago(1), body: 'Rebooted the print server; it is back online.', by: 'Owen Brooks', kind: 'reply' },
  { at: ago(1.5), body: 'State: In progress.', by: null, kind: 'system' },
  { at: ago(1.6), body: 'Assigned to Owen Brooks.', by: null, kind: 'system' },
  { at: ago(1.7), body: 'Priority raised to high.', by: null, kind: 'system' },
  { at: ago(2), body: 'Same model failed at the other clinic last week; driver push suspected.', by: 'Maya Chen', kind: 'note' },
  { at: ago(26), body: 'The front-desk printer shows offline every morning.', by: 'Jamie Holt', kind: 'reply' },
];
const view = (id: string, base: string, paths: string[]): ViewDef => ({ id, name: id, base, columns: paths.map((path) => ({ path })) });
function slot(section: PageSection, plan: SectionPlan): SlotProps {
  return {
    section,
    plan,
    page: { id: 'project', name: 'Project', base: table.id, source: 'config', sections: [section] },
    base: table,
    recordKey: { id: 1 },
    entry: { kind: 'page', pageId: 'project', table: table.id, key: { id: 1 } },
    index: 0,
    foldable: false,
    onEdit: () => {},
  };
}
const meta = {
  title: 'Records/Sections',
  beforeEach: () => {
    fixture({
      tables: [table, person],
      writable: false,
      answer: {
        '/api/record-history': ({ key }: { key: { id: number } }) => ({ entries: key.id === 2 ? [] : changes() }),
        '/api/query': () => ({
          rows: [
            { id: 1, name: 'Maya Chen' },
            { id: 2, name: 'Owen Brooks' },
          ],
        }),
        '/api/view/run': ({ view: definition }: { view: ViewDef }) => ({
          view: definition,
          columns: definition.columns.map((column) => column.path),
          rows: definition.base === 'activity' ? activity() : definition.base === 'message' ? conversation() : [{ value: 124 }],
          total: 124,
          resolved: [],
          errors: [],
          joinCount: 0,
          ms: 1,
          more: false,
          limit: 20,
          offset: 0,
        }),
        '/api/breakdown': ({ def }: { def: unknown }) => ({
          breakdown: def,
          columns: ['status', 'count'],
          resolved: [],
          ms: 1,
          offset: 0,
          rows: [
            { status: 'In progress', count: 18 },
            { status: 'Ready for review', count: 9 },
            { status: 'Waiting for customer confirmation', count: 4 },
          ],
          total: 3,
        }),
      },
    });
  },
} satisfies Meta;
export default meta;
export const Metric: StoryObj = {
  render: () => (
    <MetricSection
      {...slot(
        { kind: 'metric', from: 'task', title: 'Completed tasks' },
        { index: 0, view: view('task-count', 'task', ['id']), counts: true, query: 'task completed = true' },
      )}
    />
  ),
};
export const MissingReference: StoryObj = {
  render: () => (
    <MetricSection {...slot({ kind: 'metric', from: 'task', title: 'Completed tasks', of: 'project' }, { index: 0, empty: true })} />
  ),
};
export const GroupedCounts: StoryObj = {
  render: () => (
    <BreakdownSection
      {...slot(
        { kind: 'breakdown', from: 'task', title: 'Work by status', by: 'status', path: 'project_id' },
        {
          index: 0,
          breakdown: {
            base: 'task',
            by: [{ path: 'status' }],
            measures: [{ fn: 'count' }],
            filter: { groups: [[{ path: 'project_id', op: '=', value: 1 }]] },
          },
        },
      )}
    />
  ),
};
export const Activity: StoryObj = {
  render: () => (
    <TimelineSection
      {...slot(
        { kind: 'timeline', title: 'Recent activity' },
        {
          index: 0,
          streams: [
            {
              from: 'activity',
              at: 'at',
              show: 'body',
              by: 'by',
              detail: 'detail',
              view: view('activity', 'activity', ['at', 'body', 'by', 'detail']),
            },
          ],
        },
      )}
    />
  ),
};
export const Conversation: StoryObj = {
  render: () => (
    <TimelineSection
      {...slot(
        { kind: 'timeline', title: 'Conversation', order: 'asc', tint: { kind: { note: 'warn' } }, compact: { kind: ['system'] } },
        {
          index: 0,
          streams: [
            {
              from: 'message',
              at: 'at',
              show: 'body',
              by: 'by',
              detail: 'kind',
              view: view('message', 'message', ['at', 'body', 'by', 'kind']),
            },
          ],
        },
      )}
    />
  ),
};
export const EmptyActivity: StoryObj = {
  render: () => <TimelineSection {...slot({ kind: 'timeline', title: 'Recent activity' }, { index: 0, streams: [] })} />,
};
/* Framed as PageSections.tsx frames it. */
const history = (section: PageSection, id: number) => (
  <RecordHistory
    section={section}
    base={table}
    recordKey={{ id }}
    api={api as never}
    loading={null}
    frame={(body, broken) => <SectionBox section={section} body={body} foldable={false} broken={broken} />}
  />
);
export const History: StoryObj = { render: () => history({ kind: 'history' }, 1) };
export const EmptyHistory: StoryObj = { render: () => history({ kind: 'history', title: 'Changes' }, 2) };
