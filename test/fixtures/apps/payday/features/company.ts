import { defineFeature, fields, page } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* The company's one profile row: the name payroll runs under, its tax id,
   its pay schedule and who answers for it. A settings record — opened from
   Company profile under Settings in the account menu, never from a list —
   that the administrator edits and the payroll manager reads. */
export const company = defineFeature({
  id: 'company',
  resources: {
    company: {
      noun: 'company profile',
      access: 'write',
      settings: 'Company profile',
      labels: {
        name: 'Company name',
        ein: 'Employer ID (EIN)',
        address: 'Registered address',
        overtime_after_hours: 'Overtime after',
      },
      display: { overtime_after_hours: { unit: 'h a week' } },
    },
  },
  auth: { roles: { admin: { write: ['company'] } } },
  pages: {
    company: page('company', [
      fields(['name', 'legal_name', 'ein', 'address'], { title: 'Company', columns: 2 }),
      fields(['pay_schedule', 'overtime_after_hours', 'payroll_contact'], { title: 'Payroll', columns: 2 }),
    ]),
  },
} satisfies Feature);
