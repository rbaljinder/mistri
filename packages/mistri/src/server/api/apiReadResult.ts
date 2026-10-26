/** Pure result materialization. The checked-view input is trusted program data,
 * not proof of execution, authorization, count bounds or transaction ownership. */
import { isProxy } from 'node:util/types';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { createApiReadView } from './apiReadView.js';

const refuse = (): never => {
  throw new Error('API read result is unavailable.');
};
function own(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== 'object' || isProxy(raw)) return refuse();
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return refuse();
  return descriptor.value;
}

/** boundedCount is an actual count execution explicitly capped at 10001 by the
 * caller, NOT a count inferred from ViewDef.limit. This returns no `next` field:
 * a caller must authenticate/mint continuation when more=true before handoff. */
export function materializeApiReadResult(checked: ReturnType<typeof createApiReadView>, raw: unknown, boundedCount?: number) {
  try {
    const plan = checked.plan;
    const data = snapshot({ columns: own(raw, 'columns'), rows: own(raw, 'rows') }, 8 * 1024 * 1024).value as {
      columns: unknown;
      rows: unknown;
    };
    const fields = plan.stage === 'item-read-request-plan' ? plan.responseFields : plan.fetchFields;
    if (
      !Array.isArray(data.columns) ||
      data.columns.length !== fields.length ||
      data.columns.some((field, index) => field !== fields[index]) ||
      !Array.isArray(data.rows)
    )
      return refuse();
    const rows = data.rows;
    if (rows.length > (plan.stage === 'item-read-request-plan' ? 2 : plan.limit + 1)) return refuse();
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(row, field))
      )
        return refuse();
    }
    if (plan.stage === 'item-read-request-plan') {
      if (boundedCount !== undefined || rows.length > 1) return refuse();
      return Object.freeze({
        stage: 'item-read-result' as const,
        authorization: 'pending' as const,
        ...(rows.length === 0 ? { status: 'not-found' as const } : { status: 'found' as const, item: plan.response.encodeRow(rows[0]) }),
      });
    }
    if (plan.count ? boundedCount === undefined : boundedCount !== undefined) return refuse();
    let count: Readonly<{ value: number; exact: true; capped: boolean }> | undefined;
    if (boundedCount !== undefined) {
      if (!Number.isSafeInteger(boundedCount) || boundedCount < 0 || boundedCount > 10001 || boundedCount < rows.length) return refuse();
      count = Object.freeze({ value: Math.min(boundedCount, 10000), exact: true, capped: boundedCount > 10000 });
    }
    const more = rows.length > plan.limit,
      page = rows.slice(0, plan.limit);
    // Reuse envelope row/count validation but deliberately discard its null
    // cursor placeholder. This intermediate result is not a wire envelope.
    const encoded = plan.envelope.encode({ items: page, next: null, ...(count ? { count } : {}) });
    const boundary = more ? plan.boundary.encode(page[page.length - 1]) : undefined;
    return Object.freeze({
      stage: 'list-read-result' as const,
      authorization: 'pending' as const,
      items: encoded.items,
      more,
      ...(boundary ? { boundary } : {}),
      ...(count ? { count: encoded.count } : {}),
    });
  } catch {
    return refuse();
  }
}
