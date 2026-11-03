/*
 * Repairs: the browser gate's own App for a command form's files and
 * signature — a public form that asks a repair's title, a few photos and a
 * signature, each file held as it is picked and stored by the command as a row
 * of its file resource. Sized to e2e/held-files.spec.ts; the names are invented.
 */
import { commandForm, defineApp, listView } from '@mistriwork/mistri/app';

const FILE = { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 262_144 } as const;

export default defineApp({
  id: 'repairs',
  name: 'Brackwater Garage',
  sources: { garage: { connection: 'garage' } },
  /* The ceiling the command writes under, not a grant: no role holds generic write. */
  resources: {
    repair: { access: 'write' },
    repair_photo: { access: 'write', file: FILE },
    repair_signature: { access: 'write', file: FILE },
  },
  auth: {
    providers: ['email'],
    signUp: 'open',
    defaultRole: 'customer',
    roles: { customer: { read: [], write: false } },
  },
  views: {
    repairs: listView('Repairs', 'repair'),
    report: commandForm('Report a repair', 'reportRepair', {
      public: true,
      submitLabel: 'Send',
      done: { title: 'Your repair is in', description: 'Keep this reference.' },
    }),
  },
  home: 'repairs',
  nav: ['repairs'],
});
