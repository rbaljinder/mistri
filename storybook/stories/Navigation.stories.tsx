import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Sidebar } from '../../packages/kit/src/client/components/Sidebar.js';
import { TopNav } from '../../packages/mistri/src/client/components/TopNav.js';
import { PageLayout } from '../../packages/kit/src/client/components/PageLayout.js';
import { DashboardNote } from '../../packages/kit/src/client/components/DashboardNote.js';
import { applicationFixture } from '../mocks/core.js';
import { AppShell } from './appShell.js';

const app = {
  id: 'studio',
  name: 'Fieldwork',
  resources: {},
  home: 'overview',
  ui: { shell: { sidebar: { density: 'comfortable' as const }, counts: false } },
  views: {
    overview: { label: 'Overview', sections: [], icon: 'house' as const },
    people: { table: 'person', label: 'People', icon: 'users' as const },
    teams: { table: 'team', label: 'Teams' },
    projects: { table: 'project', label: 'Projects', icon: 'folder' as const },
    archive: { table: 'archive', label: 'Archived projects' },
  },
  nav: [
    { view: 'overview', label: 'Overview' },
    {
      group: 'work',
      label: 'Work',
      children: [
        { view: 'projects', label: 'Projects' },
        { view: 'archive', label: 'Archived projects' },
      ],
    },
    {
      group: 'directory',
      label: 'Directory',
      children: [
        { view: 'people', label: 'People' },
        { group: 'organization', label: 'Organization', children: [{ view: 'teams', label: 'Teams' }] },
      ],
    },
  ],
};
const tables = ['person', 'team', 'project', 'archive'].map((name) => ({
  id: name,
  name,
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
  ],
}));
const meta = {
  title: 'Navigation/App menus',
  beforeEach: async () => {
    await applicationFixture({ app, tables });
  },
} satisfies Meta;
export default meta;

/* A portal's bar: the Work group says `inline`, so its rooms stand in the bar as links, and Directory keeps its menu. */
const portal = {
  ...app,
  nav: app.nav.map((node) => ('group' in node && node.group === 'work' ? { ...node, inline: true as const } : node)),
};
function Top({ narrow = false, served = app }: { narrow?: boolean; served?: typeof app | typeof portal }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  /* In the bar's own element, as the App draws it: a look dresses `.topbar .tn-item`. */
  return (
    <div className="topbar" style={{ maxWidth: narrow ? 340 : undefined }}>
      <nav ref={setHost} className="topnav" aria-label="App navigation">
        {host && <TopNav app={served} host={host} />}
      </nav>
    </div>
  );
}
function Side() {
  const [host, setHost] = useState<HTMLUListElement | null>(null);
  return (
    <nav className="sidebar" aria-label="App navigation" style={{ position: 'relative', width: 240, maxWidth: '100%', minHeight: 420 }}>
      <ul ref={setHost} id="table-list">
        {host && <Sidebar host={host} tabNavigation />}
      </ul>
    </nav>
  );
}
const note = (
  <PageLayout>
    <DashboardNote
      title="Your team's workspace"
      text="Keep projects, people and responsibilities together. Choose a room from the menu to see its current selection."
    />
  </PageLayout>
);
export const TopBar: StoryObj = {
  beforeEach: () => {
    document.body.classList.add('app-topnav');
  },
  render: () => <Top />,
};
export const TopBarInlineGroup: StoryObj = {
  beforeEach: () => {
    document.body.classList.add('app-topnav');
  },
  render: () => <Top served={portal} />,
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('button', { name: 'Archived projects' })).toBeInTheDocument();
  },
};
/* Folded, and open: the story is the menu the word gives way to. */
export const FoldedMenu: StoryObj = {
  beforeEach: () => {
    document.body.classList.add('app-topnav');
  },
  render: () => <Top narrow />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: /^Menu$/ }));
    await expect(await within(document.body).findByRole('menu')).toBeInTheDocument();
  },
};
export const SidebarMenu: StoryObj = { render: () => <Side /> };

/* `navGroup(id, label, children, { folded: true })`: a section used rarely starts as its heading until someone opens it,
   and their own choice is kept over it. Here Admin is folded and holds a nested group, Integrations, folded in turn. The
   App's id is its own, so the choice one story's play keeps is not another's starting point. */
const foldedApp = (id: string) => ({
  ...app,
  id,
  views: {
    ...app.views,
    billing: { table: 'archive', label: 'Billing', icon: 'credit-card' as const },
    webhooks: { table: 'team', label: 'Webhooks' },
    keys: { table: 'team', label: 'API keys' },
  },
  nav: [
    { view: 'overview', label: 'Overview' },
    { group: 'work', label: 'Work', children: [{ view: 'projects', label: 'Projects' }] },
    {
      group: 'admin',
      label: 'Admin',
      folded: true as const,
      children: [
        { view: 'billing', label: 'Billing' },
        { view: 'people', label: 'People' },
        {
          group: 'integrations',
          label: 'Integrations',
          folded: true as const,
          children: [
            { view: 'webhooks', label: 'Webhooks' },
            { view: 'keys', label: 'API keys' },
          ],
        },
      ],
    },
  ],
});
/* A fold the person opened is remembered by the browser, so a story visited twice finds it open: open it only if it is shut. */
const open = async (canvasElement: HTMLElement, name: RegExp) => {
  const heading = await within(canvasElement).findByRole('button', { name });
  if (heading.getAttribute('aria-expanded') !== 'true') await userEvent.click(heading);
};
const foldedFixture = (id: string) => async () => {
  await applicationFixture({ app: foldedApp(id), tables });
};
export const FoldedSection: StoryObj = { beforeEach: foldedFixture('studio-folded'), render: () => <Side /> };
/* Opened by the person: Admin shows its rooms, and its nested group stays one line until it is opened too. */
export const FoldedSectionOpened: StoryObj = {
  beforeEach: foldedFixture('studio-folded-open'),
  render: () => <Side />,
  play: async ({ canvasElement }) => {
    await open(canvasElement, /^Admin$/);
    await expect(await within(canvasElement).findByText('Billing')).toBeInTheDocument();
  },
};
export const FoldedSectionNested: StoryObj = {
  beforeEach: foldedFixture('studio-folded-nested'),
  render: () => <Side />,
  play: async ({ canvasElement }) => {
    await open(canvasElement, /^Admin$/);
    await open(canvasElement, /^Integrations$/);
    await expect(await within(canvasElement).findByText('API keys')).toBeInTheDocument();
  },
};
/* In the App's frame: the menu beside the content at a desk, the bar's Menu on a phone. */
export const SidebarAndContent: StoryObj = { parameters: { shell: true }, render: () => <AppShell>{note}</AppShell> };
/* The side menu folded to its 56px rail of marks (`ui.shell.rail`); an entry
   without an icon stands as its initial. A phone has no rail: it has the drawer. */
export const IconRail: StoryObj = { parameters: { shell: true }, render: () => <AppShell rail>{note}</AppShell> };
/* The phone's drawer, open. At a desk there is no drawer, and this is the side menu. */
export const PhoneDrawer: StoryObj = {
  parameters: { shell: true },
  render: () => <AppShell>{note}</AppShell>,
  play: async ({ canvasElement }) => {
    const menu = await within(canvasElement)
      .findByRole('button', { name: /^Menu$/ })
      .catch(() => null);
    if (!menu) return;
    await userEvent.click(menu);
    await expect(await within(document.body).findByRole('dialog')).toBeInTheDocument();
  },
};
