/** Borrowed native transaction observation only; no support admission or sink. */
import { DatabaseSync } from 'node:sqlite';
import { isProxy } from 'node:util/types';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { assertSqliteTenantStore } from './tenantStore.js';
import { binding, TENANT_TABLES, type TenantStoreBinding } from './tenantStoreContract.js';
import {
  captureSupportLookup,
  supportMembershipObservation,
  supportParentLocator,
  type SupportMembershipLookup,
  type SupportMembershipObservation,
} from './tenantSupportMembership.js';

/* A structural object could answer `isTransaction: true` and fabricate every
   row, so only a genuine native handle may state its own transaction. A native
   method refuses any other receiver, and on a genuine handle `isTransaction` is
   a non-configurable accessor fixed at construction, which no caller can
   redefine. An own property named like a native method would shadow the one
   the store attestor and the reads below resolve through the prototype. */
const nativeMethods = Reflect.ownKeys(DatabaseSync.prototype);
function nativeTransaction(db: unknown): boolean {
  if (
    !db ||
    typeof db !== 'object' ||
    isProxy(db) ||
    Object.getPrototypeOf(db) !== DatabaseSync.prototype ||
    nativeMethods.some((key) => Object.hasOwn(db, key))
  )
    return denyTenant();
  Reflect.apply(DatabaseSync.prototype.location, db, []);
  const state = Object.getOwnPropertyDescriptor(db, 'isTransaction');
  if (!state?.get || state.configurable) return denyTenant();
  return Reflect.apply(state.get, db, []) === true;
}

/** Caller owns a genuine native handle and its transaction. This function
 * checks the transaction is open, not whether BEGIN was IMMEDIATE. A future
 * writer owner must establish its own write reservation; no lease is issued. */
export function observeSqliteSupportMembership(
  db: DatabaseSync,
  input: TenantStoreBinding,
  requested: SupportMembershipLookup,
): SupportMembershipObservation {
  try {
    const owner = binding(input),
      lookup = captureSupportLookup(requested);
    if (!nativeTransaction(db)) return denyTenant();
    assertSqliteTenantStore(db, owner);
    const member = (id: string) => db.prepare(`SELECT * FROM main."${TENANT_TABLES.membership}" WHERE id=? COLLATE BINARY`).get(id);
    const tenant = (id: string) =>
      db.prepare(`SELECT id,status,version,kind FROM main."${TENANT_TABLES.tenant}" WHERE id=? COLLATE BINARY`).get(id);
    const support = member(lookup.supportId),
      parentId = supportParentLocator(support, lookup);
    const observation = supportMembershipObservation(
      owner,
      lookup,
      support,
      member(parentId),
      tenant('@platform'),
      tenant(lookup.tenantId),
      parentId,
    );
    if (!nativeTransaction(db)) return denyTenant();
    return observation;
  } catch {
    return denyTenant();
  }
}
