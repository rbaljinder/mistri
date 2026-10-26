/**
 * The one chart rule that is not drawing: which periods a bucketed
 * breakdown left out. The charts themselves are components now
 * (`components/Chart.tsx`); this stays a plain function because it is a rule
 * about time, tested on its own, with no DOM in it.
 */

/**
 * The periods a bucketed breakdown left out, put back at zero.
 *
 * The grammar answers only the buckets that have rows: a month with no
 * bookings is not a row, and a line drawn point-to-index through the rows
 * that came back walked straight across the gap — 2025-12 sat beside
 * 2026-03 at the same spacing as any neighbours, and the axis lied about
 * time. Period labels are spelled the same on every engine (`2026-08`,
 * `2026-Q3`, `2026-08-14`, `2026`), so the missing ones can be named and
 * counted as what they are: zero. Keys that are not periods pass through.
 */
export function fillGaps(points) {
  if (points.length < 2) return points;
  const first = periodStep(points[0].key);
  if (!first || points.some((p) => periodStep(p.key) !== first)) return points;
  const step = first === 'day' && weekly(points.map((p) => p.key)) ? 'week' : first;
  /* Time runs left to right whatever order the answer came in: a record
     page's chart is read ranked by its measure, and a walk from the first
     key to the last found nothing to walk when the first was the newest. */
  points = [...points].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byKey = new Map(points.map((p) => [p.key, p]));
  const out = [];
  let key = points[0].key;
  const last = points[points.length - 1].key;
  for (let guard = 0; guard < 2000 && key <= last; guard++) {
    out.push(byKey.get(key) ?? { key, value: 0 });
    key = nextPeriod(key, step);
  }
  return out.length >= points.length ? out : points;
}

/** Whether every key is a period of one step, so the keys can be put in time order. */
export function isPeriodRun(keys) {
  if (!keys.length) return false;
  const step = periodStep(String(keys[0]));
  return Boolean(step) && keys.every((key) => key != null && periodStep(String(key)) === step);
}

/* A week bucket is said by its first day (`2026-10-05`), so its keys are days that all fall on one weekday: the
   gaps between them are weeks, and a missing one is a week at zero, never six days between. */
function weekly(keys) {
  const weekday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay();
  return keys.length > 1 && keys.every((key) => weekday(key) === weekday(keys[0]));
}

function periodStep(key) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return 'day';
  if (/^\d{4}-\d{2}$/.test(key)) return 'month';
  if (/^\d{4}-Q[1-4]$/.test(key)) return 'quarter';
  if (/^\d{4}$/.test(key)) return 'year';
  return null;
}

function nextPeriod(key, step) {
  const pad = (n) => String(n).padStart(2, '0');
  if (step === 'day' || step === 'week') {
    const d = new Date(
      Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)) + (step === 'week' ? 7 : 1)),
    );
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  if (step === 'month') {
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  if (step === 'quarter') {
    const y = Number(key.slice(0, 4));
    const q = Number(key.slice(6));
    return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
  }
  return String(Number(key) + 1);
}
