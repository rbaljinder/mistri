import { listView } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { views as parentViews } from '../assignment/views.ts';
import type { Paths, Tables } from './schema.ts';

export const views = {
  ...parentViews,
  vehicles: listView('Vehicles', 'vehicle', {
    advancedFilters: true,
    show: ['name', 'stock_reference', 'location_id.name', 'status'] satisfies Paths['vehicle'][],
    filters: ['name', 'stock_reference', 'location_id', 'status'] satisfies Tables['vehicle'][],
  }),
  reservations: listView('Reservations', 'vehicle_reservation', {
    show: [
      'name',
      'reference',
      'vehicle_id.name',
      'lead_id.name',
      'location_id.name',
      'status',
      'reserved_by.name',
      'reserved_on',
      'released_on',
    ] satisfies Paths['vehicle_reservation'][],
    filters: ['name', 'reference', 'vehicle_id', 'lead_id', 'location_id', 'status'] satisfies Tables['vehicle_reservation'][],
  }),
  'availability-history': listView('Availability history', 'availability_history', {
    show: [
      'name',
      'vehicle_id.name',
      'reservation_id.name',
      'actor_id.name',
      'from_status',
      'to_status',
      'reason',
      'recorded_on',
    ] satisfies Paths['availability_history'][],
  }),
} satisfies NonNullable<TypedAppConfig<Tables>['views']>;
