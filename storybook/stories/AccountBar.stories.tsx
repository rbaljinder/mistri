import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AccountControl } from '../../packages/mistri/src/client/components/AccountControl.js';
import type { InboxNotice } from '../../packages/mistri/src/client/components/InboxList.js';
import { applicationFixture } from '../mocks/core.js';
import { task, rep } from './taskFixture.js';

/* The end of an App's bar for a signed-in person: the bell with its unread
   count, and the account menu that holds their profile, an administrator's
   Manage accounts, the reader's settings and Sign out. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const notices: InboxNotice[] = [
  {
    id: 3,
    at: minutesAgo(4),
    title: 'Assigned to you: Replace the loading dock sensor',
    resource: 'task',
    key: { id: 12 },
    by: 'Priya Natarajan',
    read: false,
  },
  {
    id: 2,
    at: minutesAgo(52),
    title: 'Moved to In review: Quarterly stock count',
    resource: 'task',
    key: { id: 9 },
    by: 'Marcus Webb',
    action: 'Send for review',
    read: false,
  },
  {
    id: 1,
    at: minutesAgo(60 * 26),
    title: 'New task: Order more pallet wrap',
    resource: 'task',
    key: { id: 7 },
    by: 'Ana Souza',
    read: true,
  },
];

const meta = {
  title: 'Navigation/Account and notifications',
  parameters: { shell: true },
  beforeEach: async () => {
    await applicationFixture({
      tables: [task, rep],
      app: {
        id: 'fieldwork',
        name: 'Fieldwork',
        home: 'tasks',
        ui: { shell: { counts: false } },
        views: { tasks: { table: 'task', label: 'Tasks' } },
        nav: [{ view: 'tasks', label: 'Tasks' }],
        resources: { task: {}, rep: {} },
      },
      answer: { '/api/inbox': () => ({ notices, unread: notices.filter((notice) => !notice.read).length }) },
    });
  },
} satisfies Meta;
export default meta;

/* In the bar's own element, as the App draws it, so a look dresses it as it does there. */
const Bar = () => (
  <div style={{ minHeight: 420 }}>
    <header className="topbar">
      <button type="button" className="brand" title="Home">
        <span className="brand-mark" />
        <span className="brand-name">Fieldwork</span>
      </button>
      <div className="topbar-actions" style={{ marginLeft: 'auto' }}>
        <AccountControl who="Ada Lovelace" accountProfile accountAdministration inbox />
      </div>
    </header>
  </div>
);

export const Bell: StoryObj = {
  render: () => <Bar />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: /^Notifications, 2 unread$/ }));
    await expect(await within(document.body).findByText(/Replace the loading dock sensor/)).toBeInTheDocument();
  },
};

export const AccountMenu: StoryObj = {
  render: () => <Bar />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: /^Account: Ada Lovelace$/ }));
    await expect(await within(document.body).findByText('Manage accounts')).toBeInTheDocument();
  },
};
