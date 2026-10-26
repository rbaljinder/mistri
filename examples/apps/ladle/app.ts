import { action, defineApp, listView, machine, sum } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

/* Ladle: a cooking school's staff App. Its declared rooms are the classes and the bookings; the door's check-in is a
   page drawn whole by the school's own code (pages/check-in.page.tsx). The school's public site is not this App: it is
   a React app of the school's own (host/), which embeds this App for staff under /staff and answers its own JSON
   beside it. README.md says which part is which. */

export default defineApp({
  id: 'ladle',
  name: 'Ladle',
  connection: 'ladle',
  /* Staff sign in to the App itself, inside the school's site (mistri's session cookie, under the mount). A host
     that already knows who is at the desk signs them in with an embed assertion instead (README.md). */
  auth: {
    providers: ['email'],
    defaultRole: 'desk',
    roles: {
      // The front desk: everything read, bookings kept, guests checked in at the door. Classes are the manager's.
      desk: { label: 'Front desk', read: true, write: ['booking'], commands: ['checkIn'] },
      manager: { label: 'Manager', extends: 'desk', write: ['class_session'] },
      // The account a first start makes (MISTRI_AUTH_ADMIN_EMAIL).
      admin: { label: 'Admin', extends: 'manager' },
    },
  },
  resources: {
    class_session: {
      noun: { one: 'class', many: 'classes' },
      access: 'write',
      labels: { booked: 'Seats booked' },
      // Seats taken, by party: a cancelled booking frees its seats; who has walked in is counted apart.
      rollups: {
        booked: sum('booking', 'party_size', { query: 'status != cancelled' }),
        arrived: sum('booking', 'party_size', { query: 'status = checked_in' }),
      },
      segments: {
        upcoming: { query: 'status = scheduled and starts_at >= today', label: 'Upcoming' },
        past: { query: 'starts_at < today', label: 'Taught' },
        cancelled: 'status = cancelled',
      },
      display: {
        status: { tone: { scheduled: 'good', cancelled: 'neutral' } },
      },
      actions: {
        cancel: action('Cancel class', { set: { status: 'cancelled' }, when: 'status = scheduled', confirm: true }),
      },
    },
    booking: {
      recordLabel: 'guest_name',
      access: 'write',
      labels: { class_session_id: 'Class', guest_name: 'Guest', party_size: 'Party', checked_in_at: 'Arrived at' },
      segments: {
        expected: { query: 'status = booked', label: 'Expected' },
        arrived: { query: 'status = checked_in', label: 'Arrived' },
      },
      display: { status: { tone: { booked: 'info', checked_in: 'good', cancelled: 'neutral' } } },
      // A booking is checked in at the door by its command (commands.ts), which stamps the time; or called off.
      machine: machine('status', {
        booked: { on: { checkIn: 'checked_in', cancel: { to: 'cancelled', label: 'Cancel booking', confirm: true } } },
        checked_in: { final: true },
        cancelled: { final: true },
      }),
    },
  },
  views: {
    classes: listView('Classes', 'class_session', {
      icon: 'fork-knife',
      show: ['title', 'starts_at', 'chef', 'cuisine', 'seats', 'booked', 'price', 'status'],
      tabs: [
        { segment: 'upcoming', sort: 'starts_at' },
        { segment: 'past', sort: 'starts_at desc' },
        { segment: 'cancelled', sort: 'starts_at desc' },
      ],
    }),
    bookings: listView('Bookings', 'booking', {
      icon: 'ticket',
      show: ['guest_name', 'class_session_id', 'party_size', 'status', 'email', 'booked_at'],
      filters: ['class_session_id', 'status'],
      tabs: [{ label: 'All', sort: 'booked_at desc' }, 'expected', 'arrived'],
    }),
  },
  // The check-in page places itself first (its `nav`); the declared rooms follow.
  nav: ['classes', 'bookings'],
  home: 'classes',
  ui: {
    logo: 'fork-knife',
    locale: 'en-US',
    timezone: 'America/Chicago',
    currency: 'USD',
  },
} satisfies App);
