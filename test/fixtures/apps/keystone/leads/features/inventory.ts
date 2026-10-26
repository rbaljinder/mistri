import { count, defineFeature, fields, header, listView, page, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { dollars, miles, perMonth, vehicleStatus } from '../vocab.ts';

/* The lot, read-only here: the dealer's own settings App changes prices and
   listings. The desk needs it to pick a car for a deal and to see what is
   drawing interest. `cost`, the dealer's own figure, is hidden from this
   App altogether (app.ts). */
export const inventory = defineFeature({
  id: 'inventory',
  resources: {
    vehicle: {
      segments: {
        for_sale: 'status = listed or status = in_stock',
        pending: 'status = pending',
        sold: 'status = sold',
      },
      recordLabel: '{year} {make} {model} {trim}',
      labels: {
        stock_number: 'Stock',
        list_price: 'Price',
        est_payment: 'Advertised payment',
        received_on: 'On the lot since',
        exterior_color: 'Color',
      },
      display: {
        status: vehicleStatus,
        list_price: dollars,
        est_payment: perMonth,
        mileage: miles,
        received_on: { format: 'relative' },
        features: { format: 'items' },
      },
      /* Counted in the dealer's own context, as every read of a tenant is,
         so it is this dealer's number and never another's. */
      rollups: {
        leads: count('lead', { whose: 'vehicle_id', query: 'status != lost' }),
        deals: count('deal', { whose: 'vehicle_id', query: 'status != cancelled' }),
      },
    },
    vehicle_photo: { recordLabel: 'caption' },
  },
  views: {
    inventory: listView('Inventory', 'vehicle', {
      icon: 'car',
      realm: 'tenant',
      show: ['stock_number', 'year', 'make', 'model', 'mileage', 'list_price', 'leads', 'status'],
      filters: ['status', 'make', 'body', 'condition', 'year', 'list_price'],
      filterBar: 'rail',
      sort: 'received_on desc',
      tabs: ['for_sale', 'pending', { segment: 'sold', sort: 'sold_on desc' }, { label: 'All' }],
    }),
  },
  pages: {
    vehicle: page(
      'vehicle',
      [
        header({ status: 'status', facts: ['stock_number', 'mileage', 'exterior_color', 'received_on'] }),
        fields(['list_price', 'est_payment', 'leads']),
        related('Leads on this car', 'lead', 'vehicle_id', {
          show: ['first_name', 'last_name', 'status'],
          sort: 'created_at desc',
          empty: { title: 'No leads yet', description: 'Inquiries about this car and walk-ins recorded on it appear here.' },
        }),
        related('Deals', 'deal', 'vehicle_id', { show: ['reference', 'lead_id.last_name', 'monthly_payment', 'status'], empty: 'hide' }),
        related('Photos', 'vehicle_photo', 'vehicle_id', { show: ['caption', 'position'], empty: 'hide' }),
        fields(['condition', 'fuel', 'vin', 'body', 'drivetrain', 'interior_color', 'listed_on', 'features'], {
          title: 'Vehicle',
          region: 'aside',
        }),
      ],
      { listTabs: true },
    ),
  },
} satisfies Feature);
