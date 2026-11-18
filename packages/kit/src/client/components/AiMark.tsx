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

export function AiMark({ quiet = false, className }: { quiet?: boolean; className?: string }) {
  const label = shell().app()?.ai?.label ?? say('ai');
  return (
    <span className={className ? `ai-mark ${className}` : 'ai-mark'} data-quiet={quiet ? '' : undefined}>
      <svg className="ai-mark-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.5c.5 3.2 1.8 4.5 5 5-3.2.5-4.5 1.8-5 5-.5-3.2-1.8-4.5-5-5 3.2-.5 4.5-1.8 5-5Z" />
        <path d="M13 10.5c.2 1.2.8 1.8 2 2-1.2.2-1.8.8-2 2-.2-1.2-.8-1.8-2-2 1.2-.2 1.8-.8 2-2Z" />
      </svg>
      <span className={quiet ? 'visually-hidden' : 'ai-mark-word'}>{label}</span>
    </span>
  );
}

/** The App's word for AI, for copy that names it in a sentence ("Proposed by AI"). */
export function aiWord(): string {
  return shell().app()?.ai?.label ?? say('ai');
}
