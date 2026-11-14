/* How Lintel's values are said on its ui-next pages. Lintel keeps money in cents and days as ISO dates; "today"
   is the reader's. */
export type Row = Readonly<Record<string, unknown>>;

export const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

export const money = (cents: unknown, digits = 0): string =>
  (Number(cents ?? 0) / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const at = (iso: unknown): Date => new Date(`${text(iso).slice(0, 10)}T00:00:00Z`);

export const day = (iso: unknown, year = true): string =>
  at(iso).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });

/* Whole days from today to a date: negative once it has passed. */
export function daysUntil(iso: unknown): number {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((at(iso).getTime() - today) / 86_400_000);
}

/* A date as a reader plans by it: "today", "in 8 days", "3 weeks ago". Past two months it is only the date. */
export function fromNow(iso: unknown): string {
  const days = daysUntil(iso);
  const far = Math.abs(days);
  if (days === 0) return 'today';
  const span = far < 14 ? `${far} ${far === 1 ? 'day' : 'days'}` : far < 60 ? `${Math.round(far / 7)} weeks` : '';
  if (!span) return '';
  return days > 0 ? `in ${span}` : `${span} ago`;
}

export const words = (value: unknown): string =>
  text(value)
    .replace(/_/g, ' ')
    .replace(/^./, (first) => first.toUpperCase());

export const initials = (name: unknown): string =>
  text(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');

export const beds = (count: unknown): string => (Number(count) === 0 ? 'Studio' : `${text(count)} bed`);

/* Rows as a CSV file the browser saves: a value with a comma, a quote or a line break is quoted. */
export function saveCsv(name: string, head: string[], lines: unknown[][]): void {
  const cell = (value: unknown) => {
    const said = text(value);
    return /[",\n]/.test(said) ? `"${said.replace(/"/g, '""')}"` : said;
  };
  const file = new Blob([[head, ...lines].map((line) => line.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
