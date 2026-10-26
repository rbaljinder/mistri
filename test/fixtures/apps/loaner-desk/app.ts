import { action, defineApp, fields, header, listView, page, related } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

// Resource access is the command's ceiling. Roles grant commands, never plain writes.
const staff = { read: true, write: false, commands: ['checkoutEquipment', 'returnEquipment'] } as const;

export default defineApp({
  id: 'loaner-desk',
  name: 'Loaner Desk',
  track: 'receipts',
  sources: { lending: { connection: 'loaner-desk' } },
  resources: {
    borrower: { recordLabel: '{name}' },
    equipment: {
      segments: {
        available: 'status = available',
        checked_out: 'status = checked_out',
      },
      access: 'write',
      recordLabel: '{name}',
      actions: {
        checkout: action('Check out', { command: 'checkoutEquipment' }),
      },
    },
    equipment_loan: {
      segments: {
        open: 'status = open',
        returned: 'status = returned',
      },
      noun: 'loan',
      access: 'write',
      recordLabel: 'Loan {id}',
      actions: {
        return: action('Return', { command: 'returnEquipment' }),
      },
    },
  },
  auth: {
    providers: ['email'],
    defaultRole: 'viewer',
    roles: {
      staff: { ...staff, label: 'Staff' },
      admin: { ...staff, label: 'Admin' },
      viewer: { label: 'Viewer', read: true, write: false },
      // The return kiosk's callback runs as a service, never as a person's role: it proves a secret, not who it is.
      kiosk: { label: 'Return kiosk', service: true, read: true, write: false, commands: ['returnEquipment'] },
    },
  },
  views: {
    equipment: listView('Equipment', 'equipment', {
      show: ['name', 'status'],
      tabs: [{ label: 'All' }, 'available', 'checked_out'],
    }),
    loans: listView('Loans', 'equipment_loan', {
      show: ['equipment_id', 'borrower_id', 'status', 'checked_out_on', 'due_on', 'returned_on'],
      tabs: [{ label: 'All' }, 'open', 'returned'],
    }),
    borrowers: listView('Borrowers', 'borrower', { show: ['name', 'active'] }),
  },
  pages: {
    equipment: page('equipment', [
      header({ status: 'status' }),
      related('Loans', 'equipment_loan', 'equipment_id', {
        show: ['borrower_id', 'status', 'checked_out_on', 'due_on', 'returned_on'],
        sort: 'id desc',
      }),
    ]),
    equipment_loan: page('equipment_loan', [
      header({ status: 'status', facts: ['equipment_id', 'borrower_id'] }),
      fields(['checked_out_on', 'due_on', 'returned_on']),
    ]),
    borrower: page('borrower', [
      fields(['name', 'active']),
      related('Loans', 'equipment_loan', 'borrower_id', {
        show: ['equipment_id', 'status', 'due_on', 'returned_on'],
        sort: 'id desc',
      }),
    ]),
  },
  home: 'equipment',
  nav: ['equipment', 'loans', 'borrowers'],
  ui: { timezone: 'UTC' },
} satisfies App);
