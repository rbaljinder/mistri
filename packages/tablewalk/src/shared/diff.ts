/**
 * Two schemas, and what is different about them.
 *
 * The question is always the same and always urgent: *is staging the same
 * shape as production?* Asked before a deploy, after a migration, or when one
 * environment behaves differently for reasons nobody can name. The usual
 * answer is two schema dumps and a text diff, which reports every difference
 * in formatting as loudly as the missing column and buries it.
 *
 * This compares the model instead of the text: tables, columns and their
 * types, nullability and defaults, foreign keys and their delete rules. So
 * `varchar(40)` written on two lines is not a difference, and a column that
 * became nullable is — which is the point.
 *
 * Direction matters and is named: `left` is what you have, `right` is what
 * you are comparing against. "Only in production" and "only in staging" are
 * different sentences with different consequences, and a diff that says
 * "differs" is a diff that makes you go and look.
 */
import { primaryKey, type DatabaseSchema, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';

interface ColumnChange {
  column: string;
  /** What differs, in the words a reader needs: type, nullable, default, key. */
  what: string;
  left: string;
  right: string;
}

interface TableDiff {
  table: string;
  onlyIn?: 'left' | 'right';
  columnsOnlyLeft?: string[];
  columnsOnlyRight?: string[];
  changed?: ColumnChange[];
  keysOnlyLeft?: string[];
  keysOnlyRight?: string[];
  deleteRuleChanged?: Array<{ key: string; left: string; right: string }>;
}

interface SchemaDiff {
  left: string;
  right: string;
  tables: TableDiff[];
  /** True when the two schemas describe the same shape. */
  same: boolean;
}

const describeKey = (fk: { from: { table: string; columns: string[] }; to: { table: string; columns: string[] } }) =>
  `${fk.from.columns.join(', ')} → ${fk.to.table}(${fk.to.columns.join(', ')})`;

/** A column's facts as strings, so a difference is a difference in one of them. */
function facts(column: ColumnMeta, table: TableMeta): Record<string, string> {
  return {
    type: column.type,
    nullable: String(column.nullable),
    default: column.default ?? '—',
    key: String(primaryKey(table).includes(column.name)),
    allowed: column.allowed?.length ? column.allowed.join(', ') : '—',
  };
}

export function diffSchemas(left: DatabaseSchema, right: DatabaseSchema): SchemaDiff {
  const byId = (schema: DatabaseSchema) => new Map(schema.tables.map((t) => [t.id, t]));
  const leftTables = byId(left);
  const rightTables = byId(right);
  const tables: TableDiff[] = [];

  /* Union of ids, in one order both sides agree on: a diff whose sections
     move around between runs cannot be diffed itself. */
  const ids = [...new Set([...leftTables.keys(), ...rightTables.keys()])].sort();

  for (const id of ids) {
    const a = leftTables.get(id);
    const b = rightTables.get(id);
    if (!a || !b) {
      tables.push({ table: id, onlyIn: a ? 'left' : 'right' });
      continue;
    }

    const diff: TableDiff = { table: id };
    const aColumns = new Map(a.columns.map((c) => [c.name, c]));
    const bColumns = new Map(b.columns.map((c) => [c.name, c]));

    const onlyLeft = [...aColumns.keys()].filter((n) => !bColumns.has(n));
    const onlyRight = [...bColumns.keys()].filter((n) => !aColumns.has(n));
    if (onlyLeft.length) diff.columnsOnlyLeft = onlyLeft;
    if (onlyRight.length) diff.columnsOnlyRight = onlyRight;

    const changed: ColumnChange[] = [];
    for (const [name, column] of aColumns) {
      const other = bColumns.get(name);
      if (!other) continue;
      const mine = facts(column, a);
      const theirs = facts(other, b);
      for (const what of Object.keys(mine)) {
        if (mine[what] !== theirs[what]) {
          changed.push({ column: name, what, left: mine[what], right: theirs[what] });
        }
      }
    }
    if (changed.length) diff.changed = changed;

    const keysOf = (schema: DatabaseSchema, table: string) =>
      new Map(schema.foreignKeys.filter((fk) => fk.from.table === table).map((fk) => [describeKey(fk), fk]));
    const aKeys = keysOf(left, id);
    const bKeys = keysOf(right, id);

    const keysOnlyLeft = [...aKeys.keys()].filter((k) => !bKeys.has(k));
    const keysOnlyRight = [...bKeys.keys()].filter((k) => !aKeys.has(k));
    if (keysOnlyLeft.length) diff.keysOnlyLeft = keysOnlyLeft;
    if (keysOnlyRight.length) diff.keysOnlyRight = keysOnlyRight;

    /* A delete rule that changed is a foreign key that still exists and now
       does something else on delete — invisible to a "which keys exist"
       comparison, and the difference that turns a safe delete into a
       cascade. */
    const ruleChanges = [...aKeys.entries()]
      .filter(([key, fk]) => bKeys.has(key) && (fk.onDelete ?? 'no action') !== (bKeys.get(key)!.onDelete ?? 'no action'))
      .map(([key, fk]) => ({
        key,
        left: fk.onDelete ?? 'no action',
        right: bKeys.get(key)!.onDelete ?? 'no action',
      }));
    if (ruleChanges.length) diff.deleteRuleChanged = ruleChanges;

    if (Object.keys(diff).length > 1) tables.push(diff);
  }

  return { left: left.label, right: right.label, tables, same: tables.length === 0 };
}

/** The diff as a person reads it. */
export function diffReport(diff: SchemaDiff): string {
  if (diff.same) return `${diff.left} and ${diff.right} have the same shape.`;

  const lines = [
    `# ${diff.left} → ${diff.right}`,
    '',
    `${diff.tables.length} table${diff.tables.length === 1 ? ' differs' : 's differ'}. ` +
      `"Only in ${diff.left}" means it is missing from ${diff.right}.`,
  ];

  for (const table of diff.tables) {
    lines.push('', `## ${table.table}`, '');
    if (table.onlyIn) {
      lines.push(`- Table exists only in **${table.onlyIn === 'left' ? diff.left : diff.right}**.`);
      continue;
    }
    for (const column of table.columnsOnlyLeft ?? []) lines.push(`- Column \`${column}\` only in ${diff.left}.`);
    for (const column of table.columnsOnlyRight ?? []) lines.push(`- Column \`${column}\` only in ${diff.right}.`);
    for (const change of table.changed ?? []) {
      lines.push(`- \`${change.column}\` ${change.what}: **${change.left}** → **${change.right}**`);
    }
    for (const key of table.keysOnlyLeft ?? []) lines.push(`- Foreign key ${key} only in ${diff.left}.`);
    for (const key of table.keysOnlyRight ?? []) lines.push(`- Foreign key ${key} only in ${diff.right}.`);
    for (const rule of table.deleteRuleChanged ?? []) {
      lines.push(`- ${rule.key} on delete: **${rule.left}** → **${rule.right}**`);
    }
  }
  return lines.join('\n');
}
