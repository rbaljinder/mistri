/** The existing resource HTTP wire contract shared by producers and callers.
 * These are data types only: they neither validate JSON nor authorize a read or
 * write. HTTP status stays on the response, and no wrapper or discriminator is
 * added to the bodies. App projection must still run on the server. */
import type { CountResult, QueryResult } from './reads.js';
import type { StructuredFilter, StructuredScalar } from './structuredFilter.js';
import type { BreakdownDef, CompiledMeasure, GroupNames } from './breakdown.js';
import type { DeleteRule, Order } from './schema.js';
import type { Boundary, PageBounds } from './keysetPage.js';
import type { CompiledColumn, CompiledJoin, ViewColumn, ViewDef, ViewOrder } from './view.js';

export type ResourceHttpMode = 'app' | 'db';
export type HttpScalar = StructuredScalar;
export type HttpValues = Record<string, HttpScalar>;
/** Large integer identifiers remain strings; finite-number/key checks are runtime checks. */
export type HttpRecordKey = Record<string, string | number>;

/** Both [] and [[]] are legal. */
export type HttpFilter<Field extends 'column' | 'path' = 'column'> = StructuredFilter<Field>;

interface HttpPaginationInput {
  /** The server clamps numeric strings as well as numbers; null means unspecified. */
  limit?: number | string | null;
  offset?: number | string | null;
}
interface HttpQueryRequest extends HttpPaginationInput {
  table: string;
  filter?: HttpFilter | null;
  columns?: string[];
  orderBy?: Order[];
}
interface HttpCountRequest {
  table: string;
  filter?: HttpFilter | null;
  exactCount?: boolean;
  /** Count at most this many (clamped to 100,000); past it the reply says `capped`. */
  countLimit?: number;
}
interface HttpRunRequest extends HttpPaginationInput {
  q: string;
  columns?: string[];
  exactCount?: boolean;
  /** Count the total to at most this many (clamped to 100,000); past it the reply says `cappedTotal`.
   * A filtered total is bounded at 10,000 when neither this nor `exactCount` is sent. */
  countLimit?: number;
  /** `none` for a caller that never shows a total; `exact` is `exactCount`. */
  count?: 'none' | 'exact' | 'estimate';
  /** A page by key: the rows after a boundary (a reply's `bounds.last`), before one (`bounds.first`),
   * or the list's last `limit` rows. `offset` then only names the page; an order that cannot page by key reads by it. */
  after?: Boundary;
  before?: Boundary;
  end?: true;
}

/** HTTP normalization supplies missing IDs/names and expands string columns.
 * Connection/source config metadata is not part of this operation's view DTO. */
type HttpViewInput = Pick<Partial<ViewDef>, 'id' | 'name' | 'base' | 'aggregates' | 'limit'> & {
  columns?: Array<string | ViewColumn>;
  filter?: HttpFilter<'path'> | null;
  orderBy?: Array<Omit<ViewOrder, 'direction'> & { direction?: 'asc' | 'desc' }>;
};
type HttpViewRequest = HttpPaginationInput & {
  query?: string;
  /** Omit for an exact total; record-only readers may skip the count. */
  count?: 'none' | 'exact';
} & ({ view: HttpViewInput & { base: string }; text?: string } | { text: string; view?: HttpViewInput });
export type HttpViewDefinition = Pick<ViewDef, 'id' | 'name' | 'base' | 'columns' | 'aggregates' | 'orderBy' | 'limit' | 'text'> & {
  filter?: HttpFilter<'path'> | null;
};
export type HttpBreakdownDefinition = Omit<BreakdownDef, 'filter'> & { filter?: HttpFilter<'path'> | null };
type HttpBreakdownRequest = HttpPaginationInput & ({ def: HttpBreakdownDefinition; text?: string } | { text: string; def?: never });

