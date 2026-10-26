/**
 * One small App — Fieldwork's tasks and the people they belong to — that the
 * room stories share, so a list, its rail and a record read the same rows.
 * `/api/run` answers the question the room asks, narrowed the way the server
 * would narrow it for the few conditions the stories use; that is enough for
 * a tab, a chip and a facet to change the rows under them.
 */
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import { applicationFixture } from '../mocks/core.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
export const rep: TableMeta = {
  id: 'rep',
  name: 'rep',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')] as TableMeta['columns'],
};
export const task: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('title', 'TEXT', { nullable: false }),
    col('status', 'TEXT', { allowed: ['open', 'in_progress', 'done'] }),
    col('priority', 'TEXT', { allowed: ['low', 'normal', 'high'] }),
    col('is_urgent', 'BOOLEAN'),
    col('due_on', 'DATE'),
    col('estimate', 'INTEGER'),
    col('owner_id', 'INTEGER', { references: { table: 'rep', column: 'id' } }),
  ] as TableMeta['columns'],
};

const people = ['Nia Andersen', 'Tariq Osei', 'Hugo Duval', 'Isla Fontaine'];
const titles = [
  'Confirm the onboarding plan',
  'Draft the renewal proposal',
  'Review the accessibility audit',
  'Book the kickoff workshop',
  'Update the handover notes',
  'Reconcile September invoices',
  'Prepare the quarterly review',
  'Call back about the delivery date',
  'Migrate the shared calendar',
  'Collect equipment requests',
  'Refresh the knowledge base',
  'Close out the pilot feedback',
];
const statuses = ['open', 'in_progress', 'done', 'open', 'in_progress', 'open'] as const;
export const rows = titles.map((title, i) => ({
  id: i + 1,
  title,
  status: statuses[i % statuses.length],
  priority: (['high', 'normal', 'low'] as const)[i % 3],
  is_urgent: i % 4 === 0 ? 1 : 0,
  due_on: `2026-09-${String(8 + i * 2).padStart(2, '0')}`,
  estimate: 2 + ((i * 3) % 9),
  owner_id: (i % people.length) + 1,
  'owner_id.name': people[i % people.length],
}));

/* The conditions the stories' tabs, chips and facets write, read back. */
function narrowed(q: string) {
  let out = rows;
  const within = /status in \(([^)]*)\)/.exec(q);
  if (within) {
    const set = within[1].split(',').map((s) => s.trim());
    out = out.filter((r) => set.includes(r.status));
  }
  const is = /status = (\w+)/.exec(q);
  if (is) out = out.filter((r) => r.status === is[1]);
  const priority = /priority = (\w+)/.exec(q);
  if (priority) out = out.filter((r) => r.priority === priority[1]);
  if (/is_urgent = true/.test(q)) out = out.filter((r) => r.is_urgent);
  const contains = /title contains "([^"]*)"/.exec(q) ?? /title contains (\S+)/.exec(q);
  if (contains) out = out.filter((r) => r.title.toLowerCase().includes(contains[1].toLowerCase()));
  return out;
}

const counts = (key: 'status' | 'priority' | 'is_urgent' | 'owner_id', of: typeof rows) => {
  const by = new Map<unknown, number>();
  for (const row of of) by.set(row[key], (by.get(row[key]) ?? 0) + 1);
  return [...by];
};

/* The owner by name, through the reference, as an App's `show` says it. */
export const taskColumns = ['title', 'status', 'priority', 'due_on', 'owner_id.name', 'estimate'];

