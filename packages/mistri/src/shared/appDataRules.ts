/**
 * Declared data rules: `noOverlap` and `constraints`.
 *
 *   booking: {
 *     noOverlap: { by: ['chair_id'], from: 'starts_at', to: 'ends_at', when: 'status != cancelled',
 *                  message: 'That chair is taken then.' },
 *     constraints: { booking_fee_positive: { field: 'fee_cents', message: 'A fee is more than zero.' } },
 *   }
 *
 * `constraints` is the general half: a database constraint, by the name a refused write carries, said as a field's
 * refusal in the App's fixed words. The constraint is the App's own, made by its migration; mistri only says what
 * its refusal means. The words are said as written and never filled, so a refusal carries no value of any row —
 * including the row it conflicts with, which the person may not be able to read.
 *
 * `noOverlap` is one such constraint mistri knows the meaning of: among rows equal on every `by` column, no two may
 * hold ranges that meet. A range is half-open, `[from, to)`: one that ends at ten and one that starts at ten do not
 * meet. A row whose `by`, `from` or `to` is empty, whose range is empty (`from = to`), or that `when` leaves out is
 * outside the rule. Who holds it differs by engine, because what can hold it does:
 *
 * - PostgreSQL: an exclusion constraint (`EXCLUDE USING gist (… WITH =, tsrange(from, to) WITH &&)`), which is the
 *   only thing that holds under several writers: two transactions that each read the slot free cannot both commit.
 *   mistri owns no DDL for an App's tables, so the constraint is the migration's, and `mistri check` holds the
 *   declaration to it (`noOverlapBacking`) and prints the statement to add (`noOverlapDdl`). Its refusal is said
 *   through the same map as any named constraint's.
 * - SQLite: one writer at a time, so the App's write layer reads for a meeting row inside the write's own
 *   transaction (server/app/appDataRules.ts).
 *
 * This module is the catalog's half: what a rule names, resolved once, and the problems that keep an App from
 * loading.
 */
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import { columnKind, tableNamed, type DatabaseSchema, type TableConstraint, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { atWhenFilter } from './appAtWhen.js';
import type { AppDef } from './appModel.js';

/** What a write the rule refuses says when the rule gives no `message`. */
const NO_OVERLAP_MESSAGE = 'This overlaps another record.';

/** One `noOverlap` rule against the catalog. */
export interface NoOverlapRule {
  /** The table's id. */
  table: string;
  by: string[];
  from: string;
  to: string;
  /** `when`, as conditions a statement binds; absent, every row is in the rule. */
  when?: Filter;
  /** The column the refusal is put beside. */
  field: string;
  message: string;
  /** The name of the PostgreSQL constraint that holds it, and of the rule in a refusal's record. */
  constraint: string;
  /** Every column the rule reads: an update that writes none of them cannot break it. */
  reads: string[];
}

/** What a named constraint's refusal says, and beside which column. */
export interface ConstraintRefusal {
  field: string;
  message: string;
}

interface AppDataRules {
  /** `noOverlap` rules by table id. */
  overlaps: Map<string, NoOverlapRule[]>;
  /** Constraint name → its refusal, by table id: the `constraints` a resource declares and each `noOverlap`'s own. */
  constraints: Map<string, Map<string, ConstraintRefusal>>;
  problems: string[];
}

/* The comparisons a `when` may make: each reads the same on both engines and is immutable, as an index predicate
   has to be. A pattern match compares under a collation, which the two engines do not share. */
const WHEN_OPS: ReadonlySet<string> = new Set(['=', '!=', '<', '<=', '>', '>=', 'in', 'isNull', 'isNotNull']);

/** A table's engine: its own where a catalog merges sources, else the catalog's. */
const engineOf = (schema: DatabaseSchema, table: TableMeta) => table.sourceDialect ?? schema.dialect;

/**
 * The PostgreSQL range a column's type makes: the constructor an exclusion constraint's key is written with.
 * Undefined for a type with no range of its own (text, a time of day), which no constraint can hold.
 */
function postgresRange(type: string | undefined): string | undefined {
  const said = (type ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (said === 'date') return 'daterange';
  if (said === 'timestamp with time zone' || said === 'timestamptz') return 'tstzrange';
  if (said === 'timestamp without time zone' || said === 'timestamp') return 'tsrange';
  if (said === 'integer' || said === 'int' || said === 'int4' || said === 'smallint' || said === 'int2') return 'int4range';
  if (said === 'bigint' || said === 'int8') return 'int8range';
  if (said === 'numeric' || said === 'decimal') return 'numrange';
  return undefined;
}

/**
 * The column a tenant-owned table is owned by: its one reference to the tenancy profile (tenantOwnership.ts allows
 * a tenant table no other). Undefined for a table no tenant owns.
 */
export function tenantColumnOf(app: AppDef, schema: DatabaseSchema, resource: string): string | undefined {
  const profile = app.auth?.rows === 'tenant' ? app.auth.tenancy?.profile : undefined;
  if (!profile || app.resources?.[resource]?.owner !== 'tenant') return undefined;
  const table = tableNamed(schema, resource);
  const home = tableNamed(schema, profile);
  if (!table || !home) return undefined;
  const direct = table.columns.filter((column) => column.references?.table === home.id).map((column) => column.name);
  const keyed = schema.foreignKeys
    .filter((fk) => fk.from.table === table.id && fk.to.table === home.id && fk.from.columns.length === 1)
    .map((fk) => fk.from.columns[0]!);
  const columns = [...new Set([...direct, ...keyed])];
  return columns.length === 1 ? columns[0] : undefined;
}

/** Every resource's `noOverlap` and `constraints` against the catalog, with what keeps a rule from holding. */
export function appDataRules(app: AppDef, schema: DatabaseSchema): AppDataRules {
  const overlaps = new Map<string, NoOverlapRule[]>();
  const constraints = new Map<string, Map<string, ConstraintRefusal>>();
  const problems: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.noOverlap?.length && !resource.constraints) continue;
    const table = tableNamed(schema, name);
    // A resource the catalog lacks is said once, by the resource check.
    if (!table) continue;
    const has = (column: string) => table.columns.some((item) => item.name === column);
    const named = new Map<string, ConstraintRefusal>();
    for (const [constraint, said] of Object.entries(resource.constraints ?? {})) {
      if (!has(said.field)) {
        problems.push(
          `resources "${name}", constraints "${constraint}": "field" names "${said.field}", which is not a column of "${name}" [constraint-field]: ` +
            `name the column the refusal is put beside.`,
        );
        continue;
      }
      named.set(constraint, { field: said.field, message: said.message });
    }
    const declared = resource.noOverlap ?? [];
    declared.forEach((rule, i) => {
      const at = `resources "${name}", noOverlap${declared.length > 1 ? ` rule ${i + 1}` : ''}`;
      const missing = [...rule.by, rule.from, rule.to, ...(rule.field ? [rule.field] : [])].find((column) => !has(column));
      if (missing) {
        problems.push(
          `${at}: "${missing}" is not a column of "${name}" [no-overlap-column]: "by", "from", "to" and "field" name the resource's own columns.`,
        );
        return;
      }
      const from = table.columns.find((column) => column.name === rule.from)!;
      const to = table.columns.find((column) => column.name === rule.to)!;
      const postgres = engineOf(schema, table) === 'postgres';
      if (
        postgres
          ? !postgresRange(from.type) || postgresRange(from.type) !== postgresRange(to.type)
          : // SQLite keeps a date as text (2026-11-02 09:00:00), which orders as its instants do; a yes/no or a blob has no order to range over.
            columnKind(from.type) !== columnKind(to.type) || !['date', 'number', 'text'].includes(columnKind(from.type))
      ) {
        problems.push(
          `${at}: "${rule.from}" (${from.type || 'untyped'}) and "${rule.to}" (${to.type || 'untyped'}) do not make a range [no-overlap-range]: ` +
            `both ends are one type, a date, a timestamp or a number${postgres ? ' (date, timestamp, timestamptz, integer, bigint or numeric)' : ''}.`,
        );
        return;
      }
      let when: Filter | undefined;
      if (rule.when !== undefined) {
        const read = atWhenFilter(schema, table, rule.when);
        const beyond = read.filter?.groups.flat().find((condition) => !WHEN_OPS.has(condition.op) || condition.collation !== undefined);
        if (read.problem || !read.filter || beyond || !read.filter.groups.length) {
          problems.push(
            `${at}: "when" ${read.problem ? `does not read: ${read.problem}` : beyond ? `compares "${beyond.column}" in a way a constraint's condition cannot (${beyond.op})` : 'holds no condition'} [no-overlap-when]: ` +
              `it compares the row's own stored columns with fixed values, like 'status != cancelled' or 'status in (booked, held)'.`,
          );
          return;
        }
        when = read.filter;
      }
      const constraint = rule.constraint ?? `${table.name}_no_overlap`;
      const taken = named.has(constraint) || (overlaps.get(table.id) ?? []).some((other) => other.constraint === constraint);
      if (taken || constraint.length > 63) {
        problems.push(
          `${at}: the constraint name "${constraint}" is ${taken ? 'used twice on this resource' : 'longer than the 63 characters PostgreSQL keeps'} [no-overlap-name]: ` +
            `give the rule its own "constraint" name.`,
        );
        return;
      }
      const field = rule.field ?? rule.from;
      const message = rule.message ?? NO_OVERLAP_MESSAGE;
      const resolved: NoOverlapRule = {
        table: table.id,
        by: [...rule.by],
        from: rule.from,
        to: rule.to,
        ...(when ? { when } : {}),
        field,
        message,
        constraint,
        reads: [...new Set([...rule.by, rule.from, rule.to, ...(when?.groups.flat().map((condition) => condition.column) ?? [])])],
      };
      overlaps.set(table.id, [...(overlaps.get(table.id) ?? []), resolved]);
      named.set(constraint, { field, message });
    });
    if (named.size) constraints.set(table.id, named);
  }
  return { overlaps, constraints, problems };
}

