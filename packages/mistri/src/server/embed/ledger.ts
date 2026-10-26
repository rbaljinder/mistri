/**
 * The assertions already spent, kept in the App's auth store so every
 * instance that shares the store refuses a replay, whatever cache the
 * deployment has or has not named.
 *
 * A row of Better Auth's own `verification` table, the store's table of
 * single-use values with an expiry: the row's id is the issuer and `jti`,
 * hashed, so the insert itself is the spend — a second instance inserting the
 * same id fails on the primary key, in SQLite and PostgreSQL alike, and that
 * failure is the replay. No new table, so the store's attested layout is
 * unchanged. Rows past their expiry are swept at most once a minute per
 * process, and one still lying there when its `jti` comes back after expiry
 * is cleared and spent anew.
 */
import { createHash } from 'node:crypto';

/** The rows this ledger owns in `verification`, and the only ones it sweeps. */
export const SPENT_ASSERTION = 'mistri-embed-assertion';
const SWEEP_EVERY_MS = 60_000;

/** The part of Better Auth's adapter (`(await auth.$context).adapter`) the ledger uses. */
export interface LedgerAdapter {
  create(input: { model: string; data: Record<string, unknown>; forceAllowId?: boolean }): Promise<unknown>;
  findOne<T>(input: { model: string; where: { field: string; value: unknown; operator?: string }[] }): Promise<T | null>;
  delete(input: { model: string; where: { field: string; value: unknown; operator?: string }[] }): Promise<void>;
  deleteMany(input: { model: string; where: { field: string; value: unknown; operator?: string }[] }): Promise<number>;
}

const rowId = (issuer: string, jti: string) => `embed-${createHash('sha256').update(`${issuer}\0${jti}`).digest('base64url')}`;
const time = (value: unknown) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value)));

export function assertionLedger(adapter: () => Promise<LedgerAdapter>, now: () => number = Date.now) {
  let swept = 0;
  const sweep = async (db: LedgerAdapter) => {
    if (now() - swept < SWEEP_EVERY_MS) return;
    swept = now();
    await db.deleteMany({
      model: 'verification',
      where: [
        { field: 'identifier', value: SPENT_ASSERTION },
        { field: 'expiresAt', value: new Date(now()), operator: 'lt' },
      ],
    });
  };
  const insert = (db: LedgerAdapter, id: string, issuer: string, until: number) =>
    db.create({
      model: 'verification',
      data: {
        id,
        identifier: SPENT_ASSERTION,
        value: issuer,
        expiresAt: new Date(until),
        createdAt: new Date(now()),
        updatedAt: new Date(now()),
      },
      forceAllowId: true,
    });

  return {
    /** True the first time `jti` from `issuer` is spent, false for a replay; throws when the store cannot say. */
    async spend(issuer: string, jti: string, until: number): Promise<boolean> {
      const db = await adapter();
      await sweep(db).catch(() => {});
      const id = rowId(issuer, jti);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await insert(db, id, issuer, until);
          return true;
        } catch (error) {
          const held = await db.findOne<{ expiresAt: unknown }>({ model: 'verification', where: [{ field: 'id', value: id }] });
          if (!held) throw error;
          if (time(held.expiresAt) > now()) return false;
          // Expired and not yet swept: its assertion could not be spent any more, so the id is free again.
          await db.delete({ model: 'verification', where: [{ field: 'id', value: id }] });
        }
      }
      return false;
    },
  };
}
