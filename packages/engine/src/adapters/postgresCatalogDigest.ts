/**
 * A digest of the PostgreSQL catalog rows a description reads.
 *
 * The tenant sources attest every snapshot against it (tenantPostgresCatalog.ts,
 * tenantReadSource.ts), and a scoped transaction's writer reads it before it
 * describes the catalog (PostgresAdapter), so either describes again only when
 * the digest has moved.
 */
import { Refusal } from './adapter.js';
import { notExtensionMember } from './postgresCatalog.js';

/**
 * One statement that changes whenever anything a full attestation reads
 * changes: the `(oid, xmin)` of every catalog row the whole-catalog
 * description, the pinned relation description and the store attestation
 * depend on, over the same schemas, plus role membership and attributes and
 * the store's meta row. Transactional DDL inserts, updates or deletes those
 * rows, and a changed or removed row changes the digest. What does not change
 * it is what attests nothing: VACUUM and ANALYZE update `pg_class` in place,
 * and comments live elsewhere.
 *
 * A tenant source compares it with the digest of its last full attestation that
 * passed, read in that attestation's own snapshot. Equal, that attestation
 * stands for this snapshot; different, the full one runs again. The digest
 * must be read after the source's LOCK, as the first statement of the
 * snapshot, so DDL cannot land between it and the reads it vouches for.
 *
 * The statement has no parameters, so it can ride in the message that
 * begins the snapshot (PostgresAdapter.readSnapshot's prologue): the schema
 * names are this codebase's constants, spelled as literals. A runtime
 * store's meta row is not in it: stores are attested when they are opened.
 *
 * Not seen: an object in `pg_catalog` renamed by a superuser, which could
 * change the text of a default or index expression. It changes no read, and
 * the attestation already trusts `pg_catalog` as everything else does.
 */
export function postgresCatalogDigestStatement(excludedSchemas: readonly string[]): string {
  // Constants only: a name that is not a plain identifier is a programming error, never quoted around.
  if (excludedSchemas.some((name) => !/^[a-z_][a-z0-9_]*$/.test(name)))
    throw new Refusal('The catalog digest names only plain identifiers.');
  const excludedLiteral = `ARRAY[${excludedSchemas.map((name) => `'${name}'`).join(', ')}]`;
  return `WITH ns AS (SELECT n.oid, n.xmin FROM pg_catalog.pg_namespace n
                  WHERE n.nspname <> ALL(${excludedLiteral}::text[]) AND n.nspname !~ '^pg_(toast_)?temp_'),
          /* An extension's own relations are left out, as the description leaves them out (see notExtensionMember). */
          rel AS (SELECT c.oid, c.xmin FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace WHERE ${notExtensionMember('c')}),
          seen(v) AS (
            SELECT 'n' || ns.oid || ':' || ns.xmin FROM ns
            UNION ALL SELECT 'c' || rel.oid || ':' || rel.xmin FROM rel
            UNION ALL SELECT 'a' || a.attrelid || '.' || a.attnum || ':' || a.xmin
              FROM pg_catalog.pg_attribute a JOIN rel ON rel.oid = a.attrelid
            UNION ALL SELECT 'd' || d.oid || ':' || d.xmin FROM pg_catalog.pg_attrdef d JOIN rel ON rel.oid = d.adrelid
            UNION ALL SELECT 'k' || k.oid || ':' || k.xmin FROM pg_catalog.pg_constraint k
              WHERE k.connamespace IN (SELECT oid FROM ns) OR k.conrelid IN (SELECT oid FROM rel) OR k.confrelid IN (SELECT oid FROM rel)
            UNION ALL SELECT 'i' || i.indexrelid || ':' || i.xmin FROM pg_catalog.pg_index i JOIN rel ON rel.oid = i.indrelid
            UNION ALL SELECT 't' || g.oid || ':' || g.xmin FROM pg_catalog.pg_trigger g JOIN rel ON rel.oid = g.tgrelid
            UNION ALL SELECT 'r' || w.oid || ':' || w.xmin FROM pg_catalog.pg_rewrite w JOIN rel ON rel.oid = w.ev_class
            UNION ALL SELECT 'p' || p.oid || ':' || p.xmin FROM pg_catalog.pg_policy p JOIN rel ON rel.oid = p.polrelid
            UNION ALL SELECT 'y' || y.oid || ':' || y.xmin FROM pg_catalog.pg_type y JOIN ns ON ns.oid = y.typnamespace
            UNION ALL SELECT 'e' || e.oid || ':' || e.xmin FROM pg_catalog.pg_enum e
              JOIN pg_catalog.pg_type y ON y.oid = e.enumtypid JOIN ns ON ns.oid = y.typnamespace
            UNION ALL SELECT 'f' || f.oid || ':' || f.xmin FROM pg_catalog.pg_proc f JOIN ns ON ns.oid = f.pronamespace
            UNION ALL SELECT 'o' || o.oid || ':' || o.xmin FROM pg_catalog.pg_operator o JOIN ns ON ns.oid = o.oprnamespace
            UNION ALL SELECT 'q' || q.oid || ':' || q.xmin FROM pg_catalog.pg_opclass q JOIN ns ON ns.oid = q.opcnamespace
            UNION ALL SELECT 'l' || l.oid || ':' || l.xmin FROM pg_catalog.pg_collation l
              WHERE l.collnamespace IN (SELECT oid FROM ns)
                 OR l.oid IN (SELECT a.attcollation FROM pg_catalog.pg_attribute a JOIN rel ON rel.oid = a.attrelid)
            UNION ALL SELECT 'm' || m.roleid || '.' || m.member || ':' || m.xmin FROM pg_catalog.pg_auth_members m
            UNION ALL SELECT 'u' || r.oid || ':' || r.rolname || ':' || r.rolsuper || ':' || r.rolinherit FROM pg_catalog.pg_roles r
            UNION ALL SELECT 's' || current_user)
     SELECT md5(string_agg(v, ',' ORDER BY v)) AS fingerprint FROM seen`;
}

/** The digest a digest statement answered, from its result. */
export function postgresCatalogDigestOf(result: { rows: readonly Record<string, unknown>[] } | undefined): string {
  const value = result?.rows[0]?.fingerprint;
  if (typeof value !== 'string') throw new Refusal('The catalog digest could not be read.');
  return value;
}
