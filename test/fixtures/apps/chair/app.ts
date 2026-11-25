/*
 * Chair: the suite's own App for who may read what on one page. A dental chair's schedule, opened by the dentist and
 * by the front desk; the desk's role reads visits and no note. Owned by the test suite; see README.md.
 */
import { commandForm, defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'chair',
  name: 'Chair',
  sources: { chair: { connection: 'chair' } },
  /* `write` is the ceiling the booking command writes under, not a grant: no role holds generic write. */
  resources: { visit: { noun: 'visit', access: 'write' }, note: { noun: 'note' } },
  auth: {
    providers: ['email'],
    defaultRole: 'desk',
    roles: {
      dentist: { read: ['visit', 'note'], write: false, commands: ['bookVisit'] },
      // The desk books and seats; what the dentist wrote of a visit is not the desk's to read.
      desk: { read: ['visit'], write: false, commands: ['bookVisit'] },
    },
  },
  views: {
    visits: listView('Visits', 'visit', { show: ['patient'] }),
    book: commandForm('Book a visit', 'bookVisit', { submitLabel: 'Book' }),
  },
  home: 'visits',
  nav: ['visits', 'book'],
  ui: { locale: 'en-US', export: false },
});
