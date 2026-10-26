import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { AppAction } from '../../packages/mistri/src/shared/app.js';
import type { PageDef } from '../../packages/kit/src/client/components/pageModel.js';
import { PageView } from '../../packages/kit/src/client/components/Page.js';
import { Crumbs } from '../../packages/kit/src/client/components/Crumbs.js';
import { AppShell, openOn } from './appShell.js';
import { refusal, rows, task, taskApp } from './taskFixture.js';

/* A record's head as a reader meets it, in the App's frame and under its
   trail: the name as the room's h1, and the toolbar of the record's own
   actions — the first filled, the next quiet, the rest and Delete under
   More. No captured record showed this toolbar before. */
const page: PageDef = {
  id: 'task-page',
  name: 'Task',
  base: 'task',
  source: 'config',
  sections: [
    { kind: 'fields', title: 'Work', paths: ['status', 'priority', 'due_on', 'estimate'], presentation: 'properties' },
    { kind: 'fields', title: 'Owner', paths: ['owner_id'], region: 'aside', presentation: 'properties' },
  ],
};
const verbs: AppAction[] = [
  { id: 'startWork', label: 'Start work', set: { status: 'in_progress' } },
  { id: 'markDone', label: 'Mark done', set: { status: 'done' } },
  { id: 'raisePriority', label: 'Raise priority', set: { priority: 'high' } },
  { id: 'flagAsUrgent', label: 'Flag as urgent', set: { is_urgent: 1 } },
] as AppAction[];
const row = rows[0];

function Record({ actions }: { actions?: AppAction[] }) {
  const [label, onLabel] = useState(row.title);
  const [tab, onTab] = useState<string | undefined>();
  return (
    <AppShell>
      <div className="crumbs-host">
        <Crumbs onHome={() => {}} />
      </div>
      <PageView
        entry={{ kind: 'page', pageId: page.id, table: task.id, key: { id: row.id }, label, tab }}
        page={page}
        base={task}
        plans={[]}
        others={[]}
        onLabel={onLabel}
        onTab={onTab}
        onLayout={() => {}}
        actions={actions ? { list: actions, matches: async () => true, canUpdate: true } : undefined}
      />
    </AppShell>
  );
}

const trail = () => {
  openOn({ kind: 'table', table: 'task', query: 'task status in (open, in_progress)', view: 'tasks' });
  openOn({ kind: 'page', pageId: page.id, table: task.id, key: { id: row.id }, label: row.title }, true);
};
const meta = {
  title: 'Rooms/Record',
  parameters: { shell: true },
  beforeEach: async () => {
    await taskApp();
    trail();
  },
} satisfies Meta;
export default meta;

export const HeadWithActions: StoryObj = { render: () => <Record actions={verbs} /> };
/* More, open: the verbs that did not fit in the toolbar. */
export const HeadMoreOpen: StoryObj = {
  render: () => <Record actions={verbs} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: /^More/ }));
    await expect(await within(document.body).findByRole('menu')).toBeInTheDocument();
  },
};
/* A reader who may not change it: the name, and no verbs. */
export const HeadReadOnly: StoryObj = {
  beforeEach: async () => {
    await taskApp({ writable: false });
    trail();
  },
  render: () => <Record />,
};
/* A link to a record that is gone (404): the head keeps the name the link
   carried and offers no verbs, and the page says once that the record is not
   there, rather than each section repeating the refusal. */
export const Missing: StoryObj = {
  beforeEach: async () => {
    await taskApp({ fail: refusal(404, 'No task has this id. It may have been deleted.') });
    trail();
  },
  render: () => <Record actions={verbs} />,
};
