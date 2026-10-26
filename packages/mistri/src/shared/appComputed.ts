/**
 * A resource's computed columns (computed.ts) as one catalog serves them:
 * each expression judged against that catalog — every column it names, what
 * each is, what the whole comes to — and served as `TableMeta.computed` where
 * every name resolves.
 *
 * Like a rollup, the same rule answers two readers. At load, against the
 * whole catalog, what does not resolve is a problem naming the fix. Per
 * request, against the catalog this reader is served — pruned to their grants
 * and without the columns no reader is served — a computed column that reads
 * a column they cannot is simply not served: a list showing it says the
 * column is not there, and no value says what its inputs would not.
 */
import { grantsByRole, type AppDef } from './appModel.js';
import { appZone } from './appUi.js';
import {
  ComputedError,
  computedKind,
  computedReads,
  foldConstants,
  type ComputedColumn,
  type ComputedNode,
  type ValueKind,
} from '@mistriwork/engine/shared/computed.js';
import { parseComputed } from '@mistriwork/engine/shared/computedParse.js';
import { columnKind, isFlagColumn, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { LABEL_SEGMENT } from '@mistriwork/engine/shared/recordLabel.js';
import { tryResolvePath } from '@mistriwork/engine/shared/viewPaths.js';

/** A path's kind in this catalog, or why it cannot be read here. */
function kindAt(schema: DatabaseSchema, table: TableMeta, path: string): { kind: ValueKind; native?: boolean } | { problem: string } {
  const { resolved, error } = tryResolvePath(schema, table.id, path);
  if (!resolved) return { problem: error?.message ?? `"${path}" is not a column of ${table.name}.` };
  if (resolved.computed) return { problem: `"${path}" is itself computed; a computed column reads the table's columns (and its rollups).` };
  if (path.split('.').pop() === LABEL_SEGMENT) return { kind: 'text' };
  const column = resolved.column;
  if (resolved.rollup && !resolved.rollup.through) return { kind: columnKind(column.type) === 'date' ? 'date' : 'number' };
  if (isFlagColumn(column)) return { kind: 'boolean', native: columnKind(column.type) === 'boolean' };
  const kind = columnKind(column.type);
  return { kind: kind === 'other' ? 'text' : kind };
}

export function appComputedRules(
  app: AppDef,
  schema: DatabaseSchema,
): { rules: Map<string, Record<string, ComputedColumn>>; problems: string[] } {
  const rules = new Map<string, Record<string, ComputedColumn>>();
  const problems: string[] = [];
  const exact = grantsByRole(app);
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.computed) continue;
    const table = exact ? schema.tables.find((candidate) => candidate.id === name) : tableNamed(schema, name);
    if (!table) continue;
    const at = `resources "${name}", computed`;
    if (schema.dialect === 'http') {
      problems.push(`${at}: "${table.name}" is read from an API, which computes nothing. A computed column needs a database source.`);
      continue;
    }
    const served: Record<string, ComputedColumn> = {};
    for (const [key, declared] of Object.entries(resource.computed)) {
      const here = `${at} "${key}"`;
      if (table.columns.some((column) => column.name === key) || (table.rollups && Object.hasOwn(table.rollups, key))) {
        problems.push(
          `${here}: "${table.name}" already has a column or a rollup "${key}". A computed column reads like a column, so it needs a name of its own.`,
        );
        continue;
      }
      const isColumn = (path: string) => Boolean(tryResolvePath(schema, table.id, path).resolved);
      let parsed: ComputedNode;
      try {
        parsed = parseComputed(declared.value, isColumn);
      } catch (error) {
        const at =
          error instanceof ComputedError ? ` (at character ${error.at + 1}: "${declared.value.slice(error.at, error.at + 24)}")` : '';
        problems.push(`${here}: ${(error as Error).message}${at}`);
        continue;
      }
      const kinds = new Map<string, { kind: ValueKind; native?: boolean }>();
      let unread: string | undefined;
      for (const path of computedReads(parsed)) {
        const found = kindAt(schema, table, path);
        if ('problem' in found) {
          unread = found.problem;
          break;
        }
        kinds.set(path, found);
      }
      if (unread) {
        problems.push(`${here}: ${unread}`);
        continue;
      }
      let kind: ValueKind;
      try {
        kind = computedKind(parsed, (path) => kinds.get(path)?.kind);
      } catch (error) {
        problems.push(`${here}: ${(error as Error).message}`);
        continue;
      }
      if (kind !== declared.type) {
        problems.push(
          `${here} is declared a ${declared.type}, and "${declared.value}" is a ${kind === 'span' ? 'span of days' : kind}. ` +
            (kind === 'text' ? 'A computed column is a yes-or-no, a number or a date.' : `Declare it computed.${kind}(…).`),
        );
        continue;
      }
      served[key] = { type: declared.type, expr: parsed, reads: [...kinds.keys()] };
    }
    if (Object.keys(served).length) rules.set(table.id, served);
    /* Read-only everywhere: a column the statement computes is never a field a
       form asks for, an action sets or a rule lets anyone write. Its reads say
       who may see it, so no rule names it to be read either. */
    const named = (list: readonly string[] | undefined, where: string, verb: string) => {
      for (const column of list ?? []) {
        if (Object.hasOwn(resource.computed!, column))
          problems.push(
            `${where} ${verb} "${column}", which is computed: it is never written, and it is read wherever every column it reads is.`,
          );
      }
    };
    named(resource.fields?.write, `resources "${name}", "fields", write`, 'names');
    named(resource.fields?.read, `resources "${name}", "fields", read`, 'names');
    named(resource.form?.show, `resources "${name}", "form", show`, 'asks for');
    for (const action of resource.actions ?? []) named(Object.keys(action.set ?? {}), `resources "${name}", action "${action.id}"`, 'sets');
    for (const [role, grant] of Object.entries(app.auth?.roles ?? {})) {
      const rule = grant.fields?.[name];
      named(rule?.write, `auth, role "${role}", "fields", "${name}", write`, 'names');
      named(rule?.read, `auth, role "${role}", "fields", "${name}", read`, 'names');
    }
  }
  return { rules, problems };
}

