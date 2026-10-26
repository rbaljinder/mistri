import { fields, header, page, related } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* The rate sheet and the people. A program says who qualifies and at what
   rate, and lists what was submitted under it; a staff member's page says
   what they hold. */
export const settingsPages = {
  program: page('program', [
    header({ status: 'tier', facts: ['code', { column: 'min_score', before: 'Score from' }, 'advertised'] }),
    fields(['base_apr', 'max_amount', 'max_term']),
    fields(['description'], { title: 'Who it is for', columns: 1 }),
    related('Applications under this program', 'loan_application', 'program_id', {
      show: ['reference', 'dealer_id', 'requested_amount', 'status'],
      sort: 'submitted_at desc',
      limit: 15,
    }),
    fields(['max_ltv_pct', 'max_vehicle_age', 'max_mileage', 'active'], { title: 'Collateral', region: 'aside' }),
  ]),
  'staff-member': page(
    'lender_user',
    [
      header({ facts: ['role', 'title', { column: 'hired_on', before: 'Since' }] }),
      fields(['open_files', 'decided', 'dealers']),
      related('Files held', 'underwriting_file', 'underwriter_id', {
        query: 'decided_by is empty',
        show: ['application_id', 'assigned_at', 'decision_due_at'],
        sort: 'decision_due_at',
        tab: 'Files',
        empty: { title: 'No open files', description: 'Applications assigned to this person and not yet decided.' },
      }),
      related('Dealers', 'dealer', 'relationship_manager_id', {
        show: ['name', 'tier', 'book', 'status'],
        sort: 'name',
        tab: 'Dealers',
        empty: { title: 'No dealers', description: 'Dealers this person manages the relationship with.' },
      }),
      fields(['email', 'active'], { title: 'Account', region: 'aside' }),
    ],
    { listTabs: true },
  ),
} satisfies Pages;
