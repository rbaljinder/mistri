import type { RecordMessagesSpec } from '../../shared/branding.js';
import { messageRowProblem } from './recordMessages.js';
import { type Filter, type QueryRequest, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import {
  derivedSource,
  evaluateFormRules,
  referencedRuleFields,
  ruleColumns,
  ruleReferencePaths,
  validateFormRules,
  type FormRule,
} from '../../shared/formRules.js';
import { appFileRules, resolveValidation, resourceValidation, storedComputed, type AppDef } from '../../shared/app.js';
import { appComputedRules, computedConstants } from '../../shared/appComputed.js';
import { withComputedColumns, type ComputedColumn, type ComputedValue } from '@mistriwork/engine/shared/computed.js';
import { evaluateComputed } from '@mistriwork/engine/shared/computedValue.js';
import { typedValue } from '../../shared/formLines.js';
import { readRichTextInput, RichTextRefusal } from '../richText.js';
import { tableNamed, type ColumnMeta, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { columnTextRule, textRuleBreak, type TextRule } from '@mistriwork/engine/shared/textRules.js';
import { DEFINITIONS_MOST, servedDefined } from '@mistriwork/engine/shared/definedFields.js';
import {
  DEFINED_REASONS,
  definedBreaks,
  definedObject,
  definitionColumns,
  definitionFilter,
  readDefinitions,
} from '@mistriwork/engine/shared/definedValues.js';
import { FLOW_REASONS, flowRowBreaks, stepRowBreaks, type FlowBinding, type FlowRecordShape } from '../../shared/appFlows.js';
import { servedFlows } from './flowRecord.js';
import { AppValidationDenied } from './appValidationDenied.js';
import { appConsumesRules } from '../../shared/appConsumes.js';
import type { ConsumesWriteRule } from './appConsumes.js';

/**
 * A New form's narrowed picker (`form.fields.<ref>.where`), held on every
 * write: the referenced row must agree with the written row on each pair.
 * The picker only offers such rows; this is what refuses one sent anyway —
 * by the form, an edit, a command or the API.
 */
interface NarrowedReference {
  kind: 'narrowed';
  field: string;
  target: string;
  key: string;
  where: readonly { remote: string; local: string }[];
}

/**
 * A column's text rule (`resources.<name>.text`, textRules.ts), held on every
 * write: the stored value is judged as the form judged it while it was typed.
 * The database's own word on the column (a varchar's length, a CHECK) is the
 * database's to enforce, and is merged in only where the App states a rule.
 */
interface TextWriteRule {
  kind: 'text';
  field: string;
  rule: TextRule;
}

/**
 * A rich text column (`display: { <column>: { format: 'richText' } }`): every
 * value written to it is read as rich text — Markdown or HTML — and stored
 * sanitized (server/richText.ts), whoever writes it: the editor, an import,
 * the API, a command's handler through the App's writer. Judged on the way
 * in, not on the post-image: what is stored is what was cleaned.
 */
interface RichTextWriteRule {
  kind: 'richText';
  field: string;
  /** The App's file resources, by table id: the only places a picture may come from. */
  images: ReadonlySet<string>;
}

/**
 * A column drawn as JSON (`display: { <column>: { format: 'json' } }`) and
 * edited in the JSON editor: a text written to it must be JSON, whoever
 * writes it, so the tree that draws it never meets a value it cannot read.
 * Judged on the way in, beside rich text; a native JSON column's own type
 * says the rest.
 */
interface JsonWriteRule {
  kind: 'json';
  field: string;
}

/** The fixed sentence a JSON column's refusal carries, beside the field. */
const JSON_REASON = 'This is not valid JSON.';

/**
 * A JSON column whose keys are defined by rows (`resources.<r>.defined`,
 * definedFields.ts): the stored object is judged against the definitions the
 * write's own transaction reads — the tenant's scope in a tenant App, the
 * row policy under `auth.rows` — so a definition this principal's scope does
 * not hold never shapes or validates the record.
 */
interface DefinedWriteRule {
  kind: 'defined';
  field: string;
  from: TableMeta;
  per?: string;
}

/**
 * A row of a resource's flows or of their steps (`resources.<r>.flows`,
 * appFlows.ts): judged whole on every write — an unknown step kind, a
 * condition the run could not ask, an input its kind needs and lacks — so a
 * flow an administrator saved is one its run can follow.
 */
interface FlowWriteRule {
  kind: 'flowRow';
  rows: 'flow' | 'step';
  binding: FlowBinding;
  record: FlowRecordShape;
}

/**
 * A row of a tenant's own words (`ui.messages: fromRecord(...)`,
 * recordMessages.ts): its key one of the App's messages, its locale a tag, its
 * text ICU reading no argument the App's own text does not. Judged on every
 * write, so a row the read would skip is refused where it is typed.
 */
interface MessageWriteRule {
  kind: 'messageRow';
  spec: RecordMessagesSpec;
}

/**
 * A value a new record takes from the record it references (`form.defaults:
 * { labor_charge: { from: 'service_id.price' } }`, formRules.ts derived): a
 * create that leaves the column out gets the referenced row's value, read in
 * the write's own transaction. Filled on the way in, never judged after.
 */
interface DerivedWriteRule {
  kind: 'derived';
  field: string;
  via: string;
  table: string;
  column: string;
  key: string;
  /** Where the column is a computed one of the referenced record: worked out of what it reads, as stored (DM5). */
  worked?: { named: Readonly<Record<string, ComputedColumn>>; target: TableMeta; constants: Worked['constants'] };
}

/**
 * The App's computed columns, by table id, and the constants they read: what a validation works a computed column
 * out of the stored row with, where it names one of its own or a referenced record's (DM5). A computed column is
 * figured once the row is read, as a list figures it (computedValue.ts), never by the statement that reads it.
 */
interface Worked {
  computed: ReadonlyMap<string, Readonly<Record<string, ComputedColumn>>>;
  constants: (now: Date) => { today: string; now: Date; me: null };
}
interface WorkedWriteRule extends Worked {
  kind: 'worked';
}

type AppWriteRule =
  | FormRule
  | DerivedWriteRule
  | NarrowedReference
  | TextWriteRule
  | RichTextWriteRule
  | JsonWriteRule
  | DefinedWriteRule
  | FlowWriteRule
  | MessageWriteRule
  | ConsumesWriteRule
  | WorkedWriteRule;
export type AppValidationRules = ReadonlyMap<string, readonly AppWriteRule[]>;

const isNarrowed = (rule: AppWriteRule): rule is NarrowedReference => 'kind' in rule && rule.kind === 'narrowed';
const isText = (rule: AppWriteRule): rule is TextWriteRule => 'kind' in rule && rule.kind === 'text';
const isRichText = (rule: AppWriteRule): rule is RichTextWriteRule => 'kind' in rule && rule.kind === 'richText';
const isJson = (rule: AppWriteRule): rule is JsonWriteRule => 'kind' in rule && rule.kind === 'json';
/* Both judged on the way in (cleanRichTextValues), never on the post-image. */
const onTheWayIn = (rule: AppWriteRule) => isRichText(rule) || isJson(rule);
const isDefined = (rule: AppWriteRule): rule is DefinedWriteRule => 'kind' in rule && rule.kind === 'defined';
const isFlowRow = (rule: AppWriteRule): rule is FlowWriteRule => 'kind' in rule && rule.kind === 'flowRow';
const isMessageRow = (rule: AppWriteRule): rule is MessageWriteRule => 'kind' in rule && rule.kind === 'messageRow';
const isDerived = (rule: AppWriteRule): rule is DerivedWriteRule => 'kind' in rule && rule.kind === 'derived';
const isWorked = (rule: AppWriteRule): rule is WorkedWriteRule => 'kind' in rule && rule.kind === 'worked';

/** The App's computed columns a stored row's rules may read, and the constants they read; undefined where there are none. */
function appWorked(schema: DatabaseSchema, app: AppDef): Worked | undefined {
  const { rules } = appComputedRules(app, schema);
  if (!rules.size) return undefined;
  return Object.freeze({
    computed: rules,
    constants: (now: Date) => ({ ...computedConstants(app, now, null), now, me: null }),
  });
}

/* Whether the catalog stores the column: a computed column of that name is worked out only where it does not. */
const storedOf = (schema: DatabaseSchema, table: string, name: string) =>
  schema.tables.find((each) => each.id === table)?.columns.some((column) => column.name === name) ?? false;

/* The stored columns a computed column reads, through the computed columns it reads in turn. */
function storedReads(named: Readonly<Record<string, ComputedColumn>>, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  return [...new Set(named[name].reads.flatMap((path) => (Object.hasOwn(named, path) ? storedReads(named, path, seen) : [path])))];
}

/* A computed column of a row as stored, worked out as a list works it out and said as a stored value is: a day as
   its date, an instant as its ISO text. */
function workedOut(
  named: Readonly<Record<string, ComputedColumn>>,
  table: TableMeta,
  name: string,
  row: Readonly<Record<string, unknown>>,
  constants: { today: string; now: Date; me: null },
): unknown {
  const value = (path: string, seen: ReadonlySet<string>): ComputedValue =>
    Object.hasOwn(named, path) && !seen.has(path)
      ? evaluateComputed(named[path].expr, constants, (inner) => value(inner, new Set([...seen, path])))
      : typedValue(table, path, row[path]);
  const out = value(name, new Set());
  if (out !== null && typeof out === 'object') return 'day' in out ? out.day : out.instant.toISOString();
  return out;
}
/* Held around the write itself (appConsumes.ts moveConsumed), never on the post-image. */
const isConsumes = (rule: AppWriteRule): rule is ConsumesWriteRule => 'kind' in rule && rule.kind === 'consumes';

/** Every rich text and JSON column the App's display rules declare, by table id. A column this catalog lacks is left out. */
function appRichTextRules(schema: DatabaseSchema, app: AppDef): Map<string, Array<RichTextWriteRule | JsonWriteRule>> {
  const found = new Map<string, Array<RichTextWriteRule | JsonWriteRule>>();
  let images: ReadonlySet<string> | undefined;
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    if (!table || !resource.display) continue;
    const rules = Object.entries(resource.display).flatMap(([field, rule]): Array<RichTextWriteRule | JsonWriteRule> => {
      if (!table.columns.some((column) => column.name === field)) return [];
      if (rule?.format === 'json') return [Object.freeze({ kind: 'json' as const, field })];
      if (rule?.format !== 'richText') return [];
      images ??= Object.freeze(new Set(appFileRules(app, schema).rules.keys()));
      return [Object.freeze({ kind: 'richText' as const, field, images })];
    });
    if (rules.length) found.set(table.id, rules);
  }
  return found;
}

/**
 * A write's values with each rich text column read and sanitized, and each
 * JSON column's text held to being JSON; the rest as they came. A value that
 * is not text, or past the most a value holds, is refused by its field.
 * Synchronous: the sanitizer is loaded the first time.
 */
export function cleanRichTextValues<V extends Readonly<Record<string, unknown>>>(
  validation: AppValidationRules | undefined,
  table: string,
  values: V,
): V {
  const all = validation?.get(table);
  const rules = all?.filter(isRichText);
  if (!values || typeof values !== 'object') return values;
  for (const rule of all?.filter(isJson) ?? []) {
    const value = Object.hasOwn(values, rule.field) ? values[rule.field] : undefined;
    if (typeof value !== 'string' || value === '') continue;
    try {
      JSON.parse(value);
    } catch {
      throw new AppValidationDenied([rule.field], { [rule.field]: JSON_REASON });
    }
  }
  if (!rules?.length) return values;
  let cleaned: Record<string, unknown> | undefined;
  for (const rule of rules) {
    if (!Object.hasOwn(values, rule.field)) continue;
    const value = values[rule.field];
    if (value === null || value === undefined) continue;
    try {
      (cleaned ??= { ...values })[rule.field] = readRichTextInput(value, { images: rule.images });
    } catch (error) {
      if (error instanceof RichTextRefusal) throw new AppValidationDenied([rule.field]);
      throw error;
    }
  }
  return (cleaned ?? values) as V;
}

/** Every text rule the App's resources state, by table id, each over the column's catalog rule. A column this
 * catalog lacks is left out: the App's check says so (resolveResources). */
function appTextRules(schema: DatabaseSchema, app: AppDef): Map<string, TextWriteRule[]> {
  const found = new Map<string, TextWriteRule[]>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    if (!table || !resource.text) continue;
    const rules = Object.entries(resource.text).flatMap(([field, authored]) => {
      const column = table.columns.find((candidate) => candidate.name === field);
      const rule = column && columnTextRule(column, authored);
      return rule ? [Object.freeze({ kind: 'text' as const, field, rule: Object.freeze(rule) })] : [];
    });
    if (rules.length) found.set(table.id, rules);
  }
  return found;
}

