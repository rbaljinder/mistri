import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { FieldSuggestion } from '../../packages/mistri/src/shared/decisionSuggestions.js';
import DecisionChip from '../../packages/mistri/src/client/components/DecisionChip.js';
import { establishSessionIdentity } from '../../packages/kit/src/client/sessionIdentity.js';
import { applicationFixture } from '../mocks/core.js';

/* A decision's suggestion where a record page draws a field (PageFields.tsx): in the empty mark's place on an empty
   field, after the value on a filled one. The chip is drawn inside the same <dl><div class="page-field"> the page
   uses, so the line it stands on is the line it has in the App. */
const col = (name: string, primary = false) => ({ name, type: primary ? 'INTEGER' : 'TEXT', nullable: !primary, primaryKey: primary });
const ticket: TableMeta = {
  id: 'ticket',
  name: 'ticket',
  schema: '',
  isView: false,
  columns: [col('id', true), col('title'), col('assignee')],
};
const assign = { id: 'assign', version: 1, target: 'ticket', input: [{ name: 'assignee', label: 'Assignee', type: 'text' }] };
const app = (granted: boolean) => ({
  id: 'helpdesk',
  name: 'Helpdesk',
  ui: {},
  views: {},
  nav: [],
  grantedCommands: granted ? ['assign'] : [],
  resources: {
    ticket: { table: 'ticket', label: 'Ticket', plural: 'Tickets', actions: [{ id: 'assign', label: 'Assign', command: assign }] },
  },
});
const suggestion: FieldSuggestion = {
  id: 'dec-1',
  decision: 'route',
  field: 'assignee',
  command: 'assign',
  answer: 'Ada Nguyen',
  label: 'Ada Nguyen',
  probability: 0.9,
  filled: false,
  at: '2026-10-20T10:00:00.000Z',
};
const why = {
  decision: 'route',
  question: 'Who should take this ticket?',
  inputs: [
    { name: 'title', label: 'Title', value: 'Printer on the third floor jams every morning', readable: true },
    { name: 'notes', label: 'Private notes', readable: false },
  ],
  provider: 'jev',
  model: 'router',
  modelVersion: '2026-10',
  probability: 0.9,
  outcome: 'pending',
  at: '2026-10-20T10:00:00.000Z',
};

async function setup(granted: boolean) {
  establishSessionIdentity({ signedIn: true, accountId: 'account-1', appId: 'helpdesk' });
  await applicationFixture({
    app: app(granted),
    tables: [ticket],
    answer: {
      '/api/record-decisions/why': () => why,
      '/api/record-decisions/settle': () => ({ ok: true }),
    },
  });
}

function Field({ width, value, over }: { width?: number; value?: string; over?: Partial<FieldSuggestion> }) {
  const shown: FieldSuggestion = { ...suggestion, filled: value !== undefined, ...over };
  return (
    <dl className="page-field-grid" style={{ maxWidth: width }}>
      <div className="page-field">
        <dt>Title</dt>
        <dd>Printer on the third floor jams</dd>
      </div>
      {value === undefined ? (
        <div className="page-field">
          <dt>Assignee</dt>
          <dd className="page-field-adorned">
            <DecisionChip suggestion={shown} table="ticket" recordKey={{ id: 1 }} onSettled={() => {}} />
          </dd>
        </div>
      ) : (
        <div className="page-field">
          <dt>Assignee</dt>
          <dd>
            {value}
            <DecisionChip suggestion={shown} table="ticket" recordKey={{ id: 1 }} onSettled={() => {}} />
          </dd>
        </div>
      )}
    </dl>
  );
}

const meta = {
  title: 'Records/Decision suggestion',
  parameters: { layout: 'padded' },
  beforeEach: async () => {
    await setup(true);
  },
} satisfies Meta;
export default meta;

/** The field is empty: the suggestion stands where the empty mark would. */
export const EmptyField: StoryObj = { render: () => <Field /> };

/** The field holds a value: the suggestion trails it on the same line. */
export const FilledField: StoryObj = {
  render: () => <Field value="Marcus Lee" over={{ probability: 0.74, label: 'Ada Nguyen' }} />,
};

/** A long answer wraps inside the field rather than pushing past it. */
export const LongLabel: StoryObj = {
  render: () => (
    <Field width={360} over={{ label: 'Customer Success Escalations, Northern Europe and Nordics, Tier 2 weekdays', probability: 0.97 }} />
  ),
};

/** A reader not granted the command sees the suggestion and why, and nothing to press. */
export const NotGranted: StoryObj = {
  beforeEach: async () => {
    await setup(false);
  },
  render: () => <Field over={{ probability: 0.5 }} />,
};

/** The same field at a phone's width. */
export const Phone: StoryObj = {
  render: () => <Field width={320} over={{ label: 'Customer Success Escalations', probability: 0.88 }} />,
};
