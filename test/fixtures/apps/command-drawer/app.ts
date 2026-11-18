/*
 * Command drawer: the browser gate's own App for the command form's frame — a
 * short command is a centered dialog, a long one a side drawer. Owned by the
 * test suite; see README.md.
 */
import { action, defineApp, fields, listView, page, related } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'command-drawer',
  name: 'Command drawer',
  track: 'receipts',
  sources: { clinic: { connection: 'clinic' } },
  resources: {
    patient: {
      noun: 'patient',
      access: 'write',
      actions: {
        quickNote: action('Quick note', { command: 'quickNote' }),
        fullNote: action('Write a note', { command: 'fullNote' }),
      },
    },
    visit_note: { access: 'write' },
  },
  auth: {
    providers: ['email'],
    defaultRole: 'nurse',
    roles: { nurse: { read: true, write: false, commands: ['quickNote', 'fullNote'] } },
  },
  views: { patients: listView('Patients', 'patient', { show: ['name', 'last_note'] }) },
  pages: {
    patient: page('patient', [
      fields(['name', 'last_note'], { columns: 2 }),
      related('Notes', 'visit_note', 'patient_id', { show: ['name', 'body'] }),
    ]),
  },
  home: 'patients',
  nav: ['patients'],
  ui: { currency: 'USD', locale: 'en-US', export: false },
});
