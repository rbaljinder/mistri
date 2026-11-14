/**
 * Whether the screen is drawn for the App's own public: a signed-out visitor, or a reader whose every role says
 * `portal: true` (the server decides, appAudience.ts, and says it as `viewerAudience`). Such a reader came for their
 * own things, so the parts that are the office's tools ask this before they draw: the global search, a list's
 * view switch and column chooser, a record's pager, the look picker. One question, asked in one place each.
 */
import { shell } from './shellMode.js';

export function personFacing(): boolean {
  return (shell().app() as { viewerAudience?: string } | null)?.viewerAudience === 'person';
}
