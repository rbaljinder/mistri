/** Checked read planning -> existing ViewDef, never execution or admission. */
import type { AppDef } from '../../shared/appModel.js';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { OPS, type Op } from '@mistriwork/engine/shared/filter.js';
import { declaredOrder, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { ViewCondition, ViewDef } from '@mistriwork/engine/shared/viewPaths.js';
import { planApiItemReadRequest, planApiReadRequest, planApiViewReadRequest } from './apiReadRequest.js';
import { apiDialectOf, apiValueCodec } from './apiValueCodec.js';

const refuse = (): never => {
  throw new Error('API read view conversion is unsupported or exceeds its bounds.');
};
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  return raw as Record<string, unknown>;
};
const op = (value: unknown): value is Op => typeof value === 'string' && OPS.has(value);
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const list = (value: unknown): value is Array<string | number> =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)));
function standing(raw: unknown): ViewCondition[][] {
  const groups = object(raw).groups;
  if (!Array.isArray(groups) || groups.length > 128) return refuse();
  let total = 0;
  for (const group of groups) {
    if (!Array.isArray(group) || group.length > 128 || (total += group.length) > 2048) return refuse();
  }
  return groups.map((group) => {
    if (!Array.isArray(group) || group.length > 128) return refuse();
    return group.map((raw) => {
      const condition = object(raw);
      // A column comparison has no wire form here; refused rather than read as a comparison with nothing.
      if (typeof condition.path !== 'string' || !op(condition.op) || condition.other !== undefined) return refuse();
      const value = condition.value;
      if (value !== undefined && !scalar(value) && !list(value)) return refuse();
      return {
        path: condition.path,
        op: condition.op,
        ...(value === undefined ? {} : { value: Array.isArray(value) ? [...value] : value }),
      };
    });
  });
}

/** Only raw route inputs accepted: a caller cannot supply a purported checked
 * plan. Cursor continuation awaits verified-boundary integration. A count flag
 * stays in the returned plan, never changes this bounded row-fetch definition.
 */
export function createApiReadView(
  app: AppDef,
  schema: DatabaseSchema,
  request: { operationId: string; query: string; key?: string },
  options: { integers: 'decimal-string' | 'number' },
  now: Date,
  /** A tenant App's catalog, from trusted composition; otherwise checked here. */
  catalog?: Parameters<typeof planApiReadRequest>[5],
) {
  const raw = object(snapshot(request, 32768).value);
  if (
    typeof raw.operationId !== 'string' ||
    typeof raw.query !== 'string' ||
    (raw.key !== undefined && typeof raw.key !== 'string') ||
    Object.keys(raw).some((key) => !['operationId', 'query', 'key'].includes(key))
  )
    return refuse();
  request = { operationId: raw.operationId, query: raw.query, ...(raw.key === undefined ? {} : { key: raw.key }) };
  if (!Number.isFinite(Date.prototype.getTime.call(now))) return refuse();
  const item = request.operationId.startsWith('item:');
  if (item ? request.query !== '' || typeof request.key !== 'string' : request.key !== undefined) return refuse();
  const plan = item
    ? planApiItemReadRequest(app, schema, request.operationId, request.key!, options, catalog)
    : request.operationId.startsWith('view:')
      ? planApiViewReadRequest(app, schema, request.operationId, request.query, options, now, catalog)
      : planApiReadRequest(app, schema, request.operationId, request.query, options, catalog, now);
  let groups: ViewCondition[][];
  const view: ViewDef = { id: plan.operationId, name: plan.operationId, base: plan.resource, columns: [], limit: 2 };
  if (plan.stage === 'item-read-request-plan') {
    view.columns = plan.responseFields.map((path) => ({ path }));
    groups = [Object.entries(plan.key).map(([path, value]) => ({ path, op: '=', value }))];
  } else {
    if (plan.unverifiedCursor !== undefined) return refuse();
    view.columns = plan.fetchFields.map((path) => ({ path }));
    // Text orders by its bytes, as the cursor boundary compares it
    // (apiReadBoundary): the database's collation decides neither.
    const table = schema.tables.find((table) => table.id === plan.resource);
    if (!table) return refuse();
    view.orderBy = plan.order.map((order) => {
      const column = table.columns.find((column) => column.name === order.column);
      if (!column) return refuse();
      return {
        path: order.column,
        direction: order.direction,
        ...(column.nullable !== false ? { nulls: 'last' as const } : {}),
        // A vocabulary sorts as declared (compileView), and its boundary names values rather than comparing bytes.
        ...(apiValueCodec(column, apiDialectOf(schema, table.id), options.integers).kind === 'text' && !declaredOrder(column)
          ? { collation: 'binary' as const }
          : {}),
      };
    });
    view.limit = plan.limit + 1;
    const refinements: ViewCondition[] = [];
    const booleanChoices: Array<{ path: string; values: boolean[] }> = [];
    for (const filter of plan.filters) {
      if (filter.kind === 'equals') refinements.push({ path: filter.field, op: '=', value: filter.value });
      else if (filter.kind === 'in') {
        if (filter.values.every((value): value is boolean => typeof value === 'boolean')) {
          booleanChoices.push({ path: filter.field, values: [...filter.values] });
        } else {
          if (!list(filter.values)) return refuse();
          refinements.push({ path: filter.field, op: 'in', value: [...filter.values] });
        }
      } else {
        if (filter.min !== undefined) refinements.push({ path: filter.field, op: '>=', value: filter.min });
        if (filter.max !== undefined) refinements.push({ path: filter.field, op: '<=', value: filter.max });
      }
    }
    groups = 'standingFilter' in plan && plan.standingFilter !== undefined ? standing(plan.standingFilter) : [];
    const starting = groups.length ? groups : [[]];
    const factor = booleanChoices.reduce((factor, choice) => factor * choice.values.length, 1);
    const width = refinements.length + booleanChoices.length;
    // Check the full Cartesian result before creating any expanded branches.
    if (
      factor * starting.length > 128 ||
      starting.some((group) => group.length + width > 128) ||
      factor * starting.reduce((count, group) => count + group.length + width, 0) > 2048
    )
      return refuse();
    // (standing A OR standing B) AND every refinement. An empty standing
    // filter means true, not an empty result; never replace standing clauses.
    groups = starting.map((group) => [...group, ...refinements]);
    for (const choice of booleanChoices)
      groups = groups.flatMap((group) => choice.values.map((value) => [...group, { path: choice.path, op: '=' as const, value }]));
  }
  if (groups.length > 128 || groups.some((group) => group.length > 128) || groups.reduce((count, group) => count + group.length, 0) > 2048)
    return refuse();
  view.filter = { groups };
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(view);
  return Object.freeze({
    stage: 'checked-read-view' as const,
    authorization: 'pending' as const,
    execution: 'pending' as const,
    plan,
    view,
  });
}
