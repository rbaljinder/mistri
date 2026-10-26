/** Private explicit token extension maintenance; never native auth startup.
 * Uses the existing owned maintenance transaction/lock. The native store must already
 * exist; no schema, grants, roles, accounts or cookie policies are repaired.
 */
import { assertPostgresAuthStore } from '../../adapters/auth/postgresAuthStore.js';
import { RUNTIME_SCHEMA, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { API_TOKEN_STORE_VERSION, postgresApiTokenDdl } from '../../adapters/auth/postgresApiTokenLayout.js';
import { withPostgresMaintenanceTransaction } from '../../adapters/commands/postgresCommandJournal.js';
import { captureTenantData, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { assertApiTokenAppId, assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import {
  assertPostgresAuthStoreSeparation,
  assertPostgresAuthStoreServerSeparation,
  type PostgresSeparationConnection,
} from './authStoreSeparation.js';

const refuse = (): never => {
  throw new Error('PostgreSQL API token storage could not be provisioned.');
};
const meta = runtimeTable('postgres', 'auth_api_token_meta');

export async function provisionPostgresApiTokenStore(
  url: string,
  rawOptions: {
    appId: string;
    storeId: string;
    excludeConnections: readonly PostgresSeparationConnection[];
  },
) {
  try {
    if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url)) return refuse();
    const options = captureTenantData(rawOptions);
    tenantRecord(options, ['appId', 'storeId', 'excludeConnections']);
    assertApiTokenAppId(options.appId);
    assertApiTokenSecretId(options.storeId);
    if (!Array.isArray(options.excludeConnections) || options.excludeConnections.length > 128) return refuse();
    for (const connection of options.excludeConnections) {
      tenantRecord(connection, ['url', 'name', 'source']);
      if (
        typeof connection.url !== 'string' ||
        !connection.url.length ||
        ['name', 'source'].some((key) => Object.hasOwn(connection, key) && typeof connection[key as 'name' | 'source'] !== 'string')
      )
        return refuse();
    }
    assertPostgresAuthStoreSeparation(url, options.excludeConnections);
    const appId = options.appId,
      storeId = options.storeId;
    return await withPostgresMaintenanceTransaction(url, async (client) => {
      // The live identity helper can swallow a denied system-function read.
      // Recover even apparent success before any attestation or token DDL.
      await client.query('SAVEPOINT api_token_provision_separation');
      try {
        await assertPostgresAuthStoreServerSeparation(client, options.excludeConnections);
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT api_token_provision_separation');
        await client.query('RELEASE SAVEPOINT api_token_provision_separation');
      }
      await assertPostgresAuthStore(client);
      const existing =
        (
          await client.query(
            `SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname='auth_api_token_meta'`,
            [RUNTIME_SCHEMA],
          )
        ).rows.length > 0;
      if (!existing) {
        for (const ddl of postgresApiTokenDdl()) await client.query(ddl);
        await client.query(
          `INSERT INTO ${meta} (singleton, version, app_id, store_id, format)
          VALUES (1, ${API_TOKEN_STORE_VERSION}, $1, $2, 'twa1')`,
          [appId, storeId],
        );
      }
      await assertPostgresAuthStore(client);
      const rows = (
        await client.query(
          `SELECT singleton, version, app_id, store_id, format,
        (app_id=$1 COLLATE "C" AND store_id=$2 COLLATE "C") AS matches FROM ${meta}`,
          [appId, storeId],
        )
      ).rows;
      if (
        rows.length !== 1 ||
        rows[0].singleton !== 1 ||
        rows[0].version !== API_TOKEN_STORE_VERSION ||
        rows[0].format !== 'twa1' ||
        rows[0].matches !== true ||
        rows[0].app_id !== appId ||
        rows[0].store_id !== storeId
      )
        return refuse();
      return Object.freeze({ migrated: !existing, version: API_TOKEN_STORE_VERSION, appId, storeId });
    });
  } catch {
    return refuse();
  }
}
