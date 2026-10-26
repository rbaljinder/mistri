/**
 * Money kept as a whole number of minor units — cents, paise, fils, yen — the
 * way a payment provider and most commerce schemas keep it, declared on the
 * column's display rule: `total: { format: 'money', minor: true }`.
 *
 * The figure's decimals are the currency's own, as Intl knows them: two for
 * USD and INR, none for JPY and KRW, three for KWD and BHD. So 1999 is $19.99,
 * ¥1,999 and 1.999 KWD, and nothing about a currency is spelled twice. The
 * conversions are text to text, never through a float: an amount past 2^53
 * comes back from an adapter as a string and stays exact.
 *
 * Browser-safe, and drawn with every list, so it holds only what saying an
 * amount needs; reading a typed one back (a money box, a CSV import) is
 * moneyEntry.ts, loaded with what takes one.
 */

const digitsByCurrency = new Map<string, number>();

/** The decimals a currency is written with (ISO 4217's minor unit, as Intl has it); 2 for a code Intl does not know. */
export function currencyDigits(currency: string): number {
  const code = currency.toUpperCase();
  let digits = digitsByCurrency.get(code);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    digitsByCurrency.set(code, digits);
  }
  return digits;
}

/**
 * A stored amount of minor units as the major figure's exact decimal text —
 * 1999 → "19.99" in USD, "1999" in JPY, "1.999" in KWD — or undefined when
 * the value is not a whole number of them (an average, say), which the caller
 * then divides as a number.
 */
export function minorToMajor(value: unknown, currency: string): string | undefined {
  const m = /^(-?)0*(\d+)$/.exec(
    typeof value === 'number'
      ? Number.isSafeInteger(value)
        ? String(value)
        : ''
      : typeof value === 'string' || typeof value === 'bigint'
        ? String(value).trim()
        : '',
  );
  if (!m) return undefined;
  const digits = currencyDigits(currency);
  const whole = m[2].padStart(digits + 1, '0');
  return (/[1-9]/.test(whole) ? m[1] : '') + (digits ? `${whole.slice(0, -digits)}.${whole.slice(-digits)}` : whole);
}

/**
 * A minor-unit value as the figure a money format draws: the exact major text
 * where it is a whole number of minor units, else the number divided (a
 * total's average). Undefined for no number at all.
 */
export function minorFigure(value: unknown, currency: string): string | number | undefined {
  const exact = minorToMajor(value, currency);
  if (exact !== undefined) return exact;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n / 10 ** currencyDigits(currency) : undefined;
}

/**
 * The path a shown money column's currency is read from, where its rule says
 * `currency: { column }`: a column of the table the value was read from, so
 * `order_id.total` shown on a line reads `order_id.currency_code`, as a
 * second line does (subtitlePath.ts).
 */
export function currencyPath(rule: { currencyColumn?: string } | null | undefined, shown: string): string | undefined {
  if (!rule?.currencyColumn) return undefined;
  const hop = shown.lastIndexOf('.');
  return hop < 0 ? rule.currencyColumn : `${shown.slice(0, hop + 1)}${rule.currencyColumn}`;
}

/** A rule's currency for one row: the row's own column where the rule names one and the row holds a code, else the rule's or the App's. */
export function rowCurrency(
  rule: { currency?: string; currencyColumn?: string } | null | undefined,
  row: Readonly<Record<string, unknown>> | undefined,
  fallback: string,
  shown = '',
): string {
  const path = currencyPath(rule, shown);
  const own = path && row ? row[path] : undefined;
  return typeof own === 'string' && /^[A-Za-z]{3}$/.test(own.trim()) ? own.trim().toUpperCase() : (rule?.currency ?? fallback);
}
