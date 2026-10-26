/* Input masks as a pair of functions. A field keeps the raw value (digits, usually); `format` draws it in the box and
   `parse` reads what was typed back to raw, so a mask never has to know where the cursor is. A page may pass its own.
   Preview: @mistriwork/ui is Preview at 1.0. */

export interface Mask {
  format: (raw: string) => string;
  parse: (typed: string) => string;
  /** How many raw characters make a whole value, when there is one (a phone is 10 digits). */
  length?: number;
  placeholder?: string;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email';
}

export const digits = (s: string): string => s.replace(/\D/g, '');
/** A whole number with thousands separators (the locale is the caller's: en-US here, as the presets are). */
export const grouped = (n: number): string => n.toLocaleString('en-US');

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
  /** Whole money: `$2,500` for `symbol: '$'`, `25,000` for ''. */
  money: (symbol = '$', max = 7): Mask => ({
    parse: (typed) => digits(typed).slice(0, max),
    format: (raw) => (raw === '' ? '' : `${symbol}${grouped(Number(raw))}`),
    inputMode: 'numeric',
  }),
};

export type MaskName = 'phone' | 'date' | 'month' | 'ssn' | 'zip' | 'digits' | 'money' | 'grouped';

/** A mask by its name, for a spec that is data. */
export function maskNamed(name: MaskName | Mask): Mask {
  if (typeof name !== 'string') return name;
  if (name === 'money') return masks.money('$');
  if (name === 'grouped') return masks.money('');
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
