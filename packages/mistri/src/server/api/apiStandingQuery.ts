/** API-only standing-query constraints; the browser grammar is unchanged. */
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { parseViewQuery, resolvePath } from '@mistriwork/engine/shared/view.js';
import { apiDialectOf, apiValueCodec } from './apiValueCodec.js';

const fail = (): never => {
  throw new TypeError(
    'API standing integer predicates require canonical signed 64-bit integer literals, without decimal or exponent spellings.',
  );
};

export function parseApiStandingQuery(schema: DatabaseSchema, resource: string, text: string, now: Date) {
  const parsed = parseViewQuery(schema, resource, text, now, { columnValues: false });
  if (parsed.errors.length) return parsed;
  const integers = new Map<string, ReturnType<typeof apiValueCodec>>();
  const columns = new Map<string, Set<string>>();
  for (const group of parsed.filter.groups)
    for (const condition of group) {
      const resolved = resolvePath(schema, resource, condition.path);
      // This fixed internal strategy validates exact integer lexemes, not an
      // output representation default. Other SQL kinds keep their existing
      // standing semantics and their separate wire-codec publication checks.
      let codec: ReturnType<typeof apiValueCodec>;
      try {
        codec = apiValueCodec({ type: resolved.column.type }, apiDialectOf(schema, resolved.table.id), 'decimal-string');
      } catch {
        continue;
      }
      if (codec.kind !== 'integer') continue;
      integers.set(condition.path, codec);
      const names = columns.get(resolved.table.id) ?? new Set<string>();
      names.add(resolved.column.name);
      columns.set(resolved.table.id, names);
    }
  if (!integers.size) return parsed;
  // Reuse the same grammar with only integer value coercion disabled. This
  // retains decimal/exponent lexemes instead of inspecting already-rounded
  // numbers. Never use this alternate parse as the execution predicate.
  const lexicalSchema = {
    ...schema,
    tables: schema.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => (columns.get(table.id)?.has(column.name) ? { ...column, type: 'TEXT' } : column)),
    })),
  };
  const lexical = parseViewQuery(lexicalSchema, resource, text, now, { columnValues: false });
  if (lexical.errors.length || lexical.filter.groups.length !== parsed.filter.groups.length) return fail();
  for (const [groupIndex, group] of parsed.filter.groups.entries()) {
    const raw = lexical.filter.groups[groupIndex];
    if (raw.length !== group.length) return fail();
    for (const [index, condition] of group.entries()) {
      const literal = raw[index];
      if (literal.path !== condition.path || literal.op !== condition.op) return fail();
      const codec = integers.get(condition.path);
      if (!codec || literal.value === null || literal.value === undefined) continue;
      const values = Array.isArray(literal.value) ? literal.value : [literal.value];
      for (const value of values) {
        if (typeof value !== 'string') return fail();
        try {
          codec.encode(value);
        } catch {
          return fail();
        }
      }
    }
  }
  return parsed;
}