/** Every row-defined JSON column the App's resources bind, by table id. A binding the catalog cannot serve is left out: the App's check says so. */
function appDefinedRules(schema: DatabaseSchema, app: AppDef): Map<string, DefinedWriteRule[]> {
  const found = new Map<string, DefinedWriteRule[]>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    if (!table || !resource.defined) continue;
    const { served } = servedDefined(resource.defined, table, (from) =>
      Object.hasOwn(app.resources ?? {}, from) ? tableNamed(schema, from) : undefined,
    );
    const rules = Object.entries(served).map(([field, binding]) =>
      Object.freeze({
        kind: 'defined' as const,
        field,
        from: schema.tables.find((candidate) => candidate.id === binding.from)!,
        ...(binding.per ? { per: binding.per } : {}),
      }),
    );
    if (rules.length) found.set(table.id, rules);
  }
  return found;
}

/** The rules on every flows table and steps table the App's resources bind, by table id. */
function appFlowRules(schema: DatabaseSchema, app: AppDef): Map<string, FlowWriteRule[]> {
  const found = new Map<string, FlowWriteRule[]>();
  const add = (table: string, rule: FlowWriteRule) => found.set(table, [...(found.get(table) ?? []), Object.freeze(rule)]);
  for (const served of servedFlows(app, schema)) {
    add(served.from.id, { kind: 'flowRow', rows: 'flow', binding: served.binding, record: served.record });
    add(served.steps.id, { kind: 'flowRow', rows: 'step', binding: served.binding, record: served.record });
  }
  return found;
}

