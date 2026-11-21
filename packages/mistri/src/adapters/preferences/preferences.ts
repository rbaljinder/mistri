/**
 * An App's per-person preferences, the engine-neutral half of their store: one row per person, scope and key, its
 * value a short text and a revision that moves with every change. Generic on purpose: the first key is the App-wide
 * pick (`choose.<name>`, appPreferences.ts), and a later per-person setting lands here without a layout of its own.
 *
 * Kept in reserved `__mistri_preference_*` tables beside the App's records, provisioned once by maintenance and
 * attested when it is opened. Unlike a store an App declares and cannot serve without, a database that holds none is
 * not refused: the picks stay in the browser, as they did before the store existed. `scope` is the tenant of a tenant
 * App and '' elsewhere, so a person's pick in one tenant is never read in another.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';

export const PREFERENCES_VERSION = 1;
export const PREFERENCES_PREFIX = '__mistri_preference_';
export const PREFERENCES_TABLES = Object.freeze({
  meta: `${PREFERENCES_PREFIX}meta`,
  value: `${PREFERENCES_PREFIX}value`,
});

/** Bounds, the same on every engine: a key and its value are words, never a document. */
export const PREFERENCES_LIMITS = Object.freeze({
  app: 128,
  subject: 1024,
  scope: 128,
  key: 128,
  value: 128,
});

export class PreferencesUnavailable extends Refusal {
  constructor(message = 'The preferences store is unavailable or not this version.') {
    super(message);
    this.name = 'PreferencesUnavailable';
  }
}

/** Whose preferences: the App, the signed-in account, and the tenant ('' outside a tenant App). */
interface PreferenceOwner {
  readonly app: string;
  readonly subject: string;
  readonly scope: string;
}

export type Row = Record<string, unknown>;
export interface Db {
  all(sql: string, ...params: unknown[]): Promise<Row[]>;
  run(sql: string, ...params: unknown[]): Promise<number>;
}
/** One transaction over an attested store; the engine's file says what that means. */
export type Transaction = <T>(work: (db: Db) => Promise<T>) => Promise<T>;

export interface PreferencesStore {
  /** Every key this person holds in this scope, by key. */
  read(owner: PreferenceOwner): Promise<Record<string, string>>;
  /** One key set, or cleared (null); the revision it is now at. Clearing a key never held changes nothing. */
  set(owner: PreferenceOwner, key: string, value: string | null): Promise<number>;
  close(): Promise<void>;
}

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const KEY = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function text(value: unknown, limit: number, what: string, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value) || bytes(value) > limit || /[\p{Cc}\p{Cs}]/u.test(value))
    throw new Refusal(`Preferences: ${what} is not valid.`);
}

function assertOwner(owner: unknown): asserts owner is PreferenceOwner {
  const value = owner as PreferenceOwner;
  if (!value || typeof value !== 'object') throw new Refusal('Preferences: a person is named by App, account and scope.');
  text(value.app, PREFERENCES_LIMITS.app, 'the App');
  text(value.subject, PREFERENCES_LIMITS.subject, 'the account');
  text(value.scope, PREFERENCES_LIMITS.scope, 'the scope', true);
}

function assertKey(key: unknown): asserts key is string {
  text(key, PREFERENCES_LIMITS.key, 'the key');
  if (!KEY.test(key)) throw new Refusal('Preferences: the key is not valid.');
}

/** The store over a driver: the SQL is the same on every engine, `t` qualifying a table. */
export function createPreferencesStore(
  transaction: Transaction,
  t: (name: string) => string,
  close: () => Promise<void>,
): PreferencesStore {
  const { value } = PREFERENCES_TABLES;
  return {
    async read(owner) {
      assertOwner(owner);
      const rows = await transaction((db) =>
        db.all(
          `SELECT pref_key, pref_value FROM ${t(value)} WHERE app = ? AND subject_id = ? AND scope = ?`,
          owner.app,
          owner.subject,
          owner.scope,
        ),
      );
      return Object.fromEntries(rows.map((row) => [String(row.pref_key), String(row.pref_value)]));
    },
    async set(owner, key, next) {
      assertOwner(owner);
      assertKey(key);
      if (next !== null) text(next, PREFERENCES_LIMITS.value, 'the value');
      return transaction(async (db) => {
        const held = await db.all(
          `SELECT revision FROM ${t(value)} WHERE app = ? AND subject_id = ? AND scope = ? AND pref_key = ?`,
          owner.app,
          owner.subject,
          owner.scope,
          key,
        );
        const revision = held.length ? Number(held[0].revision) : 0;
        if (next === null) {
          if (held.length)
            await db.run(
              `DELETE FROM ${t(value)} WHERE app = ? AND subject_id = ? AND scope = ? AND pref_key = ?`,
              owner.app,
              owner.subject,
              owner.scope,
              key,
            );
          return revision;
        }
        if (held.length)
          await db.run(
            `UPDATE ${t(value)} SET pref_value = ?, revision = ? WHERE app = ? AND subject_id = ? AND scope = ? AND pref_key = ?`,
            next,
            revision + 1,
            owner.app,
            owner.subject,
            owner.scope,
            key,
          );
        else
          await db.run(
            `INSERT INTO ${t(value)} (app, subject_id, scope, pref_key, pref_value, revision) VALUES (?, ?, ?, ?, ?, 1)`,
            owner.app,
            owner.subject,
            owner.scope,
            key,
            next,
          );
        return revision + 1;
      });
    },
    close,
  };
}
