import { fields, header, note, page } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* The borrower's own record, opened from the account menu (Your profile):
   how Keystone reaches them and where their mail goes, each field changed in
   place. Their name and email are the lender's record of who borrowed, so
   they read here but change only by calling servicing. */
export const profilePage = page('customer', [
  header({
    facts: ['email', { column: 'customer_since', before: 'Customer since' }],
  }),
  fields(['phone', 'preferred_contact', 'paperless'], { title: 'How we reach you', presentation: 'properties' }),
  fields(['street', 'city', 'state', 'zip'], { title: 'Mailing address', presentation: 'properties' }),
  note('To change your name or email, call Keystone at (800) 555-0142: they are the record of who borrowed.', { title: 'Name and email' }),
]) satisfies Page;
