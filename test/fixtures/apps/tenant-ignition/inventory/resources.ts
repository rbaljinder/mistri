import { action } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { resources as parentResources } from '../assignment/resources.ts';
import type { Tables } from './schema.ts';

/* The assignment variant's seven resources, then the three inventory ones,
   all writable in the ceiling to admit the commands' effects. */
export const resources = {
  ...parentResources,
  vehicle: {
    physical: 'physical_vehicle',
    owner: 'tenant',
    access: 'write',
    actions: { reserveVehicle: action('Reserve vehicle', { command: 'reserveVehicle' }) },
  },
  vehicle_reservation: {
    noun: 'reservation',
    physical: 'physical_vehicle_reservation',
    owner: 'tenant',
    access: 'write',
    actions: { releaseReservation: action('Release reservation', { command: 'releaseReservation' }) },
  },
  availability_history: { physical: 'physical_availability_history', owner: 'tenant', access: 'write' },
} satisfies Required<NonNullable<TypedAppConfig<Tables>['resources']>>;