/* ---------- PostgreSQL: the constraint that holds a rule ---------- */

const plain = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`);

function literal(value: string | number | boolean): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${value.replaceAll("'", "''")}'`;
}

/* One condition as PostgreSQL writes it back from its catalog, so a declared rule and a stored predicate compare. */
function conditionSql(condition: Condition): string {
  const column = plain(condition.column);
  if (condition.op === 'isNull') return `${column} IS NULL`;
  if (condition.op === 'isNotNull') return `${column} IS NOT NULL`;
  if (condition.op === 'in') {
    const list = Array.isArray(condition.value) ? condition.value : [condition.value as string | number];
    return `${column} = ANY (ARRAY[${list.map(literal).join(', ')}])`;
  }
  return `${column} ${condition.op === '!=' ? '<>' : condition.op} ${literal(condition.value as string | number | boolean)}`;
}

/** A rule's `when` as an index predicate: OR of ANDs, each condition in its own parentheses. */
function noOverlapPredicate(when: Filter | undefined): string | undefined {
  if (!when?.groups.length) return undefined;
  const groups = when.groups.map((group) => group.map((condition) => `(${conditionSql(condition)})`).join(' AND '));
  if (groups.length === 1) return when.groups[0]!.length === 1 ? groups[0]!.slice(1, -1) : groups[0];
  return groups.map((group) => `(${group})`).join(' OR ');
}

