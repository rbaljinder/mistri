/**
 * Text rules on a column: how long a value may be and what form it takes,
 * in the words a command's text input already uses (packages/mistri/schema/command.d.ts):
 *
 *   text: { code: { pattern: '^[A-Z]{3}$', message: 'Three capital letters' }, name: { min: 2, max: 80 } }
 *
 * Two places say them. The App, on the resource (`text`), and the database
 * itself: a `varchar(80)` holds at most 80 characters, and on PostgreSQL a
 * `CHECK (char_length(name) >= 2)` or `CHECK (code ~ '^[A-Z]{3}$')` in that
 * simple form says the rest (adapters read them into `ColumnMeta.text`). A
 * schema-first App gets the database's words free; what the App says wins,
 * key by key.
 *
 * The browser judges a value as it is typed and says the rule under the
 * field; the server judges the stored row on every write (appValidation.ts),
 * whichever door the write came through. Pure: both sides read this one
 * judgement, so they cannot disagree about what "at least 2" counts.
 */
import { columnKind, type ColumnMeta } from './schema.js';

/** A column's rule: fewest and most characters, a regular expression the whole value matches, and what to say. */
export interface TextRule {
  /** Fewest characters, after trimming. */
  min?: number;
  /** Most characters. */
  max?: number;
  /** A regular expression the whole value must match, as its source text. */
  pattern?: string;
  /** What the form says when the rule is not met; a generic sentence otherwise. */
  message?: string;
}

const TEXT_RULE_KEYS = ['min', 'max', 'pattern', 'message'] as const;
/** The most characters a rule may name, as a command's text input. */
const TEXT_RULE_MOST = 16384;
const MESSAGE_MOST = 200;
const PATTERN_MOST = 500;

/** Which part of a rule a value breaks. */
type TextRuleBreak = 'min' | 'max' | 'pattern';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A pattern's source as a whole-value test, or undefined where JavaScript cannot read it. */
function wholePattern(source: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${source})$`, 'u');
  } catch {
    return undefined;
  }
}

/**
 * `resources.<name>.text`, read: an object of the resource's own columns, each
 * { min?, max?, pattern?, message? } with something to check. Throws the
 * sentence the author reads.
 */
export function parseTextRules(raw: unknown, at: string): Record<string, TextRule> {
  const shape = `${at} has a "text" that is not an object of the resource's own column → { min?, max?, pattern?, message? }, like text: { code: { pattern: '^[A-Z]{3}$' } }.`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) throw new Error(shape);
  const rules: Record<string, TextRule> = {};
  for (const [column, value] of Object.entries(raw as Record<string, unknown>)) {
    const here = `${at}, text "${column}"`;
    if (!IDENTIFIER.test(column)) throw new Error(`${here}: a text rule is keyed by the resource's own column, never a path.`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(shape);
    const given = value as Record<string, unknown>;
    const unknown = Object.keys(given).find((key) => !(TEXT_RULE_KEYS as readonly string[]).includes(key));
    if (unknown) throw new Error(`${here} has "${unknown}"; a text rule takes min, max, pattern and message.`);
    const rule: TextRule = {};
    for (const key of ['min', 'max'] as const) {
      if (given[key] === undefined) continue;
      const n = given[key];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > TEXT_RULE_MOST) {
        throw new Error(`${here}: "${key}" must be a whole number of characters from 1 to ${TEXT_RULE_MOST}.`);
      }
      rule[key] = n;
    }
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) throw new Error(`${here}: "min" is more than "max".`);
    if (given.pattern !== undefined) {
      const source = given.pattern;
      if (typeof source !== 'string' || !source || source.length > PATTERN_MOST) {
        throw new Error(`${here}: "pattern" must be a regular expression's source text, at most ${PATTERN_MOST} characters.`);
      }
      if (!wholePattern(source)) throw new Error(`${here}: "pattern" is not a regular expression JavaScript can read: ${source}`);
      rule.pattern = source;
    }
    if (given.message !== undefined) {
      if (typeof given.message !== 'string' || !given.message.trim() || given.message.length > MESSAGE_MOST) {
        throw new Error(`${here}: "message" must be a sentence of 1 to ${MESSAGE_MOST} characters.`);
      }
      rule.message = given.message.trim();
    }
    if (rule.min === undefined && rule.max === undefined && rule.pattern === undefined) {
      throw new Error(`${here} checks nothing; give it a "min", a "max" or a "pattern".`);
    }
    rules[column] = rule;
  }
  return rules;
}

/** Why a resource's text rules cannot run on this table, or undefined. Each must name a text column. */
export function textRulesProblem(
  rules: Readonly<Record<string, TextRule>>,
  columns: readonly ColumnMeta[],
  table: string,
): string | undefined {
  for (const name of Object.keys(rules)) {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column) return `text "${name}": "${table}" has no column "${name}".`;
    if (columnKind(column.type) !== 'text' || column.allowed?.length) {
      return `text "${name}" is ${column.allowed?.length ? 'a vocabulary' : column.type || 'untyped'}; a text rule checks a text column.`;
    }
  }
  return undefined;
}

/**
 * The rule a column is held to: the database's (`ColumnMeta.text`) with the
 * App's on top, key by key. Undefined where neither says anything.
 */
export function columnTextRule(column: Pick<ColumnMeta, 'text'>, authored?: TextRule): TextRule | undefined {
  const rule: TextRule = { ...(column.text ?? {}), ...(authored ?? {}) };
  return rule.min === undefined && rule.max === undefined && rule.pattern === undefined ? undefined : rule;
}

/** Characters as a person counts them, and as `char_length` does: code points, not UTF-16 units. */
const length = (text: string) => [...text].length;

/** What a value breaks of its rule, or undefined. An empty value breaks nothing: whether one is needed is NOT NULL's to say. */
export function textRuleBreak(rule: TextRule, value: unknown): TextRuleBreak | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (rule.min !== undefined && length(value.trim()) < rule.min) return 'min';
  if (rule.max !== undefined && length(value) > rule.max) return 'max';
  if (rule.pattern !== undefined && !wholePattern(rule.pattern)?.test(value)) return 'pattern';
  return undefined;
}

/** A column's catalog rule as the database states it, for `ColumnMeta.text`; undefined where it states none. */
export function catalogTextRule(parts: { max?: number | null; min?: number; pattern?: string }): ColumnMeta['text'] {
  const rule: NonNullable<ColumnMeta['text']> = {};
  if (typeof parts.max === 'number' && Number.isInteger(parts.max) && parts.max > 0) rule.max = parts.max;
  if (parts.min !== undefined && parts.min > 0) rule.min = parts.min;
  if (parts.pattern !== undefined) rule.pattern = parts.pattern;
  return Object.keys(rule).length ? rule : undefined;
}
