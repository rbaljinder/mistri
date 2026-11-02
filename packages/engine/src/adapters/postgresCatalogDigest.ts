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

/* pg_catalog's operators by name, as the scope's own catalog reads use them (scoped/postgresTriggers.ts CAT): the
   text concatenation the digest is built from is polymorphic, and a `public.||(text, oid)` would otherwise answer one
   digest whatever the catalog said, which reads as nothing having moved. */
const EQ = 'OPERATOR(pg_catalog.=)';
const NE = 'OPERATOR(pg_catalog.<>)';
const CAT = 'OPERATOR(pg_catalog.||)';

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
                  WHERE n.nspname ${NE} ALL(${excludedLiteral}::pg_catalog.text[]) AND n.nspname OPERATOR(pg_catalog.!~) '^pg_(toast_)?temp_'),
          /* An extension's own relations are left out, as the description leaves them out (see notExtensionMember). */
          rel AS (SELECT c.oid, c.xmin FROM pg_catalog.pg_class c JOIN ns ON ns.oid ${EQ} c.relnamespace WHERE ${notExtensionMember('c')}),
          seen(v) AS (
            SELECT 'n' ${CAT} ns.oid ${CAT} ':' ${CAT} ns.xmin FROM ns
            UNION ALL SELECT 'c' ${CAT} rel.oid ${CAT} ':' ${CAT} rel.xmin FROM rel
            UNION ALL SELECT 'a' ${CAT} a.attrelid ${CAT} '.' ${CAT} a.attnum ${CAT} ':' ${CAT} a.xmin
              FROM pg_catalog.pg_attribute a JOIN rel ON rel.oid ${EQ} a.attrelid
            UNION ALL SELECT 'd' ${CAT} d.oid ${CAT} ':' ${CAT} d.xmin FROM pg_catalog.pg_attrdef d JOIN rel ON rel.oid ${EQ} d.adrelid
            UNION ALL SELECT 'k' ${CAT} k.oid ${CAT} ':' ${CAT} k.xmin FROM pg_catalog.pg_constraint k
              WHERE k.connamespace ${EQ} ANY (SELECT oid FROM ns) OR k.conrelid ${EQ} ANY (SELECT oid FROM rel) OR k.confrelid ${EQ} ANY (SELECT oid FROM rel)
            UNION ALL SELECT 'i' ${CAT} i.indexrelid ${CAT} ':' ${CAT} i.xmin FROM pg_catalog.pg_index i JOIN rel ON rel.oid ${EQ} i.indrelid
            UNION ALL SELECT 't' ${CAT} g.oid ${CAT} ':' ${CAT} g.xmin FROM pg_catalog.pg_trigger g JOIN rel ON rel.oid ${EQ} g.tgrelid
            UNION ALL SELECT 'r' ${CAT} w.oid ${CAT} ':' ${CAT} w.xmin FROM pg_catalog.pg_rewrite w JOIN rel ON rel.oid ${EQ} w.ev_class
            UNION ALL SELECT 'p' ${CAT} p.oid ${CAT} ':' ${CAT} p.xmin FROM pg_catalog.pg_policy p JOIN rel ON rel.oid ${EQ} p.polrelid
            UNION ALL SELECT 'y' ${CAT} y.oid ${CAT} ':' ${CAT} y.xmin FROM pg_catalog.pg_type y JOIN ns ON ns.oid ${EQ} y.typnamespace
            UNION ALL SELECT 'e' ${CAT} e.oid ${CAT} ':' ${CAT} e.xmin FROM pg_catalog.pg_enum e
              JOIN pg_catalog.pg_type y ON y.oid ${EQ} e.enumtypid JOIN ns ON ns.oid ${EQ} y.typnamespace
            UNION ALL SELECT 'f' ${CAT} f.oid ${CAT} ':' ${CAT} f.xmin FROM pg_catalog.pg_proc f JOIN ns ON ns.oid ${EQ} f.pronamespace
            UNION ALL SELECT 'o' ${CAT} o.oid ${CAT} ':' ${CAT} o.xmin FROM pg_catalog.pg_operator o JOIN ns ON ns.oid ${EQ} o.oprnamespace
            UNION ALL SELECT 'q' ${CAT} q.oid ${CAT} ':' ${CAT} q.xmin FROM pg_catalog.pg_opclass q JOIN ns ON ns.oid ${EQ} q.opcnamespace
            /* What else a store attestation counts in the runtime schema (postgresRuntimeSchemaProblems): one more
               object there refuses the store, so it moves the digest too. */
            UNION ALL SELECT 'v' ${CAT} v.oid ${CAT} ':' ${CAT} v.xmin FROM pg_catalog.pg_conversion v JOIN ns ON ns.oid ${EQ} v.connamespace
            UNION ALL SELECT 'F' ${CAT} o.oid ${CAT} ':' ${CAT} o.xmin FROM pg_catalog.pg_opfamily o JOIN ns ON ns.oid ${EQ} o.opfnamespace
            UNION ALL SELECT 'Tc' ${CAT} t.oid ${CAT} ':' ${CAT} t.xmin FROM pg_catalog.pg_ts_config t JOIN ns ON ns.oid ${EQ} t.cfgnamespace
            UNION ALL SELECT 'Td' ${CAT} t.oid ${CAT} ':' ${CAT} t.xmin FROM pg_catalog.pg_ts_dict t JOIN ns ON ns.oid ${EQ} t.dictnamespace
            UNION ALL SELECT 'Tp' ${CAT} t.oid ${CAT} ':' ${CAT} t.xmin FROM pg_catalog.pg_ts_parser t JOIN ns ON ns.oid ${EQ} t.prsnamespace
            UNION ALL SELECT 'Tt' ${CAT} t.oid ${CAT} ':' ${CAT} t.xmin FROM pg_catalog.pg_ts_template t JOIN ns ON ns.oid ${EQ} t.tmplnamespace
            UNION ALL SELECT 'x' ${CAT} x.oid ${CAT} ':' ${CAT} x.xmin FROM pg_catalog.pg_statistic_ext x JOIN ns ON ns.oid ${EQ} x.stxnamespace
            UNION ALL SELECT 'X' ${CAT} x.oid ${CAT} ':' ${CAT} x.xmin FROM pg_catalog.pg_extension x JOIN ns ON ns.oid ${EQ} x.extnamespace
            UNION ALL SELECT 'l' ${CAT} l.oid ${CAT} ':' ${CAT} l.xmin FROM pg_catalog.pg_collation l
              WHERE l.collnamespace ${EQ} ANY (SELECT oid FROM ns)
                 OR l.oid ${EQ} ANY (SELECT a.attcollation FROM pg_catalog.pg_attribute a JOIN rel ON rel.oid ${EQ} a.attrelid)
            UNION ALL SELECT 'm' ${CAT} m.roleid ${CAT} '.' ${CAT} m.member ${CAT} ':' ${CAT} m.xmin FROM pg_catalog.pg_auth_members m
            UNION ALL SELECT 'u' ${CAT} r.oid ${CAT} ':' ${CAT} r.rolname ${CAT} ':' ${CAT} r.rolsuper ${CAT} ':' ${CAT} r.rolinherit FROM pg_catalog.pg_roles r
            UNION ALL SELECT 's' ${CAT} current_user)
     SELECT pg_catalog.md5(pg_catalog.string_agg(v, ',' ORDER BY v)) AS fingerprint FROM seen`;
}

/** The digest a digest statement answered, from its result. */
export function postgresCatalogDigestOf(result: { rows: readonly Record<string, unknown>[] } | undefined): string {
  const value = result?.rows[0]?.fingerprint;
  if (typeof value !== 'string') throw new Refusal('The catalog digest could not be read.');
  return value;
}
