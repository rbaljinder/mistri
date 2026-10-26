import { fields, header, history, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One person on the dealership's team: their role and standing, how to
   reach them, the leads they are working, and who changed their seat. The
   verbs are the team commands; Deactivate is destructive and comes last. */
export const memberPage = page('dealer_user', [
  header({
    status: 'status',
    facts: ['role', 'dealer_id', { column: 'joined_on', before: 'Joined' }],
    primary: 'changeTeamRole',
    destructive: ['deactivateTeamMember'],
  }),
  fields(['email', 'phone', 'invited_on'], { title: 'How to reach them', columns: 3 }),
  related('Leads assigned', 'lead', 'salesperson_id', {
    show: ['reference', 'source', 'created_at', 'status'],
    query: 'status != draft',
    sort: 'created_at desc',
    limit: 10,
    empty: { title: 'No leads assigned', description: 'Leads the desk assigns to them are listed here.' },
  }),
  history(),
]) satisfies Page;
