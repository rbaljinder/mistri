/** Resource/view read planning without SQL, principal authority or cursor trust. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema, Order } from '@mistriwork/engine/shared/schema.js';
import { parseApiStandingQuery } from './apiStandingQuery.js';
import { withDeclaredSegments } from '../../shared/appSegments.js';
import { mentionsMe } from '../../shared/appMe.js';
import { expandSegments } from '@mistriwork/engine/shared/query.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { parseApiListParams } from './apiListParams.js';
import { resolveApiListOrder } from './apiListOrder.js';
import { createApiReadRowCodec } from './apiReadRowCodec.js';
import { createApiReadEnvelopeCodec } from './apiReadEnvelope.js';
import { createApiReadKeyCodec } from './apiReadKey.js';
import { createApiReadBoundaryCodec } from './apiReadBoundary.js';
import { validateApiFilters } from './apiTypedFilters.js';
import { appZone, zonedNow } from '../../shared/appZone.js';

/* The request's instant as the App's wall clock, which a date phrase is read by (zonedNow): the API's `today` is
   the day its lists show, not the server's. An API token has no reader, so the zone is the App's own. The plan
   keeps the instant itself for the cursor it binds. */
const appClock = (app: AppDef, now: Date) => zonedNow(appZone(app.ui), now);

/** A tenant App's API reads from its tenant catalog (apiTenantReadCatalog),
 * which trusted composition supplies; every other App's is checked here. */
type Catalog = ReturnType<typeof checkApiReadCatalog>;

export function planApiReadRequest(
  app: AppDef,
  schema: DatabaseSchema,
  operationId: string,
  rawQuery: string,
  options: { integers: 'decimal-string' | 'number' },
  given?: Catalog,
  /** The request's clock, for a segment that says `today`. */
  now: Date = new Date(),
) {
  if (!app.api) throw new Error('API read request requires explicit exposure.');
  const catalog = given ?? checkApiReadCatalog(app.api, app, schema);
  const operation = catalog.operations.find((operation) => operation.id === operationId);
  if (!operation || operation.kind !== 'list') throw new Error('API read request supports exposed resource lists only.');
  const parsed = parseApiListParams(rawQuery, operation);
  const plan = { ...listPlan(operation, schema, parsed, options), stage: 'resource-read-request-plan' as const };
  /* A segment narrows as a view's standing question does: ANDed with every refinement, never replaced by one. */
  const declared = parsed.segment === undefined ? undefined : withDeclaredSegments(app, schema);
  /* Never one about `me`, whatever catalog offered it: the API reads no person, and an unread `me` is a word. */
  if (
    parsed.segment !== undefined &&
    mentionsMe(expandSegments(parsed.segment, declared!.tables.find((table) => table.id === operation.resource)?.segments).text)
  )
    throw new Error('API list parameters: segment is not one this list offers.');
  const question =
    parsed.segment === undefined ? undefined : parseApiStandingQuery(declared!, operation.resource, parsed.segment, appClock(app, now));
  if (question && (question.errors.length || question.columns.length || question.limit !== undefined || question.orderBy.length))
    throw new Error('API segment is unsupported.');
  return Object.freeze({
    ...plan,
    ...(question ? { segment: parsed.segment!, standingFilter: snapshot(question.filter, 16384).value } : {}),
  });
}

