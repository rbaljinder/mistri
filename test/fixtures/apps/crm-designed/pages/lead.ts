import { breakdown, fields, metric, page, related, stream, timeline } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

export default page('lead', [
  // A lead is its contact details, eight of mixed kinds and lengths: read as
  // caption and value, not as a strip of figures.
  fields([], { presentation: 'properties', columns: 2 }),
  fields(['converted_contact_id.name', 'converted_contact_id.title', 'converted_contact_id.email', 'converted_contact_id.phone'], {
    title: 'Converted to',
    width: 'half',
    when: 'status = converted',
  }),
  breakdown('Campaign touches by kind', 'campaign_member', 'campaign_id.kind', { whose: 'lead_id', width: 'half' }),
  metric('Campaign memberships', 'campaign_member', { whose: 'lead_id', width: 'third' }),
  metric('Responded', 'campaign_member', { whose: 'lead_id', query: 'responded = true', width: 'third', offsetRight: 'third' }),
  related('Campaign history', 'campaign_member', 'lead_id', {
    show: ['campaign_id.name', 'responded', 'added_on'],
    sort: 'added_on desc',
  }),
  // What the designed page's Activity card draws: the campaigns a lead joined, and the calls and meetings with the
  // contact it became (a stream `about` a reference reads that record's rows).
  timeline('Activity', [
    stream('campaign_member', 'lead_id', 'added_on', 'campaign_id.name', { badge: 'campaign_id.kind' }),
    stream('activity', 'contact_id', 'happened_on', 'subject', { about: 'converted_contact_id', badge: 'kind', author: 'owner_id.name' }),
  ]),
]) satisfies Page;
