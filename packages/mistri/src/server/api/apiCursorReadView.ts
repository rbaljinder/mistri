/** Cursor-authenticated predicate planning, not bearer/host authorization or
 * execution. Trusted context must be recomputed by the serving owner. */
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { planApiReadRequest, planApiViewReadRequest } from './apiReadRequest.js';
import { createApiReadView } from './apiReadView.js';
import { createApiReadCursorCodec } from './apiReadCursor.js';
import { composeApiReadContinuation } from './apiReadContinuation.js';
import { apiDialectOf, apiValueCodec, apiIntegerRepresentation } from './apiValueCodec.js';

interface Context {
  secret: Uint8Array;
  scopeFingerprint: string;
  deploymentId: string;
  catalogId: string;
  ttlMs: number;
}
const refuse = (): never => {
  throw new Error('API cursor read planning is unavailable.');
};
const fingerprint = (value: unknown) => createHash('sha256').update(snapshot(value, 1048576).json).digest('hex');
/* The catalog's identity, streamed into the hash rather than written out first. An App of a few
   hundred tables and their columns is past the 1 MiB and 10,000 nodes a snapshot of untrusted input is held to, and
   every paged read was refused for it. Only already-captured catalog data reaches this (captureTenantData bounds it,
   at 262,144 nodes); it is the same canonical spelling — UTF-16 sorted keys, JSON numbers — and an undefined member
   is left out as JSON leaves it out. Do not discard schema names or annotations. */
function catalogFingerprint(value: unknown) {
  const hash = createHash('sha256');
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') hash.update(JSON.stringify(item));
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) refuse();
      hash.update(JSON.stringify(Object.is(item, -0) ? 0 : item));
    } else if (Array.isArray(item)) {
      hash.update('[');
      item.forEach((member, index) => {
        if (index) hash.update(',');
        if (member === undefined) refuse();
        visit(member);
      });
      hash.update(']');
    } else if (item && typeof item === 'object') {
      hash.update('{');
      let first = true;
      for (const key of Object.keys(item).sort()) {
        const member = (item as Record<string, unknown>)[key];
        if (member === undefined) continue;
        hash.update(`${first ? '' : ','}${JSON.stringify(key)}:`);
        first = false;
        visit(member);
      }
      hash.update('}');
    } else refuse();
  };
  visit(value);
  return hash.digest('hex');
}

