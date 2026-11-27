/**
 * Shared PostgreSQL lifecycle and deterministic PRNG helpers for Mistri Jepsen workloads.
 *
 * Every workload creates its own uniquely named disposable database on the target
 * PostgreSQL server and drops it on exit, so concurrent or repeated runs never
 * collide or leave residue behind.
 */
import { randomUUID } from 'node:crypto';
import type { PgQuery } from '../../packages/engine/src/adapters/postgresPool.js';

export interface PgControlClient extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

export async function openPgClient(connectionString: string): Promise<PgControlClient> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as {
    default?: { Client: new (c: unknown) => PgControlClient };
    Client?: new (c: unknown) => PgControlClient;
  };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString });
  await created.connect();
  return created;
}

/** Create a disposable database on `adminUrl`, run `work`, and force-drop it on completion. */
export async function withIsolatedPostgresDb<T>(
  adminUrl: string,
  prefix: string,
  work: (ctx: { readonly dbUrl: string; readonly dbName: string; readonly control: PgControlClient }) => Promise<T>,
): Promise<T> {
  const dbName = `mistri_jepsen_${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = await openPgClient(adminUrl);
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = `/${dbName}`;
  const dbUrl = target.href;
  const control = await openPgClient(dbUrl);
  try {
    return await work({ dbUrl, dbName, control });
  } finally {
    await control.end().catch(() => {});
    const cleaner = await openPgClient(adminUrl);
    try {
      await cleaner.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await cleaner.end().catch(() => {});
    }
  }
}

/** Seeded Mulberry32 PRNG so chaotic workloads and nemesis schedules are reproducible by `--seed`. */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)];
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
