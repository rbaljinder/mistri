import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppShell, openOn } from './appShell.js';
import { refusal, taskApp } from './taskFixture.js';

/* The App's list room as a reader meets it: the real content pane in the
   App's frame, opened on a list the way a link opens it. Its title, count,
   star, New and Export sit in the crumb bar; tabs, search, "+ filters", the
   applied chips and Sort in the bar under it; the grid, its pager, row
   selection and each row's ⋯ below. */
const open = (query: string) => () => {
  openOn({ kind: 'table', table: 'task', query, view: 'tasks' });
};
/* A phone draws rows as records; these stories are about the grid, so they
   take the phone's own Table switch first, as a reader would. */
async function asTable(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const table = await canvas.findByRole('button', { name: /^Table$/ }).catch(() => null);
  if (table && table.getAttribute('aria-pressed') !== 'true') await userEvent.click(table);
  return canvas;
}

const meta = {
  title: 'Rooms/List',
  parameters: { shell: true },
  render: () => <AppShell />,
  beforeEach: async () => {
    await taskApp();
    open('task status in (open, in_progress)')();
  },
} satisfies Meta;
export default meta;

export const Room: StoryObj = {};

/* Refined past the tab: the chips say so, each with its ×, and Clear all. */
export const Narrowed: StoryObj = {
  beforeEach: async () => {
    await taskApp();
    open('task status in (open, in_progress) and priority = high')();
  },
};

/* A compact grid with a row picked: the bulk bar's count and verbs. */
export const CompactWithSelection: StoryObj = {
  beforeEach: async () => {
    await taskApp({ view: { density: 'compact' } });
    open('task status in (open, in_progress)')();
  },
  play: async ({ canvasElement }) => {
    const canvas = await asTable(canvasElement);
    const boxes = await canvas.findAllByRole('checkbox', { name: /^Select / });
    await userEvent.click(boxes[1]);
    await userEvent.click(boxes[2]);
    await expect(await canvas.findByRole('toolbar', { name: 'Selected records' })).toBeInTheDocument();
  },
};

/* `editable: true`: a cell opened in place, the record form's editor for
   its column where the value was, the row around it as it was. */
export const EditableCell: StoryObj = {
  beforeEach: async () => {
    await taskApp({ view: { editable: true } });
    open('task status in (open, in_progress)')();
  },
  play: async ({ canvasElement }) => {
    const canvas = await asTable(canvasElement);
    const [first] = await canvas.findAllByRole('button', { name: 'Edit Task' });
    await userEvent.click(first);
    await expect(await canvas.findByRole('textbox', { name: 'Task' })).toHaveFocus();
  },
};

/* The selection's "Set field…": one of the list's editable columns, one value, for every selected record. */
export const SetField: StoryObj = {
  beforeEach: async () => {
    await taskApp({ view: { editable: ['title', 'priority', 'owner_id', 'due_on'] } });
    open('task status in (open, in_progress)')();
  },
  play: async ({ canvasElement }) => {
    const canvas = await asTable(canvasElement);
    const boxes = await canvas.findAllByRole('checkbox', { name: /^Select / });
    await userEvent.click(boxes[1]);
    await userEvent.click(boxes[2]);
    await userEvent.click(await canvas.findByRole('button', { name: 'Set field…' }));
    await expect(await within(document.body).findByRole('dialog', { name: 'Set a field' })).toBeInTheDocument();
  },
};

/* A row's ⋯, open: the record's own actions without leaving the list. */
export const RowMenu: StoryObj = {
  play: async ({ canvasElement }) => {
    const canvas = await asTable(canvasElement);
    const [first] = await canvas.findAllByRole('button', { name: /^Actions for / });
    await userEvent.click(first);
    await expect(await within(document.body).findByRole('menu')).toBeInTheDocument();
  },
};

/* A refinement nothing matches: "No matches", and the way back is one press. */
export const NoMatches: StoryObj = {
  beforeEach: async () => {
    await taskApp();
    open('task status in (open, in_progress) and title contains "zeppelin"')();
  },
};

/* The list in its first minute: nothing in it yet, said in the App's words. */
export const Empty: StoryObj = {
  beforeEach: async () => {
    await taskApp({
      empty: true,
      view: { tabs: undefined, empty: { title: 'No tasks yet', message: 'Tasks your team takes on will be listed here.' } },
    });
    open('task')();
  },
};

/* The rail of facets (`filterBar: 'rail'`) is Lists/Filter rail. */

/* The room when its rows cannot be read, in the words the client gives each
   failure: a reader the server refuses (403), and a server that has stopped
   answering (the client's own sentence for a fetch that never landed). */
export const Forbidden: StoryObj = {
  beforeEach: async () => {
    await taskApp({ fail: refusal(403, 'You do not have access to Tasks.') });
    open('task status in (open, in_progress)')();
  },
};
export const Offline: StoryObj = {
  beforeEach: async () => {
    await taskApp({
      fail: new Error('tablewalk is not answering. The server it was started with may have stopped — restart it and reload this page.'),
    });
    open('task status in (open, in_progress)')();
  },
};
