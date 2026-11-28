/**
 * Retention, declared: how long the runtime keeps what it writes about the
 * App as it runs. Three windows, each a duration in the App's one spelling of
 * "how long" (`'30 days'`, engine/src/shared/duration.ts) or `'forever'`:
 *
 *   retention: { history: '730 days', commands: '730 days', attempts: '30 days' }
 *
 * `history` is the record history (who changed what), `commands` the command
 * journal's receipts with their audit (one that carries events is kept while
 * they are), `attempts` the finished tries of jobs
 * and webhook deliveries. Absent, a window is its default; a window the App
 * names changes only that one. A daily built-in job prunes past them
 * (server/retention.ts); `'forever'` prunes nothing.
 *
 * The duration form has no month or year, so the two-year defaults are spelled
 * in days.
 */
import { DURATION_WORDS, parseDuration } from '@mistriwork/engine/shared/duration.js';
import { isRecord } from '@mistriwork/engine/shared/model.js';

const RETENTION_WINDOWS = ['history', 'commands', 'attempts', 'reads'] as const;
type RetentionWindow = (typeof RETENTION_WINDOWS)[number];
/** A duration (`'30 days'`, `'6 years'`), or `'forever'`. */
type RetentionSpan = string;
/** As the App declares it: the windows it names. */
export type AppRetention = Readonly<Partial<Record<RetentionWindow, RetentionSpan>>>;

const FOREVER = 'forever';
const YEAR_MS = 365 * 86_400_000;
/** What a window is when the App does not name it. `reads` defaults to `'forever'` so existing read audits are never pruned unless declared. */
const RETENTION_DEFAULTS: Readonly<Record<RetentionWindow, RetentionSpan>> = Object.freeze({
  history: '730 days',
  commands: '730 days',
  attempts: '30 days',
  reads: FOREVER,
});

function parseRetentionDuration(value: unknown): number | undefined {
  const base = parseDuration(value);
  if (base !== undefined) return base;
  const years = typeof value === 'string' ? /^\s*(\d{1,9})\s+years?\s*$/.exec(value) : null;
  return years ? Number(years[1]) * YEAR_MS : undefined;
}

/** A declared `retention`, checked: the windows it names, each a duration above zero or `'forever'`. */
export function parseAppRetention(raw: unknown, where: string): AppRetention {
  if (!isRecord(raw))
    throw new Error(`${where} is an object naming history, commands, attempts and reads, like { attempts: '14 days', reads: '6 years' }.`);
  const out: Partial<Record<RetentionWindow, RetentionSpan>> = {};
  for (const key of Object.keys(raw)) {
    if (!(RETENTION_WINDOWS as readonly string[]).includes(key))
      throw new Error(`${where} has no "${key}". It takes: ${RETENTION_WINDOWS.join(', ')}.`);
  }
  for (const key of RETENTION_WINDOWS) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    const text = typeof value === 'string' ? value.trim() : value;
    if (text !== FOREVER && !parseRetentionDuration(text))
      throw new Error(`${where} ${key} is ${DURATION_WORDS} (or years), above zero, or '${FOREVER}'.`);
    out[key] = text as RetentionSpan;
  }
  return Object.freeze(out);
}

/** The windows in milliseconds, defaults applied; null keeps for ever. */
export function retentionMs(declared?: AppRetention): Readonly<Record<RetentionWindow, number | null>> {
  const ms = (key: RetentionWindow): number | null => {
    const span = declared?.[key] ?? RETENTION_DEFAULTS[key];
    return span === FOREVER ? null : parseRetentionDuration(span)!;
  };
  return Object.freeze({ history: ms('history'), commands: ms('commands'), attempts: ms('attempts'), reads: ms('reads') });
}