/** Both existing update forms are accepted; values takes precedence if both are supplied. */
/** A new record's lines on its save, by child resource: every row the collection has, in order (server/http/formLinesWrite.ts). */
type HttpLines = Record<string, Array<{ values: HttpValues }>>;
export type HttpUpdateRequest = { table: string; key: HttpRecordKey; expected?: HttpValues } & (
  | { values: HttpValues; column?: string; value?: HttpScalar }
  | { column: string; value?: HttpScalar; values?: never }
);
interface HttpInsertRequest {
  table: string;
  values: HttpValues;
  lines?: HttpLines;
}
interface HttpDeleteRequest {
  table: string;
  key: HttpRecordKey;
  confirm?: boolean;
}
export type HttpRevertRequest<Token extends number | string = number> =
  | { confirm?: false; limit?: number; expectedId?: Token }
  | { confirm: true; expectedId: Token; limit?: number };

/** Routing selectors are separate from operation bodies and never confer authority.
 * The client's internal conn-to-app translation happens before this wire shape. */
type ResourceHttpIdentity<Mode extends ResourceHttpMode> = Mode extends 'app'
  ? { app?: string; conn?: never }
  : { conn?: string; app?: never };

type HttpErrorCode =
  | 'validation_failed'
  | 'consumes_refused'
  | 'record_conflict'
  | 'required_value'
  | 'duplicate_value'
  | 'reference_conflict'
  | 'constraint_failed'
  | 'data_unavailable'
  | 'write_unconfirmed'
  | 'forbidden'
  | 'undo_failed';
export interface HttpDiagnostic {
  message: string;
  at?: number;
  code?: HttpErrorCode;
  /** App write validation may identify a safe field, never its value. */
  fields?: readonly { field: string; message: string }[];
}
interface HttpSignInInfo {
  app: string;
  /** How people sign in: `email`, a social provider's name, `oidc:<name>` or `saml:<name>` (an App's `auth.providers`), as the sign-in screen offers them. */
  providers: readonly string[];
  /** `provider`: accounts are made at a first sign-in through an identity provider (auth.ts signInInfo). */
  signUp: 'open' | 'invite' | 'provider';
  labels?: Record<string, string>;
}
/** Non-2xx transport failures. They are not successful operation acknowledgements. */
interface HttpRequestFailure {
  error: string;
  code?: HttpErrorCode;
  errors?: HttpDiagnostic[];
  signIn?: HttpSignInInfo;
  /** An invalid authenticated-session ID can include the signed-out bootstrap fields. */
  signedIn?: false;
  accountId?: null;
  appId?: string;
  who?: null;
  header?: null;
  rows?: never;
  outcome?: never;
}
/** Parser/structured-breakdown failures can be HTTP 200, with no partial rows. */
export interface HttpReadFailure {
  errors: HttpDiagnostic[];
  rows?: never;
  columns?: never;
}

type HttpRows = Pick<QueryResult, 'columns' | 'rows' | 'ms'>;
export type HttpSql = QueryResult['sql'];
interface HttpResolvedOrder {
  order: Order[];
  implicit: boolean;
}
/** Explicit allowlists match appDataResponse; compiler additions do not become public DTO fields. */
type HttpAppViewColumn = Pick<
  CompiledColumn,
  'path' | 'name' | 'table' | 'column' | 'type' | 'nullable' | 'primaryKey' | 'hops' | 'aggregate'
>;
type HttpAppMeasure = Pick<CompiledMeasure, 'name' | 'kind' | 'fn' | 'path' | 'type' | 'bucket'>;
type AppProjection<Body> = Body & { sql?: never; explain?: never; joins?: never };
type QuerySuccess = HttpRows & { order: HttpResolvedOrder };
/** `total` is absent for an API, which reports none: a full page then means more may follow. */
/** A page's first and last rows' order values, for the step either side; `keyset` when this page was read by one. */
type HttpPageBounds = { bounds?: PageBounds; keyset?: true };
type RunRecordsSuccess = QuerySuccess &
  HttpPageBounds & {
    table: string;
    total?: number;
    exactTotal?: boolean;
    cappedTotal?: true;
    limit: number;
    offset: number;
    errors: [];
  };