/**
 * The statements that give a PostgreSQL table the constraint a rule needs. `tenant` is the table's ownership column
 * in a tenant App: the constraint includes it, so it holds within one tenant and says nothing of another's rows.
 */
export function noOverlapDdl(rule: NoOverlapRule, table: TableMeta, tenant?: string): string {
  const equal = [...new Set([...(tenant ? [tenant] : []), ...rule.by])];
  const range = postgresRange(table.columns.find((column) => column.name === rule.from)?.type) ?? 'tsrange';
  const predicate = noOverlapPredicate(rule.when);
  const target = table.schema && table.schema !== 'public' ? `${plain(table.schema)}.${plain(table.name)}` : plain(table.name);
  return (
    `${equal.length ? 'CREATE EXTENSION IF NOT EXISTS btree_gist; ' : ''}` +
    `ALTER TABLE ${target} ADD CONSTRAINT ${plain(rule.constraint)} EXCLUDE USING gist (` +
    [...equal.map((column) => `${plain(column)} WITH =`), `${range}(${plain(rule.from)}, ${plain(rule.to)}) WITH &&`].join(', ') +
    `)${predicate ? ` WHERE (${predicate})` : ''};`
  );
}

/*
 * An expression as the catalog wrote it and as this module writes it, made comparable: casts, quotes, parentheses
 * and spaces are how PostgreSQL dresses the same expression (`((status)::text <> 'cancelled'::text)`), so they go.
 * Type names are lower case and keywords upper, which is what tells a cast's end from the word after it.
 */
