import type { Paths as ParentPaths, Rows as ParentRows, Tables as ParentTables } from '../assignment/schema.ts';

/** Exact logical extension of the disposable host-owned SQLite store. */
export type Rows = ParentRows & {
  vehicle: {
    id: string;
    tenant_id: string;
    location_id: string;
    stock_reference: string;
    name: string;
    status: 'available' | 'reserved' | 'unavailable';
    version: number;
  };
  vehicle_reservation: {
    id: string;
    tenant_id: string;
    location_id: string;
    vehicle_id: string;
    lead_id: string;
    reserved_by: string;
    released_by: string | null;
    reference: string;
    name: string;
    status: 'active' | 'released';
    version: number;
    reason: string;
    reserved_on: string;
    released_on: string | null;
  };
  availability_history: {
    id: string;
    tenant_id: string;
    location_id: string;
    vehicle_id: string;
    reservation_id: string;
    actor_id: string;
    name: string;
    from_status: string;
    to_status: string;
    reason: string;
    recorded_on: string;
  };
};

export type Tables = ParentTables & {
  [T in Exclude<keyof Rows, keyof ParentRows>]: Extract<keyof Rows[T], string>;
};

// All relationships reference opaque id keys; constrain authored one-hop paths.
export type Paths = ParentPaths & {
  vehicle: Tables['vehicle'] | `location_id.${Tables['location']}`;
  vehicle_reservation:
    | Tables['vehicle_reservation']
    | `location_id.${Tables['location']}`
    | `vehicle_id.${Tables['vehicle']}`
    | `lead_id.${Tables['lead']}`
    | `reserved_by.${Tables['review_staff']}`
    | `released_by.${Tables['review_staff']}`;
  availability_history:
    | Tables['availability_history']
    | `location_id.${Tables['location']}`
    | `vehicle_id.${Tables['vehicle']}`
    | `reservation_id.${Tables['vehicle_reservation']}`
    | `actor_id.${Tables['review_staff']}`;
};
