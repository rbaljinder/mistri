import { runtimeTable } from '../../packages/engine/src/shared/runtimeTables.js';

/** A statement written once for every engine names a runtime table by the physical name SQLite and
 * MySQL keep, `"__mistri_x"` (or `public."__mistri_x"` from before PostgreSQL had a schema of its
 * own for them). PostgreSQL keeps the table in the runtime schema under its plain name, so a suite
 * that runs the same SQL there spells it this way. The migration bookkeeping stays where it was. */
export const postgresRuntimeSql = (sql: string): string =>
  sql.replace(
    /(?<![\w.])(?:public\.)?(?:"(__mistri_[a-z0-9_]+)"|(__mistri_[a-z0-9_]+)\b)/gi,
    (whole, quoted: string | undefined, bare: string | undefined) => {
      const name = (quoted ?? bare)!;
      return /^__mistri_schema_(snapshot|history)$/i.test(name) ? whole : runtimeTable('postgres', name);
    },
  );
