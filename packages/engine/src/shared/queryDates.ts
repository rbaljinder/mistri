/*
 * Relative dates for the query language: `today`, `last 30 days`,
 * `previous 3 months` resolved to two concrete timestamps against a given
 * now, so they bind as parameters and mean the same on every engine.
 */

/* ---------- relative dates ----------

   SNQL, which this grammar comes from, could leave a relative date as a
   `javascript:` expression for the server to evaluate. There is no such
   escape hatch in SQL, and there should not be: the window is resolved to two
   concrete timestamps here, and those timestamps are bound as parameters.
   The upshot is that `last 7 days` means the same thing in both dialects and
   is visible as a real date in the compiled query. */

interface DateWindow {
  label: string;
  start: Date;
  end: Date;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

/* ---------- today plus or minus N units ----------

   One grammar for the day `today - 18 years` names, read by the query language (a window of that one day) and by a
   command's conditions (`shared/commandDraft.ts`, which works the day out before it compiles), so the two cannot
   come to mean different days. */

const ARITHMETIC_UNITS: Record<string, 'day' | 'month' | 'year'> = {
  day: 'day',
  days: 'day',
  week: 'day',
  weeks: 'day',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
};
const ARITHMETIC_SOURCE = String.raw`today\s*([+-])\s*(\d{1,4})\s*(days?|weeks?|months?|years?)`;
/** `today + 30 days` inside a longer text, each one found. */
export const DATE_ARITHMETIC = new RegExp(String.raw`\b${ARITHMETIC_SOURCE}\b`, 'gi');
const WHOLE_ARITHMETIC = new RegExp(`^${ARITHMETIC_SOURCE}$`, 'i');

/** The day `today ± N units` names, from `today` (YYYY-MM-DD); a month or a year past the month's end lands on its last day. */
export function shiftedDay(today: string, sign: string, count: number, unit: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const by = (sign === '-' ? -1 : 1) * count * (unit.toLowerCase().startsWith('week') ? 7 : 1);
  const kind = ARITHMETIC_UNITS[unit.toLowerCase()];
  if (kind === 'day') return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
  const months = kind === 'year' ? by * 12 : by;
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/**
 * `now` is a parameter rather than a call to the clock, so the compiler is a
 * pure function of its inputs. That is what makes the tests below able to
 * assert on an exact timestamp instead of a range.
 */
export function dateWindow(phrase: string, now: Date): DateWindow | undefined {
  const p = phrase.toLowerCase().trim();
  const today = startOfDay(now);

  const fixed: Record<string, [Date, Date]> = {
    today: [today, addDays(today, 1)],
    yesterday: [addDays(today, -1), today],
    tomorrow: [addDays(today, 1), addDays(today, 2)],
  };
  if (fixed[p]) return { label: p, start: fixed[p][0], end: fixed[p][1] };

  if (p === 'this week' || p === 'last week') {
    // Weeks start Monday, which is what a working calendar means by "this week".
    const dow = (today.getDay() + 6) % 7;
    const monday = addDays(today, -dow);
    const start = p === 'this week' ? monday : addDays(monday, -7);
    return { label: p, start, end: addDays(start, 7) };
  }
  if (p === 'this month' || p === 'last month') {
    const base = new Date(today.getFullYear(), today.getMonth() + (p === 'last month' ? -1 : 0), 1);
    const end = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    return { label: p, start: base, end };
  }
  if (p === 'this quarter' || p === 'last quarter' || p === 'next quarter') {
    /* Calendar quarters, from January, April, July and October: an App declares no fiscal year, so a quarter is the
       calendar's. `Date` carries a month before January or after December into the year beside it. */
    const shift = p === 'last quarter' ? -3 : p === 'next quarter' ? 3 : 0;
    const start = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 + shift, 1);
    return { label: p, start, end: new Date(start.getFullYear(), start.getMonth() + 3, 1) };
  }
  if (p === 'this year' || p === 'last year') {
    const year = today.getFullYear() + (p === 'last year' ? -1 : 0);
    return { label: p, start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
  }

  /* One day, not a span: `due = today + 30 days` is that whole day, and `next 30 days` stays the "within" form. */
  const arithmetic = WHOLE_ARITHMETIC.exec(p);
  if (arithmetic) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const [, sign, count, unit] = arithmetic;
    const day = shiftedDay(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`, sign, Number(count), unit);
    const [y, m, d] = day.split('-').map(Number);
    const start = new Date(y, m - 1, d);
    return { label: p, start, end: addDays(start, 1) };
  }

  const span = p.match(/^(last|next|previous)\s+(\d+)\s+(minute|hour|day|week|month|year)s?$/);
  if (span) {
    const [, dir, amountRaw, unit] = span;
    const amount = Number(amountRaw);
    const past = dir === 'last';
    /* `previous N` is the window immediately before `last N`, the same
       length, ending where `last N` starts. It exists so a metric's
       "previous period" compare is equal-span *by construction*: `last 30
       days` runs from thirty days ago to tomorrow (31 calendar days, today
       included), and any rewrite in terms of `last` was a day short. */
    const previous = dir === 'previous';
    /* A span of the clock, from the instant: `last 30 minutes` is an update just now, `next 2 hours` what falls due
       before then. */
    if (unit === 'hour' || unit === 'minute') {
      const ms = amount * (unit === 'hour' ? 3600_000 : 60_000);
      if (previous) return { label: p, start: new Date(now.getTime() - 2 * ms), end: new Date(now.getTime() - ms) };
      return past
        ? { label: p, start: new Date(now.getTime() - ms), end: now }
        : { label: p, start: now, end: new Date(now.getTime() + ms) };
    }
    const days = unit === 'week' ? amount * 7 : amount;
    if (unit === 'month' || unit === 'year') {
      /* Counted in calendar units rather than in days, so `last 3 months`
         from the 31st lands on a date that exists and `last 1 year` from a
         leap day does not drift. `Date` normalises an overflowing day of the
         month, which is the behaviour wanted here: three months before the
         31st of May is the 28th of February, not a date in March. */
      const months = unit === 'year' ? amount * 12 : amount;
      const other = new Date(today.getFullYear(), today.getMonth() + (past || previous ? -months : months), today.getDate());
      if (previous) {
        /* `last N months` is N months and a day (to tomorrow); the window
           before it is the same: N months back from its start, less a day. */
        const start = new Date(other.getFullYear(), other.getMonth() - months, other.getDate() - 1);
        return { label: p, start, end: other };
      }
      return past ? { label: p, start: other, end: addDays(today, 1) } : { label: p, start: today, end: other };
    }
    if (previous) {
      const end = addDays(today, -days);
      return { label: p, start: addDays(end, -(days + 1)), end };
    }
    return past
      ? { label: p, start: addDays(today, -days), end: addDays(today, 1) }
      : { label: p, start: today, end: addDays(today, days) };
  }
  return undefined;
}

/* ---------- a tone key's date comparison ----------

   A display rule's `tone` keys name a comparison: `>= 90` for a figure, and for a date the same phrases a list's
   conditions take (`< today`, `<= next 7 days`). It is read here, by `dateWindow`, so a phrase means one thing in a
   segment and in a tone, and each edge is the one the query compiler binds: `<` and `>=` the window's start, `>` and
   `<=` its end. A tone colors a day, so a phrase that is a span of the clock (`last 2 hours`) is refused. */

interface DateComparison {
  op: '<' | '<=' | '>' | '>=';
  phrase: string;
}

/** A tone key that is a date comparison — `<= today`, `< next 7 days` — or undefined where it is not one. */
export function dateComparison(key: string): DateComparison | undefined {
  const m = /^(>=|<=|>|<)\s*([a-z][a-z0-9 ]*)$/i.exec(key.trim());
  if (!m) return undefined;
  const phrase = m[2].trim().replace(/\s+/g, ' ').toLowerCase();
  if (/\b(?:hour|minute)s?$/.test(phrase) || !dateWindow(phrase, new Date())) return undefined;
  return { op: m[1] as DateComparison['op'], phrase };
}

/**
 * Whether a day satisfies a date comparison. `offset` is the day's distance from `today` in whole days (negative
 * before it), `today` the App's today as a Date whose local fields read it (what `dateWindow` computes with).
 */
export function dateComparisonHolds(cmp: DateComparison, offset: number, today: Date): boolean {
  const window = dateWindow(cmp.phrase, today);
  if (!window) return false;
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const from = (d: Date) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - base) / 86_400_000);
  const start = from(window.start);
  const end = from(window.end);
  if (cmp.op === '<') return offset < start;
  if (cmp.op === '>=') return offset >= start;
  if (cmp.op === '>') return offset >= end;
  return offset < end;
}
