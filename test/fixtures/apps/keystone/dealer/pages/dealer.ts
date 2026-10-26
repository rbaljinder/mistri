import { card, fields, header, history, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* The dealership as its owner reads it: where it stands with Keystone, the
   lot and the team in figures, and its people, Keystone's visits and its
   website as tabs. Beside them, who at Keystone looks after it, the terms
   it trades on, and the address its apply link is published under. The
   forward verb is Add a team member. */
export const dealerPage = page(
  'dealer',
  [
    header({
      status: 'status',
      facts: ['tier', 'city', { column: 'joined_on', before: 'With Keystone since' }],
      primary: 'addTeamMember',
    }),
    fields(['on_hold_reason'], { title: 'Keystone has put this dealership on hold', columns: 1, when: 'status = on_hold' }),
    fields(['listed', 'team', 'oldest_listing']),
    related('Team', 'dealer_user', 'dealer_id', {
      show: ['name', 'role', 'joined_on', 'status'],
      query: 'status != deactivated',
      sort: 'name',
      empty: { title: 'No one on the team yet', description: 'Add a team member: they are invited to the leads desk.' },
    }),
    related('Keystone visits', 'dealer_visit', 'dealer_id', {
      show: ['happened_on', 'kind', 'summary', 'next_step'],
      sort: 'happened_on desc',
      limit: 12,
      empty: { title: 'No visits yet', description: 'Your relationship manager’s visits and calls are recorded here.' },
    }),
    related('Website', 'dealer_site', 'dealer_id', { show: ['headline', 'custom_domain', 'published'] }),
    card('Your Keystone contact', 'relationship_manager_id', ['title', 'email']),
    fields(['legal_name', 'kind', 'franchise_make', 'reserve_pct', 'monthly_goal', 'phone', 'email', 'street', 'zip', 'intake_address'], {
      title: 'Terms and contact',
      region: 'aside',
    }),
    history(undefined, { limit: 6 }),
  ],
  { listTabs: true },
) satisfies Page;
