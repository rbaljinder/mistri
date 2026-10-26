/**
 * A union: one read-only resource over tables that share a shape
 * — My requests over incidents and requested items, in one order, one page.
 * Each branch names its resource and which of its columns stands for each of
 * the union's (`as`); the union adds `from`, the branch's resource, and `key`,
 * its record's id, so a row opens its own record. It is not one statement: a
 * read asks each branch through the reader's own reads — their grants, row
 * policy and hidden columns — and merges the answers (server/app/unionReads.ts).
 * A branch the reader cannot read is no rows of theirs, never a refusal.
 */
import { type AppDef } from './appModel.js';
import { allowKeys, isRecord } from '@mistriwork/engine/shared/model.js';
import {
  columnKind,
  primaryKey,
  tableNamed,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
export type { UnionTable } from '@mistriwork/engine/shared/servedApp.js';

interface AppUnionBranch {
  /** The branch's resource. */
  from: string;
  /** The union's column → this branch's own, local column. */
  as: Readonly<Record<string, string>>;
}
export interface AppUnion {
  name: string;
  branches: readonly AppUnionBranch[];
}

/** The union's own columns: the branch a row came from and its record's id. */
export const UNION_FROM = 'from';
export const UNION_KEY = 'key';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseUnions(raw: unknown, where: string): AppUnion[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: "unions" is a list of union('name', [{ from, as }, …]).`);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const at = `${where}: unions[${i}]`;
    if (!isRecord(item)) throw new Error(`${at} is not a union('name', [{ from, as }, …]).`);
    allowKeys(item, ['name', 'branches'], at);
    if (typeof item.name !== 'string' || !NAME.test(item.name))
      throw new Error(`${at} has no name a resource could have, like "my_requests".`);
    if (seen.has(item.name)) throw new Error(`${at}: a second union is called "${item.name}".`);
    seen.add(item.name);
    if (!Array.isArray(item.branches) || item.branches.length < 2)
      throw new Error(`${at} ("${item.name}") reads fewer than two tables; a list of one is that table's.`);
    const branches = item.branches.map((branch: unknown, b: number): AppUnionBranch => {
      const here = `${at} ("${item.name}"), branch ${b + 1}`;
      if (!isRecord(branch)) throw new Error(`${here} is not { from, as }.`);
      allowKeys(branch, ['from', 'as'], here);
      if (typeof branch.from !== 'string' || !branch.from.trim()) throw new Error(`${here} names no "from" resource.`);
      if (!isRecord(branch.as) || !Object.keys(branch.as).length)
        throw new Error(`${here} says no columns: "as" maps the union's columns to this table's, { title: 'short_description' }.`);
      for (const [name, column] of Object.entries(branch.as)) {
        if (!NAME.test(name) || name === UNION_FROM || name === UNION_KEY)
          throw new Error(`${here}: "${name}" cannot be a union's column ("${UNION_FROM}" and "${UNION_KEY}" are its own).`);
        if (typeof column !== 'string' || !NAME.test(column))
          throw new Error(`${here}: "${name}" is "${String(column)}", which is not one of the table's own columns.`);
      }
      return { from: branch.from.trim(), as: { ...(branch.as as Record<string, string>) } };
    });
    const shape = Object.keys(branches[0]!.as).sort().join(', ');
    const odd = branches.find((branch) => Object.keys(branch.as).sort().join(', ') !== shape);
    if (odd)
      throw new Error(
        `${at} ("${item.name}"): every branch says the same columns; "${odd.from}" says ${Object.keys(odd.as).sort().join(', ')}, the first ${shape}.`,
      );
    return { name: item.name, branches };
  });
}

/** What the startup log and the check name against the whole catalog. */
export function unionProblems(app: AppDef, schema: DatabaseSchema): string[] {
  const problems: string[] = [];
  for (const union of app.unions ?? []) {
    const at = `unions "${union.name}"`;
    if (tableNamed(schema, union.name) || Object.hasOwn(app.resources ?? {}, union.name))
      problems.push(`${at}: "${union.name}" is already a table; a union needs a name of its own.`);
    const kinds = new Map<string, string>();
    for (const branch of union.branches) {
      const table = tableNamed(schema, branch.from);
      if (!Object.hasOwn(app.resources ?? {}, branch.from) || !table) {
        problems.push(`${at}: "${branch.from}" is not one of the App's resources.`);
        continue;
      }
      if (primaryKey(table).length !== 1) problems.push(`${at}: "${branch.from}" has no single-column key, so its rows could not open.`);
      for (const [name, local] of Object.entries(branch.as)) {
        const column = table.columns.find((column) => column.name === local);
        if (!column) {
          problems.push(`${at}: "${branch.from}" has no column "${local}" (for "${name}").`);
          continue;
        }
        const kind = columnKind(column.type);
        const first = kinds.get(name);
        if (first === undefined) kinds.set(name, kind);
        else if (first !== kind)
          problems.push(`${at}: "${name}" is ${first} in one branch and ${kind} in "${branch.from}"; one column is one kind.`);
      }
    }
  }
  return problems;
}

/**
 * The catalog with each union this reader can read: a read-only table of the
 * union's columns, typed by the first readable branch, holding only the
 * branches whose table, key and columns this catalog serves. None readable,
 * no table: a union is never a way to a column a grant keeps.
 */
export function withUnions(app: AppDef, schema: DatabaseSchema): DatabaseSchema {
  if (!app.unions?.length) return schema;
  const added: TableMeta[] = [];
  for (const union of app.unions) {
    if (schema.tables.some((table) => table.id === union.name)) continue;
    const readable = union.branches.flatMap((branch) => {
      const table = tableNamed(schema, branch.from);
      const key = table ? primaryKey(table) : [];
      const columns = table && key.length === 1 ? Object.values(branch.as).map((local) => table.columns.find((c) => c.name === local)) : [];
      return table && columns.length && columns.every(Boolean)
        ? [{ branch: { from: table.id, key: key[0]!, as: branch.as }, columns: columns as ColumnMeta[] }]
        : [];
    });
    if (!readable.length) continue;
    const first = readable[0]!;
    const names = Object.keys(first.branch.as);
    added.push({
      id: union.name,
      name: union.name,
      schema: '',
      isView: true,
      insertable: false,
      deletable: false,
      columns: [
        { name: UNION_FROM, type: 'TEXT', nullable: false, primaryKey: true },
        { name: UNION_KEY, type: 'TEXT', nullable: false, primaryKey: true },
        ...names.map((name, i) => ({
          name,
          type: first.columns[i]!.type,
          nullable: readable.some(({ branch, columns }) => columns[Object.keys(branch.as).indexOf(name)]?.nullable !== false),
          primaryKey: false,
        })),
      ],
      union: { branches: readable.map(({ branch }) => branch) },
    });
  }
  return added.length ? { ...schema, tables: [...schema.tables, ...added] } : schema;
}