/** A refusal as the client's `api` raises it: the server's words, with the status beside them. */
export const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function taskApp({
  view = {},
  empty = false,
  writable = true,
  fail,
}: {
  view?: Record<string, unknown>;
  empty?: boolean;
  writable?: boolean;
  /** Every read of the tasks answers with this instead: a 403, a 404, the server gone. */
  fail?: Error;
} = {}) {
  const tasks = {
    table: 'task',
    label: 'Tasks',
    icon: 'list-checks',
    favorite: true,
    rowActions: true,
    show: taskColumns,
    tabs: [
      { label: 'Open', query: 'status in (open, in_progress)' },
      { label: 'Done', query: 'status = done' },
      { label: 'All', query: '' },
    ],
    filters: ['title', 'status', 'priority', 'owner_id'],
    sorts: [
      { label: 'Due soonest', sort: 'due_on' },
      { label: 'Newest', sort: 'id desc' },
    ],
    ...view,
  };
  await applicationFixture({
    tables: [task, rep],
    writable,
    foreignKeys: [{ name: 'task_owner', from: { table: 'task', columns: ['owner_id'] }, to: { table: 'rep', columns: ['id'] } }],
    app: {
      id: 'fieldwork',
      name: 'Fieldwork',
      home: 'tasks',
      ui: { shell: { counts: false } },
      views: { tasks, people: { table: 'rep', label: 'People', icon: 'users' } },
      nav: [
        { view: 'tasks', label: 'Tasks' },
        { view: 'people', label: 'People' },
      ],
      resources: {
        task: {
          table: 'task',
          label: 'Task',
          plural: 'Tasks',
          /* A verb for many rows at once and one for a row alone: the grid's
             selection column and each row's ⋯ are drawn only when there is one. */
          actions: [
            { id: 'markDone', label: 'Mark done', set: { status: 'done' }, bulk: true },
            { id: 'startWork', label: 'Start work', set: { status: 'in_progress' } },
          ],
          labels: { owner_id: 'Owner', due_on: 'Due', is_urgent: 'Urgent', title: 'Task' },
          display: {
            status: { tone: { open: 'info', in_progress: 'warn', done: 'good' } },
            priority: { tone: { high: 'bad', normal: 'neutral', low: 'neutral' } },
          },
        },
        rep: { table: 'rep', label: 'Person', plural: 'People' },
      },
    },
    answer: {
      '/api/run': ({ q = '', limit = 25, offset = 0 }: { q?: string; limit?: number; offset?: number }) => {
        const text = String(q);
        const tableName = text.split(/\s+/)[0];
        if (tableName === 'rep') {
          const reps = people.map((name, i) => ({ id: i + 1, name }));
          return {
            table: 'rep',
            columns: ['name', 'id'],
            rows: reps,
            total: reps.length,
            limit,
            offset,
            errors: [],
            ms: 1,
            order: { order: [], implicit: true },
          };
        }
        if (fail) throw fail;
        const found = empty ? [] : narrowed(text);
        return {
          table: 'task',
          columns: ['id', ...taskColumns],
          rows: found.slice(offset, offset + limit),
          total: found.length,
          exactTotal: true,
          limit,
          offset,
          errors: [],
          ms: 3,
          order: { order: [], implicit: true },
        };
      },
      /* A record page's sections read their row, or rows pointing at it, as views. */
      '/api/view/run': ({ view: definition }: { view: { base: string; columns: Array<{ path: string }> } }) => {
        if (fail) throw fail;
        // The stories' records are the first task; a page asks for one row at a time.
        const found = definition.base === 'task' ? rows.slice(0, 1) : [];
        return {
          view: definition,
          columns: definition.columns.map((column) => column.path),
          rows: found,
          total: found.length,
          resolved: [],
          errors: [],
          joinCount: 0,
          ms: 1,
          more: false,
          limit: 20,
          offset: 0,
        };
      },
      '/api/breakdown': ({ text }: { text?: string }) => {
        const t = String(text);
        const of = empty ? [] : narrowed(t.replace(/\bby\b.*$/, ''));
        for (const key of ['status', 'priority', 'is_urgent'] as const) {
          if (t.includes(`by ${key}`))
            return { columns: [key, 'count'], rows: counts(key, of).map(([value, count]) => ({ [key]: value, count })) };
        }
        if (t.includes('by owner_id')) {
          return {
            columns: ['owner_id', 'owner_id.name', 'count'],
            rows: counts('owner_id', of).map(([id, count]) => ({ owner_id: id, 'owner_id.name': people[Number(id) - 1], count })),
          };
        }
        return { columns: ['value', 'count'], rows: [] };
      },
    },
  });
}
