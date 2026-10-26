/**
 * An answer as its field draws it: a masked text through its mask, an amount in the App's currency. One place, so
 * the control (IntakeControls.tsx) and the review that reads the answer back (reviewValues.ts) say `(303) 555-0142`
 * and `$450` alike; the review never says the raw `3035550142` the control hands on.
 */
import { defaultCurrency, formatLocale } from '@mistriwork/kit/client/locale.js';

/** A mask's places: a digit, a letter, either. Anything else is a literal drawn as written. */
export const PLACE = /[0a*]/;

/** The raw characters drawn through the mask: its literals stand between them, up to the last one typed. */
export function maskShown(mask: string, raw: string): string {
  let out = '';
  let at = 0;
  for (const c of mask) {
    if (at >= raw.length) break;
    if (PLACE.test(c)) out += raw[at++];
    else out += c;
  }
  return out;
}

/**
 * An amount in the App's currency, grouped as the locale groups it: `$1,000` on a whole step or a whole amount,
 * `$12.50` where the cents say something. Without a currency it is the App's (`ui.currency`), else US dollars.
 */
export function amountIn(amount: number, currency?: string, step?: number): string {
  const digits = step === undefined || Number.isInteger(step) || Number.isInteger(amount) ? 0 : 2;
  try {
    return new Intl.NumberFormat(formatLocale(), {
      style: 'currency',
      currency: currency || defaultCurrency(),
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return amount.toLocaleString(formatLocale());
  }
}

/** The currency's symbol in the App's locale: `$`, `€`, `₹`. */
export function moneySymbol(currency?: string): string {
  const code = currency || defaultCurrency();
  try {
    return (
      new Intl.NumberFormat(formatLocale(), { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? code
    );
  } catch {
    return code;
  }
}
