import { action, type TypedAppConfig } from '@mistriwork/mistri/app';
import type { Tables } from './schema.ts';

/* Who owns each table: the clinic profile and triage are the platform's, everything a clinic keeps is the
   tenant's (its `clinic_id`, which the server fills and never serves). The policy's ownership says the same. */
export const resources = {
  clinic: { owner: 'platform', access: 'write' },
  triage: { owner: 'platform', access: 'write' },
  patient: { owner: 'tenant', access: 'write' },
  // A targeted command is offered somewhere or prepared nowhere: its record's action is that place.
  appointment: { owner: 'tenant', access: 'write', actions: { recordPayment: action('Record payment', { command: 'recordPayment' }) } },
  payment: { owner: 'tenant', access: 'write' },
  // A clinic's price list is its configuration: copied into a sandbox, and imported back.
  service: { owner: 'tenant', access: 'write', clone: 'config' },
  visit_request: { owner: 'tenant', access: 'write' },
  notice: { owner: 'tenant', access: 'write' },
  /* One room, one time: two bookings of a room may not meet, a cancelled one aside. A booking that ends at ten and
     one that starts at ten do not meet. PostgreSQL holds it with the exclusion constraint the seed adds; the
     database's own CHECK that a booking runs forward is said beside the end it is about. */
  room_booking: {
    owner: 'tenant',
    access: 'write',
    noOverlap: { by: ['room'], from: 'starts_at', to: 'ends_at', when: 'status != cancelled', message: 'That room is taken then.' },
    constraints: { room_booking_runs_forward: { field: 'ends_at', message: 'A booking ends after it starts.' } },
  },
} satisfies Required<NonNullable<TypedAppConfig<Tables>['resources']>>;
