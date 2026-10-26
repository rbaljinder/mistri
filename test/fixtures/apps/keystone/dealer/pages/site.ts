import { fields, header, history, note, page } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* The dealership's website settings, grouped by what a visitor meets: the
   words on the front page, the brand, how to reach the dealer, and where it
   lives. Every field is edited where it stands. The forward verb is
   Publish; a live site offers Unpublish, last and confirming. */
export const sitePage = page('dealer_site', [
  header({
    status: 'published',
    facts: ['custom_domain', { column: 'published_on', before: 'Live since' }],
  }),
  note('Your website is not published. Visitors to your address see a “coming soon” page until you publish it.', {
    title: 'Not live yet',
    when: 'published = false',
  }),
  fields(['headline', 'tagline', 'about'], { title: 'Front page', columns: 1 }),
  fields(['contact_phone', 'contact_email', 'hours'], { title: 'How visitors reach you', columns: 2 }),
  fields(['logo_text', 'brand_color', 'accent_color'], { title: 'Brand', region: 'aside' }),
  fields(['dealer_id', 'custom_domain', 'show_prices'], { title: 'Address and pricing', region: 'aside' }),
  history(undefined, { limit: 6 }),
]) satisfies Page;
