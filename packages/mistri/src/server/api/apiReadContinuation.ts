/** Pure predicate composition. Boundary data is NOT a verified cursor,
 * authorization or a checked execution plan. No SQL or transport admission. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { OPS } from '@mistriwork/engine/shared/filter.js';
import type { ViewDef, ViewCondition } from '@mistriwork/engine/shared/viewPaths.js';

type Term =
  | Readonly<{ field: string; operator: '=' | '>' | '<' | 'in'; value: string | number | boolean | readonly string[] }>
  | Readonly<{ field: string; operator: 'isNull'; value?: undefined }>;
const refuse = (): never => {
  throw new Error('API read continuation is invalid or exceeds its bounds.');
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  return value as Record<string, unknown>;
};
const scalar = (value: unknown) =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
function groups(raw: unknown): unknown[][] {
  if (!Array.isArray(raw) || raw.length > 128) return refuse();
  let total = 0;
  for (const group of raw) {
    if (!Array.isArray(group) || group.length > 128 || (total += group.length) > 2048) return refuse();
  }
  return raw;
}

/** Trusted structural ViewDef only: authored text would supersede the filter.
 * `count` retains the complete original definition, including its limit; the
 * count executor owns its existing independent cap. Neither definition admits
 * execution. Snapshots reject accessors/proxies/undefined/non-JSON metadata. */
export function composeApiReadContinuation(view: ViewDef, branches: readonly (readonly Term[])[]) {
  try {
    const captured = object(snapshot(view, 1048576).value);
    if (
      typeof captured.id !== 'string' ||
      typeof captured.name !== 'string' ||
      typeof captured.base !== 'string' ||
      !Array.isArray(captured.columns) ||
      Object.hasOwn(captured, 'text')
    )
      return refuse();
    const baseline = captured.filter === undefined ? [] : groups(object(captured.filter).groups);
    for (const group of baseline)
      for (const raw of group) {
        const term = object(raw);
        if (
          typeof term.path !== 'string' ||
          !term.path ||
          typeof term.op !== 'string' ||
          !OPS.has(term.op) ||
          Object.keys(term).some((key) => !['path', 'op', 'value'].includes(key)) ||
          (term.value !== undefined &&
            !scalar(term.value) &&
            !(
              Array.isArray(term.value) &&
              term.value.every((value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
            ))
        )
          return refuse();
      }
    const boundary = groups(snapshot(branches, 1048576).value);
    if (!boundary.length || boundary.some((group) => !group.length)) return refuse();
    const suffix: ViewCondition[][] = boundary.map((group) =>
      group.map((raw) => {
        const term = object(raw);
        const keys = Object.keys(term).sort().join(',');
        // A nullable sort's step: at its null, or past a value into its nulls (apiReadBoundary).
        if (
          keys === 'field,operator' &&
          term.operator === 'isNull' &&
          typeof term.field === 'string' &&
          /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(term.field)
        )
          return { path: term.field, op: 'isNull' as const };
        if (
          (keys !== 'field,operator,value' && !(keys === 'collation,field,operator,value' && term.collation === 'binary')) ||
          typeof term.field !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(term.field)
        )
          return refuse();
        // A vocabulary's step past a value: the values after it, named (apiReadBoundary).
        if (term.operator === 'in') {
          if (
            keys !== 'field,operator,value' ||
            !Array.isArray(term.value) ||
            !term.value.length ||
            term.value.length > 256 ||
            !term.value.every((value) => typeof value === 'string')
          )
            return refuse();
          return { path: term.field, op: 'in' as const, value: [...(term.value as string[])] };
        }
        if (!['=', '>', '<'].includes(term.operator as string) || !scalar(term.value)) return refuse();
        return {
          path: term.field,
          op: term.operator as '=' | '>' | '<',
          value: term.value as string | number | boolean,
          ...(term.collation === 'binary' ? { collation: 'binary' as const } : {}),
        };
      }),
    );
    // Match buildWhere's empty-group convention: it ignores empty groups;
    // when none remain, the whole original filter is unrestricted.
    const nonempty = baseline.filter((group) => group.length);
    const starting = nonempty.length ? nonempty : [[]];
    if (starting.length * suffix.length > 128) return refuse();
    let total = 0;
    for (const group of starting)
      for (const tail of suffix) {
        const size = group.length + tail.length;
        if (size > 128 || (total += size) > 2048) return refuse();
      }
    const continued = starting.flatMap((group) => suffix.map((tail) => [...group, ...tail]));
    const rows = snapshot({ ...captured, filter: { ...(captured.filter as object), groups: continued } }, 1048576).value;
    return Object.freeze({
      stage: 'read-continuation-composition' as const,
      authorization: 'pending' as const,
      cursorVerification: 'pending' as const,
      rows: rows as unknown as ViewDef,
      count: captured as unknown as ViewDef,
    });
  } catch {
    return refuse();
  }
}
