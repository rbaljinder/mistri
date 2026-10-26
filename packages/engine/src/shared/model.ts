/**
 * The helpers every model parser and rule reads, whichever product it
 * belongs to: what a closed union's last case says, a key refused by name,
 * a plain object, a name said the way a person says it.
 */
import { unknownKey } from './suggest.js';

/**
 * The end of a switch over a closed union: a compile error where a new
 * member has no case, and a throw where one arrives at run time anyway.
 * A `default` that quietly answered "nothing" is how a new section kind
 * once skipped a role check.
 */
export function assertNever(value: never, what = 'case'): never {
  throw new Error(`Unknown ${what}: ${JSON.stringify((value as { kind?: unknown } | null)?.kind ?? value)}.`);
}

/**
 * Refuse a key the location does not have, naming the ones it does.
 *
 * An unknown key used to vanish: `lable`, `qeury`, `navigation` all parsed
 * to an emptier app with no word said, which for a manifest written by an
 * agent — no editor squiggle, no schema check — is the worst failure mode a
 * config surface has. The header promises nothing is silently skipped; this
 * is what keeps the promise at every level. Keys beginning with `$` or `_`
 * are annotations (`$schema`, `_comment`) and pass: JSON has no comments and
 * a manifest is allowed to explain itself.
 *
 * A key the location declares ahead of its feature is in `refused`, and is
 * refused with the reason instead of the list. Any other is offered the key
 * it is a near miss of, or the place it belongs (unknownKey).
 */
export function allowKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
  refused: Readonly<Record<string, string>> = {},
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key) || /^[$_]/.test(key)) continue;
    if (Object.hasOwn(refused, key)) throw new Error(`${at} has "${key}", which ${refused[key]}.`);
    throw new Error(`${at} ${unknownKey(key, allowed, keyHomes(key))}.`);
  }
}

/* Where else a key is taken, for a refusal to name. app.ts sets it to the
   App parsers' own key lists, read on the first refusal (appKeyHomes.ts): a
   hook, because every parser imports this module and the lists cannot be
   imported back into it. Absent, a refusal names no home. */
let keyHomes: (key: string) => readonly string[] = () => [];

export const setKeyHomes = (homes: (key: string) => readonly string[]): void => {
  keyHomes = homes;
};

export const keyHomesOf = (key: string): readonly string[] => keyHomes(key);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * A plain data object, or a refusal: own enumerable data properties only, on
 * no borrowed prototype. The places a getter could run code during a parse,
 * or an inherited value could stand in for an authored one — the root, the
 * resource blocks and their ceilings — are read only after this.
 */
export function plainRecord(raw: unknown, at: string, what: string): Record<string, unknown> {
  if (!isRecord(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error(`${at} is not ${what}.`);
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error(`${at} must be plain data: "${String(key)}" is not a data property.`);
    }
  }
  return raw;
}

/** A trimmed non-empty string, or undefined when absent; anything else is refused. */
export function optionalText(o: Record<string, unknown>, key: string, at: string): string | undefined {
  const value = o[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${at} has a "${key}" that is not a non-empty string.`);
  return value.trim();
}

export const RESERVED_NAMES = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

/** A view key: its address — `{id}:` before a list's question, `@dash-{id}`, `@form-{id}`, `/form/{id}`. */
export const VIEW_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A page key: the page id (`@{id}` when its name does not say it unambiguously). */
export const PAGE_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A table or column name as a person would say it: `work_order` → "Work
 * order", `shippedOn` → "Shipped on". The nav used to serve the raw name
 * when the author wrote no label, so the sidebar read `work_order` beside
 * a breadcrumb that had already humanised it. Mirror of `humanName` in the
 * client (core.js), for the one place the server labels something.
 */
export function humanName(name: string): string {
  if (!name || /\s/.test(name)) return name;
  /* A table is named by its schema too (`billing.order_line`), and a reader of the page it heads was never told which
     schema it came from: the name after the last dot is the one that is said. */
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  if (!bare) return name;
  const words = bare
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/_+/)
    .filter(Boolean);
  if (!words.length) return name;
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (HUMAN_CAPS.has(lower)) return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/* The same set as the client's CAPS, kept identical by test/mirrors.test.ts. */
const HUMAN_CAPS = new Set(['id', 'url', 'uuid', 'sku', 'api', 'ip', 'iso', 'sla']);

/** What one of a resource's records is called, and more than one, as they read mid-sentence: `noun` on its block.
    appNoun.ts says it where each place needs it. */
export interface AppNoun {
  one: string;
  many: string;
}

/* A stored vocabulary word (`in_progress`, `in progress`, `no-show`) is said
   the way its picker and a workflow strip say it ("In progress", "No-show"),
   whichever joiner the schema spelled it with: underscores alone left a column
   reading "Done" above "in progress". A code (`RNO`), a mixed-case name or
   anything with punctuation stays as stored. */
const VOCABULARY_WORD = /^[a-z][a-z0-9]*(?:(?:_+| |-)[a-z0-9]+)*$/;

/** What a stored value is called wherever the platform words it: a tone chip, a picker, a filter, a board's lane and row heads. */
export function vocabularyWord(text: string): string {
  return VOCABULARY_WORD.test(text) ? humanName(text.replaceAll(' ', '_')) : text;
}

/**
 * The word a display rule says a stored value as: the author's own
 * (`values`), the value made words where the rule says `humanize`
 * (`IN_REVIEW` → "In review"), or undefined where the rule says neither.
 * Own keys only, as everywhere a stored value names a key. One rule for a
 * cell (the client's valueModel) and a record's computed name
 * (appRecordLabels.ts).
 */
export function displayWord(
  rule: { values?: Record<string, string>; humanize?: boolean } | null | undefined,
  text: string,
): string | undefined {
  if (rule?.values && Object.hasOwn(rule.values, text)) return rule.values[text];
  if (rule?.humanize && text.trim()) {
    const plain = /^[A-Z0-9_]+$/.test(text) ? text.toLowerCase() : text;
    const word = vocabularyWord(plain);
    return word !== plain ? word : humanName(plain);
  }
  return undefined;
}

export type DisplayTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/* `neutral` exists for the "*" rule: a vocabulary is all pills or no pills,
   and the values the author has nothing to say about wear a pill that says
   nothing in particular rather than falling back to bare text beside the
   coloured ones. */
export const DISPLAY_TONES = ['good', 'warn', 'bad', 'info', 'neutral'] as const;

/** What a masked value is drawn as (`masked: true`): short, and the same for every value, so its length says nothing either. */
export const MASK = '••••••';

export const CHART_SHAPES = ['line', 'bar', 'donut', 'stacked'] as const;

/** How a measured section says its figures where its measure has no column rule to say them: `duration` reads
    the figure as seconds ("10h 2m"), as a `duration` column rule does. */
export const FIGURE_FORMATS = ['percent', 'number', 'money', 'duration'] as const;

export type FigureFormat = (typeof FIGURE_FORMATS)[number];

/** The refusal's list of them, to finish its own sentence. */
export const FIGURE_FORMAT_WORDS = '"percent" (a figure 0–100), "number", "money" or "duration" (a figure in seconds)';
