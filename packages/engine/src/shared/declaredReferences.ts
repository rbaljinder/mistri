/**
 * Declared references: an App's soft keys (`references: { product_sku: {
 * to: 'product', column: 'sku' } }`), a column the database holds no foreign
 * key for, joined as if it did.
 *
 * One edge, two places. In the App's logical catalog it is an ordinary
 * ForeignKey marked `declared`, so every path, label, link, related list and
 * rollup that follows a key follows it, and the reader's pruned catalog
 * (accessibleSchema) drops it with the column or table it touches, as it does
 * a real one. Below that catalog every layer compiles against the database's
 * own, which has no such key; there the edge rides in the view
 * (`ViewDef.references`), attached by the App's resource layer, and the
 * compilers put it back for that one statement.
 *
 * Only a join that cannot multiply the base row is taken: the target column
 * must be the table's single-column primary key or proven unique. That is
 * judged when the App loads and again, against the catalog in hand, at every
 * compile, so an edge that has stopped being true is dropped rather than run.
 */
import { columnKind, primaryKey, type DatabaseSchema, type ForeignKey, type TableMeta } from './schema.js';

/** One declaration as a resource block says it, in the source's local logical names. */
export interface DeclaredReference {
  table: string;
  column: string;
  to: string;
  /** Absent: the target's single-column primary key. */
  toColumn?: string;
}

/** The target column proves one row per value: the whole primary key, or unique on its own. */
function uniqueIn(table: TableMeta, column: string): boolean {
  const key = primaryKey(table);
  return (key.length === 1 && key[0] === column) || Boolean(table.unique?.includes(column));
}

/** The edge a declaration names, or why the catalog refuses it. */
export function declaredEdge(schema: DatabaseSchema, reference: DeclaredReference, at: string): ForeignKey {
  const from = schema.tables.find((table) => table.id === reference.table);
  if (!from) throw new Error(`${at}: "${reference.table}" is not a table in this catalog.`);
  const column = from.columns.find((item) => item.name === reference.column);
  if (!column) throw new Error(`${at}: "${reference.column}" is not a column of ${reference.table}.`);
  if (column.primaryKey)
    throw new Error(`${at}: "${reference.column}" is part of the primary key; a reference is a column that points elsewhere.`);
  if (column.references || schema.foreignKeys.some((fk) => fk.from.table === from.id && fk.from.columns.includes(column.name))) {
    throw new Error(`${at}: "${reference.column}" already has a foreign key in the database, which the App follows as it is.`);
  }
  const to = schema.tables.find((table) => table.id === reference.to);
  if (!to) throw new Error(`${at}: "to" names "${reference.to}", which is not a table in this catalog.`);
  const key = primaryKey(to);
  const toColumn = reference.toColumn ?? (key.length === 1 ? key[0] : undefined);
  if (!toColumn) throw new Error(`${at}: ${reference.to} has no single-column primary key, so name the "column" it is looked up by.`);
  const target = to.columns.find((item) => item.name === toColumn);
  if (!target) throw new Error(`${at}: "${toColumn}" is not a column of ${reference.to}.`);
  if (!uniqueIn(to, toColumn)) {
    throw new Error(
      `${at}: ${reference.to}.${toColumn} is not proven unique (its primary key, or a unique constraint or index on it alone), ` +
        `so one ${reference.table} could name several. Add a unique index on ${reference.to}(${toColumn}).`,
    );
  }
  if (columnKind(column.type) !== columnKind(target.type)) {
    throw new Error(
      `${at}: ${reference.table}.${column.name} is ${column.type} and ${reference.to}.${toColumn} is ${target.type}; ` +
        'a reference compares like with like.',
    );
  }
  return {
    name: `${from.id}_${column.name}_declared`,
    from: { table: from.id, columns: [column.name] },
    to: { table: to.id, columns: [toColumn] },
    declared: true,
  };
}

/**
 * The single-column edges a composite key implies. A tenant's
 * key `(tenant_id, group_id) → assignment_group (tenant_id, id)`, where `id`
 * is unique on its own, names one group by `group_id` alone: every other leg
 * is NOT NULL, so the composite is checked whenever `group_id` is set, and
 * the row it lands on is the one `id` names. A reader who cannot read
 * `tenant_id` — every tenant context — still follows the reference by the leg
 * it reads. Never a smaller key: the target column is already unique alone,
 * and the database's composite key still decides what may be written.
 */