export function createApiCursorReadView(
  app: AppDef,
  schema: DatabaseSchema,
  request: { operationId: string; query: string },
  options: { integers: 'decimal-string' | 'number' },
  context: Context,
  now: Date,
  /** A tenant App's catalog, from trusted composition; otherwise checked here. */
  given?: ReturnType<typeof checkApiReadCatalog>,
) {
  try {
    const capturedApp = captureTenantData(app),
      capturedSchema = captureTenantData(schema);
    const raw = snapshot(request, 32768).value as unknown as { operationId: string; query: string };
    if (
      !raw ||
      typeof raw !== 'object' ||
      Object.keys(raw).sort().join(',') !== 'operationId,query' ||
      typeof raw.operationId !== 'string' ||
      typeof raw.query !== 'string'
    )
      return refuse();
    if (!context || typeof context !== 'object' || isProxy(context)) return refuse();
    const descriptors = Object.getOwnPropertyDescriptors(context);
    const keys = ['secret', 'scopeFingerprint', 'deploymentId', 'catalogId', 'ttlMs'];
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      keys.some((key) => !descriptors[key] || !('value' in descriptors[key]) || !descriptors[key].enumerable)
    )
      return refuse();
    const metadata = snapshot(Object.fromEntries(keys.filter((key) => key !== 'secret').map((key) => [key, descriptors[key].value])), 4096)
      .value as unknown as Omit<Context, 'secret'>;
    for (const value of [metadata.scopeFingerprint, metadata.deploymentId, metadata.catalogId]) {
      if (typeof value !== 'string' || !value || value.trim() !== value || /[\p{Cc}\p{Cs}]/u.test(value) || Buffer.byteLength(value) > 256)
        return refuse();
    }
    const instant = Date.prototype.getTime.call(now),
      expiresAt = instant + metadata.ttlMs;
    if (
      !Number.isSafeInteger(instant) ||
      instant < 0 ||
      !Number.isSafeInteger(metadata.ttlMs) ||
      metadata.ttlMs <= 0 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt > 8640000000000000
    )
      return refuse();
    const integers = apiIntegerRepresentation(options),
      policy = { integers } as const;
    const catalog = given ? captureTenantData(given) : checkApiReadCatalog(capturedApp.api!, capturedApp, capturedSchema);
    const operation = catalog.operations.find((operation) => operation.id === raw.operationId);
    if (!operation || operation.kind === 'item') return refuse();
    // Parse the ORIGINAL request first, including duplicate/encoded cursor
    // spellings. Only a successful strict parse permits removing that member.
    const plan =
      operation.kind === 'view'
        ? planApiViewReadRequest(capturedApp, capturedSchema, raw.operationId, raw.query, policy, new Date(instant), catalog)
        : planApiReadRequest(capturedApp, capturedSchema, raw.operationId, raw.query, policy, catalog, new Date(instant));
    const table = capturedSchema.tables.find((table) => table.id === operation.resource)!;
    for (const order of plan.order) {
      const column = table.columns.find((column) => column.name === order.column)!;
      // Text is ordered and compared by bytes on both sides (apiReadView,
      // apiReadBoundary). Dates stay refused: their wire form is not the
      // stored value on every engine, so the boundary could not be exact.
      if (!['integer', 'number', 'boolean', 'text'].includes(apiValueCodec(column, apiDialectOf(capturedSchema, table.id), integers).kind))
        return refuse();
    }
    const query = (raw.query.startsWith('?') ? raw.query.slice(1) : raw.query)
      .split('&')
      .filter((part) => part && decodeURIComponent(part.slice(0, part.indexOf('=')).replace(/\+/g, ' ')) !== 'cursor')
      .join('&');
    const baseline = createApiReadView(
      capturedApp,
      capturedSchema,
      { operationId: raw.operationId, query },
      policy,
      new Date(instant),
      catalog,
    );
    const actualCatalog = catalogFingerprint({
      appId: capturedApp.id,
      api: capturedApp.api,
      resources: capturedApp.resources,
      operations: catalog.operations,
      // Introspection timestamp and approximate counts are not schema identity.
      // The engine that reads this operation's table; on several connections each table names its own.
      schema: {
        dialect: apiDialectOf(capturedSchema, operation.resource),
        foreignKeys: capturedSchema.foreignKeys,
        tables: capturedSchema.tables.map((table) => ({
          id: table.id,
          name: table.name,
          schema: table.schema,
          isView: table.isView,
          columns: table.columns,
          ...(table.sourceDialect === undefined ? {} : { sourceDialect: table.sourceDialect }),
        })),
      },
    });
    const binding = {
      appId: capturedApp.id,
      apiVersion: capturedApp.api!.version,
      operationId: operation.id,
      integers,
      scopeFingerprint: fingerprint({ ...metadata, actualCatalog }),
      queryFingerprint: fingerprint({
        resource: plan.resource,
        filters: plan.filters,
        fields: plan.responseFields,
        limit: plan.limit,
        count: plan.count,
        ...(plan.stage === 'view-read-request-plan' ? { tab: plan.tab, standingFilter: plan.standingFilter } : {}),
        // A page of one segment never continues another's.
        ...(plan.stage === 'resource-read-request-plan' && plan.segment !== undefined
          ? { segment: plan.segment, standingFilter: plan.standingFilter }
          : {}),
      }),
      orderFingerprint: fingerprint(plan.order),
    };
    const cursor = createApiReadCursorCodec(descriptors.secret.value, operation, capturedSchema, plan.order, policy);
    const continued =
      plan.unverifiedCursor === undefined
        ? undefined
        : composeApiReadContinuation(baseline.view, plan.boundary.after(cursor.open(plan.unverifiedCursor, binding, instant).boundary));
    return Object.freeze({
      stage: 'cursor-read-view' as const,
      authorization: 'pending' as const,
      execution: 'pending' as const,
      cursorVerification: 'authenticated-data-only' as const,
      collationValidation: 'binary-text' as const,
      rows: continued?.rows ?? baseline.view,
      count: continued?.count ?? baseline.view,
      plan,
      /** Owner supplies the actual last RETURNED materialized row, never the
       * lookahead row. TTL starts at the captured request instant; owner must
       * independently enforce current token expiry and row origin. */
      sealNext(lastReturnedRow: unknown): string {
        try {
          return cursor.seal(binding, plan.boundary.encode(lastReturnedRow), instant, expiresAt);
        } catch {
          return refuse();
        }
      },
    });
  } catch {
    return refuse();
  }
}
