/**
 * A display unit as it is said beside a figure. An App writes a unit plural
 * (`{ unit: 'days' }`, `{ unit: 'bikes' }`), and one of them is said
 * singular: "1 day" and "1 bike", never "1 days" or "1 bikes". Shared, so a
 * public page the server draws says what the client says
 * (http/publicPage.ts, components/valueModel.ts).
 *
 * An abbreviation keeps its spelling ("1 lbs", "1 pcs", "1 hrs"): it has no
 * vowel, or is too short to be a word. A unit that is not one plain word
 * ("kWh", "m²", "per day") is said as written.
 */
const ONE = /^[-−]?1$/;
const TIME_PLURAL = /^(second|minute|hour|day|night|week|month|year)s$/i;
/* A plain plural: four letters or more, a vowel before its ending, and an "s" that is not a word's own ("glass", "bus", "basis"). */
const PLURAL = /^(?=[a-z]*[aeiouy][a-z]*s$)[a-z]{3,}s$/i;

/** The singular of a regular English plural: batteries → battery, boxes → box, bikes → bike. */
function singular(unit: string): string {
  if (/[^aeiou]ies$/i.test(unit)) return `${unit.slice(0, -3)}${unit.at(-3) === 'I' ? 'Y' : 'y'}`;
  if (/(x|ch|sh|ss|z)es$/i.test(unit)) return unit.slice(0, -2);
  return unit.slice(0, -1);
}

/** The singular of a word written in the plural ("days", "tickets"), or undefined where the word is not a plural
    the rule can read: an abbreviation, a word whose own "s" ends it, a word already singular. */
export function singularOf(word: string): string | undefined {
  if (TIME_PLURAL.test(word)) return word.slice(0, -1);
  if (PLURAL.test(word) && !/(ss|us|is)$/i.test(word) && /[aeiouy]/i.test(word.slice(0, -1))) return singular(word);
  return undefined;
}

export function unitWord(figure: string, unit: string): string {
  if (!ONE.test(figure)) return unit;
  return singularOf(unit) ?? unit;
}
