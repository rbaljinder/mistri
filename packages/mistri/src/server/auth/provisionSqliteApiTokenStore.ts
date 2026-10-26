/** Explicit private operator maintenance, never cookie-auth initialization.
 * The operator supplies the existing auth path and every in-scope SQLite
 * business exclusion. Structural validation is not proof of file history or
 * OS ownership; hostile concurrent filesystem writers are outside this fence.
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { API_TOKEN_STORE_VERSION, SQLITE_API_TOKEN_DDL, SQLITE_API_TOKEN_TABLES } from '../../adapters/auth/sqliteApiTokenLayout.js';
import { assertSqliteAuthCoreLayout, assertSqliteAuthTokenLayout } from '../../adapters/auth/sqliteAuthStoreLayout.js';
import { assertApiTokenAppId, assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import { captureTenantData, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { assertAuthStoreSeparation, type AuthStoreExclusion } from './authStoreSeparation.js';

const refuse = (): never => {
  throw new Error('SQLite API token storage could not be provisioned.');
};
interface ProvisionOptions {
  appId: string;
  storeId: string;
  exclusions: readonly AuthStoreExclusion[];
}

export function provisionSqliteApiTokenStore(existingPath: string, rawOptions: ProvisionOptions) {
  let db: DatabaseSync | undefined;
  try {
    if (typeof existingPath !== 'string' || !isAbsolute(existingPath) || existingPath.includes('\0')) return refuse();
    const options = captureTenantData(rawOptions);
    tenantRecord(options, ['appId', 'storeId', 'exclusions']);
    assertApiTokenAppId(options.appId);
    assertApiTokenSecretId(options.storeId);
    if (!Array.isArray(options.exclusions) || options.exclusions.length > 128) return refuse();
    const path = realpathSync(existingPath),
      identity = statSync(path);
    if (!identity.isFile()) return refuse();
    const fence = () => {
      const current = statSync(path);
      if (realpathSync(existingPath) !== path || !current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino)
        return refuse();
      for (const exclusion of options.exclusions) assertAuthStoreSeparation(path, exclusion);
    };
    fence();
    // mode=rw refuses a missing target instead of SQLite's default CREATE.
    // The encoded URI retains spaces, Unicode and literal ?/# in file names.
    const uri = pathToFileURL(path);
    uri.searchParams.set('mode', 'rw');
    db = new DatabaseSync(uri.href, { enableForeignKeyConstraints: true });
    fence();
    db.exec('BEGIN IMMEDIATE');
    fence();
    const existing = db.prepare('SELECT 1 FROM main.sqlite_schema WHERE name = ? COLLATE BINARY').get(SQLITE_API_TOKEN_TABLES.meta);
    let migrated = false;
    if (existing) {
      assertSqliteAuthTokenLayout(db);
    } else {
      assertSqliteAuthCoreLayout(db);
      for (const ddl of SQLITE_API_TOKEN_DDL) db.exec(ddl);
      db.prepare(`INSERT INTO "${SQLITE_API_TOKEN_TABLES.meta}" (singleton, version, app_id, store_id, format)
        VALUES (1, ?, ?, ?, 'twa1')`).run(API_TOKEN_STORE_VERSION, options.appId, options.storeId);
      migrated = true;
    }
    assertSqliteAuthTokenLayout(db);
    const rows = db
      .prepare(`SELECT singleton, version, app_id, store_id, format,
      (app_id = ? COLLATE BINARY AND store_id = ? COLLATE BINARY) AS binding_matches,
      instr(app_id, char(0)) AS app_nul, instr(store_id, char(0)) AS store_nul,
      instr(format, char(0)) AS format_nul FROM "${SQLITE_API_TOKEN_TABLES.meta}"`)
      .all(options.appId, options.storeId);
    if (rows.length !== 1) return refuse();
    const meta = rows[0];
    if (
      meta.singleton !== 1 ||
      meta.version !== API_TOKEN_STORE_VERSION ||
      meta.app_id !== options.appId ||
      meta.store_id !== options.storeId ||
      meta.format !== 'twa1' ||
      meta.binding_matches !== 1 ||
      meta.app_nul !== 0 ||
      meta.store_nul !== 0 ||
      meta.format_nul !== 0
    )
      return refuse();
    fence();
    if (!db.isTransaction) return refuse();
    db.exec('COMMIT');
    return Object.freeze({ migrated, version: API_TOKEN_STORE_VERSION, appId: options.appId, storeId: options.storeId });
  } catch {
    return refuse();
  } finally {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* owner handle still closes */
    }
    try {
      db?.close();
    } catch {
      /* no sensitive driver diagnostics */
    }
  }
}
