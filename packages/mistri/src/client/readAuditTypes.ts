/** What `useReadAudit()` reads, apart from the route that answers it (readAuditAccess.ts), so a headless surface can name an empty log without it. */

/** Where a read was made: the App's pages, its API, its MCP, the assistant, an export, a picker, a free-form page, a record's related list or a command. */
type ReadAuditRoute = 'page' | 'api' | 'mcp' | 'assistant' | 'export' | 'picker' | 'custom-page' | 'related' | 'command';

/** One line of the tenant's read audit, as /api/reads answers it (tenantReadsRoute.ts). */
export interface ReadAuditLine {
  readonly id: number;
  /** ISO instant. */
  readonly at: string;
  /** An account id, or `service:<principal>`, `support:<operator>`, `api-token:<id>`, `assistant:<account>`, `public`. */
  readonly actor: string;
  /** The account's name from the sign-in store, where the actor names a person it knows. */
  readonly person?: string;
  /** The roles the read was granted under; an API token's are its own. */
  readonly roles?: readonly string[];
  /** The membership the reader read through: a person's own, or the one that holds the API token. */
  readonly membership?: string;
  readonly resource: string;
  readonly route: ReadAuditRoute;
  /** The command whose handler or lookup made the read, where the route is `command`. */
  readonly command?: string;
  readonly kind: 'opened' | 'listed';
  /** The record opened (`kind: 'opened'`). */
  readonly record?: string;
  /** How many rows the list returned (`kind: 'listed'`). */
  readonly count?: number;
}

/** What a page asks of the log: every filter optional, as the Reads room's. `before` is a line's id, to read below it. */
export interface ReadAuditFilters {
  readonly actor?: string;
  readonly resource?: string;
  /** A record's id: matched where it was opened and in every list that showed it. */
  readonly record?: string;
  /** ISO instants, inclusive. */
  readonly since?: string;
  readonly until?: string;
  readonly before?: number;
}

/** One page of the log, newest first; `next` is the id to ask `before` for the page below, absent on the last. */
export interface ReadAuditPage {
  readonly reads: readonly ReadAuditLine[];
  readonly next?: number;
  /** The resources whose reads are audited. */
  readonly resources: readonly string[];
}

export interface ReadAuditAccess {
  read(filters: ReadAuditFilters): Promise<ReadAuditPage>;
}

export const EMPTY_READS: ReadAuditPage = Object.freeze({ reads: Object.freeze([]), resources: Object.freeze([]) });

/** An access with no log: outside a tenant App there is nothing to read, and nothing is asked. */
export const noReadAuditAccess: ReadAuditAccess = { read: async () => EMPTY_READS };