const bare = (text: string) => text.replace(/::"?[a-z_][a-z0-9_ ]*"?(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?/g, '').replace(/[\s()"]/g, '');

/**
 * Why a PostgreSQL table's constraints do not hold a rule, with the statement that would; undefined when one does.
 * A constraint holds the rule when it is an exclusion constraint of the rule's name, checked as each statement
 * runs, that compares exactly the `by` columns (and the tenant's) with `=` and the range `[from, to)` with `&&`,
 * under the rule's `when` and nothing else.
 */
export function noOverlapBacking(
  rule: NoOverlapRule,
  table: TableMeta,
  tenant: string | undefined,
  found: readonly TableConstraint[],
): string | undefined {
  const ddl = noOverlapDdl(rule, table, tenant);
  const held = found.find((constraint) => constraint.name === rule.constraint);
  if (!held) return `"${table.name}" has no constraint named "${rule.constraint}". Add it in a migration: ${ddl}`;
  const differs = (why: string) => `the constraint "${rule.constraint}" on "${table.name}" ${why}. Drop it and add it as declared: ${ddl}`;
  if (held.kind !== 'exclusion' || !held.exclusion) return differs('is not an exclusion constraint');
  if (held.exclusion.deferrable) return differs('is DEFERRABLE, so it would refuse at COMMIT and not the write that broke it');
  if (held.exclusion.method !== 'gist') return differs(`uses ${held.exclusion.method || 'another index method'}, not gist`);
  const equal = new Set([...(tenant ? [tenant] : []), ...rule.by]);
  const range = postgresRange(table.columns.find((column) => column.name === rule.from)?.type);
  const ranges = [`${range}${rule.from},${rule.to}`, `${range}${rule.from},${rule.to},'['`];
  const keys = held.exclusion.keys.map((key) => ({
    expression: bare(key.expression),
    operator: key.operator,
  }));
  const equals = keys.filter((key) => key.operator === '=').map((key) => key.expression);
  const others = keys.filter((key) => key.operator !== '=');
  if (equals.length !== equal.size || equals.some((column) => !equal.has(column)))
    return differs(
      `compares ${equals.length ? equals.map((column) => `"${column}"`).join(', ') : 'no column'} with =, where the rule needs ${
        equal.size ? [...equal].map((column) => `"${column}"`).join(', ') : 'none'
      }${tenant ? ` (the tenant column "${tenant}" included)` : ''}`,
    );
  if (others.length !== 1 || others[0]!.operator !== '&&' || !ranges.includes(others[0]!.expression))
    return differs(`does not exclude the range ${range}(${rule.from}, ${rule.to}) with &&`);
  const wanted = noOverlapPredicate(rule.when);
  if (bare(wanted ?? '') !== bare(held.exclusion.predicate ?? ''))
    return differs(
      wanted
        ? `${held.exclusion.predicate ? `holds WHERE ${held.exclusion.predicate}` : 'has no WHERE'}, where the rule's "when" is ${wanted}`
        : `holds only WHERE ${held.exclusion.predicate}, and the rule has no "when"`,
    );
  return undefined;
}

/**
 * The `noOverlap` rules of an App's PostgreSQL tables that the database does not hold, each as the problem that
 * keeps the App from serving, with the statement to run. On PostgreSQL the rule is the constraint: served without
 * it, a rule that held in development on SQLite would be nothing at all where the App is hosted. `constraintsOf`
 * answers a table's constraints by its id, or undefined where they cannot be read, which concludes nothing.
 */
export async function noOverlapUnheld(
  app: AppDef,
  schema: DatabaseSchema,
  constraintsOf: (table: string) => Promise<readonly TableConstraint[] | undefined>,
  /** Each tenant-owned table's ownership column, where the deployment's policy says it; else read off the catalog (tenantColumnOf). */
  owners?: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const problems: string[] = [];
  const { overlaps } = appDataRules(app, schema);
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.noOverlap?.length) continue;
    const table = tableNamed(schema, name);
    if (!table || engineOf(schema, table) !== 'postgres') continue;
    const rules = overlaps.get(table.id) ?? [];
    if (!rules.length) continue;
    const found = await constraintsOf(table.id);
    if (!found) continue;
    const tenant = owners ? owners[table.id] : tenantColumnOf(app, schema, name);
    rules.forEach((rule, i) => {
      const unheld = noOverlapBacking(rule, table, tenant, found);
      if (unheld)
        problems.push(
          `resources "${name}", noOverlap${rules.length > 1 ? ` rule ${i + 1}` : ''}: PostgreSQL holds this rule with an exclusion constraint, and ${unheld} [no-overlap-constraint]`,
        );
    });
  }
  return problems;
}