type RunViewSuccess = HttpRows &
  HttpPageBounds & {
    table: string;
    view: HttpViewDefinition;
    text: string;
    total?: number;
    limit: number;
    offset: number;
    errors: [];
  };
type ViewSuccess = HttpRows & {
  view: HttpViewDefinition;
  text: string;
  total?: number;
  more: boolean;
  limit: number;
  offset: number;
  errors: [];
};
type BreakdownSuccess = HttpRows & {
  breakdown: HttpBreakdownDefinition & { limit: number };
  total?: number;
  offset: number;
  /** Each reference key's groups by the name of the record each is. */
  names?: GroupNames;
};
/** sectionFromText's copy-to-dashboard payload, not a compiled statement. */
interface HttpBreakdownSection {
  kind: 'metric' | 'breakdown' | 'chart' | 'matrix';
  table: string;
  query?: string;
  measure?: string;
  by?: string;
}
type TextBreakdown = { text: string; section: HttpBreakdownSection | null };

export type HttpAppQuerySuccess = AppProjection<QuerySuccess>;
export type HttpDbQuerySuccess = QuerySuccess & { sql: HttpSql };
export type HttpAppRunSuccess = AppProjection<RunRecordsSuccess | (RunViewSuccess & { resolved: HttpAppViewColumn[]; joinCount: number })>;
/** The query-bar view branch currently emits explain but does not emit sql. */
export type HttpDbRunSuccess =
  | (RunRecordsSuccess & { sql: HttpSql; explain: string })
  | (RunViewSuccess & { resolved: CompiledColumn[]; joins: CompiledJoin[]; explain: string; sql?: never });
export type HttpAppViewSuccess = AppProjection<ViewSuccess & { resolved: HttpAppViewColumn[]; joinCount: number }>;
export type HttpDbViewSuccess = ViewSuccess & { resolved: CompiledColumn[]; joins: CompiledJoin[]; sql: HttpSql; explain: string };
export type HttpAppBreakdownSuccess = AppProjection<
  BreakdownSuccess & { resolved: HttpAppMeasure[] } & ({ text?: never; section?: never } | TextBreakdown)
>;
export type HttpDbBreakdownSuccess = BreakdownSuccess & { resolved: CompiledMeasure[]; sql: HttpSql } & (
    | { text?: never; section?: never; explain?: never }
    | (TextBreakdown & { explain: string })
  );

export interface HttpUpdateSuccess<Token extends number | string = number> {
  affected: number;
  applied: HttpValues;
  undoId?: Token;
  errors?: never;
  outcome?: never;
}
export interface HttpInsertSuccess<Token extends number | string = number> {
  key: HttpRecordKey;
  row?: Record<string, unknown>;
  applied: HttpValues;
  undoId?: Token;
  errors?: never;
  outcome?: never;
}
interface HttpWriteFailure {
  errors: HttpDiagnostic[];
  outcome: 'rejected' | 'unknown';
  /** Scoped context failures also supply a top-level error. */
  error?: string;
  applied?: never;
  undoId?: never;
}
/** Only immediate incoming references; count -1 means its count failed. */
interface HttpDeleteImpact {
  table: string;
  columns: string[];
  constraint: string;
  onDelete?: DeleteRule;
  filter: HttpFilter;
  count: number;
  error?: string;
}
export interface HttpDeletePreview {
  impact: HttpDeleteImpact[];
  deleted: false;
  outcome?: never;
  errors?: never;
}
export interface HttpDeleteSuccess<Token extends number | string = number> {
  impact: HttpDeleteImpact[];
  deleted: true;
  affected: number;
  undoId?: Token;
  outcome?: never;
  errors?: never;
}
export type HttpDeleteFailure = Omit<HttpWriteFailure, 'outcome'> & { impact?: HttpDeleteImpact[] } & (
    | { deleted: false; outcome: 'rejected' }
    | { deleted: null; outcome: 'unknown' }
  );

/** Own public history DTO: never derive this from the private JournalEntry.
 * Existing graph/raw-SQL history can appear here; this adds no execution API. */
