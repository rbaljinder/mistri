/**
 * One suite App's Governance room, assembled from what the suite already
 * holds: the App's journal reader, the authority it was started with, its
 * address book for record links, and — when the suite owns sign-in — the
 * grant ledger, the accounts' emails and the history of what each start granted.
 */
import { recordSegments, type AddressBook } from '../../shared/appAddress.js';
import { authorityReport } from '../../shared/appAuthority.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { LoadedApp } from '../app/apps.js';
import { nativeAccountEmailOf, nativeMailAccount } from '../auth/authAccounts.js';
import type { AppAuthRuntime } from '../auth/auth.js';
import { suiteAppRoles } from '../auth/suiteAppRoles.js';
import type { SuiteAuthority, SuiteGrants } from '../auth/suiteStores.js';
import type { ConsoleGovernance } from './governance.js';

export function suiteGovernance(input: {
  app: LoadedApp;
  book: AddressBook;
  /** The book of a person holding these roles (apps.ts appRoutes): a record link is the address they are served. */
  bookFor?: (roles: readonly string[]) => AddressBook;
  tables: readonly TableMeta[];
  /** Where the App is served: a record link is under it. */
  basePath: string;
  startedAt: number;
  audit: NonNullable<ConsoleGovernance['audit']>;
  identity?: {
    native: AppAuthRuntime;
    grants: SuiteGrants;
    authority: SuiteAuthority;
    basePath: string;
  };
}): ConsoleGovernance {
  const { app, book, identity } = input;
  const appId = app.app.id;
  // Read once: the server does not start an App whose authority differs from its lock, and a reload that would change it closes the App.
  const report = app.authority?.report ?? authorityReport(app.app),
    locked = app.authority?.lock !== undefined;
  /* Each start records what it serves, so the room can say what changed since the one before. A history that
     cannot be written does not stop the App: the room then sees only this start. */
  /* Awaited before the history is read, since a PostgreSQL store records asynchronously; the SQLite one has
     recorded by the time this returns, as before. */
  const recorded = identity
    ? (async () => {
        try {
          await identity.authority.record(appId, report, input.startedAt);
        } catch {
          /* the authority view says it sees only this start */
        }
      })()
    : undefined;
  const tableOf = (resource: string) =>
    [resource, app.app.resources?.[resource]?.physical].find((id) => id !== undefined && book.records.has(id)) ??
    input.tables.find((table) => table.name === resource && book.records.has(table.id))?.id;
  /* One book per role set, as the browser holds one per payload: the room links many records for one reader. */
  const books = new Map<string, AddressBook>();
  const booked = (roles: readonly string[]) => {
    const key = [...new Set(roles)].sort().join(',');
    let held = books.get(key);
    if (!held) books.set(key, (held = input.bookFor!(roles)));
    return held;
  };
  return Object.freeze({
    audit: input.audit,
    authority: () => ({ report, locked, startedAt: input.startedAt }),
    recordHref: (resource: string, key: unknown, roles?: readonly string[]) => {
      const table = tableOf(resource);
      if (!table || !key || typeof key !== 'object' || Array.isArray(key)) return undefined;
      if (Object.values(key).some((value) => value !== null && typeof value === 'object')) return undefined;
      const segments = recordSegments(roles && input.bookFor ? booked(roles) : book, table, { key: key as Record<string, unknown> });
      return segments ? `${input.basePath}/${segments.join('/')}` : undefined;
    },
    ...(identity
      ? {
          access: async (accountId: string) =>
            identity.grants.listAccess(
              { appId, actorId: accountId, declaredRoles: suiteAppRoles(app.app) },
              { administratorRevision: (await identity.grants.read(accountId, appId)).revision },
            ),
          accessAudit: async (accountId: string, query: Parameters<NonNullable<ConsoleGovernance['accessAudit']>>[1]) =>
            identity.grants.listAccessChanges(
              { appId, actorId: accountId, declaredRoles: suiteAppRoles(app.app) },
              { administratorRevision: (await identity.grants.read(accountId, appId)).revision },
              query,
            ),
          email: (accountId: string) => nativeAccountEmailOf(identity.native, accountId),
          accountOf: async (email: string) => (await nativeMailAccount(identity.native, email))?.id ?? null,
          previousAuthority: async () => {
            await recorded;
            return identity.authority.previous(appId);
          },
          manageHref: `${identity.basePath}/_mistri/apps#manage=${encodeURIComponent(appId)}`,
        }
      : {}),
  });
}
