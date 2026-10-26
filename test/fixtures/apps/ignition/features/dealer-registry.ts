import { action, count, defineFeature, fields, header, listView, metric, navGroup, page, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* The lender's dealer registry: one row per dealership, which is also the
   tenancy profile — `auth.tenancy.profile` — so `dealer.id` is the tenant id
   every owned row carries.

   That gives this one table a double life. In the platform realm it is an
   ordinary record with a page, a status and the lender's own intake address on
   it. In a dealership's realm it is invisible, except that the dealership's own
   rows point at it through their ownership column, which is the single
   exception the ownership rules allow and the reason the lender can break its
   portfolio down "by dealer" at all.

   Rotating the intake address is the lender's maintenance, not a secret being
   reissued: the address is a routing address that lets anyone submit to that
   dealership, which is exactly what the dealership published it for. */

export const dealerRegistry = defineFeature({
  id: 'dealer-registry',
  resources: {
    dealer: {
      segments: {
        active: 'status = active',
        suspended: 'status = suspended',
      },
      /* The dealership's profile, each drawn and edited as what it is: a color as its swatch and the system's
         picker, the desk's opening hour in the reader's words, this year's attainment as a ring, the DMS settings as
         a JSON tree, and the renewal month as a month. */
      display: {
        brand_color: { format: 'color' },
        opens_at: { format: 'time' },
        target_attainment: { format: 'percent', ring: true },
        dms_settings: { format: 'json' },
        renewal_month: { format: 'month' },
      },
      labels: { brand_color: 'Color', opens_at: 'Desk opens', target_attainment: 'Target attainment', dms_settings: 'DMS settings' },
      actions: { rotateIntakeAddress: action('Rotate intake address', { command: 'rotateIntakeAddress' }) },
      // The lender's view across every dealership: what each has with the lender now.
      rollups: {
        in_flight: count('loan_application', {
          whose: 'tenant_id',
          query: 'status != approved and status != declined and status != withdrawn',
        }),
      },
    },
  },
  auth: { roles: { platform_admin: { commands: ['rotateIntakeAddress'] } } },
  views: {
    dealers: listView('Dealerships', 'dealer', {
      icon: 'storefront',
      realm: 'platform',
      show: ['name', 'code', 'region', 'channel', 'in_flight', 'target_attainment', 'status', 'joined_on'],
      filters: ['name', 'region', 'channel', 'status'],
      tabs: ['active', 'suspended', { label: 'All' }],
    }),
  },
  pages: {
    dealer: page(
      'dealer',
      [
        header({ status: 'status', facts: ['code', 'region', 'channel', { column: 'joined_on', before: 'Joined' }] }),
        // The address is shown to the lender's own staff, who issue it. It is not
        // a credential, but it is not idle reading either, so it sits in its own
        // section next to the verb that changes it.
        fields(['intake_address'], { title: 'Public intake address', columns: 1 }),
        fields(['brand_color', 'opens_at', 'target_attainment', 'renewal_month', 'dms_settings'], { title: 'Profile', columns: 2 }),
        metric('Applications', 'loan_application', { whose: 'tenant_id', width: 'third' }),
        metric('Requested financing', 'loan_application', { whose: 'tenant_id', measure: 'sum requested_amount', width: 'third' }),
        metric('Leads', 'lead', { whose: 'tenant_id', width: 'third' }),
        related('Applications', 'loan_application', 'tenant_id', {
          show: ['reference', 'applicant_ref', 'requested_amount', 'status'],
        }),
        related('Review files', 'review_file', 'dealer_id', {
          show: ['application_id.reference', 'desk_id.name', 'reviewer_id.name', 'review_due_on'],
        }),
      ],
      { listTabs: true, realm: 'platform' },
    ),
  },
  nav: [navGroup('lender-dealers', 'Dealerships', ['dealers'], { realm: 'platform' })],
} satisfies Feature);
