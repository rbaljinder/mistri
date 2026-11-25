/**
 * `mistri check` for an App's declared data rules (shared/appDataRules.ts), read off the database itself.
 *
 * What the catalog alone can judge — a rule's columns, its range, its `when` — is a problem the App does not load
 * with (appDataRules). Here is what takes the connection's own adapter:
 *
 * - a `noOverlap` on PostgreSQL with no exclusion constraint that holds it, or one that holds another rule
 *   [no-overlap-constraint]: a problem here, and what keeps a server from starting (`unheldNoOverlap`);
 * - a `constraints` name the table has no constraint by: its refusal would never be said, and the write would
 *   still answer `constraint_failed` [constraint-unknown]; and one this engine never names in a refusal (SQLite
 *   reports a unique rule by its columns) [constraint-unnamed];
 * - a `noOverlap` on SQLite: held by the App's own read, so check says what a PostgreSQL database will need
 *   before the App is hosted on one [no-overlap-postgres], and where a row policy can hide the row a write would
 *   meet [no-overlap-rows].
 */
import type { Adapter, TableConstraint } from '@mistriwork/engine/adapters/adapter.js';
import { tableNamed } from '@mistriwork/engine/shared/schema.js';
import { appDataRules, noOverlapDdl, noOverlapUnheld, tenantColumnOf } from '../../shared/appDataRules.js';
import type { AppDef } from '../../shared/appModel.js';
import type { RuntimeResources } from './appRuntimeResources.js';

/** Each resource's constraints, read once per connection through the connection's own adapter, by the App's name for the table. */
function constraintReader(resources: RuntimeResources, open: (connection: string) => Promise<Adapter>) {
  const byConnection = new Map<string, Promise<ReadonlyMap<string, readonly TableConstraint[]> | undefined>>();
  return async (logical: string): Promise<readonly TableConstraint[] | undefined> => {
    let connection: string;
    try {
      connection = resources.connectionFor(logical);
    } catch {
      return undefined;
    }
    if (!byConnection.has(connection))
      byConnection.set(
        connection,
        Promise.resolve()
          .then(() => open(connection))
          .then((adapter) => adapter.constraints?.())
          .catch(() => undefined),
      );
    const found = await byConnection.get(connection)!;
    if (!found) return undefined;
    for (const [id, constraints] of found) {
      try {
        if (resources.toLogicalAt(id, connection) === logical) return constraints;
      } catch {
        /* A table the App does not serve. */
      }
    }
    return [];
  };
}

/**
 * The `noOverlap` rules of an App's PostgreSQL tables with no constraint behind them (shared/appDataRules.ts
 * noOverlapUnheld): what `mistri check` reports and what keeps a server from starting.
 */
export function unheldNoOverlap(
  app: AppDef,
  resources: RuntimeResources,
  open: (connection: string) => Promise<Adapter>,
): Promise<string[]> {
  if (!Object.values(app.resources ?? {}).some((resource) => resource.noOverlap?.length)) return Promise.resolve([]);
  const read = constraintReader(resources, open);
  const logical = (table: string) => Object.keys(app.resources ?? {}).find((name) => tableNamed(resources.schema, name)?.id === table);
  return noOverlapUnheld(app, resources.schema, async (table) => {
    const name = logical(table);
    return name === undefined ? undefined : read(name);
  });
}

export async function dataRuleFindings(
  app: AppDef,
  resources: RuntimeResources,
  /* The connection's own adapter: the App's source adapter answers only what an App request asks. */
  open: (connection: string) => Promise<Adapter>,
  /** The App's schema.sql, where it keeps one: a constraint it already declares is not said again. */
  declared?: string,
): Promise<{ problems: string[]; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { schema } = resources;
  const rules = appDataRules(app, schema);
  const constraintsOf = constraintReader(resources, open);
  problems.push(...(await unheldNoOverlap(app, resources, open)));
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    if (!table) continue;
    const sqlite = (table.sourceDialect ?? schema.dialect) === 'sqlite';
    if (resource.constraints) {
      const found = await constraintsOf(name);
      for (const constraint of Object.keys(resource.constraints)) {
        if (!found) continue;
        const held = found.filter((item) => item.name === constraint);
        if (!held.length)
          problems.push(
            `resources "${name}", constraints "${constraint}": "${name}" has no constraint of that name [constraint-unknown]: ` +
              `a refused write is said by the name the database gives the constraint` +
              `${
                found.some((item) => item.named)
                  ? ` (it has ${found
                      .filter((item) => item.named)
                      .slice(0, 8)
                      .map((item) => `"${item.name}"`)
                      .join(', ')})`
                  : ''
              }` +
              `${sqlite ? '; on SQLite that is a named CHECK (CONSTRAINT <name> CHECK (…)) or what a trigger raises' : ''}.`,
          );
        else if (!held.some((item) => item.named))
          warnings.push(
            `resources "${name}", constraints "${constraint}": SQLite reports a unique rule by its columns, never by its name [constraint-unnamed]: ` +
              `this refusal is said on PostgreSQL only; on SQLite the write answers duplicate_value beside the column.`,
          );
      }
    }
    if (!sqlite) continue;
    for (const rule of rules.overlaps.get(table.id) ?? []) {
      if (!declared?.includes(rule.constraint))
        warnings.push(
          `resources "${name}", noOverlap: held by mistri's own read on SQLite, where one writer runs at a time; a PostgreSQL database holds it with ` +
            `an exclusion constraint, and the App will not load on one without it [no-overlap-postgres]: ${noOverlapDdl(rule, postgresTyped(table), tenantColumnOf(app, schema, name))}`,
        );
      if (app.auth?.rows === 'policy')
        warnings.push(
          `resources "${name}", noOverlap: on SQLite the rule is read through the writer's own rows, so a row the row policy hides from them ` +
            `does not refuse their write [no-overlap-rows]: PostgreSQL's constraint sees every row. Test the rule on PostgreSQL where a role reads only some of "${name}".`,
        );
    }
  }
  return { problems, warnings };
}

/* A SQLite table as its PostgreSQL twin would type the ends of a range: what the printed statement is written for. */
function postgresTyped<T extends { columns: ReadonlyArray<{ name: string; type?: string }> }>(table: T): T {
  const typed = (type: string | undefined) => {
    const said = (type ?? '').toLowerCase();
    if (/^date$/.test(said)) return 'date';
    if (/date|time/.test(said)) return 'timestamp';
    if (/int/.test(said)) return 'integer';
    if (/num|dec|real|float|double/.test(said)) return 'numeric';
    return 'timestamp';
  };
  return {
    ...table,
    columns: table.columns.map((column) => ({
      ...column,
      type: typed(column.type),
    })),
  };
}
