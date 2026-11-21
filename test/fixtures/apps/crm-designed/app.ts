import { assistant, defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { navigation } from './navigation.ts';
import { resources } from './resources.ts';
import { quarry, slate } from './theme.ts';
import { views } from './views.ts';

export default defineApp({
  id: 'compass',
  name: 'Compass',
  resources,
  views,
  home: 'sales-dashboard',
  // Offered once the operator gives the server a model (ANTHROPIC_API_KEY) and the
  // database its assistant store (provisionStores with only: ['assistant'], from @mistriwork/mistri/maintenance).
  assistant: assistant({
    instructions:
      'Compass is a sales CRM. Reps ask about their leads, deals and accounts: find stale deals, ' +
      'sum up a lead or a deal before a call, and log their calls and meetings as activities.',
    // Questions an empty conversation offers, one press each.
    starters: ['Show stale deals', 'Pipeline by stage', 'Which leads are new this week?'],
    // Beside every room, about the open record, and a room of its own at /compass/assistant (navigation.ts).
    placement: ['panel', 'record', 'page'],
    // Losing a deal is the rep's call, made on the deal itself.
    exclude: ['opportunity.markLost'],
    limits: { tokensPerTurn: 80_000, tokensPerPersonPerDay: 1_000_000 },
  }),
  nav: navigation,
  ui: {
    logo: 'address-book',
    shell: { placement: 'top' },
    // The designed pages (pages/leads, pages/lead, pages/sales-dashboard) are
    // drawn for Compass's own look; Quarry stays offered in the picker.
    customThemes: [quarry, slate],
    theme: { preset: 'compass-slate' },
    locale: 'en-US',
    timezone: 'America/New_York',
    currency: 'USD',
  },
} satisfies App);
