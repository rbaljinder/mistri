import { action, defineFeature, fields, listView, now, page, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* Documents are signed by the teammate, not here: an administrator can only
   see what is outstanding and send a reminder, which records the day it went
   (the server's 'now', as a date). */

export const documents = defineFeature({
  id: 'documents',
  resources: {
    document: {
      segments: {
        awaiting_signature: 'status = pending',
        signed: 'status = signed',
      },
      access: 'write',
      labels: {
        title: 'Document',
        kind: 'Type',
        due_date: 'Due',
        reminded_on: 'Last reminder',
      },
      display: {
        status: { tone: { pending: 'warn', signed: 'good' } },
        kind: { tone: { offer: 'neutral', tax: 'info', identity: 'info', payroll: 'neutral', policy: 'neutral' } },
      },
      actions: { remind: action('Send reminder', { set: { reminded_on: now }, when: 'status = pending' }) },
    },
  },
  auth: { roles: { admin: { actions: { document: ['remind'] } }, payroll_manager: { actions: { document: ['remind'] } } } },
  views: {
    documents: listView('Documents', 'document', {
      icon: 'file-text',
      show: ['employee_id.name', 'title', 'status', 'requested_on', 'due_date', 'reminded_on'],
      filters: ['kind', 'employee_id'],
      tabs: [
        { segment: 'awaiting_signature', sort: 'due_date' },
        { segment: 'signed', sort: 'signed_on desc' },
        { label: 'All', sort: 'requested_on desc' },
      ],
      rowActions: true,
      empty: {
        title: 'No documents yet',
        description: 'Offer letters, tax forms and policy acknowledgments appear here once they are sent.',
      },
    }),
  },
  pages: {
    document: page('document', [
      fields(['status', 'kind', 'due_date'], { title: 'Signature', columns: 3 }),
      fields(['requested_on', 'signed_on', 'reminded_on'], { title: 'History', presentation: 'properties' }),
      related(
        'Other documents for this teammate',
        'document',
        { same: ['employee_id'] },
        { show: ['title', 'status', 'due_date', 'signed_on'], sort: 'status, due_date' },
      ),
      fields(['employee_id', 'employee_id.title', 'employee_id.email', 'employee_id.start_date'], { title: 'Teammate', region: 'aside' }),
    ]),
  },
  nav: ['documents'],
} satisfies Feature);
