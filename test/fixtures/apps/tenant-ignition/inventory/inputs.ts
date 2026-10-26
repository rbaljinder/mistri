import type { Tables } from './schema.js';

/* The one declaration of the inventory commands' inputs, read by their server
   registrations (test/support/tenantInventoryFixture.ts). The App names the
   commands (resources.ts) and is served these inputs with them; importing
   nothing else, so the registrations can read them without the App's module graph. */
export const reserveVehicleInput = {
  lead: {
    label: 'Lead',
    type: 'reference',
    from: 'lead' satisfies keyof Tables,
    by: 'id' satisfies Tables['lead'],
    labelColumn: 'name' satisfies Tables['lead'],
    query: 'status = open',
  },
  reason: { label: 'Reservation reason', type: 'textarea', max: 500 },
} as const;

export const releaseReservationInput = {
  reason: { label: 'Release reason', type: 'textarea', max: 500 },
} as const;
