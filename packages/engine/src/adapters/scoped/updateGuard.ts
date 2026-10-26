import { Refusal, type SqlFragment, type SqlStyle, type UpdateRequest } from '../adapter.js';
import { comparableType, isJsonType } from '../../shared/schema.js';

/** Appended to a complete primary-key WHERE, with values bound after its parameters. */
export function buildUpdateGuard(
  request: UpdateRequest,
  types: Record<string, string>,
  style: SqlStyle,
  dialect: 'sqlite' | 'postgres' | 'mysql',
  startIndex: number,
): SqlFragment {
  if (request.expected === undefined) return { text: '', params: [] };
  const expected = request.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected))
    throw new Refusal('Expected values must be an object containing exactly the fields being updated.');
  /* A JSON column is written whole and compares on no engine, so its
     original value may be left out (a command's update leaves it out). */
  const columns = Object.keys(request.values).filter((column) => Object.hasOwn(expected, column) || !isJsonType(types[column] ?? ''));
  if (Object.keys(expected).length !== columns.length || !columns.every((column) => Object.hasOwn(expected, column))) {
    throw new Refusal('Expected values must contain exactly the fields being updated.');
  }
  const params: unknown[] = [];
  const checks = columns.map((column) => {
    const value = expected[column];
    const quoted = style.quote(column);
    if (value === null) return `${quoted} IS NULL`;
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new Refusal(`The original value of "${column}" must be a scalar or NULL.`);
    }
    const type = types[column] ?? '';
    if (!comparableType(type)) {
      throw new Refusal(`Protected editing of "${column}" (${type}) is not supported. Its original value cannot be compared safely here.`);
    }
    const placeholder = style.placeholder(startIndex + params.length);
    // Preserve decimal/integer strings: Number() could round the original value.
    params.push(dialect === 'sqlite' && typeof value === 'boolean' ? Number(value) : value);
    // SQLite can store text even without a declared type; its collation still applies.
    if (dialect === 'sqlite') return `${quoted} COLLATE BINARY = ${placeholder}`;
    if (/char|text|clob|citext|enum|set\(/i.test(type)) {
      if (dialect === 'mysql') return `CAST(${quoted} AS BINARY) = CAST(${placeholder} AS BINARY)`;
      if (dialect === 'postgres' && /char|text|clob|citext/i.test(type)) return `${quoted}::text COLLATE "C" = ${placeholder}`;
    }
    return `${quoted} = ${placeholder}`;
  });
  return checks.length ? { text: ` AND (${checks.join(' AND ')})`, params } : { text: '', params: [] };
}
