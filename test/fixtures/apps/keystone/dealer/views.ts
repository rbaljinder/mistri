import { breakdown, cards, chart, dashboard, listView, metric, rows } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

/* The dealership's rooms: how the lot and the leads are doing, the website,
   the inventory as the public sees it, the team, and the dealership as
   Keystone knows it. Every row is the signed-in manager's own dealership's
   (policy.ts); nothing here filters by dealer. */

const vehicleCard = cards('model', {
  value: 'list_price',
  badge: 'status',
  facts: ['year', 'mileage', 'body'],
  properties: ['make', 'stock_number'],
  image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
});

export const views = {
  overview: dashboard(
    'Overview',
    [
      metric('Listed for sale', 'vehicle', { query: 'status = listed' }),
      metric('Sold', 'vehicle', {
        query: 'status = sold and sold_on = last 30 days',
        over: 'sold_on',
        compare: 'previous period',
        better: 'up',
      }),
      metric('New leads', 'lead', {
        query: 'status != draft and created_at = last 30 days',
        over: 'created_at',
        compare: 'previous period',
        better: 'up',
      }),
      chart('Leads by month', 'lead', 'month created_at', { query: 'status != draft and created_at = last 12 months', width: 'half' }),
      breakdown('Leads by source', 'lead', 'source', {
        query: 'status != draft and created_at = last 30 days',
        over: 'created_at',
        width: 'half',
      }),
      rows('Your website', 'dealer_site', { show: ['dealer_id', 'published', 'custom_domain'], width: 'half' }),
      rows('Longest on the lot', 'vehicle', {
        query: 'status = listed',
        show: ['stock_number', 'model', 'listed_on'],
        sort: 'listed_on',
        limit: 5,
        width: 'half',
      }),
    ],
    {
      heading: 'Hello, {me.name}',
      description: 'Your lot, your leads and your website, this period.',
      icon: 'gauge',
      windows: ['last 30 days', 'last 90 days', 'last 12 months'],
    },
  ),

  website: listView('Website', 'dealer_site', {
    icon: 'globe',
    show: ['dealer_id', 'published', 'custom_domain', 'headline', 'published_on'],
    sort: 'dealer_id',
    filters: [],
    empty: { title: 'No website yet', description: 'Keystone sets up the website when a dealership joins.' },
  }),

  inventory: listView('Inventory', 'vehicle', {
    icon: 'car',
    show: ['stock_number', 'list_price', 'status', 'featured', 'model', 'listed_on'],
    // Pricing is the daily work: the price and the featured flag change in the row.
    editable: ['list_price', 'featured'],
    tabs: [
      { segment: 'listed', sort: 'listed_on' },
      { segment: 'in_stock', sort: 'received_on' },
      'sale_pending',
      { segment: 'sold', sort: 'sold_on desc' },
      { label: 'All' },
    ],
    filterBar: 'rail',
    filters: ['make', 'body', 'fuel', 'condition', 'list_price', 'year'],
    sort: 'stock_number',
    rowActions: true,
    empty: { title: 'Nothing here', description: 'Vehicles your dealership receives appear here, ready to price and list.' },
  }),

  showroom: listView('Showroom', 'vehicle', {
    icon: 'storefront',
    query: 'status = listed or status = pending',
    presentation: vehicleCard,
    tabs: ['picks', { label: 'All listed' }],
    filterBar: 'rail',
    filters: ['make', 'body', 'list_price', 'mileage'],
    sort: [
      { label: 'Newest listings', sort: 'listed_on desc' },
      { label: 'Longest on the lot', sort: 'listed_on' },
      { label: 'Lowest price', sort: 'list_price' },
      { label: 'Highest price', sort: 'list_price desc' },
    ],
    empty: { title: 'Nothing on the market', description: 'List a vehicle from Inventory and it shows here as the public sees it.' },
  }),

  team: listView('Team', 'dealer_user', {
    icon: 'users',
    show: ['name', 'role', 'status', 'phone', 'joined_on'],
    tabs: ['active', { segment: 'invited', sort: 'invited_on desc' }, 'deactivated', { label: 'All' }],
    filters: ['role'],
    sort: 'name',
    rowActions: true,
    empty: {
      title: 'No one here',
      description: 'Add a team member from your dealership page.',
      action: { label: 'Your dealership', to: 'dealership' },
    },
  }),

  dealership: listView('Dealership', 'dealer', {
    icon: 'buildings',
    show: ['name', 'status', 'tier', 'relationship_manager_id', 'listed'],
    sort: 'name',
    filters: [],
  }),

  visits: listView('Keystone visits', 'dealer_visit', {
    icon: 'handshake',
    show: ['happened_on', 'kind', 'lender_user_id', 'summary', 'next_step'],
    sort: 'happened_on desc',
    filters: ['kind', 'happened_on'],
    empty: { title: 'No visits yet', description: 'Your relationship manager’s visits, calls and reviews are recorded here.' },
  }),

  programs: listView('Programs', 'program', {
    icon: 'bank',
    query: 'active = true',
    show: ['name', 'tier', 'base_apr', 'max_term', 'max_amount', 'min_score'],
    sort: 'base_apr',
    filters: ['tier', 'advertised'],
  }),
} satisfies App['views'];
