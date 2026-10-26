/**
 * A number's `live` lines, said under it as it is typed: "$54,167 monthly · $650,000 annually". Each is an expression
 * over the input's numbers (`biweekly_gross * 26 / 12`), read by the evaluator computed columns use, in the field's
 * format. Display only: nothing here is sent, and a line whose numbers are not all given says nothing.
 */
import { type ComputedNode } from '@mistriwork/engine/shared/computed.js';
import { parseComputed } from '@mistriwork/engine/shared/computedParse.js';
import { evaluateComputed } from '@mistriwork/engine/shared/computedValue.js';
import { formatLocale } from '@mistriwork/kit/client/locale.js';
import { useMemo } from 'react';
import './CommandLive.css';
import type { AppCommandField } from '../../shared/command.js';
import type { CommandValues } from './CommandFields.js';

type LiveField = AppCommandField & { type: 'number' | 'money'; live?: Readonly<Record<string, string>> };

const parsed = new Map<string, ComputedNode | null>();
function tree(expression: string, numbers: ReadonlySet<string>): ComputedNode | null {
  const key = `${[...numbers].join(',')}|${expression}`;
  if (!parsed.has(key)) {
    try {
      parsed.set(
        key,
        parseComputed(expression, (name) => numbers.has(name)),
      );
    } catch {
      parsed.set(key, null);
    }
  }
  return parsed.get(key)!;
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const n = Number(value.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function liveFigures(field: LiveField, fields: readonly AppCommandField[], values: CommandValues): Array<[string, number]> {
  const numbers = new Set(fields.filter((each) => each.type === 'number' || each.type === 'money').map((each) => each.name));
  const out: Array<[string, number]> = [];
  for (const [word, expression] of Object.entries(field.live ?? {})) {
    const node = tree(expression, numbers);
    if (!node) continue;
    let missing = false;
    const value = evaluateComputed(node, { today: '', now: new Date(), me: null }, (name) => {
      const n = asNumber(values[name]);
      if (n === null) missing = true;
      return n;
    });
    if (!missing && typeof value === 'number' && Number.isFinite(value)) out.push([word, value]);
  }
  return out;
}

export function CommandLive({
  field,
  fields,
  values,
  id,
  currency = 'USD',
}: {
  field: LiveField;
  fields: readonly AppCommandField[];
  values: CommandValues;
  id: string;
  currency?: string;
}) {
  const figures = useMemo(() => liveFigures(field, fields, values), [field, fields, values]);
  const say = (n: number) =>
    new Intl.NumberFormat(
      formatLocale(),
      field.type === 'money'
        ? { style: 'currency', currency, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }
        : { maximumFractionDigits: 2 },
    ).format(n);
  return (
    <p id={id} className="command-live" aria-live="polite">
      {figures.map(([word, n], at) => (
        <span key={word}>
          {at > 0 && ' · '}
          {say(n)} {word}
        </span>
      ))}
    </p>
  );
}
