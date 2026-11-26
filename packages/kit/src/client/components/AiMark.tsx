/**
 * The one mark for something a model made or proposed: a small glyph and the App's word for it (`ai: { label }` on
 * the App, "AI" when absent), in `--ai`. Every built-in AI surface draws this — the review queue, a record's
 * proposal line, history, an unconfirmed field — and an App's own components draw the same one
 * (`@mistriwork/mistri/ui`), so a reader learns one sign rather than six labels.
 *
 * The glyph is drawn here, not taken from the icon set: the chrome's icons travel in the first page's bundle, and
 * this one is needed only where a proposal is. Its rule is a few lines of features.css, so nothing waits on a sheet.
 * `quiet` drops the word, for a cell where the word would crowd the value; the word is still there for a screen reader.
 */
import { shell } from '../shellMode.js';
import { say } from '../copy/shell/components/AiMark.js';
import { registerAiLabel } from './surfaceSeam.js';

/** The App's word for AI, for copy that names it in a sentence ("Proposed by AI"). */
export function aiWord(): string {
  return shell().app()?.ai?.label ?? say('ai');
}

registerAiLabel(aiWord);

export { AiBadge } from '@mistriwork/ui/AiBadge.js';
