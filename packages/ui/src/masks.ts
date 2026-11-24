/* Input masks as a pair of functions. A field keeps the raw value (digits, usually); `format` draws it in the box and
   `parse` reads what was typed back to raw, so a mask never has to know where the cursor is. A page may pass its own.
   Preview: @mistriwork/ui is Preview at 1.0. */

import { resolveLocale } from './internal/locale.js';

export interface Mask {
  format: (raw: string) => string;
  parse: (typed: string) => string;
  /** How many raw characters make a whole value, when there is one (a phone is 10 digits). */
  length?: number;
  placeholder?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email';
}

export const digits = (s: string): string => s.replace(/\D/g, '');
/** A number with thousands separators in the resolved locale, preserving >2^53 numeric string precision. */
export const grouped = (n: number | bigint | string, locale?: string): string => {
  const resolved = resolveLocale(locale);
  if (typeof n === 'bigint') {
    return new Intl.NumberFormat(resolved).format(n);
  }
  if (typeof n === 'number') {
    return Number.isFinite(n) ? new Intl.NumberFormat(resolved, { maximumFractionDigits: 20 }).format(n) : String(n);
  }
  const trimmed = n.trim();
  if (!trimmed) return '';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return new Intl.NumberFormat(resolved, { maximumFractionDigits: 20 }).format(trimmed as Intl.StringNumericLiteral);
  }
  return trimmed;
};

/* The decimal character the resolved locale writes, which is what `format` draws and so what `parse` must read. */
function separators(locale?: string): { decimal: string } {
  const parts = new Intl.NumberFormat(resolveLocale(locale)).formatToParts(1.5);
  return { decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.' };
}

/** Digits cut into groups: sizes [3,3,4] with '-' gives 678-678-6781. A partial value ends where its digits do. */
function grouping(sizes: number[], sep: string, placeholder?: string, inputMode: Mask['inputMode'] = 'numeric'): Mask {
  const max = sizes.reduce((a, b) => a + b, 0);
  return {
    parse: (typed) => digits(typed).slice(0, max),
    format: (raw) => {
      const parts: string[] = [];
      let at = 0;
      for (const size of sizes) {
        if (at >= raw.length) break;
        parts.push(raw.slice(at, at + size));
        at += size;
      }
      return parts.join(sep);
    },
    length: max,
    placeholder,
    inputMode,
  };
}

export const masks = {
  phone: grouping([3, 3, 4], '-', undefined, 'tel'),
  date: grouping([2, 2, 4], '/', 'MM/DD/YYYY'),
  month: grouping([2, 4], '/', 'MM/YYYY'),
  ssn: grouping([3, 2, 4], '-'),
  zip: grouping([5], '-'),
  digits: { ...grouping([30], ''), length: undefined },
  /** Money with thousands separators (and 2 decimal places when fractional): `$2,500` or `$1,250.50` for `symbol: '$'`. */
  money: (symbol = '$', max = 20, locale?: string): Mask => ({
    parse: (typed) => {
      /* Read with the separators `format` wrote: in German `1.250` is twelve hundred and fifty, and reading its `.` as
         a decimal point would turn it into 1.25 on the next keystroke. The raw value keeps `.` whatever the locale. */
      const { decimal } = separators(locale);
      const firstDigit = typed.search(/\d/);
      const lead = firstDigit === -1 ? typed : typed.slice(0, firstDigit);
      const sign = /[-\u2212]/.test(lead) ? '-' : '';
      /* The symbol goes first: one that holds the decimal character (`Rs.`, `kr.`) is not where the fraction starts. */
      const symbolAt = symbol ? typed.indexOf(symbol) : -1;
      const body = symbolAt === -1 ? typed : typed.slice(0, symbolAt) + typed.slice(symbolAt + symbol.length);
      const pointAt = body.indexOf(decimal);
      if (pointAt === -1) return sign + digits(body).slice(0, max);
      const intPart = digits(body.slice(0, pointAt)).slice(0, max);
      const fracPart = digits(body.slice(pointAt + 1)).slice(0, 2);
      if (!intPart && !fracPart) return sign;
      return `${sign}${intPart || '0'}.${fracPart}`;
    },
    format: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return '';
      const neg = trimmed.startsWith('-');
      const unsigned = neg ? trimmed.slice(1) : trimmed;
      /* A minus alone is a negative amount being typed: drawn bare, so one backspace still empties the box. */
      if (!unsigned) return neg ? '-' : '';
      const prefix = neg ? `-${symbol}` : symbol;
      if (unsigned.endsWith('.')) {
        const intPart = unsigned.slice(0, -1) || '0';
        return `${prefix}${grouped(intPart, locale)}${separators(locale).decimal}`;
      }
      if (/^\d+\.\d+$/.test(unsigned)) {
        const formatted = new Intl.NumberFormat(resolveLocale(locale), {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(unsigned as Intl.StringNumericLiteral);
        return `${prefix}${formatted}`;
      }
      return `${prefix}${grouped(unsigned, locale)}`;
    },
    inputMode: 'decimal',
  }),
};

export type MaskName = 'phone' | 'date' | 'month' | 'ssn' | 'zip' | 'digits' | 'money' | 'grouped';

/** A mask by its name, for a spec that is data. */
export function maskNamed(name: MaskName | Mask): Mask {
  if (typeof name !== 'string') return name;
  if (name === 'money') return masks.money('$');
  if (name === 'grouped') return { ...masks.money(''), parse: (typed) => digits(typed).slice(0, 20), inputMode: 'numeric' };
  return masks[name];
}

/** A typed MM/DD/YYYY as YYYY-MM-DD, or '' when it is not a real day. */
export function isoDay(typed: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(typed);
  if (!m) return '';
  const [, mm, dd, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (d.getUTCFullYear() !== Number(yyyy) || d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) return '';
  return `${yyyy}-${mm}-${dd}`;
}
