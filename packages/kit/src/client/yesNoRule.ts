/**
 * A yes/no column's display rule, keyed as its engine stores the value (valueModel.ts dresses with it; appnav.js
 * hands it out). Kept apart from valueModel so the shell's display source needs nothing of the record room.
 */
import type { DisplayRule } from './components/valueModel.js';

/* The ways an engine hands back yes and no: SQLite as 1 and 0, PostgreSQL as true and false. */
const YES_NO: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['true', ['1', 't']],
  ['false', ['0', 'f']],
];
const yesNoRules = new WeakMap<DisplayRule, DisplayRule>();

/**
 * A yes/no column's rule, keyed as the database hands the value back. An author keys a boolean's `values`, `tone` and
 * `icons` by `true` and `false`; SQLite stores 1 and 0, so no key matched and the cell said a bare "1". The stored
 * spellings are added beside the author's, and a toned or marked yes/no with no word of its own says ✓ or ✗, as the
 * plain boolean cell does.
 */
export function yesNoRule(rule: DisplayRule | null | undefined): DisplayRule | null {
  if (!rule) return null;
  const known = yesNoRules.get(rule);
  if (known) return known;
  const alias = (map: Record<string, string> | undefined, fallback?: Record<string, string>) => {
    if (!map && !fallback) return undefined;
    const out: Record<string, string> = { ...fallback, ...map };
    for (const [word, stored] of YES_NO)
      if (Object.hasOwn(out, word)) for (const spelling of stored) if (!Object.hasOwn(out, spelling)) out[spelling] = out[word];
    return out;
  };
  const marked = Boolean(rule.tone || rule.icons);
  const said: DisplayRule = {
    ...rule,
    ...(rule.values || marked ? { values: alias(rule.values, marked ? { true: '✓', false: '✗' } : undefined) } : {}),
    ...(rule.tone ? { tone: alias(rule.tone) } : {}),
    ...(rule.icons ? { icons: alias(rule.icons) } : {}),
  };
  yesNoRules.set(rule, said);
  return said;
}
