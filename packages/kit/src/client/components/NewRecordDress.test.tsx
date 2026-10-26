/**
 * An App's New form, dressed: what `form.fields`, a group's description, the
 * form's own sentence and frame, its starting words and a narrowed picker
 * draw. The schema is the fixture — a task with a project and a milestone of
 * that project, prose, a flag, money and a vocabulary — because each input is
 * chosen from its column.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { ColumnMeta, TableMeta } from '../../../../engine/src/shared/schema.js';
import { writeValues } from '../resourceRequests.js';

const calls: Array<{ path: string; body: unknown }> = [];
const answers: Record<string, unknown> = {};

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo' },
  api: async (path: string, body: unknown) => {
    calls.push({ path, body });
    const answer = typeof answers[path] === 'function' ? (answers[path] as (b: unknown) => unknown)(body) : answers[path];
    if (answer instanceof Error) throw answer;
    return answer ?? {};
  },
  viewportBox: () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 }),
  viewportSize: () => ({ width: 1000, height: 800 }),
  labelPath: (table: TableMeta) => table.columns.find((column) => column.name !== 'id' && column.type === 'TEXT')?.name,
  recordLabel: () => undefined,
}));

const { NewRecordForm, NewRecordDrawer } = await import('./NewRecord.js');
const { derivedValue } = await import('./formDefaults.js');
const { api } = await import('../core.js');

const col = (name: string, type: string, extra: Partial<ColumnMeta> & { allowed?: string[] } = {}): ColumnMeta =>
  ({ name, type, nullable: true, primaryKey: false, ...extra }) as ColumnMeta;
const keyed = (id: string, ...columns: ColumnMeta[]): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false, identity: 'by-default' }), ...columns],
});

const project = keyed('project', col('name', 'TEXT'));
const milestone = keyed('milestone', col('name', 'TEXT'), col('project_id', 'INTEGER', { references: { table: 'project', column: 'id' } }));
const person = keyed('person', col('name', 'TEXT'), col('email', 'TEXT'));
const task = keyed(
  'task',
  col('title', 'TEXT', { nullable: false }),
  col('project_id', 'INTEGER', { nullable: false, references: { table: 'project', column: 'id' } }),
  col('milestone_id', 'INTEGER', { references: { table: 'milestone', column: 'id' } }),
  col('description', 'TEXT'),
  col('priority', 'TEXT', { nullable: false, allowed: ['low', 'normal', 'high'] }),
  col('stage', 'TEXT', { nullable: false, default: "'todo'", allowed: ['todo', 'in_progress', 'review', 'done', 'on_hold'] }),
  col('billable', 'BOOLEAN', { nullable: false }),
  col('budget', 'NUMERIC(12,2)'),
  col('due_on', 'DATE'),
  col('starts_at', 'TIMESTAMP'),
  col('owner_id', 'INTEGER', { references: { table: 'person', column: 'id' } }),
  col('filed_by', 'TEXT'),
);
const tables: Record<string, TableMeta> = { project, milestone, person };

function draw(tree: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, tree));
}

const props = () => ({
  table: task,
  app: true,
  label: (c: ColumnMeta) =>
    c.name
      .replace(/_id$/, '')
      .replace(/_/g, ' ')
      .replace(/^./, (first) => first.toUpperCase()),
  target: (id: string) => tables[id],
  display: (c: ColumnMeta) =>
    c.name === 'budget'
      ? { format: 'money', currency: 'EUR' }
      : c.name === 'priority'
        ? { values: { low: 'Low', normal: 'Normal', high: 'Urgent' } }
        : undefined,
  insert: (values: Record<string, unknown>) => api('/api/insert', { table: task.id, values: writeValues(values) }),
  onAdded: vi.fn(),
  onCancel: vi.fn(),
});

const sent = () => (calls.filter((call) => call.path === '/api/insert').at(-1)!.body as { values: Record<string, unknown> }).values;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  answers['/api/run'] = { rows: [{ id: 7, name: 'Launch' }] };
  answers['/api/insert'] = { key: { id: 42 }, row: { id: 42, title: 'Draft' } };
});

afterEach(() => {
  cleanup();
  document.getElementById('content')?.remove();
});

describe('each field wears its dress', () => {
  test('a caption, a help sentence under the control and a placeholder; a section heading with its line', () => {
    draw(
      <NewRecordForm
        {...props()}
        form={{
          show: ['title', 'project_id', 'priority'],
          description: 'A task is one piece of work someone can finish.',
          groups: [{ label: 'The work', description: 'What it is and where it belongs.', fields: ['title', 'project_id'] }],
          fields: { title: { label: 'Task', help: 'Start with a verb.', placeholder: 'Write the brief' } },
        }}
      />,
    );
    const title = screen.getByRole('textbox', { name: 'Task' });
    expect(title).toHaveAttribute('placeholder', 'Write the brief');
    expect(title).toHaveAccessibleDescription('Start with a verb.');
    const section = screen.getByRole('group', { name: 'The work' });
    expect(within(section).getByText('What it is and where it belongs.')).toBeInTheDocument();
    // The form's sentence stands where the old "leave a field empty" line stood.
    expect(screen.getByText('A task is one piece of work someone can finish.')).toBeInTheDocument();
    expect(screen.queryByText(/Leave a field empty/)).toBeNull();
  });

  test('the input is chosen from the column: prose, words, a flag, money, a date and time', () => {
    draw(<NewRecordForm {...props()} form={{ show: ['title', 'description', 'priority', 'stage', 'billable', 'budget', 'starts_at'] }} />);
    // Prose is a box of several lines; a name is one.
    expect(screen.getByRole('textbox', { name: 'Description' }).tagName).toBe('TEXTAREA');
    expect(screen.getByRole('textbox', { name: 'Title' }).tagName).toBe('INPUT');
    // Three words that must be answered are radios, in the display rule's words.
    const priority = screen.getByRole('radiogroup', { name: 'Priority' });
    expect(
      within(priority)
        .getAllByRole('radio')
        .map((radio) => radio.parentElement!.textContent),
    ).toEqual(['Low', 'Normal', 'Urgent']);
    // Five are a listbox, opened on the schema's default, said as a word.
    expect(screen.getByRole('button', { name: 'Stage' })).toHaveTextContent(/^Todo/);
    // A flag that must be answered is a switch, off.
    expect(screen.getByRole('switch', { name: 'Billable' })).not.toBeChecked();
    // Money carries its currency; a timestamp takes a date and a time.
    expect(screen.getByText('€')).toBeInTheDocument();
    // The figure starts after the sign as drawn: measured (the stand-in ruler says the sign ends 100px in), and a gap.
    expect(screen.getByRole('textbox', { name: 'Budget' }).style.paddingLeft).toBe('104px');
    expect(screen.getByRole('textbox', { name: 'Starts at' })).toHaveAttribute('placeholder', 'YYYY-MM-DD HH:MM');
  });

  test('multiline says otherwise where the name would decide', () => {
    draw(
      <NewRecordForm
        {...props()}
        form={{ show: ['title', 'description'], fields: { title: { multiline: true }, description: { multiline: false } } }}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Title' }).tagName).toBe('TEXTAREA');
    expect(screen.getByRole('textbox', { name: 'Description' }).tagName).toBe('INPUT');
  });

  test('a radio answers, the switch sends no when left off, and the words are sent as stored', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordForm {...p} form={{ show: ['title', 'project_id', 'priority', 'billable'] }} />);
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft');
    await user.type(screen.getByRole('combobox', { name: 'Project' }), 'La');
    await user.click(await screen.findByText('Launch'));
    await user.click(screen.getByRole('radio', { name: 'Urgent' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toEqual({ title: 'Draft', project_id: '7', priority: 'high', billable: false });
  });
});

describe("`as` draws a vocabulary or a flag the author's way", () => {
  test('cards over a vocabulary, buttons over a flag, and the stored word is what is sent', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(
      <NewRecordForm
        {...p}
        form={{
          show: ['title', 'project_id', 'priority', 'billable'],
          defaults: { project_id: 7 },
          fields: { priority: { as: 'cards' }, billable: { as: 'buttons' } },
        }}
      />,
    );
    // Three words that would be radios are cards (a label and a box); a flag is a Yes and a No, not a switch.
    const cards = await screen.findByRole('radiogroup', { name: 'Priority' });
    expect(cards).toHaveClass('choice-cards');
    expect(
      within(cards)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')!.textContent),
    ).toEqual(['Low', 'Normal', 'Urgent']);
    const pair = screen.getByRole('radiogroup', { name: 'Billable' });
    expect(pair).toHaveClass('choice-pair');
    expect(screen.queryByRole('switch')).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft');
    await user.click(within(cards).getByRole('radio', { name: 'Urgent' }));
    await user.click(within(pair).getByRole('radio', { name: 'Yes' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toMatchObject({ title: 'Draft', priority: 'high', billable: '1' });
  });

  test('select puts few words in a listbox and radios puts many in a row of them', () => {
    draw(
      <NewRecordForm
        {...props()}
        form={{
          show: ['title', 'priority', 'stage', 'billable'],
          fields: { priority: { as: 'select' }, stage: { as: 'radios' }, billable: { as: 'select' } },
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Priority' })).toBeInTheDocument();
    expect(within(screen.getByRole('radiogroup', { name: 'Stage' })).getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Billable' })).toBeInTheDocument();
  });
});

describe('defaults that say a word', () => {
  test('today and now are filled from the clock as the form opens', () => {
    draw(<NewRecordForm {...props()} form={{ show: ['title', 'due_on', 'starts_at'], defaults: { due_on: 'today', starts_at: 'now' } }} />);
    const due = screen.getByRole('textbox', { name: 'Due on' }) as HTMLInputElement;
    expect(due.value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(Math.abs(Date.parse(due.value) - Date.now())).toBeLessThan(2 * 86_400_000);
    expect((screen.getByRole('textbox', { name: 'Starts at' }) as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test('me is asked of the server: a person row for a reference, the email for text', async () => {
    const user = userEvent.setup();
    const p = props();
    answers['/api/run'] = (body: { q: string }) => (body.q.startsWith('person id = me') ? { rows: [{ id: 5 }] } : { rows: [] });
    answers['/api/whoami?app=demo'] = { signedIn: true, who: 'ada@example.test' };
    draw(
      <NewRecordForm
        {...p}
        form={{
          show: ['title', 'project_id'],
          defaults: { owner_id: 'me', filed_by: 'me', project_id: 3, priority: 'normal', billable: true },
        }}
      />,
    );
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Draft');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(calls.find((call) => call.path === '/api/run')?.body).toMatchObject({ q: 'person id = me show id' });
    expect(sent()).toMatchObject({ owner_id: 5, filed_by: 'ada@example.test', project_id: 3 });
  });

  test('me that names nobody starts the field empty, and the form asks for it', async () => {
    answers['/api/run'] = { rows: [] };
    draw(<NewRecordForm {...props()} form={{ show: ['title', 'owner_id'], defaults: { owner_id: 'me' } }} />);
    expect(await screen.findByRole('combobox', { name: 'Owner' })).toHaveValue('');
  });
});

describe('a picker narrowed by an earlier field', () => {
  const form = { show: ['title', 'project_id', 'milestone_id'], fields: { milestone_id: { where: { project_id: 'project_id' } } } };

  test("offers nothing until the project is chosen, then only that project's milestones", async () => {
    const user = userEvent.setup();
    draw(<NewRecordForm {...props()} form={form} />);
    const picker = screen.getByRole('combobox', { name: 'Milestone' });
    expect(picker).toBeDisabled();
    expect(picker).toHaveAccessibleDescription('Choose Project first.');
    await user.type(screen.getByRole('combobox', { name: 'Project' }), 'La');
    await user.click(await screen.findByText('Launch'));
    expect(screen.getByRole('combobox', { name: 'Milestone' })).toBeEnabled();
    calls.length = 0;
    await user.type(screen.getByRole('combobox', { name: 'Milestone' }), 'B');
    await vi.waitFor(() => expect(calls.some((call) => call.path === '/api/run')).toBe(true));
    await vi.waitFor(() => expect(calls.some((call) => (call.body as { q?: string } | undefined)?.q?.includes('contains "B"'))).toBe(true));
    expect((calls.find((call) => (call.body as { q?: string } | undefined)?.q?.includes('contains "B"'))!.body as { q: string }).q).toMatch(
      /^milestone project_id = 7 and name contains "B"/,
    );
  });

  test('a changed project empties the milestone chosen for the one before', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordForm {...p} form={{ ...form, defaults: { project_id: 7, milestone_id: 7, priority: 'normal', billable: false } }} />);
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft');
    await user.clear(screen.getByRole('combobox', { name: 'Project' }));
    // The project's list is open over the form, so the milestone is found by its label.
    expect(screen.getByLabelText('Milestone')).toBeDisabled();
    await user.type(screen.getByRole('combobox', { name: 'Project' }), 'La');
    await user.click(await screen.findByText('Launch'));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toEqual({ title: 'Draft', project_id: '7', priority: 'normal', billable: false });
  });
});

describe('the frame', () => {
  test('a long form is a page in the content pane, the list kept but not drawn', () => {
    const pane = Object.assign(document.createElement('main'), { id: 'content' });
    pane.append(Object.assign(document.createElement('div'), { className: 'applist-host', textContent: 'The list' }));
    document.body.append(pane);
    draw(
      <NewRecordDrawer
        {...props()}
        appName="Tracker"
        form={{
          description: 'One piece of work.',
          show: ['title', 'project_id', 'milestone_id', 'description', 'priority', 'stage', 'billable', 'budget', 'due_on'],
        }}
      />,
    );
    expect(pane).toHaveClass('has-new-page');
    const page = within(pane).getByRole('region', { name: 'New task' });
    expect(within(page).getByRole('heading', { level: 1, name: 'New task' })).toBeInTheDocument();
    expect(within(page).getByText('Tracker')).toHaveClass('eyebrow');
    expect(within(page).getByText('One piece of work.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Cancel then Add, under the last field.
    expect(
      within(page)
        .getAllByRole('button')
        .slice(-2)
        .map((button) => button.textContent),
    ).toEqual(['Cancel', 'Add']);
  });

  test('a short form is the drawer, and open says which', () => {
    document.body.append(Object.assign(document.createElement('main'), { id: 'content' }));
    const view = draw(<NewRecordDrawer {...props()} form={{ show: ['title', 'project_id'] }} />);
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument();
    view.unmount();
    draw(<NewRecordDrawer {...props()} form={{ show: ['title', 'project_id'], open: 'page' }} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.getElementById('content')).toHaveClass('has-new-page');
  });

  test("a stepped form keeps Cancel in the step's row, beside Continue", () => {
    document.body.append(Object.assign(document.createElement('main'), { id: 'content' }));
    draw(
      <NewRecordDrawer
        {...props()}
        form={{
          steps: [
            { id: 'what', label: 'What', fields: ['title'] },
            { id: 'where', label: 'Where', fields: ['project_id'] },
          ],
        }}
      />,
    );
    const row = document.querySelector('.multi-step-actions')!;
    expect([...row.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Cancel', 'Continue']);
    expect(document.querySelector('.form-actions:not(.multi-step-actions)')).toBeNull();
  });
});

describe('a value from the chosen record', () => {
  test('follows the reference as it is chosen, until the person writes their own, and is sent', async () => {
    const user = userEvent.setup();
    const p = props();
    answers['/api/query'] = (body: { table: string; columns: string[] }) =>
      body.table === 'project' && body.columns[0] === 'name' ? { rows: [{ name: 'Launch plan' }] } : { rows: [] };
    draw(
      <NewRecordForm
        {...p}
        form={{ show: ['title', 'project_id', 'priority', 'billable', 'description'], derived: { description: 'project_id.name' } }}
      />,
    );
    const description = screen.getByRole('textbox', { name: 'Description' }) as HTMLInputElement;
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft');
    await user.type(screen.getByRole('combobox', { name: 'Project' }), 'La');
    await user.click(await screen.findByText('Launch'));
    await vi.waitFor(() => expect(description.value).toBe('Launch plan'));
    await user.click(screen.getByRole('radio', { name: 'Urgent' }));
    expect(calls.find((call) => call.path === '/api/query')?.body).toMatchObject({
      table: 'project',
      columns: ['name'],
      filter: { groups: [[{ column: 'id', op: '=', value: '7' }]] },
    });
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toMatchObject({ project_id: '7', description: 'Launch plan' });
  });

  /* A computed column of the chosen record is worked out by the statement a view runs; a table read has only what is
     stored, and answered that the column does not exist (DM5). */
  test('a computed column of the chosen record is read through the view runner, which works it out', async () => {
    const listed = { ...project, computed: { list: { type: 'number' as const, expr: { k: 'number' as const, value: 0 }, reads: [] } } };
    answers['/api/view/run'] = { rows: [{ list: 17000 }] };
    const reference = task.columns.find((c) => c.name === 'project_id')!;
    expect(await derivedValue('project_id.list', reference, '7', () => listed)).toBe('17000');
    expect(calls.map((call) => call.path)).toEqual(['/api/view/run']);
    expect(calls[0].body).toMatchObject({
      view: { base: 'project', columns: [{ path: 'list' }], filter: { groups: [[{ path: 'id', op: '=', value: '7' }]] }, limit: 1 },
    });
  });

  /* `{ from }` is filled by the server where the create leaves it out (appValidation.ts fillDerived): a required
     column the form does not show is not the person's to fill, once its reference is chosen. */
  test('a required value from the chosen record the form does not show is left to the server', async () => {
    const user = userEvent.setup();
    const p = props();
    const required = { ...task, columns: task.columns.map((c) => (c.name === 'description' ? { ...c, nullable: false } : c)) };
    answers['/api/query'] = { rows: [] };
    draw(
      <NewRecordForm
        {...p}
        table={required}
        form={{ show: ['title', 'project_id', 'priority', 'billable'], derived: { description: 'project_id.name' } }}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft');
    await user.click(screen.getByRole('radio', { name: 'Urgent' }));
    // No project yet: nothing names the record the description comes from, so the form says what is missing.
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(p.onAdded).not.toHaveBeenCalled();
    expect(calls.some((call) => call.path === '/api/insert')).toBe(false);
    await user.type(screen.getByRole('combobox', { name: 'Project' }), 'La');
    await user.click(await screen.findByText('Launch'));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toMatchObject({ project_id: '7', title: 'Draft' });
    expect(sent()).not.toHaveProperty('description');
  });

  test('a value the person wrote stays theirs when the reference changes', async () => {
    const user = userEvent.setup();
    answers['/api/query'] = { rows: [{ name: 'Launch plan' }] };
    draw(
      <NewRecordForm {...props()} form={{ show: ['title', 'project_id', 'description'], derived: { description: 'project_id.name' } }} />,
    );
    const description = screen.getByRole('textbox', { name: 'Description' }) as HTMLInputElement;
    await user.type(description, 'Mine');
    await user.type(screen.getByRole('combobox', { name: 'Project' }), 'La');
    await user.click(await screen.findByText('Launch'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(description.value).toBe('Mine');
    // The picker reads the chosen label (id and name); nothing asks for the value the person already wrote.
    expect(calls.filter((call) => call.path === '/api/query').map((call) => (call.body as { columns: string[] }).columns)).toEqual([
      ['id', 'name'],
    ]);
  });
});

describe('a record form draws its rows', () => {
  /* The parsed shape the server sends: the flat list, and the rows beside it (formRules.ts). */
  const rowOf = (name: string) => screen.getByRole('textbox', { name }).closest('.form-columns');

  test('a row of show stands in one Columns in the drawer, the rest one to a row, and the form measures itself', () => {
    draw(
      <NewRecordDrawer
        {...props()}
        form={{ show: ['title', 'filed_by', 'description'], showRows: [['title', 'filed_by'], ['description']] }}
      />,
    );
    const row = rowOf('Title');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole('textbox', { name: 'Filed by' })).toBeInTheDocument();
    expect(rowOf('Description')).toBeNull();
    // The fieldset is the container its rows are measured on (structure.css), so a narrow drawer — a phone's — makes
    // them one column whatever the window is; happy-dom lays nothing out, and e2e/form-desk.spec.ts measures both.
    expect(row!.closest('.insert-form-app > .insert-fields')).not.toBeNull();
  });

  test("a group's row stays inside its section, and a hidden half leaves its neighbor one to a row", async () => {
    draw(
      <NewRecordForm
        {...props()}
        form={{
          show: ['title', 'billable', 'filed_by', 'budget'],
          showRows: [['title'], ['billable'], ['filed_by', 'budget']],
          groups: [
            { label: 'The work', fields: ['title'] },
            { label: 'Paperwork', fields: ['billable', 'filed_by', 'budget'], rows: [['billable'], ['filed_by', 'budget']] },
          ],
          when: { budget: 'billable = true' },
        }}
      />,
    );
    const section = screen.getByRole('group', { name: 'Paperwork' });
    expect(rowOf('Filed by')).toBeNull();
    await userEvent.click(within(section).getByRole('switch', { name: 'Billable' }));
    const row = rowOf('Filed by');
    expect(row).not.toBeNull();
    expect(section).toContainElement(row as HTMLElement);
    expect(within(row as HTMLElement).getByRole('textbox', { name: 'Budget' })).toBeInTheDocument();
  });
});
