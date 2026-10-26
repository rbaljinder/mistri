import { action, defineFeature, listView } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/** A signed-in customer's shortlist. policy.ts confines its rows to the
 * verified account; the handlers (server/shortlist.ts) take no account id. */
export const shortlist = defineFeature({
  id: 'shortlist',
  resources: {
    vehicle: {
      actions: {
        saveVehicle: action('Save to shortlist', { command: 'saveVehicle' }),
      },
    },
    saved_vehicle: {
      actions: {
        removeSavedVehicle: action('Remove from shortlist', { command: 'removeSavedVehicle' }),
      },
    },
  },
  auth: {
    roles: {
      customer: { read: ['saved_vehicle'], commands: ['saveVehicle', 'removeSavedVehicle'] },
      marketplace_admin: { read: ['saved_vehicle'], commands: ['saveVehicle', 'removeSavedVehicle'] },
    },
  },
  views: {
    shortlist: listView('Your shortlist', 'saved_vehicle', {
      icon: 'bookmark-simple',
      query: 'status = saved',
      sort: 'saved_at desc',
      show: ['vehicle_id', 'vehicle_id.list_price', 'vehicle_id.est_payment', 'vehicle_id.mileage', 'vehicle_id.status', 'saved_at'],
      rowActions: true,
      empty: {
        title: 'Nothing saved yet',
        description: 'Save cars from their pages to compare them here.',
        action: { label: 'Browse cars for sale', to: 'vehicles' },
      },
    }),
  },
} satisfies Feature);
