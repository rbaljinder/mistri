/**
 * A database role's reach beyond reading, behind `Adapter.privileges`: one
 * catalog query on PostgreSQL, the account's grants on MySQL. Every read runs
 * in a read-only transaction, which holds for everything tablewalk sends but
 * not for a superuser (`COPY … TO PROGRAM` is a read); the role is the
 * boundary that always holds, so the registry says when it is wider than a
 * read-only connection.
 */
import type { RolePrivileges } from './adapter.js';
import { RESERVED_SCHEMAS } from './reservedSql.js';
import { notExtensionMember } from './postgresCatalog.js';

type Reader = { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> };

/** Superuser, write grants on the browsed tables, CREATE in a browsed schema. */
export async function postgresPrivileges(db: Reader, browsed: readonly string[], system: readonly string[]): Promise<RolePrivileges> {
  const schemas = browsed.length ? browsed.filter((schema) => !RESERVED_SCHEMAS.includes(schema)) : [...system, ...RESERVED_SCHEMAS];
  // Temporary and toast namespaces are the session's own, not the database's.
  const within = `${browsed.length ? 'n.nspname = ANY($1)' : 'n.nspname <> ALL($1)'} AND n.nspname NOT LIKE 'pg\\_%'`;
  const { rows } = await db.query(
    `SELECT r.rolsuper AS superuser,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'p') AND ${notExtensionMember('c')} AND ${within}
                AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
                  OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))) AS writable,
            EXISTS (SELECT 1 FROM pg_namespace n WHERE ${within} AND has_schema_privilege(n.oid, 'CREATE')) AS can_create
       FROM pg_roles r WHERE r.rolname = current_user`,
    [schemas],
  );
  const row = (rows as Array<{ superuser?: boolean; writable?: number; can_create?: boolean }>)[0] ?? {};
  const writable = Number(row.writable ?? 0);
  return {
    superuser: row.superuser === true,
    create: row.can_create === true,
    writes: writable ? [`INSERT/UPDATE/DELETE on ${writable} table${writable === 1 ? '' : 's'}`] : [],
  };
}

const WRITING = new Set(['ALL PRIVILEGES', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER']);

/**
 * From `SHOW GRANTS`: grants on `*.*` or on the databases this connection
 * browses. A read-only session is not enough against an account with SUPER,
 * which can step around it, so SUPER or every privilege on `*.*` is a superuser.
 */
export function mysqlPrivileges(grants: readonly string[], databases: readonly string[]): RolePrivileges {
  const within = (on: string) => on === '*.*' || databases.some((name) => on.startsWith(`\`${name}\`.`) || on.startsWith(`${name}.`));
  let superuser = false,
    create = false;
  const writes: string[] = [];
  for (const line of grants) {
    const grant = /^GRANT (.+?) ON (\S+) TO /i.exec(line);
    if (!grant) continue;
    const privileges = grant[1].toUpperCase().split(/\s*,\s*/),
      on = grant[2];
    if (on === '*.*' && privileges.some((p) => p === 'ALL PRIVILEGES' || p === 'SUPER')) superuser = true;
    if (!within(on)) continue;
    const writing = privileges.filter((p) => WRITING.has(p));
    if (writing.length) writes.push(`${writing.join('/')} on ${on}`);
    if (privileges.some((p) => p === 'ALL PRIVILEGES' || p === 'CREATE')) create = true;
  }
  return { superuser, create, writes };
}
