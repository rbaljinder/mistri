/** Exact logical schema of the disposable host-owned SQLite store. */
export type Rows = {
  project: {
    id: string;
    tenant_id: string;
    business_id: string;
    name: string;
  };
  issue: {
    id: string;
    tenant_id: string;
    project_id: string;
    business_id: string;
    name: string;
    status: string;
  };
  discussion: {
    id: string;
    tenant_id: string;
    project_id: string;
    issue_id: string;
    business_id: string;
    name: string;
    status: string;
    version: number;
  };
  comment: {
    id: string;
    tenant_id: string;
    project_id: string;
    discussion_id: string;
    name: string;
    body: string;
    created_at: string;
  };
};

export type Tables = { [T in keyof Rows]: Extract<keyof Rows[T], string> };

// All foreign keys reference id. The DSL leaves paths as strings, so check
// the authored one-hop paths here as well as validating the real host catalog.
export type Paths = {
  project: Tables['project'];
  issue: Tables['issue'] | `project_id.${Tables['project']}`;
  discussion: Tables['discussion'] | `project_id.${Tables['project']}` | `issue_id.${Tables['issue']}`;
  comment: Tables['comment'] | `project_id.${Tables['project']}` | `discussion_id.${Tables['discussion']}`;
};
