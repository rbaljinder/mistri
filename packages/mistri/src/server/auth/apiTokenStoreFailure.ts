/** The one thing a token observation can say apart from its judgement: the
 * store itself could not answer. A token that is revoked, expired, unknown or
 * for another App is a judgement — the caller may say 401. A locked file, a
 * terminated connection, a transaction that never began or never committed is
 * not: nothing was decided about the credential, so the caller must say 503
 * with the outcome unknown instead of blaming the token.
 *
 * Fail closed, and deliberately narrow: only connecting, beginning, committing
 * and the plain lock statements raise this. Everything an observation decides —
 * a contract violation, a row that will not decode, an ineligible account —
 * stays the opaque judgement it already was, because a row that cannot be read
 * back is not distinguishable here from a row that says no. So a store that
 * fails for the first time *inside* a row read still answers 401, and only a
 * store that cannot be reached, begun or committed answers 503.
 *
 * The message carries no driver text, file path, SQL or credential, exactly
 * like the judgement it replaces.
 */
export class ApiTokenStoreUnavailable extends Error {
  constructor() {
    super('The API token store could not be read.');
    this.name = 'ApiTokenStoreUnavailable';
  }
}

/** Runs one store-touching step, so a driver or transaction failure in it is
 * reported as the store being unreachable rather than as a bad token. A
 * judgement thrown inside (already an `ApiTokenStoreUnavailable`, or any
 * refusal the observer itself decided) is passed through unchanged. */
export function throughApiTokenStore<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ApiTokenStoreUnavailable) throw error;
    throw new ApiTokenStoreUnavailable();
  }
}

/** The asynchronous counterpart, for a PostgreSQL store's awaited steps. */
export async function throughApiTokenStoreAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiTokenStoreUnavailable) throw error;
    throw new ApiTokenStoreUnavailable();
  }
}
