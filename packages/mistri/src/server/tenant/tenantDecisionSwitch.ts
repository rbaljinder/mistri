/**
 * Each tenant's decision switches (one per model provider), their records at
 * closure and their usage, as tenant administration reads and writes them:
 * inside the administration owner's own transaction
 * (tenantAdministration.ts), on the tenant source that holds the decision
 * store beside its records. The switch is the platform owner's; nothing here
 * decides who may set it.
 *
 * An App that declares decisions may run without the store (nothing was
 * provisioned): the switches then read as absent, a write refuses, and
 * closing a tenant has no record to forget.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { DECISION_TABLES } from '../../adapters/decide/decisionStore.js';
import { DECIDE_FEATURES, decideFeature, providerOf, TENANT_SWITCH_TABLES } from '../../adapters/switch/tenantSwitch.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { AdministrationDecisionSwitch, AdministrationDecisionUsageRow } from '../../shared/tenantAdministration.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

export interface DecisionSwitchStore {
  /** One switch per named provider, in the order given (off and unconsented when never set), or null when the database holds no decision store. */
  read(tenantId: string, providers: readonly string[]): Promise<AdministrationDecisionSwitch[] | null>;
  put(tenantId: string, value: AdministrationDecisionSwitch, at: string): Promise<void>;
  /** A closed tenant's decision records and its switches. Its usage stays: it is the bill. */
  forget(tenantId: string): Promise<void>;
  /** The named tenants' decision usage by tenant and day from `since`, newest day first, at most `limit` rows. */
  usage(tenants: readonly string[], since: string, limit: number): Promise<AdministrationDecisionUsageRow[]>;
}

const { record, usage } = DECISION_TABLES;
const switches = TENANT_SWITCH_TABLES.tenant;
const switchesOf = (found: Record<string, unknown>[], providers: readonly string[]): AdministrationDecisionSwitch[] => {
  const stored = new Map<string, AdministrationDecisionSwitch>();
  for (const row of found) {
    const enabled = Number(row.enabled);
    if (
      typeof row.feature !== 'string' ||
      !row.feature.startsWith('decide:') ||
      (enabled !== 0 && enabled !== 1) ||
      typeof row.consent !== 'string'
    )
      return denyTenant();
    const provider = providerOf(row.feature);
    stored.set(provider, {
      provider,
      enabled: enabled === 1,
      consent: row.consent,
    });
  }
  return providers.map((provider) => stored.get(provider) ?? { provider, enabled: false, consent: '' });
};
const rows = (found: Record<string, unknown>[]): AdministrationDecisionUsageRow[] =>
  found.map((row) => {
    const calls = Number(row.calls);
    const units = Number(row.units);
    const costMicros = Number(row.costMicros);
    if (
      typeof row.tenantId !== 'string' ||
      typeof row.day !== 'string' ||
      !Number.isSafeInteger(calls) ||
      !Number.isSafeInteger(units) ||
      !Number.isSafeInteger(costMicros)
    )
      return denyTenant();
    return { tenantId: row.tenantId, day: row.day, calls, units, costMicros };
  });

export function sqliteDecisionSwitch(db: DatabaseSync, app: string): DecisionSwitchStore {
  const present = () => !!db.prepare(`SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? COLLATE BINARY`).get(record);
  return {
    async read(tenantId, providers) {
      if (!present()) return null;
      return switchesOf(
        db
          .prepare(
            `SELECT feature, enabled, consent FROM main."${switches}" WHERE app = ? COLLATE BINARY AND tenant = ? COLLATE BINARY AND feature LIKE ?`,
          )
          .all(app, tenantId, DECIDE_FEATURES) as Record<string, unknown>[],
        providers,
      );
    },
    async put(tenantId, value, at) {
      if (!present()) return denyTenant();
      db.prepare(
        `INSERT INTO main."${switches}" (app, tenant, feature, enabled, consent, changed_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (app, tenant, feature) DO UPDATE SET enabled = excluded.enabled, consent = excluded.consent, changed_at = excluded.changed_at`,
      ).run(app, tenantId, decideFeature(value.provider), value.enabled ? 1 : 0, value.consent, at);
    },
    async forget(tenantId) {
      if (!present()) return;
      db.prepare(`DELETE FROM main."${record}" WHERE app = ? COLLATE BINARY AND tenant = ? COLLATE BINARY`).run(app, tenantId);
      db.prepare(`DELETE FROM main."${switches}" WHERE app = ? COLLATE BINARY AND tenant = ? COLLATE BINARY AND feature LIKE ?`).run(
        app,
        tenantId,
        DECIDE_FEATURES,
      );
    },
    async usage(tenants, since, limit) {
      if (!present()) return [];
      return rows(
        db
          .prepare(
            `SELECT tenant AS tenantId, day, SUM(calls) AS calls, SUM(units) AS units, SUM(cost_micros) AS costMicros
          FROM main."${usage}"
          WHERE app = ? COLLATE BINARY AND tenant IN (SELECT value FROM json_each(?)) AND day >= ?
          GROUP BY tenant, day ORDER BY day DESC, tenant LIMIT ?`,
          )
          .all(app, JSON.stringify(tenants), since, limit) as Record<string, unknown>[],
      );
    },
  };
}

export function postgresDecisionSwitch(client: PgQuery, app: string): DecisionSwitchStore {
  const present = async () =>
    (await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [runtimeTable('postgres', record)])).rows[0]?.present === true;
  return {
    async read(tenantId, providers) {
      if (!(await present())) return null;
      // Locked with the tenant row the caller already holds: two switches of one tenant are made one after the other.
      return switchesOf(
        (
          await client.query(
            `SELECT feature, enabled, consent FROM ${runtimeTable('postgres', switches)} WHERE app = $1 AND tenant = $2 AND feature LIKE $3 FOR UPDATE`,
            [app, tenantId, DECIDE_FEATURES],
          )
        ).rows,
        providers,
      );
    },
    async put(tenantId, value, at) {
      if (!(await present())) return denyTenant();
      await client.query(
        `INSERT INTO ${runtimeTable('postgres', switches)} (app, tenant, feature, enabled, consent, changed_at) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (app, tenant, feature) DO UPDATE SET enabled = excluded.enabled, consent = excluded.consent, changed_at = excluded.changed_at`,
        [app, tenantId, decideFeature(value.provider), value.enabled ? 1 : 0, value.consent, at],
      );
    },
    async forget(tenantId) {
      if (!(await present())) return;
      await client.query(`DELETE FROM ${runtimeTable('postgres', record)} WHERE app = $1 AND tenant = $2`, [app, tenantId]);
      await client.query(`DELETE FROM ${runtimeTable('postgres', switches)} WHERE app = $1 AND tenant = $2 AND feature LIKE $3`, [
        app,
        tenantId,
        DECIDE_FEATURES,
      ]);
    },
    async usage(tenants, since, limit) {
      if (!(await present())) return [];
      return rows(
        (
          await client.query(
            `SELECT tenant AS "tenantId", day, SUM(calls)::float8 AS calls, SUM(units)::float8 AS units, SUM(cost_micros)::float8 AS "costMicros"
            FROM ${runtimeTable('postgres', usage)}
            WHERE app = $1 AND tenant = ANY($2::text[]) AND day >= $3 GROUP BY tenant, day ORDER BY day DESC, tenant LIMIT $4`,
            [app, [...tenants], since, limit],
          )
        ).rows,
      );
    },
  };
}
