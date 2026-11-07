/**
 * The bare App: what a coding agent's least effort declares. Drafted with
 * `mistri --scaffold-app` over test/fixtures/databases/bare, then cut back to
 * the floor — the tables, their writes, the job's states, a list per table,
 * a menu and the sign-in the draft read off the technicians. No pages, no
 * dashboard, no list columns, tabs or filters, no display rules and no theme:
 * every screen is mistri's default, and that default is what is judged.
 * Grow it only by what a lazy agent would also write. See ./README.md.
 */
import { defineApp, listView, machine } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

export default defineApp({
  id: 'bare',
  name: 'North Valley Service',
  connection: 'bare',
  auth: {
    providers: ['email'],
    me: { from: 'technician', column: 'email' },
    defaultRole: 'technician',
    roles: {
      technician: { label: 'Technician', read: true, write: ['customer', 'job', 'line_item', 'note', 'site', 'visit'] },
      admin: { label: 'Admin', read: true, write: true },
    },
  },
  resources: {
    customer: { access: 'write' },
    site: { access: 'write' },
    technician: { access: 'write' },
    job: {
      access: 'write',
      machine: machine('status', {
        new: { on: { schedule: 'scheduled', cancel: { to: 'cancelled', confirm: true } } },
        scheduled: { on: { start: 'in_progress', cancel: { to: 'cancelled', confirm: true } } },
        in_progress: { on: { complete: 'completed', hold: 'on_hold', cancel: { to: 'cancelled', confirm: true } } },
        on_hold: { on: { resume: 'in_progress', cancel: { to: 'cancelled', confirm: true } } },
        completed: { final: true },
        cancelled: { final: true },
      }),
    },
    visit: { access: 'write' },
    line_item: { access: 'write' },
    note: { access: 'write' },
  },
  views: {
    jobs: listView('Jobs', 'job'),
    visits: listView('Visits', 'visit'),
    customers: listView('Customers', 'customer'),
    sites: listView('Sites', 'site'),
    technicians: listView('Technicians', 'technician'),
    'line-items': listView('Line items', 'line_item'),
    notes: listView('Notes', 'note'),
  },
  nav: ['jobs', 'visits', 'customers', 'sites', 'technicians', 'line-items', 'notes'],
} satisfies App);
