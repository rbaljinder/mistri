import { card, fields, header, history, page, related } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* From an approval to money at the dealer. Rejected is a way back to the
   dealer, not a step, so it is a tone. */

/* A funding as the funder works it: the dealer and the wire in the head;
   the money in the figures, with the road it travels; the application's
   conditions, which must all be cleared before it funds; and beside them the
   application and the dates. */
export const fundingPages = {
  funding: page('funding', [
    header({
      status: 'status',
      facts: ['dealer_id', 'application_id', { column: 'contract_received_on', before: 'Contract in' }],
    }),
    fields(['reject_reason'], { title: 'Rejected because', columns: 1, when: 'status = rejected' }),
    fields(['amount', 'dealer_reserve', 'application_id.approved_amount']),
    related(
      'Conditions to clear before funding',
      'stipulation',
      { same: ['application_id'] },
      {
        show: ['kind', 'received_at', 'status'],
        sort: 'requested_at',
        empty: { title: 'No conditions on this approval', description: 'Nothing stands between the audit and the wire.' },
      },
    ),
    card('Application', 'application_id', ['approved_term', 'approved_apr', 'approved_payment']),
    fields(['contract_received_on', 'audited_by', 'funded_on'], { title: 'Funding', region: 'aside' }),
    history(),
  ]),
} satisfies Pages;
