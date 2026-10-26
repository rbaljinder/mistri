/**
 * A decision as the person reading a record meets it (server/http/decisionRoutes.ts serves these): a suggestion at a
 * field, a list row's mark, and "Why this?". Confidence is said in words; the percent is "Why this?"'s alone.
 */

/** One waiting suggestion, as a record's field shows it. */
export interface FieldSuggestion {
  readonly id: string;
  readonly decision: string;
  readonly field: string;
  readonly command: string;
  readonly answer: unknown;
  /** What the answer is called: a reference's record by its label, a choice as itself. */
  readonly label: string;
  readonly probability: number;
  /** The field held a value when it was asked: the suggestion trails that value rather than standing in its place. */
  readonly filled: boolean;
  readonly at: string;
}

/** A list row with a suggestion waiting on an empty field: the row's place among the keys asked, the field, the answer's words. */
export interface DecisionMark {
  readonly row: number;
  readonly field: string;
  readonly label: string;
}

export interface DecisionWhy {
  readonly decision: string;
  readonly question: string;
  /** The inputs it was asked with, by name, with the value each holds now where this reader may read it. */
  readonly inputs: readonly Readonly<{ name: string; label: string; value?: unknown; readable: boolean }>[];
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly probability: number | null;
  readonly outcome: string;
  readonly at: string;
}

type Confidence = 'almostCertain' | 'veryLikely' | 'likely' | 'possible';

/** A probability in words (design §7): at least 0.95 almost certain, 0.85 very likely, 0.70 likely, below that possible. */
export function confidenceOf(probability: number): Confidence {
  return probability >= 0.95 ? 'almostCertain' : probability >= 0.85 ? 'veryLikely' : probability >= 0.7 ? 'likely' : 'possible';
}

/** The words in English, for what the server writes down itself: an applied value's history line names its decision and how sure it was. */
export const CONFIDENCE_WORDS: Readonly<Record<Confidence, string>> = Object.freeze({
  almostCertain: 'almost certain',
  veryLikely: 'very likely',
  likely: 'likely',
  possible: 'possible',
});
