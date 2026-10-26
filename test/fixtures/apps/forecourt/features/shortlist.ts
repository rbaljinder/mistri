import { action, defineFeature, fields, listView, page } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/** A signed-in buyer's durable shortlist. policy.ts restricts its rows to the
 * verified account; the App only gives the three account roles its surface. */
export const shortlist = defineFeature({
  id: 'shortlist',
  resources: {
    vehicle: { actions: { saveVehicle: action('Save vehicle', { command: 'saveVehicle' }) } },
    saved_vehicle: {
      recordLabel: 'vehicle_id.title',
      actions: { removeFromShortlist: action('Remove from shortlist', { command: 'removeSavedVehicle' }) },
      display: { saved_at: { format: 'relative' } },
      labels: { saved_at: 'Saved' },
    },
  },
  auth: {
    roles: {
      shopper: { read: ['saved_vehicle'], commands: ['saveVehicle', 'removeSavedVehicle'] },
      staff: { read: ['saved_vehicle'], commands: ['saveVehicle', 'removeSavedVehicle'] },
      admin: { read: ['saved_vehicle'], commands: ['saveVehicle', 'removeSavedVehicle'] },
    },
  },
  views: {
    shortlist: listView('My shortlist', 'saved_vehicle', {
      query: 'active = true',
      empty: {
        title: 'Your shortlist is empty',
        description: 'Save vehicles from their pages to keep them here.',
        action: { label: 'Browse vehicles', to: 'vehicles' },
      },
      show: ['vehicle_id.title', 'vehicle_id.price', 'saved_at'],
      filters: ['vehicle_id', 'saved_at'],
    }),
  },
  pages: {
    'saved-vehicle': page('saved_vehicle', [fields(['vehicle_id', 'vehicle_id.price', 'saved_at', 'active'], { columns: 2 })]),
  },
} satisfies Feature);
