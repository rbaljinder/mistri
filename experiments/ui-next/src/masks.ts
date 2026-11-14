/* What a field shows of what was typed, and what it keeps. A mask is two functions over the kept value (the
   digits, usually): `format` says them as the reader expects to see them, and `parse` reads them back out of
   whatever is in the box. Said as a shape, `#` is a digit and anything else is drawn as it stands. */
export type Mask = {
  format: (raw: string) => string;
  parse: (typed: string) => string;
  /* How many characters the kept value has when it is whole, where there is such a number. */
  length?: number;
  placeholder?: string;
  inputMode?: 'numeric' | 'tel' | 'decimal' | 'text';
  autoComplete?: string;
};

export const digits = (text: string): string => text.replace(/\D/g, '');

/* A mask from its shape: `(###) ###-####`. A part of the shape that is not a digit is drawn only once a digit
   stands after it, so a half-typed value ends where its digits do and never in a bracket waiting to be closed. */
export function shaped(shape: string, more: Partial<Mask> = {}): Mask {
  const length = [...shape].filter((mark) => mark === '#').length;
  return {
    length,
    inputMode: 'numeric',
    parse: (typed) => digits(typed).slice(0, length),
    format: (raw) => {
      let out = '';
      let at = 0;
      for (const mark of shape) {
        if (at >= raw.length) break;
        if (mark === '#') {
          out += raw[at];
          at += 1;
        } else out += mark;
      }
      return out;
    },
    ...more,
  };
}

export const masks = {
  phone: shaped('(###) ###-####', { inputMode: 'tel', autoComplete: 'tel-national', placeholder: '(555) 555-0100' }),
  date: shaped('##/##/####', { placeholder: 'MM/DD/YYYY' }),
  month: shaped('##/####', { placeholder: 'MM/YYYY' }),
  time: shaped('##:##', { placeholder: 'HH:MM' }),
  ssn: shaped('###-##-####'),
  zip: shaped('#####', { autoComplete: 'postal-code' }),
  card: shaped('#### #### #### ####', { autoComplete: 'cc-number', placeholder: '0000 0000 0000 0000' }),
  /* Digits and nothing else, as many as are typed. */
  digits: { parse: digits, format: (raw: string) => raw, inputMode: 'numeric' } satisfies Mask as Mask,
  /* Whole money, grouped: `$2,500`. */
  money: (symbol = '$', max = 9): Mask => ({
    parse: (typed) =>
      digits(typed)
        .slice(0, max)
        .replace(/^0+(?=\d)/, ''),
    format: (raw) => (raw === '' ? '' : `${symbol}${Number(raw).toLocaleString('en-US')}`),
    inputMode: 'numeric',
  }),
};

export type MaskName = Exclude<keyof typeof masks, 'money'>;

/* Where the caret belongs in `text` when it stood after this many kept characters: just past the last of them, so
   editing in the middle of a value leaves the caret where the reader was typing and not at the end. */
export function caretAfter(text: string, kept: number, counts: (mark: string) => boolean = (mark) => /\d/.test(mark)): number {
  if (kept <= 0) return 0;
  let seen = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (counts(text[at]!)) seen += 1;
    if (seen === kept) return at + 1;
  }
  return text.length;
}
