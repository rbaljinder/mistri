import { breakdown, fields, metric, page, related } from '@mistriwork/mistri/app';
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
]) satisfies Page;