/** Every narrowed reference the App's forms declare, by table id. One whose
 * reference or columns this catalog lacks is left out: its form is not
 * served either (validateAppForm says why). */
export function appNarrowings(schema: DatabaseSchema, app: AppDef): Map<string, NarrowedReference[]> {
  const found = new Map<string, NarrowedReference[]>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    if (!table) continue;
    for (const [field, dress] of Object.entries(resource.form?.fields ?? {})) {
      const column = table.columns.find((c) => c.name === field);
      const target = column?.references && schema.tables.find((t) => t.id === column.references!.table);
      if (!dress?.where || !column?.references || !target) continue;
      const where = Object.entries(dress.where).map(([remote, local]) => ({ remote, local: local as string }));
      if (where.some((pair) => !target.columns.some((c) => c.name === pair.remote) || !table.columns.some((c) => c.name === pair.local)))
        continue;
      const rules = found.get(table.id) ?? [];
      rules.push(
        Object.freeze({ kind: 'narrowed' as const, field, target: target.id, key: column.references.column, where: Object.freeze(where) }),
      );
      found.set(table.id, rules);
    }
  }
  return found;
}

export function compileAppDefinitionValidation(schema: DatabaseSchema, app: AppDef): AppValidationRules | undefined {
  const narrowed = appNarrowings(schema, app);
  const texts = appTextRules(schema, app);
  const rich = appRichTextRules(schema, app);
  const defined = appDefinedRules(schema, app);
  const flows = appFlowRules(schema, app);
  const derived = appDerivedRules(schema, app);
  const consumed = appConsumesRules(app, schema).rules;
  const words = app.ui.messages?.source && tableNamed(schema, app.ui.messages.from);
  if (
    !resourceValidation(app) &&
    !narrowed.size &&
    !texts.size &&
    !rich.size &&
    !defined.size &&
    !flows.size &&
    !derived.size &&
    !consumed.size &&
    !words
  )
    return undefined;
  const rules = new Map<string, readonly AppWriteRule[]>();
  if (resourceValidation(app)) {
    const resolved = resolveValidation(app, schema);
    if (resolved.warnings.length) throw new Error(resolved.warnings[0]);
    /* A rule may name a computed column, the record's own or a referenced record's: it reads like a column, and is
       worked out of the stored row where the rule is judged (DM5). */
    const worked = appWorked(schema, app);
    for (const [table, declared] of compileAppValidation(storedComputed(app, schema), resolved.validation) ?? [])
      rules.set(table, worked ? Object.freeze([...declared, Object.freeze({ kind: 'worked' as const, ...worked })]) : declared);
  }
  for (const [table, narrowings] of narrowed) rules.set(table, Object.freeze([...(rules.get(table) ?? []), ...narrowings]));
  for (const [table, text] of texts) rules.set(table, Object.freeze([...(rules.get(table) ?? []), ...text]));
  for (const [table, text] of rich) rules.set(table, Object.freeze([...(rules.get(table) ?? []), ...text]));
  for (const [table, bound] of defined) rules.set(table, Object.freeze([...(rules.get(table) ?? []), ...bound]));
  for (const [table, bound] of flows) rules.set(table, Object.freeze([...(rules.get(table) ?? []), ...bound]));
  for (const [table, taken] of derived) rules.set(table, Object.freeze([...(rules.get(table) ?? []), ...taken]));
  for (const [table, moved] of consumed)
    rules.set(
      table,
      Object.freeze([...(rules.get(table) ?? []), ...moved.map((rule) => Object.freeze({ kind: 'consumes' as const, rule }))]),
    );
  if (words)
    rules.set(
      words.id,
      Object.freeze([...(rules.get(words.id) ?? []), Object.freeze({ kind: 'messageRow' as const, spec: app.ui.messages! })]),
    );
  return rules;
}

