import { card, fields, header, page } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One autopay enrollment: the account it drafts, on which day, since when.
   Turning it off is its one verb, quiet and confirmed: it ends something. */
export const autopayPage = page('autopay', [
  header({
    status: 'status',
    facts: [{ column: 'enrolled_on', before: 'Since' }, 'account_type'],
    destructive: ['cancelAutopay'],
  }),
  fields(['draft_day', 'account_last4', 'bank_name']),
  card('Loan', 'loan_id', ['payment_amount', 'next_due_on']),
]) satisfies Page;