type HttpHistoryKind = 'update' | 'insert' | 'delete' | 'insert_graph' | 'delete_graph' | 'sql';
export interface HttpHistoryEntry<Token extends number | string = number> {
  id: Token;
  kind: HttpHistoryKind;
  at: string;
  summary: string;
  by?: string;
  revertible: boolean;
  reason?: string;
  undoState?: 'pending' | 'unknown';
  blocksUndo?: boolean;
  connection?: never;
  principal?: never;
  app?: never;
  steps?: never;
}
type HttpHistoryNext<Token extends number | string = number> = Pick<HttpHistoryEntry<Token>, 'id' | 'kind' | 'at' | 'summary'>;
type HttpHistoryUndone<Token extends number | string = number> = Pick<HttpHistoryEntry<Token>, 'id' | 'kind' | 'summary'>;
export interface HttpHistoryPreview<Token extends number | string = number> {
  reverted: false;
  writes: HttpHistoryEntry<Token>[];
  next?: HttpHistoryNext<Token>;
  outcome?: never;
}
interface HttpUndoStep {
  table: string;
  key?: Record<string, unknown>;
  action: string;
}
export interface HttpUndoSuccess<Token extends number | string = number> {
  reverted: true;
  outcome: 'applied';
  undone: HttpHistoryUndone<Token>;
  steps?: HttpUndoStep[];
  errors?: never;
}
export interface HttpUndoFailure<Token extends number | string = number> {
  reverted: false;
  outcome: 'not_applied' | 'unknown';
  undone?: HttpHistoryUndone<Token>;
  steps?: HttpUndoStep[];
  errors?: HttpDiagnostic[];
  error?: string;
}
/** Some pre-execution Undo refusals have only error/outcome, with no reverted flag. */
type UndoRequestFailure = Omit<HttpRequestFailure, 'outcome'> & {
  outcome: 'not_applied' | 'unknown';
  reverted?: false;
};

export interface ResourceHttpBodies {
  '/api/query': HttpQueryRequest;
  '/api/count': HttpCountRequest;
  '/api/run': HttpRunRequest;
  '/api/view/run': HttpViewRequest;
  '/api/breakdown': HttpBreakdownRequest;
  '/api/update': HttpUpdateRequest;
  '/api/insert': HttpInsertRequest;
  '/api/delete': HttpDeleteRequest;
  '/api/revert': HttpRevertRequest;
}
export type ResourceHttpPath = keyof ResourceHttpBodies;
export type ResourceHttpBody<Path extends ResourceHttpPath> = ResourceHttpBodies[Path];
export type ResourceHttpRequest<Path extends ResourceHttpPath, Mode extends ResourceHttpMode = ResourceHttpMode> = ResourceHttpBody<Path> &
  ResourceHttpIdentity<Mode>;

interface AppSuccesses {
  '/api/query': HttpAppQuerySuccess;
  '/api/count': AppProjection<CountResult>;
  '/api/run': HttpAppRunSuccess;
  '/api/view/run': HttpAppViewSuccess;
  '/api/breakdown': HttpAppBreakdownSuccess;
  '/api/update': AppProjection<HttpUpdateSuccess>;
  '/api/insert': AppProjection<HttpInsertSuccess>;
  '/api/delete': AppProjection<HttpDeletePreview | HttpDeleteSuccess>;
  '/api/revert': AppProjection<HttpHistoryPreview | HttpUndoSuccess>;
}
interface DbSuccesses {
  '/api/query': HttpDbQuerySuccess;
  '/api/count': CountResult;
  '/api/run': HttpDbRunSuccess;
  '/api/view/run': HttpDbViewSuccess;
  '/api/breakdown': HttpDbBreakdownSuccess;
  '/api/update': HttpUpdateSuccess & { sql: HttpSql };
  '/api/insert': HttpInsertSuccess & { sql: HttpSql };
  '/api/delete': HttpDeletePreview | (HttpDeleteSuccess & { sql: HttpSql });
  '/api/revert': HttpHistoryPreview | HttpUndoSuccess;
}
type OperationFailure<Path extends ResourceHttpPath, Mode extends ResourceHttpMode> = Path extends '/api/run'
  ? HttpReadFailure & (Mode extends 'db' ? { explain?: string } : object)
  : Path extends '/api/view/run' | '/api/breakdown'
    ? HttpReadFailure
    : Path extends '/api/update' | '/api/insert'
      ? HttpWriteFailure
      : Path extends '/api/delete'
        ? HttpDeleteFailure
        : Path extends '/api/revert'
          ? HttpUndoFailure | UndoRequestFailure
          : never;

