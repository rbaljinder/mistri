/** Exact logical schema of the disposable host-owned SQLite store. */
export type Rows = {
  location: {
    id: string;
    tenant_id: string;
    business_id: string;
    name: string;
  };
  lead: {
    id: string;
    tenant_id: string;
    location_id: string;
    business_id: string;
    name: string;
    status: string;
  };
  follow_up: {
    id: string;
    tenant_id: string;
    location_id: string;
    lead_id: string;
    business_id: string;
    name: string;
    status: string;
    version: number;
  };
  activity: {
    id: string;
    tenant_id: string;
    location_id: string;
    follow_up_id: string;
    name: string;
    body: string;
    created_at: string;
  };
};

export type Tables = { [T in keyof Rows]: Extract<keyof Rows[T], string> };

// All foreign keys reference id. The DSL leaves paths as strings, so check
// the authored one-hop paths here as well as validating the real host catalog.
export type Paths = {
  location: Tables['location'];
  lead: Tables['lead'] | `location_id.${Tables['location']}`;
  follow_up: Tables['follow_up'] | `location_id.${Tables['location']}` | `lead_id.${Tables['lead']}`;
  activity: Tables['activity'] | `location_id.${Tables['location']}` | `follow_up_id.${Tables['follow_up']}`;
};
