import { fields, page, related } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { pages as parentPages } from '../assignment/pages.ts';
import type { Paths, Tables } from './schema.ts';

/* Keyed by page id; the assignment variant's pages keep their ids and order. */
export const pages = {
  ...parentPages,
  location: {
    ...parentPages.location,
    listTabs: true,
    sections: [
      ...(parentPages.location.sections ?? []),
      related('Vehicles', 'vehicle', 'location_id' satisfies Tables['vehicle'], {
        show: ['name', 'stock_reference', 'status'] satisfies Paths['vehicle'][],
      }),
    ],
  },
  lead: {
    ...parentPages.lead,
    listTabs: true,
    sections: [
      ...(parentPages.lead.sections ?? []),
      related('Vehicle reservations', 'vehicle_reservation', 'lead_id' satisfies Tables['vehicle_reservation'], {
        show: ['name', 'reference', 'vehicle_id.name', 'status', 'reserved_on', 'released_on'] satisfies Paths['vehicle_reservation'][],
        sort: 'reserved_on desc',
      }),
    ],
  },
  vehicle: page(
    'vehicle',
    [
      fields(['name', 'stock_reference', 'location_id', 'status', 'version'] satisfies Paths['vehicle'][]),
      // Related lists omit id intentionally; the framework fetches navigation keys.
      related('Reservations', 'vehicle_reservation', 'vehicle_id' satisfies Tables['vehicle_reservation'], {
        show: [
          'name',
          'reference',
          'lead_id.name',
          'status',
          'reserved_by.name',
          'reserved_on',
          'released_on',
        ] satisfies Paths['vehicle_reservation'][],
        sort: 'reserved_on desc',
      }),
      related('Availability history', 'availability_history', 'vehicle_id' satisfies Tables['availability_history'], {
        show: [
          'name',
          'reservation_id.name',
          'actor_id.name',
          'from_status',
          'to_status',
          'reason',
          'recorded_on',
        ] satisfies Paths['availability_history'][],
        sort: 'recorded_on desc',
      }),
    ],
    { listTabs: true },
  ),
  vehicle_reservation: page('vehicle_reservation', [
    fields([
      'name',
      'reference',
      'location_id',
      'vehicle_id',
      'lead_id',
      'reserved_by',
      'released_by',
      'status',
      'version',
      'reason',
      'reserved_on',
      'released_on',
    ] satisfies Paths['vehicle_reservation'][]),
    related('Availability history', 'availability_history', 'reservation_id' satisfies Tables['availability_history'], {
      show: [
        'name',
        'vehicle_id.name',
        'actor_id.name',
        'from_status',
        'to_status',
        'reason',
        'recorded_on',
      ] satisfies Paths['availability_history'][],
      sort: 'recorded_on desc',
    }),
  ]),
  availability_history: page('availability_history', [
    fields([
      'name',
      'location_id',
      'vehicle_id',
      'reservation_id',
      'actor_id',
      'from_status',
      'to_status',
      'reason',
      'recorded_on',
    ] satisfies Paths['availability_history'][]),
  ]),
} satisfies NonNullable<TypedAppConfig<Tables>['pages']>;
