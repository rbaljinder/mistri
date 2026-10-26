/**
 * The rows PostgreSQL's catalog queries return, as the adapter's
 * introspection reads them, and the two readings it makes of them: a
 * column's value vocabulary from its CHECK constraints, and the planner's row
 * estimate. `postgresCatalog.ts` holds the queries; this holds their shapes.
 */
import { checkTextRule, checkVocabulary } from '../shared/vocabulary.js';

export interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  identity_generation: string | null;
  /** `ALWAYS` for a generated column, `NEVER` otherwise. */
  is_generated?: string;
  ordinal_position: number;
  comment: string | null;
  /** Labels when the column's type is an enum; null otherwise. */
  enum_labels: string[] | null;
  /** A `varchar(n)`'s n; null for any other type. */
  character_maximum_length: number | null;
}

/** What the checks say of a text column's length and form (vocabulary.ts checkTextRule), the first of each. */
export function checkedText(checks: string[], column: string): { min?: number; pattern?: string } {
  const found: { min?: number; pattern?: string } = {};
  for (const check of checks) {
    const rule = checkTextRule(check, column);
    if (rule?.min !== undefined && found.min === undefined) found.min = rule.min;
    if (rule?.pattern !== undefined && found.pattern === undefined) found.pattern = rule.pattern;
  }
  return found;
}

/** The first check that pins this column's values, if any does. */
export function firstVocabulary(checks: string[], column: string): string[] | undefined {
  for (const check of checks) {
    const values = checkVocabulary(check, column);
    if (values) return values;
  }
  return undefined;
}

export interface CheckRow {
  table_schema: string;
  table_name: string;
  expression: string;
}

export interface KeyRow {
  constraint_name: string;
  delete_rule?: string;
  from_schema: string;
  from_table: string;
  from_columns: string[];
  to_schema: string;
  to_table: string;
  to_columns: string[];
}

export interface PkRow {
  table_schema: string;
  table_name: string;
  columns: string[];
}

export interface IndexRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  sole_unique?: boolean;
  unique_pair?: string[] | null;
  trigram_columns?: string[];
}

export interface RelRow {
  table_schema: string;
  table_name: string;
  kind: string;
  approx_rows: string | number | null;
  comment: string | null;
}

/** PostgreSQL's negative catalog estimate means unknown, not an empty table. */
export function postgresRowEstimate(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : undefined;
}
