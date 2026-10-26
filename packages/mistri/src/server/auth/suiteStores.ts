/** A suite's grants, preferences and authority history, as their callers see
 * them whichever database keeps them. The SQLite stores answer synchronously
 * and the PostgreSQL ones asynchronously; every caller awaits, so one shape
 * serves both, and the SQLite store is passed as it is. */
import type { openSuiteGrantStore } from './suiteGrantStore.js';
import type { openSuitePreferencesStore } from './suitePreferences.js';
import type { openSuiteAuthorityStore } from './suiteAuthority.js';

/** Each method's answer now or later. */
type Answering<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Awaited<R> | Promise<Awaited<R>> : T[K];
};
/** Each method's answer later: what a PostgreSQL store implements. */
export type Asynchronous<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : T[K];
};

export type SuiteGrants = Answering<ReturnType<typeof openSuiteGrantStore>>;
export type SuitePreferences = Answering<ReturnType<typeof openSuitePreferencesStore>>;
export type SuiteAuthority = Answering<ReturnType<typeof openSuiteAuthorityStore>>;
