/**
 * The values a form or a fixed action fills in rather than states: the day
 * (`today`), the moment (`now`) and the signed-in person (`me`). They are
 * written as the constants `@mistriwork/mistri/app` exports — `defaults: { due_on:
 * today, owner_id: me }`, `set: { resolved_at: now }` — which are
 * `{ auto: 'today' }` and so on in JSON, so a word can never be read out of
 * a literal: a status of "now" is not the moment, and a text column's "me"
 * is not an email.
 *
 * The model carries the word, as it always has (formDefaults.ts in the
 * client, appStamps.ts on the server read it), so the word itself is
 * reserved there: a literal that spells one is refused here, since past
 * this point it would be read as the value filled in.
 */
type AutoWord = 'today' | 'now' | 'me';
const AUTO_WORDS: readonly AutoWord[] = ['today', 'now', 'me'];

const said = (word: string) => `${word} ({ auto: '${word}' })`;

/**
 * An authored default or `set` value, as the model carries it: a filled-in
 * value becomes its word, and a literal passes through. `words` are the ones
 * this place fills in — a fixed action writes `now` and `me`, a form also
 * `today`.
 */
export function authoredValue(value: unknown, at: string, words: readonly AutoWord[] = AUTO_WORDS): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'auto')) {
    const auto = (value as Record<string, unknown>).auto;
    if (Object.keys(value).length !== 1 || typeof auto !== 'string' || !(words as readonly string[]).includes(auto)) {
      throw new Error(`${at} fills in ${JSON.stringify(auto)}; this place fills in ${words.map(said).join(', ')}.`);
    }
    return auto;
  }
  if (typeof value === 'string' && (AUTO_WORDS as readonly string[]).includes(value)) {
    throw new Error(
      `${at} is the text '${value}', which reads as the value filled in: write the constant ${said(value)}, or another literal.`,
    );
  }
  return value;
}

/** The authored spelling of a model value: its word back as `{ auto }`, any other value as itself. */
export function authoredSpelling(value: unknown, words: readonly AutoWord[] = AUTO_WORDS): unknown {
  return typeof value === 'string' && (words as readonly string[]).includes(value) ? { auto: value } : value;
}