/** Only the App's `consumes` rules, as write rules: what a command's own transaction holds (businessCommandLoader.ts). */
export function consumesValidation(schema: DatabaseSchema, app: AppDef): AppValidationRules | undefined {
  const { rules } = appConsumesRules(app, schema);
  if (!rules.size) return undefined;
  return new Map(
    [...rules].map(([table, moved]) => [table, Object.freeze(moved.map((rule) => Object.freeze({ kind: 'consumes' as const, rule })))]),
  );
}

/**
 * Compile the root App invariants against the source catalog once at binding
 * time. Form presentation is allowed to be partial; resource validation is
 * not. A malformed rule therefore fails App startup rather than becoming an
 * unchecked write at runtime.
 */
export function compileAppValidation(
  schema: DatabaseSchema,
  declarations: Record<string, FormRule[]> | undefined,
): AppValidationRules | undefined {
  if (!declarations) return undefined;
  const result = new Map<string, readonly FormRule[]>();
  for (const [resource, rules] of Object.entries(declarations)) {
    const table = schema.tables.find((candidate) => candidate.id === resource);
    if (!table) throw new Error(`validation: unknown resource "${resource}".`);
    const problems = validateFormRules(rules, table, schema);
    if (problems.length) throw new Error(`validation.${resource}: ${problems[0]}`);
    result.set(resource, Object.freeze([...rules]));
  }
  return result;
}