function listPlan(
  operation: ReturnType<typeof checkApiReadCatalog>['operations'][number],
  schema: DatabaseSchema,
  parsed: ReturnType<typeof parseApiListParams>,
  options: { integers: 'decimal-string' | 'number' },
  standingOrder?: readonly Order[],
) {
  const filters = validateApiFilters(parsed.filters, operation, schema, options);
  const table = schema.tables.find((table) => table.id === operation.resource)!;
  // Order may need a column omitted by fields=. Retain it only in the fetch
  // projection; the response encoder must still omit it. This is an exposed
  // ordering dependency, never a reason to fetch an undeclared field.
  const order = resolveApiListOrder(table, operation, parsed.order, standingOrder);
  const responseFields = Object.freeze([...parsed.fields]);
  const needed = new Set([...responseFields, ...order.order.map((item) => item.column)]);
  const fetchFields = Object.freeze(operation.fields.filter((field) => needed.has(field)));
  // Validate even the full exposure, so narrowing fields cannot make an
  // unsupported wire type appear to be a publishable operation.
  createApiReadRowCodec(operation, schema, options);
  const response = createApiReadRowCodec({ ...operation, fields: responseFields }, schema, options);
  const envelope = createApiReadEnvelopeCodec({ ...operation, fields: responseFields }, schema, {
    integers: options.integers,
    limit: parsed.limit,
    countRequested: parsed.count,
  });
  return Object.freeze({
    authorization: 'pending' as const,
    execution: 'pending' as const,
    cursorVerification: 'pending' as const,
    collationValidation: 'pending' as const,
    operationId: operation.id,
    resource: operation.resource,
    limit: parsed.limit,
    count: parsed.count,
    responseFields,
    fetchFields,
    filters: filters.predicates,
    order: order.order,
    response,
    envelope,
    boundary: createApiReadBoundaryCodec(operation, schema, order.order, options),
    ...(parsed.cursor === undefined ? {} : { unverifiedCursor: parsed.cursor }),
  });
}

/** Evaluate relative dates once using an explicit request clock. Standing
 * constraints remain mandatory alongside refinements, not replaced by them. */
export function planApiViewReadRequest(
  app: AppDef,
  schema: DatabaseSchema,
  operationId: string,
  rawQuery: string,
  options: { integers: 'decimal-string' | 'number' },
  now: Date,
  given?: Catalog,
) {
  if (!app.api) throw new Error('API read request requires explicit exposure.');
  const operation = (given ?? checkApiReadCatalog(app.api, app, schema)).operations.find((operation) => operation.id === operationId);
  if (!operation || operation.kind !== 'view' || !operation.standing) throw new Error('API view request requires an exposed list view.');
  const time = Date.prototype.getTime.call(now);
  if (!Number.isFinite(time)) throw new Error('API view request requires a valid explicit clock.');
  const standing = operation.standing;
  const parsed = parseApiListParams(rawQuery, { ...operation, tabs: standing.tabs.map((tab) => tab.id) });
  const tab = parsed.segment ?? standing.defaultTab;
  const selected = tab === null ? standing : standing.tabs.find((candidate) => candidate.id === tab)!;
  const question = parseApiStandingQuery(
    withDeclaredSegments(app, schema),
    operation.resource,
    selected.query,
    appClock(app, new Date(time)),
  );
  if (question.errors.length || question.columns.length || question.limit !== undefined)
    throw new Error('API standing view question is unsupported.');
  const plan = listPlan(
    operation,
    schema,
    parsed,
    options,
    selected.order.map((order) => ({ column: order.path, direction: order.direction })),
  );
  return Object.freeze({
    ...plan,
    stage: 'view-read-request-plan' as const,
    evaluatedAt: new Date(time).toISOString(),
    tab,
    filterComposition: 'standing-and-refinements' as const,
    standingFilter: snapshot(question.filter, 16384).value,
  });
}

/** Raw key is one still-encoded path segment, never router-decoded text.
 * Resolving a well-formed key does not establish record existence or access. */
export function planApiItemReadRequest(
  app: AppDef,
  schema: DatabaseSchema,
  operationId: string,
  rawKey: string,
  options: { integers: 'decimal-string' | 'number' },
  given?: Catalog,
) {
  if (!app.api) throw new Error('API read request requires explicit exposure.');
  const operation = (given ?? checkApiReadCatalog(app.api, app, schema)).operations.find((operation) => operation.id === operationId);
  if (!operation || operation.kind !== 'item') throw new Error('API item request supports exposed item operations only.');
  const key = createApiReadKeyCodec(operation, schema, options).decode(rawKey);
  const response = createApiReadRowCodec(operation, schema, options);
  return Object.freeze({
    stage: 'item-read-request-plan' as const,
    authorization: 'pending' as const,
    execution: 'pending' as const,
    operationId: operation.id,
    resource: operation.resource,
    key,
    responseFields: operation.fields,
    response,
  });
}
