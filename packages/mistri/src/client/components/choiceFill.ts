/**
 * A choice that fills other inputs (`default: { answer: '<choice>.<column>' }`): what a pick puts into the inputs beside
 * it. A fill is a starting value and nothing more: the person may change it, and what they have changed is never
 * written over (`useListFills` keeps which). A form opened with a pick already made fills only what is still empty;
 * a pick made later fills every input not edited, whether empty or filled by an earlier pick. Clearing the choice
 * clears nothing. The server trusts none of it: what is sent is judged as typed.
 */
import { useEffect, useMemo, useRef } from 'react';
import { choiceFills, type AppCommandField } from '../../shared/command.js';
import type { CommandValue } from '../commandState.js';
import type { CommandValues } from './CommandFields.js';

type Option = {
  readonly value: string | number;
  readonly row?: Readonly<Record<string, unknown>>;
  readonly values?: Readonly<Record<string, unknown>>;
};

/** The inputs a choice fills (input → the column or key of its pick), and the hand the choice gives their values to. */
export interface ChoiceFill {
  readonly fills: Readonly<Record<string, string>>;
  readonly onFill: (picked: Readonly<Record<string, unknown>>, mode: 'open' | 'pick') => void;
}

const given = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

/** The columns of a table choice's rows its siblings start from, for a read to carry beside the key and the label. */
export const fillColumns = (fills: ChoiceFill['fills'] | undefined): string[] => [...new Set(Object.values(fills ?? {}))].sort();

/** The values the picked option holds for each key `fills` names: a table row's column, or a static option's `values`. */
function pickedValues(option: Option | undefined, fills: ChoiceFill['fills']): Record<string, unknown> {
  const held = option?.values ?? option?.row;
  const picked: Record<string, unknown> = {};
  if (!held) return picked;
  for (const [target, key] of Object.entries(fills))
    if (Object.hasOwn(held, key) && held[key] !== undefined && held[key] !== null) picked[target] = held[key];
  return picked;
}

/**
 * Puts the pick's values into the inputs beside the choice, once per pick: when the form opened with one, as soon as
 * its row is offered (the inputs still empty only), and at each later pick (the inputs not edited).
 */
export function useChoiceFill(options: {
  value: unknown;
  /** The rows or options on offer; undefined while they are being read. */
  offered: readonly Option[] | undefined;
  fill: ChoiceFill | undefined;
}): void {
  const { value, offered, fill } = options;
  const opened = useRef(given(value));
  const applied = useRef<unknown>(undefined);
  const hand = useRef(fill);
  hand.current = fill;
  const active = fill !== undefined && Object.keys(fill.fills).length > 0;
  useEffect(() => {
    if (!active || !hand.current) return;
    if (!given(value) || Array.isArray(value)) {
      applied.current = undefined;
      return;
    }
    if (applied.current === value || !offered) return;
    const option = offered.find((each) => each.value === value);
    if (!option) return;
    applied.current = value;
    const mode = opened.current ? 'open' : 'pick';
    opened.current = false;
    const picked = pickedValues(option, hand.current.fills);
    if (Object.keys(picked).length) hand.current.onFill(picked, mode);
  }, [active, value, offered]);
}

/* A fill as the input holds a value: text as text, a number or an amount as it came, a yes or a no as one, a choice's
   value as it is; a value the input could not hold fills nothing. */
function fitted(field: AppCommandField, value: unknown): CommandValue | undefined {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'number':
    case 'money':
      return typeof value === 'number' || typeof value === 'string' ? value : undefined;
    case 'choice':
      return typeof value === 'string' || typeof value === 'number' ? value : undefined;
    case 'text':
    case 'textarea':
    case 'date':
    case 'datetime':
    case 'time':
    case 'month':
      return typeof value === 'object' ? undefined : String(value);
    default:
      return undefined;
  }
}

/**
 * The fills of one list of inputs — the input's own, a group's or one line of a repeating group's — which is also the
 * reach of a pick: a line's choice fills that line's inputs only. `edited` is told each change the person makes;
 * `forField` hands a choice its fills.
 */
export function useListFills(
  fields: readonly AppCommandField[],
  values: CommandValues,
  change: (next: CommandValues, path: string) => void,
  pathOf: (name: string) => string,
) {
  const edits = useRef(new Set<string>());
  const latest = useRef({ values, change, pathOf });
  latest.current = { values, change, pathOf };
  return useMemo(
    () => ({
      edited: (name: string) => {
        edits.current.add(name);
      },
      forField: (field: AppCommandField): ChoiceFill | undefined => {
        if (field.type !== 'choice') return undefined;
        const fills = choiceFills(fields, field.name);
        if (!Object.keys(fills).length) return undefined;
        return {
          fills,
          onFill: (picked, mode) => {
            const now = latest.current.values;
            const next: CommandValues = { ...now };
            let first: string | undefined;
            for (const target of fields) {
              if (!Object.hasOwn(picked, target.name) || edits.current.has(target.name)) continue;
              const value = fitted(target, picked[target.name]);
              if (value === undefined) continue;
              const held = now[target.name];
              // A box unticked is the blank a yes-or-no starts as, not an answer.
              if (mode === 'open' && given(held) && !(target.type === 'boolean' && held === false)) continue;
              if (held === value) continue;
              next[target.name] = value;
              first ??= target.name;
            }
            if (first !== undefined) latest.current.change(next, latest.current.pathOf(first));
          },
        };
      },
    }),
    [fields],
  );
}
