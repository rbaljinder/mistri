import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppShell, openOn } from './appShell.js';
import { taskApp } from './taskFixture.js';

/* The rail in the list it narrows, in the App's frame: facets with live
   counts beside the rows at a desk, and on a phone a Filters button whose
   sheet holds the same facets. Drawn on its own it printed the question it
   would ask as text, and its phone capture was the desk rail squeezed. */
const railed = (query: string) => async () => {
  await taskApp({ view: { filterBar: 'rail', filters: ['title', 'status', 'priority', 'is_urgent', 'due_on', 'owner_id'] } });
  openOn({ kind: 'table', table: 'task', query, view: 'tasks' });
};
const meta = {
  title: 'Lists/Filter rail',
  parameters: { shell: true },
  render: () => <AppShell />,
  beforeEach: railed('task status in (open, in_progress)'),
} satisfies Meta;
export default meta;

/* Tick values and pick a date window; the chips over the rows say what is asked. */
export const Facets: StoryObj = {};
export const Narrowed: StoryObj = { beforeEach: railed('task status in (open, in_progress) and priority = high and due_on = next 7 days') };

/* The phone's sheet, open. A desk has no sheet, so there it is Facets again. */
export const PhoneSheet: StoryObj = {
  play: async ({ canvasElement }) => {
    const button = await within(canvasElement)
      .findByRole('button', { name: /^Filters/ })
      .catch(() => null);
    if (!button) return;
    await userEvent.click(button);
    await expect(await within(document.body).findByRole('dialog')).toBeInTheDocument();
  },
};
