import { authoredValue } from './autoValues.js';
import { autoKey, isRequired } from './form.js';
import { findTable, primaryKey, type DatabaseSchema, type TableMeta } from './schema.js';
import { hopName } from './view.js';
import { parseQuery } from './query.js';
import type { RelatedCreate } from '../../schema/model.js';

type Scalar = string | number | boolean | null;
const CREATE_KEYS = ['label', 'show', 'defaults', 'prefill'];
/** Columns filled from the page's record, at most. */
const MAX_FILL = 8;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A tenant host hands its pages over as captured, null-prototype copies (evidence.ts), and those are plain too.
const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));

export function parseRelatedCreate(raw: unknown, at: string): RelatedCreate<string> {
  if (typeof raw === 'string') raw = { label: raw };
  if (!isPlain(raw)) throw new Error(`${at}: create must be an object.`);
  const value = raw;
  if (Object.keys(value).some((key) => !CREATE_KEYS.includes(key)))
    throw new Error(`${at}: create accepts label, show, defaults and prefill.`);
  if (typeof value.label !== 'string' || !value.label.trim()) throw new Error(`${at}: create needs a label.`);
  if (value.show !== undefined && (!Array.isArray(value.show) || value.show.some((c) => typeof c !== 'string' || !c.trim())))
    throw new Error(`${at}: create.show must contain column names.`);
  let defaults: Record<string, Scalar> | undefined;
  if (value.defaults !== undefined) {
    if (!isPlain(value.defaults)) throw new Error(`${at}: create.defaults is an object of column → value.`);
    defaults = {};
    for (const [column, authored] of Object.entries(value.defaults)) {
      if (!COLUMN.test(column)) throw new Error(`${at}: create.defaults "${column}" is not a column name.`);
      const v = authoredValue(authored, `${at}: create.defaults "${column}"`);
      if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
        throw new Error(`${at}: create.defaults "${column}" is a text, number, true/false, null, today, now or me.`);
      }
      defaults[column] = v as Scalar;
    }
  }
  let prefill: Record<string, string> | undefined;
  if (value.prefill !== undefined) {
    const pairs = isPlain(value.prefill) ? Object.entries(value.prefill) : [];
    if (
      !pairs.length ||
      pairs.length > MAX_FILL ||
      pairs.some(([child, parent]) => !COLUMN.test(child) || typeof parent !== 'string' || !COLUMN.test(parent))
    ) {
      throw new Error(
        `${at}: create.prefill maps one to ${MAX_FILL} of the new row's columns to the record's: { patient_id: 'patient_id' }.`,
      );
    }
    prefill = Object.fromEntries(pairs) as Record<string, string>;
  }
  return {
    label: value.label.trim(),
    ...(value.show === undefined ? {} : { show: (value.show as string[]).map((c) => c.trim()) }),
    ...(defaults ? { defaults } : {}),
    ...(prefill ? { prefill } : {}),
  };
}

/** Whether a create says more than its label, so it cannot be written as the label alone. */
export function createSaysMore(create: RelatedCreate<string>): boolean {
  return create.show !== undefined || create.defaults !== undefined || create.prefill !== undefined;
}

/**
 * What a filtered related list's query pins: its equalities (`status = open`,
 * `kind in (visit)`), read by the query language's own parser over the child
 * table. A row added from the list starts with them, so it is listed where it
 * was added. An `or`, a range or a path pins nothing.
 */
function filterEqualities(schema: DatabaseSchema, from: TableMeta, filter: string | undefined): Record<string, Scalar> {
  if (!filter?.trim()) return {};
  const parsed = parseQuery(`${from.id} ${filter}`, { schema });
  const groups = parsed.query?.filter.groups;
  if (parsed.errors.length || !groups || groups.length !== 1) return {};
  const pinned: Record<string, Scalar> = {};
  for (const condition of groups[0]) {
    if (condition.column.includes('.') || !from.columns.some((c) => c.name === condition.column)) continue;
    const value =
      condition.op === '='
        ? condition.value
        : condition.op === 'in' && Array.isArray(condition.value) && condition.value.length === 1
          ? condition.value[0]
          : undefined;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') pinned[condition.column] = value;
  }
  return pinned;
}

/** Bind only a direct FK to the whole parent PK, never inferred query equalities.
 * `filter` is the related list's own query; the values it pins fill the new row
 * as defaults do, never as bindings. */
