import { applyTo, embed, hero, landing } from '@mistriwork/mistri/app';
import type { Views } from '../mistri-schema.d.ts';
import { views as authored } from '../views.ts';

// Placement is a server policy. The existing stock/rate filters remain merchandising.
// This integration layer replaces the original single-dealer presentation.
export const views = {
  ...authored,
  welcome: landing(
    hero('Find your next car', 'Open your dealership’s website to see its inventory and contact its team.', [
      { label: 'Shop inventory', to: 'inventory' },
      applyTo('apply', 'Apply for financing', 'secondary'),
    ]),
    [
      embed('visit', { title: 'Your dealership', limit: 1 }),
      embed('featured', { title: 'Featured vehicles', limit: 3, sort: 'list_price desc' }),
      embed('financing', { title: 'Keystone Auto Finance', limit: 3, sort: 'base_apr' }),
    ],
    { label: 'Dealership website' },
  ),
  inventory: { ...authored.inventory, query: 'status in (listed, pending)' },
  featured: { ...authored.featured, query: 'status in (listed, pending) and featured = true' },
  visit: { ...authored.visit, query: undefined },
  ask: { ...authored.ask, description: 'A question for this dealership’s sales team. From a car’s page the form already names the car.' },
  apply: {
    ...authored.apply,
    description:
      'About five minutes. This dealership’s finance manager sends your application to Keystone Auto Finance and contacts you with the answer. A demonstration on synthetic data: no credit is offered and no bureau is asked.',
  },
} satisfies Views;
