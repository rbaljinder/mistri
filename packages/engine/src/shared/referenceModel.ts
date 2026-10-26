/** Reference paths and joined labels used when planning record and view reads. */
import { findTable, labelColumn, primaryKey, type ColumnMeta, type DatabaseSchema, type TableMeta } from './schema.js';
import { rollupColumnMeta } from './rollups.js';
import { MAX_PATH_DEPTH, tryResolvePath } from './viewPaths.js';

function viewOutputs(columns: readonly { path: string; alias?: string }[]) {
  const counts = new Map<string, number>();
  return columns.map((col) => {
    const name = col.alias?.trim() || col.path;
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    return count === 1 ? name : `${name}_${count}`;
  });
}

/** Joined labels share the field query; never fetch each reference separately. */
export function referenceProjection(
  schema: DatabaseSchema,
  table: TableMeta,
  paths: readonly string[],
  enabled: boolean,
  namingPath: (table: TableMeta) => string | undefined = labelColumn,
) {
  const fetched = [...new Set(paths)];
  const labels = new Map<string, string>();
  if (!enabled) return { fetched, labels };
  /* A single column cannot safely traverse one leg of a composite foreign
     key — unless it is also a key of its own: a tenant's `vehicle_id` is both
     the composite `(tenant_id, vehicle_id)`, which keeps it in its tenant, and
     the single key its path walks, and was drawn as its opaque id. */
  const composite = (tableId: string) => {
    const single = new Set(
      schema.foreignKeys.filter((fk) => fk.from.table === tableId && fk.from.columns.length === 1).map((fk) => fk.from.columns[0]),
    );
    return new Set(
      schema.foreignKeys
        .filter((fk) => fk.from.table === tableId && fk.from.columns.length > 1)
        .flatMap((fk) => fk.from.columns)
        .filter((column) => !single.has(column)),
    );
  };
  for (const path of paths) {
    /* A reference reached through others — `employee_id.department_id` —
       is named the same way as one on the row itself: its record's label,
       read one hop further along, while the path stays within reach. */
    let column: ColumnMeta | undefined;
    let owner = table.id;
    let hops = 0;
    let derived = false;
    if (!path.includes('.')) {
      column = table.columns.find((col) => col.name === path);
      /* A latest of a reference column is the record's key too (rollups.ts): named as the column it reads is, by a
         column of that record (`resident.name`, viewPaths.ts); a template or a path past it is not a column to read. */
      const rollup = !column && table.rollups && Object.hasOwn(table.rollups, path) ? table.rollups[path] : undefined;
      if (rollup?.fn === 'latest' && rollup.references && !rollup.of) {
        column = rollupColumnMeta(path, rollup);
        derived = true;
      }
    } else {
      const { resolved } = tryResolvePath(schema, table.id, path);
      if (!resolved) continue;
      column = resolved.column;
      owner = resolved.table.id;
      hops = resolved.hops.length;
    }
    if (!column?.references || composite(owner).has(column.name)) continue;
    const target = findTable(schema, column.references.table);
    const naming = target && namingPath(target);
    if (derived && (!naming || naming.includes('.') || !target?.columns.some((col) => col.name === naming))) continue;
    if (!naming || hops + 1 + naming.split('.').length - 1 > MAX_PATH_DEPTH) continue;
    const labelAt = `${path}.${naming}`;
    labels.set(path, labelAt);
    if (!fetched.includes(labelAt)) fetched.push(labelAt);
  }
  return { fetched, labels };
}

/** Hidden label columns must not replace raw keys or collide with authored aliases. */
export function referenceView<T extends { columns?: Array<{ path: string; alias?: string }> }>(
  schema: DatabaseSchema,
  table: TableMeta,
  view: T,
  enabled: boolean,
  namingPath: (table: TableMeta) => string | undefined = labelColumn,
) {
  const columns = view.columns ?? [];
  const projection = referenceProjection(
    schema,
    table,
    columns.map((col) => col.path),
    enabled,
    namingPath,
  );
  const labelColumns: Record<string, string> = {};
  const hidden: string[] = [];
  const outputs = viewOutputs(columns);
  const used = new Set(outputs);
  const extra: Array<{ path: string; alias: string }> = [];
  columns.forEach((col, index) => {
    const label = projection.labels.get(col.path);
    if (!label) return;
    let alias = `__tw_reference_${index}`;
    while (used.has(alias)) alias += '_';
    used.add(alias);
    extra.push({ path: label, alias });
    labelColumns[outputs[index]] = alias;
    hidden.push(alias);
  });
  return { view: extra.length ? { ...view, columns: [...columns, ...extra] } : view, labelColumns, hidden };
}