function keyFilter(table: TableMeta, key: Record<string, string | number>): Filter {
  const primary = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (!primary.length || Object.keys(key).length !== primary.length || primary.some((column) => !Object.hasOwn(key, column))) {
    throw new AppValidationDenied();
  }
  return { groups: [primary.map((column) => ({ column, op: '=' as const, value: key[column] }))] };
}

async function storedRow(tx: WriteTransaction, table: TableMeta, key: Record<string, string | number>): Promise<Record<string, unknown>> {
  const result = await tx.query({
    table: table.id,
    columns: table.columns.map((column) => column.name),
    filter: keyFilter(table, key),
    limit: 2,
    offset: 0,
  });
  if (result.rows.length !== 1) throw new AppValidationDenied();
  return result.rows[0];
}

/** Validate the database's actual post-image, never a write-intent DTO. */
export async function validateStoredPostImage(
  tx: WriteTransaction,
  schema: DatabaseSchema,
  validation: AppValidationRules | undefined,
  tableName: string,
  key: Record<string, string | number>,
  /** The columns an update wrote, or `insert`: a row-defined column is judged when it or its `per` was written. */
  written: readonly string[] | 'insert' = 'insert',
): Promise<void> {
  // A rich text rule was held on the way in (cleanRichTextValues); the post-image has nothing more to say about it.
  const rules = validation?.get(tableName)?.filter(
    (rule) =>
      !onTheWayIn(rule) &&
      !isConsumes(rule) &&
      (!isDefined(rule) || written === 'insert' || written.includes(rule.field) || (!!rule.per && written.includes(rule.per))) &&
      /* A narrowed picker is judged where the write sets the reference or what narrows it. A command that moves a
           request's status or names its vendor writes neither, and was refused on the tenant it never touched
           (`invalid_input`, field tenant_id) wherever a stored row predated the form's narrowing. */
      (!isNarrowed(rule) ||
        written === 'insert' ||
        written.includes(rule.field) ||
        rule.where.some((pair) => written.includes(pair.local))),
  );
  if (!rules?.length) return;
  const table = schema.tables.find((candidate) => candidate.id === tableName);
  if (!table || table.isView) throw new AppValidationDenied();
  const row = await storedRow(tx, table, key);
  const declared = rules.filter(
    (rule): rule is FormRule =>
      !isWorked(rule) &&
      !isNarrowed(rule) &&
      !isText(rule) &&
      !onTheWayIn(rule) &&
      !isDefined(rule) &&
      !isFlowRow(rule) &&
      !isMessageRow(rule) &&
      !isDerived(rule),
  );
  const broken = rules
    .filter(isText)
    .filter((text) => textRuleBreak(text.rule, row[text.field]) !== undefined)
    .map((text) => text.field);
  if (broken.length) throw new AppValidationDenied(broken);
  const worked = rules.find(isWorked);
  const result = declared.length
    ? evaluateFormRules(
        declared,
        ...(await throughReferences(tx, schema, table, declared, workedRow(worked, table, declared, row), worked)),
        {
          mode: 'authoritative',
        },
      )
    : undefined;
  /* A rule's `message` is the App author's own sentence, written to be said to
     the person: it crosses with its field. A value, the rule's condition and
     the database's words never do. */
  if (result && !result.valid)
    throw new AppValidationDenied(
      [...Object.keys(result.errors), ...result.unresolved],
      Object.fromEntries(Object.entries(result.errors).map(([field, messages]) => [field, messages.join(' ')])),
    );
  const outside: string[] = [];
  const narrowed: Record<string, string> = {};
  for (const rule of rules.filter(isNarrowed))
    if (!(await withinNarrowing(tx, rule, row))) {
      outside.push(rule.field);
      // Said, not only named: the field alone sent an author bisecting a command that never took it.
      narrowed[rule.field] = narrowingReason(rule);
    }
  if (outside.length) throw new AppValidationDenied(outside, narrowed);
  const reasons: Record<string, string> = {};
  for (const rule of rules.filter(isDefined)) {
    for (const { key, reason } of await definedRowBreaks(tx, rule, row, written === 'insert' || written.includes(rule.field)))
      reasons[`${rule.field}.${key}`] = DEFINED_REASONS[reason];
  }
  for (const rule of rules.filter(isFlowRow)) {
    const breaks = rule.rows === 'flow' ? flowRowBreaks(row, rule.record) : stepRowBreaks(row, rule.binding, rule.record);
    for (const { field, reason } of breaks) reasons[field] ??= FLOW_REASONS[reason];
  }
  for (const { spec } of rules.filter(isMessageRow)) {
    const problem = await messageRowProblem(spec, row[spec.fields.key], row[spec.fields.locale], row[spec.fields.text]);
    if (problem) reasons[spec.fields[problem.field]] ??= problem.reason;
  }
  if (Object.keys(reasons).length) throw new AppValidationDenied(Object.keys(reasons), reasons);
}