export function impliedEdges(schema: DatabaseSchema): ForeignKey[] {
  const edges: ForeignKey[] = [];
  for (const fk of schema.foreignKeys) {
    if (fk.declared || fk.from.columns.length < 2) continue;
    const from = schema.tables.find((table) => table.id === fk.from.table);
    const to = schema.tables.find((table) => table.id === fk.to.table);
    if (!from || !to) continue;
    fk.from.columns.forEach((name, index) => {
      const column = from.columns.find((item) => item.name === name);
      const target = to.columns.find((item) => item.name === fk.to.columns[index]);
      if (!column || !target || column.primaryKey || !uniqueIn(to, target.name) || columnKind(column.type) !== columnKind(target.type))
        return;
      const legs = fk.from.columns.filter((other) => other !== name);
      if (legs.some((other) => from.columns.find((item) => item.name === other)?.nullable !== false)) return;
      // A column that is already a single-column key is that key's, and needs no second edge.
      if (
        schema.foreignKeys.some(
          (other) => other.from.table === from.id && other.from.columns.length === 1 && other.from.columns[0] === name,
        )
      )
        return;
      edges.push({
        // Named by what it joins, not after the constraint: a composite's name usually spells the column a tenant never reads.
        name: `${from.id}.${name}->${to.id}`,
        from: { table: from.id, columns: [name] },
        to: { table: to.id, columns: [target.name] },
        declared: true,
      });
    });
  }
  return edges;
}
const sameEdge = (a: ForeignKey, b: ForeignKey) =>
  a.from.table === b.from.table &&
  a.to.table === b.to.table &&
  a.from.columns[0] === b.from.columns[0] &&
  a.to.columns[0] === b.to.columns[0];

/** The catalog with these edges in it: each column gains its `references`, as a real key's does. */
export function withDeclaredEdges(schema: DatabaseSchema, edges: readonly ForeignKey[]): DatabaseSchema {
  if (!edges.length) return schema;
  return {
    ...schema,
    tables: schema.tables.map((table) => {
      const mine = edges.filter((edge) => edge.from.table === table.id);
      if (!mine.length) return table;
      return {
        ...table,
        columns: table.columns.map((column) => {
          const edge = mine.find((item) => item.from.columns[0] === column.name);
          return edge && !column.references ? { ...column, references: { table: edge.to.table, column: edge.to.columns[0] } } : column;
        }),
      };
    }),
    foreignKeys: [...schema.foreignKeys, ...edges],
  };
}

/**
 * A view's carried edges put back into the catalog it is compiled against,
 * each only while it still holds there: both ends real columns, the target
 * unique, the column not already a key. One that does not is dropped, and
 * a path through it fails as a path through nothing.
 */
export function withViewReferences(schema: DatabaseSchema, references: readonly ForeignKey[] | undefined): DatabaseSchema {
  if (!references?.length) return schema;
  /* One catalog per (view's references, catalog): a fresh object each time would also start
     every cache keyed by the catalog (resolvePath's) empty on every compile. */
  let byCatalog = viewCatalogs.get(references);
  if (!byCatalog) viewCatalogs.set(references, (byCatalog = new WeakMap()));
  let kept = byCatalog.get(schema);
  if (!kept) byCatalog.set(schema, (kept = withViewReferencesFresh(schema, references)));
  return kept;
}

const viewCatalogs = new WeakMap<readonly ForeignKey[], WeakMap<DatabaseSchema, DatabaseSchema>>();

function withViewReferencesFresh(schema: DatabaseSchema, references: readonly ForeignKey[]): DatabaseSchema {
  let implied: ForeignKey[] | undefined;
  const holding = references.filter((edge) => {
    if (edge.from.columns.length !== 1 || edge.to.columns.length !== 1) return false;
    if (schema.foreignKeys.some((fk) => fk.name === edge.name && fk.from.table === edge.from.table)) return false;
    // A leg of a composite key in this catalog: true here as long as the key is.
    if ((implied ??= impliedEdges(schema)).some((other) => sameEdge(other, edge))) return true;
    try {
      declaredEdge(schema, { table: edge.from.table, column: edge.from.columns[0], to: edge.to.table, toColumn: edge.to.columns[0] }, '');
      return true;
    } catch {
      return false;
    }
  });
  return withDeclaredEdges(
    schema,
    holding.map((edge) => ({ ...edge, declared: true as const })),
  );
}