/* The App's day, as a `today` in a query is (app.ts zonedNow): its zone's calendar, else the server's. */
function dayIn(zone: string | undefined, now: Date): string {
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (!zone) return local;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
      now,
    );
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return local;
  }
}

/** What `today`, `now` and `me` come to for this reader, as a computed column folds them; `zone` is the reader's (appZone). */
export function computedConstants(
  app: AppDef,
  now: Date,
  me: string | null,
  zone?: string,
): { today: string; now: string; me: string | null } {
  return { today: dayIn(appZone(app.ui, zone), now), now: now.toISOString(), me };
}

/**
 * The catalog with each table's computed columns this reader is served, their
 * constants folded: `today` the App's day in its zone, `now` the instant, `me`
 * the reader's email (nobody, for a visitor or a check).
 */
export function withComputed(
  app: AppDef,
  schema: DatabaseSchema,
  now: Date = new Date(),
  me: string | null = null,
  zone?: string,
): DatabaseSchema {
  if (!Object.values(app.resources ?? {}).some((resource) => resource.computed)) return schema;
  const { rules } = appComputedRules(app, schema);
  if (!rules.size) return schema;
  const values = computedConstants(app, now, me, zone);
  return {
    ...schema,
    tables: schema.tables.map((table) =>
      rules.has(table.id)
        ? {
            ...table,
            computed: Object.fromEntries(
              Object.entries(rules.get(table.id)!).map(([key, computed]) => [
                key,
                { ...computed, expr: foldConstants(computed.expr, values) },
              ]),
            ),
          }
        : table,
    ),
  };
}
