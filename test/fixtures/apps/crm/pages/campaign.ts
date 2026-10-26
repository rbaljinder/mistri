import { breakdown, fields, metric, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

export default page('campaign', [
  fields([]),
  metric('Members', 'campaign_member', { whose: 'campaign_id', width: 'third' }),
  metric('Responses', 'campaign_member', { whose: 'campaign_id', query: 'responded = true', width: 'third', offsetRight: 'third' }),
  breakdown('Members by lead status', 'campaign_member', 'lead_id.status', { whose: 'campaign_id', width: 'half' }),
  breakdown('Members by lead source', 'campaign_member', 'lead_id.source', { whose: 'campaign_id', width: 'half' }),
  related('Members', 'campaign_member', 'campaign_id', {
    show: ['lead_id.name', 'responded', 'added_on'],
    limit: 15,
    sort: 'added_on desc',
  }),
]) satisfies Page;
