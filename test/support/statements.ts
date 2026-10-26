/**
 * The statements a piece of work sends, as the dev observer sees them: every
 * driver call inside one span, with its SQL (adapters/telemetry/drivers.ts).
 * For the tests that hold the speed budgets (scripts/statement-budgets.mjs)
 * and the caches' "never wrong" proofs, which count catalog reads.
 */
import { addSink, inSpan } from '../../packages/engine/src/adapters/telemetry/trace.js';
import { instrumentDrivers } from '../../packages/engine/src/adapters/telemetry/drivers.js';
import { statementShape } from '../../packages/engine/src/adapters/telemetry/statement.js';

/** A read of the catalog: PostgreSQL's system catalogs and information_schema, SQLite's schema table and PRAGMAs. */
export const CATALOG =
  /\b(pg_catalog|pg_class|pg_attribute|pg_trigger|pg_collation|pg_namespace|pg_index|pg_constraint|pg_rewrite|pg_policy|pg_type|pg_proc|pg_roles|pg_auth_members|information_schema|sqlite_master|sqlite_schema|pragma_\w+|PRAGMA)\b/i;
/** The one statement a transaction spends on knowing the catalog has not moved: not a catalog read, its validation. */
export const EPOCH = /__mistri_schema_epoch|pragma_schema_version/;
const CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

export interface Counted {
  statements: string[];
  total: number;
  /** Catalog reads, the epoch statement not among them. */
  catalog: string[];
  epoch: number;
  /** Statements whose shape already ran in this work, BEGIN and COMMIT aside. */
  repeated: string[];
}

export function count(statements: readonly string[]): Counted {
  const seen = new Map<string, number>();
  const repeated: string[] = [];
  for (const sql of statements) {
    if (CONTROL.test(sql) && !EPOCH.test(sql)) continue;
    const shape = statementShape(sql);
    const n = (seen.get(shape) ?? 0) + 1;
    seen.set(shape, n);
    if (n > 1) repeated.push(shape);
  }
  return {
    statements: [...statements],
    total: statements.length,
    epoch: statements.filter((sql) => EPOCH.test(sql)).length,
    catalog: statements.filter((sql) => CATALOG.test(sql) && !EPOCH.test(sql)),
    repeated,
  };
}

/** Run `work` inside a span and collect every statement it sent. */
export async function statementsOf<T>(work: () => Promise<T>): Promise<{ result: T } & Counted> {
  instrumentDrivers();
  const statements: string[] = [];
  const remove = addSink({
    local: true,
    onEnd(span) {
      if (span.attributes['db.system.name'] && typeof span.detail.sql === 'string') statements.push(span.detail.sql);
    },
  });
  try {
    const result = await inSpan('measured', {}, () => work());
    return { result, ...count(statements) };
  } finally {
    remove();
  }
}
