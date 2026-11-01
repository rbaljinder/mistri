/**
 * Tick — a tiny tasks app, authored entirely with the typed DSL.
 * See ./README.md for database setup and the quickstart.
 * Edit this manifest; the running app reloads it automatically.
 */
import { action, checklist, computed, defineApp, fields, listView, page } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';

// The same shapes `mistri --export types` writes, kept inline: each
// table's columns (and its computed one, `is_overdue`), its references (a
// task references nothing), and the one connection Tick binds.
type Tables = { task: 'id' | 'name' | 'completed' | 'due_on' | 'position' | 'is_overdue' };
type References = {};
type App = TypedAppConfig<Tables, References, 'tick'>;

export default defineApp({
  id: 'tick',
  name: 'Tick',
  connection: 'tick',
  resources: {
    // The one thing Tick writes, and what it says about it: how a due date
    // reads, the New form, and the two things a task can have done to it.
    task: {
      segments: {
        open: 'completed = false',
        due_today: { query: 'completed = false and due_on = today', label: 'Today' },
        overdue: 'is_overdue = true',
        upcoming: 'completed = false and due_on > today',
        done: 'completed = true',
      },
      access: 'write',
      // A finished list is cleared by hand, so a task can be deleted.
      delete: true,
      // Worked out in the statement, never stored: an open task whose day has passed.
      computed: { is_overdue: computed.boolean('due_on < today and not completed') },
      form: {
        // A new task is open and asks for its name and, if it has one, its day: whether it is completed
        // is not a question when adding, so it is defaulted and left out of what the form shows.
        show: ['name', 'due_on'],
        defaults: { completed: false },
      },
      actions: {
        complete: action('Complete', { set: { completed: true }, when: 'completed = false' }),
        reopen: action('Reopen', { set: { completed: false }, when: 'completed = true' }),
      },
    },
  },
  views: {
    tasks: listView('Tasks', 'task', {
      open: 'modal',
      show: ['name', 'completed', 'due_on'],
      presentation: checklist('name', 'completed', { lines: ['due_on'] }),
      // Your order: drag a task into place, press Alt+↑/↓, or use its grip.
      // Open and Today read in it; Upcoming reads by date and Done as added.
      order: 'position',
      quickAdd: true,
      filterBar: 'none',
      tabs: [
        'open',
        'due_today',
        { segment: 'overdue', sort: 'due_on' },
        { segment: 'upcoming', sort: 'due_on' },
        { segment: 'done', sort: 'id' },
      ],
    }),
  },
  pages: {
    // An article: one column at a reading measure and no side rail, whose only field would be `position`, the list's order.
    task: page('task', [fields(['name', 'completed', 'due_on'], { columns: 1 })], { layout: 'article' }),
  },
  // Where a visitor starts. With no `nav`, Tick draws no menu: one list is the whole App.
  home: 'tasks',
  ui: {
    logo: 'list-checks',
    shell: {
      placement: 'top',
      headerWidth: 'content',
      search: false,
      breadcrumbs: false,
      heading: false,
      width: 'narrow',
      gutter: 'comfortable',
    },
    editing: { save: 'blur' },
  },
} satisfies App);
