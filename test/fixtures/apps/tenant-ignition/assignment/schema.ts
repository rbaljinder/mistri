import type { Paths as ParentPaths, Rows as ParentRows, Tables as ParentTables } from '../schema.ts';

/** Exact logical extension of the disposable host-owned SQLite store. */
export type Rows = ParentRows & {
  review_staff: {
    id: string;
    tenant_id: string;
    location_id: string;
    business_id: string;
    name: string;
    role: string;
    active: 0 | 1;
  };
  loan_application: {
    id: string;
    tenant_id: string;
    location_id: string;
    lead_id: string;
    business_id: string;
    name: string;
    status: string;
    reviewer_id: string | null;
    version: number;
  };
  assignment_history: {
    id: string;
    tenant_id: string;
    location_id: string;
    application_id: string;
    assigned_to: string;
    assigned_by: string;
    name: string;
    reason: string;
    assigned_on: string;
  };
};

export type Tables = ParentTables & {
  [T in Exclude<keyof Rows, keyof ParentRows>]: Extract<keyof Rows[T], string>;
};

// Every relationship references id; constrain authored one-hop paths even
// where the public DSL deliberately leaves query/path grammar as strings.
export type Paths = ParentPaths & {
  review_staff: Tables['review_staff'] | `location_id.${Tables['location']}`;
  loan_application:
    | Tables['loan_application']
    | `location_id.${Tables['location']}`
    | `lead_id.${Tables['lead']}`
    | `reviewer_id.${Tables['review_staff']}`;
  assignment_history:
    | Tables['assignment_history']
    | `location_id.${Tables['location']}`
    | `application_id.${Tables['loan_application']}`
    | `assigned_to.${Tables['review_staff']}`
    | `assigned_by.${Tables['review_staff']}`;
};