/* The stored row with each computed column of its own the rules name worked out of it (DM5). */
function workedRow(
  worked: Worked | undefined,
  table: TableMeta,
  rules: readonly FormRule[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const named = worked?.computed.get(table.id);
  if (!worked || !named) return row;
  const own = referencedRuleFields(rules).filter((path) => !path.includes('.') && Object.hasOwn(named, path));
  if (!own.length) return row;
  const constants = worked.constants(new Date());
  return { ...row, ...Object.fromEntries(own.map((name) => [name, workedOut(named, table, name, row, constants)])) };
}

/* What a validation reads through a reference (`order_id.status`), from the record it names as this transaction
   sees it: a parent changed earlier in the same write is judged as changed. An empty reference reads as empty.
   A computed column of that record (`service_id.list`) is worked out of the columns it reads (DM5). */
async function throughReferences(
  tx: WriteTransaction,
  stored: DatabaseSchema,
  storedTable: TableMeta,
  rules: readonly FormRule[],
  row: Record<string, unknown>,
  worked?: Worked,
): Promise<[Record<string, unknown>, ColumnMeta[]]> {
  const schema = worked ? withComputedColumns(stored, worked.computed) : stored;
  const table = schema.tables.find((each) => each.id === storedTable.id) ?? storedTable;
  const { columns } = ruleColumns(rules, table, schema);
  if (columns.length === table.columns.length) return [row, columns];
  const judged: Record<string, unknown> = { ...row };
  const byReference = new Map<string, string[]>();
  for (const path of ruleReferencePaths(rules)) byReference.set(path.split('.')[0], [...(byReference.get(path.split('.')[0]) ?? []), path]);
  for (const paths of byReference.values()) {
    const sources = paths.map((path) => [path, derivedSource(path, table, schema)] as const);
    const found = sources.filter(
      (entry): entry is readonly [string, Exclude<ReturnType<typeof derivedSource>, { problem: string }>] => !('problem' in entry[1]),
    );
    if (!found.length) continue;
    const { via, target, key } = found[0][1];
    const named = worked?.computed.get(target.id);
    const computed = (name: string) => named !== undefined && Object.hasOwn(named, name) && !storedOf(stored, target.id, name);
    const chosen = row[via.name];
    const read =
      typeof chosen === 'string' || typeof chosen === 'number'
        ? await tx.query({
            table: target.id,
            columns: [
              ...new Set(
                found.flatMap(([, source]) =>
                  computed(source.column.name) ? storedReads(named!, source.column.name) : [source.column.name],
                ),
              ),
            ],
            filter: { groups: [[{ column: key, op: '=', value: chosen }]] },
            limit: 1,
            offset: 0,
          })
        : undefined;
    const record = read?.rows[0];
    const constants = worked?.constants(new Date());
    const storedTarget = stored.tables.find((each) => each.id === target.id) ?? target;
    for (const [path, source] of found)
      judged[path] =
        record && computed(source.column.name)
          ? workedOut(named!, storedTarget, source.column.name, record, constants!)
          : (record?.[source.column.name] ?? null);
  }
  return [judged, columns];
}

/* The record's definitions, read in the write's own transaction, and what its object breaks. */
async function definedRowBreaks(tx: WriteTransaction, rule: DefinedWriteRule, row: Record<string, unknown>, extras: boolean) {
  const object = definedObject(row[rule.field]);
  // Not an object at all (a list, a number, text that is not JSON): the column itself is what is wrong.
  if (!object) throw new AppValidationDenied([rule.field]);
  const read = await tx.query({
    table: rule.from.id,
    columns: definitionColumns(rule.from, rule.per),
    ...(rule.per ? { filter: definitionFilter(rule.per, row[rule.per]) } : {}),
    limit: DEFINITIONS_MOST,
    offset: 0,
  });
  return definedBreaks(readDefinitions(read.rows, rule.per), object, { extras });
}

/* The form's narrowing as a sentence: the columns it pairs, never a value. The referenced row is read in the
   write's own transaction, so a command that sets the field and does not read its table finds no row to agree. */
const narrowingReason = (rule: NarrowedReference): string =>
  `Choose one whose ${rule.where.map((pair) => `${pair.remote} is this record's ${pair.local}`).join(' and ')} ` +
  `(form.fields.${rule.field}.where; a command that sets it reads "${rule.target}").`;

/* An empty reference narrows nothing. A set one names a row that agrees on
   every pair; an empty local value agrees with nothing, as the picker,
   which offers no choices until that field is filled. */
async function withinNarrowing(tx: WriteTransaction, rule: NarrowedReference, row: Record<string, unknown>): Promise<boolean> {
  const chosen = row[rule.field];
  if (chosen === null || chosen === undefined) return true;
  const values = rule.where.map((pair) => row[pair.local]);
  if (values.some((value) => typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) return false;
  const found = await tx.query({
    table: rule.target,
    columns: [rule.key],
    limit: 1,
    offset: 0,
    filter: {
      groups: [
        [
          { column: rule.key, op: '=', value: chosen as string | number },
          ...rule.where.map((pair, i) => ({ column: pair.remote, op: '=' as const, value: values[i] as string | number | boolean })),
        ],
      ],
    },
  });
  return found.rows.length === 1;
}

export function postImageKey(
  schema: DatabaseSchema,
  tableName: string,
  original: Record<string, string | number>,
  applied: Record<string, string | number | boolean | null>,
): Record<string, string | number> {
  const table = schema.tables.find((candidate) => candidate.id === tableName);
  if (!table) throw new AppValidationDenied();
  const key = { ...original };
  for (const column of table.columns.filter((candidate) => candidate.primaryKey)) {
    if (Object.hasOwn(applied, column.name)) {
      const value = applied[column.name];
      if (typeof value !== 'string' && typeof value !== 'number') throw new AppValidationDenied();
      key[column.name] = value;
    }
  }
  return key;
}

/** Every value a resource's New form takes from a referenced record, by table id. A path the catalog cannot follow is
 * left out: the App's check says so (validateAppForm). */
function appDerivedRules(schema: DatabaseSchema, app: AppDef): Map<string, DerivedWriteRule[]> {
  const found = new Map<string, DerivedWriteRule[]>();
  /* A referenced record's computed column reads like a column of it, and is worked out of what it reads (DM5). */
  const withComputed = storedComputed(app, schema);
  let worked: Worked | undefined | null = null;
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    if (!table || !resource.form?.derived) continue;
    const rules = Object.entries(resource.form.derived).flatMap(([field, path]) => {
      const source = derivedSource(path!, table, withComputed);
      if ('problem' in source) return [];
      const stored = schema.tables
        .find((each) => each.id === source.target.id)
        ?.columns.some((column) => column.name === source.column.name);
      if (!stored && worked === null) worked = appWorked(schema, app);
      if (!stored && !worked?.computed.get(source.target.id)?.[source.column.name]) return [];
      return [
        Object.freeze({
          kind: 'derived' as const,
          field,
          via: source.via.name,
          table: source.target.id,
          column: source.column.name,
          key: source.key,
          ...(stored
            ? {}
            : {
                worked: Object.freeze({
                  named: worked!.computed.get(source.target.id)!,
                  target: schema.tables.find((each) => each.id === source.target.id)!,
                  constants: worked!.constants,
                }),
              }),
        }),
      ];
    });
    if (rules.length) found.set(table.id, rules);
  }
  return found;
}

/**
 * A new record's values with each derived column it leaves out taken from the
 * record its reference names, read through `read` (the write's transaction).
 * A reference left empty, or naming no row, leaves the column to the database.
 */
export async function fillDerived<V extends Readonly<Record<string, unknown>>>(
  validation: AppValidationRules | undefined,
  table: string,
  values: V,
  read: (request: QueryRequest) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>,
): Promise<V> {
  const rules = validation?.get(table)?.filter(isDerived);
  if (!rules?.length || !values || typeof values !== 'object') return values;
  let filled: Record<string, unknown> | undefined;
  for (const rule of rules) {
    if (Object.hasOwn(values, rule.field)) continue;
    const via = values[rule.via];
    if (via === null || via === undefined || via === '') continue;
    const worked = rule.worked;
    const found = await read({
      table: rule.table,
      columns: worked ? storedReads(worked.named, rule.column) : [rule.column],
      limit: 1,
      offset: 0,
      filter: { groups: [[{ column: rule.key, op: '=', value: via as string | number }]] },
    });
    const row = found.rows[0];
    const value =
      worked && row ? workedOut(worked.named, worked.target, rule.column, row, worked.constants(new Date())) : row?.[rule.column];
    if (value !== undefined && value !== null) (filled ??= { ...values })[rule.field] = value;
  }
  return (filled ?? values) as V;
}
