/**
 * Each tenant's assistant switch, its conversations at closure and its token
 * counts, as tenant administration reads and writes them: inside the
 * administration owner's own transaction (tenantAdministration.ts), on the
 * tenant source that holds the assistant store beside its records. The
 * switch is the platform owner's; nothing here decides who may set it.
 *
 * An App that declares an assistant may run without its store (no model is
 * set up, so nothing was provisioned): the switch then reads as absent, a
 * write refuses, and closing a tenant has no conversation to forget.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { ASSISTANT_TABLES } from '../../adapters/assistant/assistantStore.js';
import { ASSISTANT_FEATURE, TENANT_SWITCH_TABLES } from '../../adapters/switch/tenantSwitch.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { AdministrationAssistantImage, AdministrationUsageRow } from '../../shared/tenantAdministration.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

export interface AssistantSwitchStore {
  /** The tenant's switch (off and unconsented when never set), or null when the database holds no assistant store. */
  read(tenantId: string): Promise<AdministrationAssistantImage | null>;
  put(tenantId: string, image: AdministrationAssistantImage, at: string): Promise<void>;
  /** A closed tenant's conversations, their events and its switch. Its token counts stay: they are the bill. */
  forget(tenantId: string): Promise<void>;
  /** The named tenants' tokens by tenant and day from `since`, newest day first, at most `limit` rows. */
  usage(tenants: readonly string[], since: string, limit: number): Promise<AdministrationUsageRow[]>;
}

const { conversation, event, usage } = ASSISTANT_TABLES;
const switches = TENANT_SWITCH_TABLES.tenant;
const image = (row: Record<string, unknown> | undefined): AdministrationAssistantImage => {
  if (!row) return { enabled: false, consent: '' };
  const enabled = Number(row.enabled);
  if ((enabled !== 0 && enabled !== 1) || typeof row.consent !== 'string') return denyTenant();
  return captureTenantData({ enabled: enabled === 1, consent: row.consent });
};
const rows = (found: Record<string, unknown>[]): AdministrationUsageRow[] =>
  found.map((row) => {
    const tokens = Number(row.tokens);
    if (typeof row.tenantId !== 'string' || typeof row.day !== 'string' || !Number.isSafeInteger(tokens)) return denyTenant();
    return { tenantId: row.tenantId, day: row.day, tokens };
  });

export function sqliteAssistantSwitch(db: DatabaseSync, app: string): AssistantSwitchStore {
  const present = () => !!db.prepare(`SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? COLLATE BINARY`).get(conversation);
  return {
    async read(tenantId) {
      if (!present()) return null;
      return image(
        db
          .prepare(
            `SELECT enabled, consent FROM main."${switches}" WHERE app = ? COLLATE BINARY AND tenant = ? COLLATE BINARY AND feature = ?`,
          )
          .get(app, tenantId, ASSISTANT_FEATURE),
      );
    },
    async put(tenantId, value, at) {
      if (!present()) return denyTenant();
      db.prepare(
        `INSERT INTO main."${switches}" (app, tenant, feature, enabled, consent, changed_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (app, tenant, feature) DO UPDATE SET enabled = excluded.enabled, consent = excluded.consent, changed_at = excluded.changed_at`,
      ).run(app, tenantId, ASSISTANT_FEATURE, value.enabled ? 1 : 0, value.consent, at);
    },
    async forget(tenantId) {
      if (!present()) return;
      db.prepare(
        `DELETE FROM main."${event}" WHERE conversation IN
        (SELECT id FROM main."${conversation}" WHERE app = ? COLLATE BINARY AND tenant = ? COLLATE BINARY)`,
      ).run(app, tenantId);
      db.prepare(`DELETE FROM main."${conversation}" WHERE app = ? COLLATE BINARY AND tenant = ? COLLATE BINARY`).run(app, tenantId);
      db.prepare(`DELETE FROM main."${switches}" WHERE app = ? COLLATE BINARY AND tenant = ? COLLATE BINARY AND feature = ?`).run(
        app,
        tenantId,
        ASSISTANT_FEATURE,
      );
    },
    async usage(tenants, since, limit) {
      if (!present()) return [];
      return rows(
        db
          .prepare(
            `SELECT tenant AS tenantId, day, SUM(tokens) AS tokens FROM main."${usage}"
          WHERE app = ? COLLATE BINARY AND tenant IN (SELECT value FROM json_each(?)) AND day >= ?
          GROUP BY tenant, day ORDER BY day DESC, tenant LIMIT ?`,
          )
          .all(app, JSON.stringify(tenants), since, limit) as Record<string, unknown>[],
      );
    },
  };
}

export function postgresAssistantSwitch(client: PgQuery, app: string): AssistantSwitchStore {
  const present = async () =>
    (await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [runtimeTable('postgres', conversation)])).rows[0]?.present ===
    true;
  return {
    async read(tenantId) {
      if (!(await present())) return null;
      // Locked with the tenant row the caller already holds: two switches of one tenant are made one after the other.
      return image(
        (
          await client.query(
            `SELECT enabled, consent FROM ${runtimeTable('postgres', switches)} WHERE app = $1 AND tenant = $2 AND feature = $3 FOR UPDATE`,
            [app, tenantId, ASSISTANT_FEATURE],
          )
        ).rows[0],
      );
    },
    async put(tenantId, value, at) {
      if (!(await present())) return denyTenant();
      await client.query(
        `INSERT INTO ${runtimeTable('postgres', switches)} (app, tenant, feature, enabled, consent, changed_at) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (app, tenant, feature) DO UPDATE SET enabled = excluded.enabled, consent = excluded.consent, changed_at = excluded.changed_at`,
        [app, tenantId, ASSISTANT_FEATURE, value.enabled ? 1 : 0, value.consent, at],
      );
    },
    async forget(tenantId) {
      if (!(await present())) return;
      await client.query(
        `DELETE FROM ${runtimeTable('postgres', event)} WHERE conversation IN (SELECT id FROM ${runtimeTable('postgres', conversation)} WHERE app = $1 AND tenant = $2)`,
        [app, tenantId],
      );
      await client.query(`DELETE FROM ${runtimeTable('postgres', conversation)} WHERE app = $1 AND tenant = $2`, [app, tenantId]);
      await client.query(`DELETE FROM ${runtimeTable('postgres', switches)} WHERE app = $1 AND tenant = $2 AND feature = $3`, [
        app,
        tenantId,
        ASSISTANT_FEATURE,
      ]);
    },
    async usage(tenants, since, limit) {
      if (!(await present())) return [];
      return rows(
        (
          await client.query(
            `SELECT tenant AS "tenantId", day, SUM(tokens)::float8 AS tokens FROM ${runtimeTable('postgres', usage)}
            WHERE app = $1 AND tenant = ANY($2::text[]) AND day >= $3 GROUP BY tenant, day ORDER BY day DESC, tenant LIMIT $4`,
            [app, [...tenants], since, limit],
          )
        ).rows,
      );
    },
  };
}