/** Navigation needs the complete authorized key, independently of authored show.
 * Add labels first so hidden key columns do not introduce extra reference labels. */
export function recordView<T extends { columns?: Array<{ path: string; alias?: string }> }>(
  schema: DatabaseSchema,
  table: TableMeta,
  view: T,
  enabled: boolean,
  namingPath: (table: TableMeta) => string | undefined = labelColumn,
  rootLabelPath?: (table: TableMeta) => string | undefined,
) {
  const shown = view.columns?.length ? view : { ...view, columns: table.columns.map((column) => ({ path: column.name })) };
  const presentation = referenceView(schema, table, shown, enabled, namingPath);
  const columns = [...(presentation.view.columns ?? [])];
  const outputs = viewOutputs(columns);
  const used = new Set(outputs);
  const hidden = [...presentation.hidden];
  // A record's configured label may be a joined path and the view may have
  // named an unrelated column or alias the same way. Carry it in a private
  // output so navigation never reads an authored cell as the record's name.
  const naming = rootLabelPath?.(table);
  let labelColumn: { path: string; index: number } | undefined;
  if (naming) {
    let alias = '__tw_label';
    while (used.has(alias)) alias += '_';
    used.add(alias);
    labelColumn = { path: naming, index: columns.length };
    columns.push({ path: naming, alias });
    outputs.push(alias);
    hidden.push(alias);
  }
  const keyColumns = primaryKey(table).map((column, keyIndex) => {
    // A colliding authored output cannot be trusted to contain this path's value.
    let index = columns.findIndex((col, i) => col.path === column && outputs.filter((name) => name === outputs[i]).length === 1);
    if (index < 0) {
      let alias = `__tw_key_${keyIndex}`;
      while (used.has(alias)) alias += '_';
      used.add(alias);
      index = columns.length;
      columns.push({ path: column, alias });
      outputs.push(alias);
      hidden.push(alias);
    }
    return { column, index };
  });
  return { ...presentation, view: { ...presentation.view, columns }, hidden, keyColumns, labelColumn };
}

/** A private synthetic output is the only value record navigation may treat as
 * the configured label. It deliberately does not copy or rename authored cells. */
export function recordViewLabel(
  labelColumn: { path: string; index: number } | undefined,
  outputs: readonly string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (!labelColumn) return {};
  const output = outputs[labelColumn.index];
  if (output === undefined || outputs.filter((name) => name === output).length !== 1 || !Object.hasOwn(row, output)) return {};
  return { [labelColumn.path]: row[output] };
}

/** Returned output positions preserve aliases without narrowing numeric strings. */
export function recordViewKey(
  keyColumns: readonly { column: string; index: number }[],
  outputs: readonly string[],
  row: Record<string, unknown>,
): Record<string, string | number> | null {
  if (!keyColumns.length) return null;
  const entries: Array<[string, string | number]> = [];
  for (const { column, index } of keyColumns) {
    const output = outputs[index];
    if (output === undefined || outputs.filter((name) => name === output).length !== 1 || !Object.hasOwn(row, output)) return null;
    const value = row[output];
    if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return null;
    entries.push([column, value]);
  }
  return Object.fromEntries(entries);
}

/* A child is named by its parent and a word that tells it from its siblings
   ("Ada Park · follow-up", docs/design.md). On the parent's own page every
   sibling repeats the page's title, so the list says the word alone; a name
   of some other parent, or one that is the parent's name and nothing more,
   is left as it is. */
const AFTER_PARENT = /^\s*[·•–—:|/-]\s*/u;

/** A name that opens with the page record's, said without it. */
export function withoutParent<T>(value: T, parent: string | undefined): T | string {
  const name = parent?.trim();
  if (!name || typeof value !== 'string' || !value.startsWith(name)) return value;
  const rest = value.slice(name.length);
  const cut = AFTER_PARENT.exec(rest);
  const word = cut ? rest.slice(cut[0].length) : '';
  return cut && word.trim() ? word : value;
}

/** The rows with every label that opens with the page record's name said without it. */
export function withoutParentName(
  rows: ReadonlyArray<Record<string, unknown>>,
  labelOutputs: readonly string[],
  parent: string | undefined,
): Array<Record<string, unknown>> {
  if (!parent?.trim() || !labelOutputs.length) return rows as Array<Record<string, unknown>>;
  const trim = (value: unknown) => withoutParent(value, parent);
  return rows.map((row) => {
    let next: Record<string, unknown> | undefined;
    for (const output of labelOutputs) {
      if (!Object.hasOwn(row, output)) continue;
      const said = trim(row[output]);
      if (said !== row[output]) (next ??= { ...row })[output] = said;
    }
    return next ?? row;
  });
}