export type ResourceHttpSuccess<Path extends ResourceHttpPath, Mode extends ResourceHttpMode = ResourceHttpMode> = Mode extends 'app'
  ? AppSuccesses[Path]
  : DbSuccesses[Path];
export type ResourceHttpFailure<Path extends ResourceHttpPath, Mode extends ResourceHttpMode = ResourceHttpMode> = Mode extends 'app'
  ? AppProjection<HttpRequestFailure | OperationFailure<Path, Mode>>
  : HttpRequestFailure | OperationFailure<Path, Mode>;
/** Includes non-2xx failures; callers that throw those still need to handle 200 failures. */
export type ResourceHttpReply<Path extends ResourceHttpPath, Mode extends ResourceHttpMode = ResourceHttpMode> =
  | ResourceHttpSuccess<Path, Mode>
  | ResourceHttpFailure<Path, Mode>;
export type ResourceHttpContract<Path extends ResourceHttpPath, Mode extends ResourceHttpMode = ResourceHttpMode> = {
  request: ResourceHttpRequest<Path, Mode>;
  success: ResourceHttpSuccess<Path, Mode>;
  failure: ResourceHttpFailure<Path, Mode>;
  reply: ResourceHttpReply<Path, Mode>;
};

/** The bundled client throws non-2xx responses but must still check 200 failures.
 * Its conn selector is translated to App identity before reaching the wire. */
type ClientPath<Path extends string> = Path extends `${infer Route}?${string}` ? Route : Path;
type ClientRoute<Path extends string> = Extract<ClientPath<Path>, ResourceHttpPath>;
/** Bundled callers can be ordinary or tenant-bound. Wire contracts above keep
 * their distinct token types; runtime selection decides which one may be sent. */
type ClientBody<Path extends ResourceHttpPath> = Path extends '/api/revert' ? HttpRevertRequest<number | string> : ResourceHttpBody<Path>;
type TenantClientSuccess<Path extends ResourceHttpPath> = Path extends '/api/update'
  ? HttpUpdateSuccess<string>
  : Path extends '/api/insert'
    ? HttpInsertSuccess<string>
    : Path extends '/api/delete'
      ? HttpDeletePreview | HttpDeleteSuccess<string>
      : Path extends '/api/revert'
        ? HttpHistoryPreview<string> | HttpUndoSuccess<string>
        : never;
export type ResourceClientArgs<Path extends string> = string extends Path
  ? never
  : [Extract<Path, `${string}#${string}`>] extends [never]
    ? // Reverse the overlap check: /api/${string} can name a resource even though
      // that whole pattern is not assignable to any one known route.
      [Extract<ResourceHttpPath, ClientPath<Path>>] extends [never]
      ? [body?: Record<string, unknown>]
      : [ClientPath<Path>] extends [ResourceHttpPath]
        ? [body: ClientBody<ClientRoute<Path>> & { conn?: string | null }]
        : never
    : never;
/** Non-resource routes retain their existing contract outside this workstream. */
export type ResourceClientReply<Path extends string> = [ResourceClientArgs<Path>] extends [never]
  ? never
  : [ClientRoute<Path>] extends [never]
    ? any
    :
        | ResourceHttpSuccess<ClientRoute<Path>>
        | TenantClientSuccess<ClientRoute<Path>>
        | OperationFailure<ClientRoute<Path>, ResourceHttpMode>
        | (ClientRoute<Path> extends '/api/revert' ? HttpUndoFailure<string> : never);