export function relatedCreatePlan(
  schema: DatabaseSchema,
  baseId: string,
  fromId: string,
  path: string,
  create: RelatedCreate<string>,
  list: { filter?: string } = {},
) {
  const base = findTable(schema, baseId);
  const from = findTable(schema, fromId);
  const candidates = schema.foreignKeys.filter((fk) => fk.from.table === fromId);
  const fk = candidates.find((fk) => fk.name === path) ?? candidates.find((fk) => hopName(fk) === path);
  /* A wrong `whose` is the usual mistake, so it is named for what it is —
     not a column, or a column that points elsewhere — with the references
     that would do, rather than as a rule about primary keys. */
  if (base && from && !fk && !path.includes('.')) {
    const toBase = candidates.filter((ref) => ref.to.table === baseId).map((ref) => `"${hopName(ref)}"`);
    const could = toBase.length
      ? ` Its references to ${base.name}: ${toBase.join(', ')}.`
      : ` ${from.name} has no reference to ${base.name}.`;
    return {
      error: from.columns.some((c) => c.name === path)
        ? `"${path}" is a column of ${from.name}, but not a reference to ${base.name}.${could}`
        : `"${path}" is not a column of ${from.name}.${could}`,
    };
  }
  if (base && fk && fk.to.table !== baseId) {
    return {
      error: `"${path}" refers to ${findTable(schema, fk.to.table)?.name ?? fk.to.table}, not to ${base.name}, so a row added here would not belong to this record.`,
    };
  }
  if (
    !base ||
    !from ||
    from.isView ||
    !fk ||
    fk.to.columns.length !== primaryKey(base).length ||
    !primaryKey(base).every((c) => fk.to.columns.includes(c))
  ) {
    return { error: 'Related creation needs a direct reference to the complete parent primary key.' };
  }
  const show = create.show ?? from.columns.map((c) => c.name);
  if (show.some((name) => !from.columns.some((c) => c.name === name))) return { error: 'Related creation names an unknown form column.' };
  const unknownDefault = Object.keys(create.defaults ?? {}).find((name) => !from.columns.some((c) => c.name === name));
  if (unknownDefault) return { error: `Related creation defaults "${unknownDefault}", which is not a column of ${from.name}.` };
  /* A filled column comes from the record: the child's column, the record's column. */
  const fill: Record<string, string> = { ...(create.prefill ?? {}) };
  for (const [child, parent] of Object.entries(fill)) {
    if (!from.columns.some((c) => c.name === child))
      return { error: `Related creation fills "${child}", which is not a column of ${from.name}.` };
    if (!base.columns.some((c) => c.name === parent))
      return { error: `Related creation fills "${child}" from "${parent}", which is not a column of ${base.name}.` };
    if (fk.from.columns.includes(child))
      return { error: `Related creation fills "${child}", the reference to ${base.name} it already binds.` };
  }
  const pinned = filterEqualities(schema, from, list.filter);
  const given = new Set([...Object.keys(create.defaults ?? {}), ...Object.keys(fill), ...Object.keys(pinned)]);
  const assigned = autoKey(from);
  const hiddenRequired = from.columns.filter(
    (c) => isRequired(c, assigned) && !show.includes(c.name) && !fk.from.columns.includes(c.name) && !given.has(c.name),
  );
  if (hiddenRequired.length)
    return { error: `Related creation must show required columns: ${hiddenRequired.map((c) => c.name).join(', ')}.` };
  /* A required reference to another record (a work order's bike, added from its mechanic): the record cannot say it,
     so a New the list offers on its own would ask a whole other choice; one the author writes still may. */
  const otherParents = schema.foreignKeys
    .filter((ref) => ref !== fk && ref.from.table === fromId)
    .flatMap((ref) => ref.from.columns)
    .filter((name, index, all) => all.indexOf(name) === index && !fk.from.columns.includes(name) && !given.has(name))
    .filter((name) => {
      const column = from.columns.find((c) => c.name === name);
      return column !== undefined && isRequired(column, assigned);
    });
  return {
    show: show.filter((c) => !fk.from.columns.includes(c)),
    bindings: fk.from.columns.map((column, i) => ({ column, parent: fk.to.columns[i] })),
    otherParents,
    // The list's own equalities win: a row added here is listed here.
    defaults: { ...(create.defaults ?? {}), ...pinned },
    fill,
  };
}
