/**
 * The check codes as the shipped documentation states them: one source.
 *
 * `site/src/content/docs/docs/check-codes.md` (and `design-lint.md` for the
 * design rules) hold a row per code — what it means and the fix. `mistri
 * explain` prints a row; `mistri check --brief` borrows its fix where the
 * check itself named none. Nothing here restates a code: a row added to the
 * page is known the moment it is written. `theme-contract.md` states the
 * thirteen promises (C1 to C13) in the same four columns, so `explain C5`
 * prints a promise as it prints a code.
 */
import { docPage } from '../docs.js';

export interface CodeRow {
  code: string;
  /** The step (or kind) the page says the code belongs to. */
  where: string;
  means: string;
  fix: string;
  /** The page it was read from, as the `mistri docs` topic. */
  topic: string;
}

/** A table cell's Markdown as plain text: spans, links and anchors said as their words. */
const plain = (cell: string) =>
  cell
    .replace(/<span id="[^"]*"><\/span>/g, '')
    .replace(
      /\[([^\]]+)\]\(([^)]*)\)/g,
      (_, text: string, to: string) =>
        `${text}${/^\/docs\/([a-z0-9-]+)/.exec(to) ? ` (mistri docs ${/^\/docs\/([a-z0-9-]+)/.exec(to)![1]})` : ''}`,
    )
    .trim();

/** Split a pipe row on the pipes outside backticks. */
function cells(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let ticks = false;
  for (const char of line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')) {
    if (char === '`') ticks = !ticks;
    if (char === '|' && !ticks) {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

/** Every code the pages document, in the pages' order; a code in two rows (a problem and a warning) keeps both. */
export function codeRows(): CodeRow[] {
  const rows: CodeRow[] = [];
  for (const [page, shape] of [
    ['check-codes', 'four'],
    ['design-lint', 'three'],
    ['theme-contract', 'four'],
  ] as const) {
    const text = docPage(page)?.body ?? '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const parts = cells(line);
      /* A promise is written as it is said, C5; explain reads every code lowercased. */
      const code = /^`([a-z][a-z0-9-]+|C\d+)`$/.exec(parts[0])?.[1]?.toLowerCase();
      if (!code || parts.length < (shape === 'four' ? 4 : 3)) continue;
      rows.push(
        shape === 'four'
          ? { code, where: plain(parts[1]), means: plain(parts[2]), fix: plain(parts[3]), topic: page }
          : { code, where: 'design', means: plain(parts[1]), fix: plain(parts[2]), topic: 'design' },
      );
    }
  }
  return rows;
}

/** The fix the documentation gives a code, joined where it has more than one row. Every row says one of its own
    (test/agent-brief.test.ts): a row that pointed at the message printed that pointer as `explain`'s fix. */
export function documentedFix(code: string): string | undefined {
  const fixes = codeRows()
    .filter((row) => row.code === code)
    .map((row) => row.fix)
    .filter((fix) => fix !== '');
  return fixes.length ? [...new Set(fixes)].join('; or ') : undefined;
}
