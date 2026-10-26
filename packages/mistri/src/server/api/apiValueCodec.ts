/** Server-owned scalar policy shared by output rows and typed filter lexemes.
 * These are representation facts, never query or caller authority. */
import { int64Codec, finiteNumberCodec } from '../../shared/apiNumeric.js';
import type { ColumnMeta, DatabaseSchema, Dialect } from '@mistriwork/engine/shared/schema.js';
import { isProxy } from 'node:util/types';
import { apiDateCodec } from './apiDateCodec.js';

/* A decimal is exact text, never a JSON number: `numeric(20,2)` money and rates lose digits through a double. */
const DECIMAL_PATTERN = '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$(?![\\s\\S])';
const decimalText = new RegExp(DECIMAL_PATTERN);
/* pg's own text for a timestamptz (the adapter hands it through unparsed): `2026-10-04 07:21:00.5+05:30`. */
const instantText =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.[0-9]{1,9})?(?:(Z)|([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9]))?(?::?[0-5][0-9])?)$(?![\s\S])/;
const INSTANT_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$(?![\\s\\S])';
const fail = (): never => {
  throw new TypeError('The API scalar cannot be represented by this codec.');
};
export function apiIntegerRepresentation(options: { integers: 'decimal-string' | 'number' }) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || isProxy(options)) return fail();
  const descriptor = options && Object.getOwnPropertyDescriptor(options, 'integers');
  const value: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  return value === 'decimal-string' || value === 'number' ? value : fail();
}
function scalar(type: string, dialect: Dialect, integers: 'number' | 'decimal-string') {
  if (!['sqlite', 'postgres', 'mysql'].includes(dialect)) return fail();
  const normalized = type.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'date') return apiDateCodec();
  const integer =
    dialect === 'postgres'
      ? /^(?:smallint|integer|bigint|int2|int4|int8|smallserial|serial|bigserial|serial2|serial4|serial8)$/
      : dialect === 'mysql'
        ? /^(?:tinyint|smallint|mediumint|int|integer|bigint)(?:\([0-9]{1,3}\))?$/
        : /^(?:int|integer|tinyint|smallint|mediumint|bigint|int2|int8)$/;
  // Raw MySQL/SQLite boolean values are numeric; no implicit conversion.
  if (dialect === 'mysql' && normalized === 'tinyint(1)') return fail();
  // Postgres and MySQL return exact decimals as text; SQLite's NUMERIC affinity stores doubles and has no such promise.
  if (dialect !== 'sqlite' && /^(?:numeric|decimal)(?:\([0-9]{1,3}(?:, ?-?[0-9]{1,3})?\))?$/.test(normalized))
    return Object.freeze({
      kind: 'decimal' as const,
      schema: Object.freeze({ type: 'string', format: 'decimal', pattern: DECIMAL_PATTERN }),
      encode(value: unknown): string {
        return typeof value === 'string' && decimalText.test(value) ? value : fail();
      },
    });
  if (dialect === 'postgres' && /^(?:timestamptz|timestamp with time zone)(?:\([0-6]\))?$/.test(normalized))
    return Object.freeze({
      kind: 'timestamp' as const,
      schema: Object.freeze({ type: 'string', format: 'date-time', pattern: INSTANT_PATTERN }),
      encode(value: unknown): string {
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? fail() : value.toISOString();
        const parts = typeof value === 'string' ? instantText.exec(value) : null;
        if (!parts) return fail();
        apiDateCodec().encode(parts[1]);
        const [, day, hh, mm, ss, fraction = '', zulu, sign, oh, om = '00'] = parts;
        const offset = zulu || (oh === '00' && om === '00') ? 'Z' : `${sign}${oh}:${om}`;
        return `${day}T${hh}:${mm}:${ss}${fraction}${offset}`;
      },
    });
  if (integer.test(normalized))
    return Object.freeze({ kind: 'integer' as const, ...(integers === 'number' ? int64Codec('number') : int64Codec('decimal-string')) });
  if (/^(?:real|float|double|double precision|float4|float8)$/.test(normalized)) {
    if (dialect !== 'postgres' && /float[48]/.test(normalized)) return fail();
    const finite = finiteNumberCodec();
    return Object.freeze({
      kind: 'number' as const,
      schema: finite.schema,
      encode(value: unknown) {
        const number = finite.encode(value);
        // JSON has one zero. Normalize before list deduplication/range output so
        // internal predicate and row representations do not disagree on -0.
        return number === 0 ? 0 : number;
      },
    });
  }
  if (dialect === 'postgres' && /^(?:boolean|bool)$/.test(normalized))
    return Object.freeze({
      kind: 'boolean' as const,
      schema: Object.freeze({ type: 'boolean' }),
      encode(value: unknown): boolean {
        return typeof value === 'boolean' ? value : fail();
      },
    });
  const textual =
    dialect === 'mysql'
      ? /^(?:tinytext|text|mediumtext|longtext|(?:char|varchar)\([0-9]+\))$/
      : dialect === 'postgres'
        ? /^(?:text|(?:character varying|varchar|character|char)(?:\([0-9]+\))?)$/
        : /^(?:text|clob|(?:character varying|varchar|character|char|nvarchar|nchar)(?:\([0-9]+\))?)$/;
  if (textual.test(normalized))
    return Object.freeze({
      kind: 'text' as const,
      schema: Object.freeze({ type: 'string' }),
      encode(value: unknown): string {
        return typeof value === 'string' ? value : fail();
      },
    });
  return fail();
}

