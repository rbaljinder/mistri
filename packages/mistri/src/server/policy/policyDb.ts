/**
 * The `db` a row policy reads through: one read-only handle per resource the
 * App declares, the same typed handle a command's `db` is (commandDb.ts),
 * over the App's own adapters. So a policy that must look a person up — their
 * seats at a dealership, the borrower row their account is linked to — asks
 * the App's pooled connection, and every statement is a span of the request
 * that asked (adapters/telemetry/drivers.ts), where a pool of the policy's
 * own was neither pooled with the App nor traced, and needed types for `pg`.
 *
 * Read-only by construction: the handles are built without a writer, and
 * the reader under them holds only `query` and `count`. It reads rows whole
 * and across every principal, because deciding who sees what is the policy's
 * job; what it returns is a row scope, which is judged like any other.
 */
import type { Filter, QueryRequest } from '@mistriwork/engine/adapters/adapter.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import { commandCatalog, zonedCatalog, createCommandDb, type ReadTable, type UntypedRow } from '../commands/commandDb.js';

/** Every declared resource, by its logical name, read-only: `db.dealer_user.where({ account_id })`. */
export type PolicyDb<Rows = unknown> = unknown extends Rows
  ? Readonly<Record<string, ReadTable<UntypedRow>>>
  : { readonly [T in keyof Rows & string]: ReadTable<Readonly<Rows[T]>> };

/** What `resolveRows` is given beside the principal. */
export interface PolicyReadContext<Rows = unknown> {
  readonly db: PolicyDb<Rows>;
}

/** The handles, over the adapters the deployment acquired: each resource read through its own source's connection.
    `zone` is the App's: a policy's `where` that says `today` means the App's day, as a command's does. */
export function createPolicyDb(resources: RuntimeResources, zone?: string): PolicyDb {
  const names = resources.schema.tables.map((table) => table.id);
  const plain = commandCatalog(resources.schema, names, (name) => name);
  const catalog = plain && zonedCatalog(plain, zone);
  if (!catalog) throw new Error("The row policy's catalog could not be built.");
  const adapter = (table: string) => resources.forConnection(resources.connectionFor(table));
  const reader = Object.freeze({
    query: (request: QueryRequest) => adapter(request.table).query(request),
    count: (table: string, filter?: Filter) => adapter(table).count(table, filter),
  });
  return createCommandDb({ tx: reader, catalog, read: names, write: [], now: () => new Date() }) as PolicyDb;
}