/**
 * The engine a table's values come from: its own source's when the catalog
 * merges several connections (`sourceDialect`), the catalog's otherwise. The
 * one place the API reads a dialect, so a value is never encoded by the rules
 * of the default source's engine when another engine produced it. A catalog
 * that stamps some tables and not this one is refused rather than guessed at.
 */
export function apiDialectOf(schema: Pick<DatabaseSchema, 'dialect' | 'tables'>, table: string): Dialect {
  const found = schema.tables.find((candidate) => candidate.id === table);
  if (!found) return fail();
  if (found.sourceDialect !== undefined) return found.sourceDialect;
  return schema.tables.some((candidate) => candidate.sourceDialect !== undefined) ? fail() : schema.dialect;
}

/** The catalog's one engine when no table carries its own: undefined for a catalog of several sources. */
export function apiSingleDialect(schema: Pick<DatabaseSchema, 'dialect' | 'tables'>): Dialect | undefined {
  return schema.tables.some((table) => table.sourceDialect !== undefined) ? undefined : schema.dialect;
}

/**
 * Whether an engine owner may serve these tables: each is read by `engine`.
 * An owner names the tables its exposed operations reach, so a source the API
 * does not expose may be on any engine; with no tables named, the whole
 * catalog is judged. A one-source catalog is judged by its dialect, as before.
 */
export function apiCatalogOn(schema: Pick<DatabaseSchema, 'dialect' | 'tables'>, engine: Dialect, tables?: Iterable<string>): boolean {
  const single = apiSingleDialect(schema);
  if (single !== undefined) return single === engine;
  try {
    for (const table of tables ?? schema.tables.map((candidate) => candidate.id)) if (apiDialectOf(schema, table) !== engine) return false;
    return true;
  } catch {
    return false;
  }
}

export function apiValueCodec(column: Pick<ColumnMeta, 'type' | 'allowed'>, dialect: Dialect, integers: 'number' | 'decimal-string') {
  if (integers !== 'number' && integers !== 'decimal-string') return fail();
  if (!column || typeof column !== 'object' || isProxy(column) || ![null, Object.prototype].includes(Object.getPrototypeOf(column)))
    return fail();
  const type = Object.getOwnPropertyDescriptor(column, 'type'),
    allowed = Object.getOwnPropertyDescriptor(column, 'allowed');
  if (!type || !Object.hasOwn(type, 'value') || typeof type.value !== 'string' || (allowed && !Object.hasOwn(allowed, 'value')))
    return fail();
  const codec = scalar(type.value, dialect, integers);
  let choices: readonly (string | number | boolean)[] | undefined;
  if (allowed?.value !== undefined) {
    const values: unknown = allowed.value;
    if (
      !Array.isArray(values) ||
      isProxy(values) ||
      !values.length ||
      (codec.kind !== 'text' && codec.kind !== 'integer' && codec.kind !== 'date')
    )
      return fail();
    const encoded = [];
    for (let index = 0; index < values.length; index++) {
      const value = Object.getOwnPropertyDescriptor(values, String(index));
      if (!value || !Object.hasOwn(value, 'value') || typeof value.value !== 'string') return fail();
      encoded.push(codec.encode(value.value));
    }
    choices = Object.freeze([...new Set(encoded)]);
  }
  return Object.freeze({
    kind: codec.kind,
    schema: choices ? Object.freeze({ ...codec.schema, enum: choices }) : codec.schema,
    encode(value: unknown) {
      const encoded = codec.encode(value);
      return choices && !choices.includes(encoded) ? fail() : encoded;
    },
  });
}

/**
 * What a row's field is said as: a scalar (apiValueCodec), or a JSON column's
 * object (row-defined fields, definedFields.ts) — PostgreSQL and MySQL hand
 * it parsed, SQLite as text. Copied through JSON, so nothing but plain data
 * reaches the wire. Never a filter or a sort (apiReadCatalog.ts).
 */
export function apiFieldCodec(column: Pick<ColumnMeta, 'type' | 'allowed'>, dialect: Dialect, integers: 'number' | 'decimal-string') {
  if (!column || typeof column !== 'object' || typeof column.type !== 'string' || !/^(?:json|jsonb)$/i.test(column.type.trim()))
    return apiValueCodec(column, dialect, integers);
  return Object.freeze({
    kind: 'json' as const,
    schema: Object.freeze({ type: 'object' }),
    encode(value: unknown): Readonly<Record<string, unknown>> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof value === 'string' ? value : JSON.stringify(value));
      } catch {
        return fail();
      }
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : fail();
    },
  });
}
