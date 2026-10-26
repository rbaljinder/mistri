/**
 * `mistri shot --text`: what a page shows, as lines an agent can read for
 * a fraction of what a picture costs. The page is read as rendered, once it
 * has settled: its title and headings, each table's columns and how many rows
 * it drew, the buttons a person could press, any empty-state note, and what
 * went wrong. Layout is not in it, and it says so by being silent about it:
 * a question of spacing or composition is still the screenshot's.
 */
import type { Page } from 'playwright-core';

interface PageText {
  title: string;
  headings: string[];
  tables: Array<{ columns: string[]; rows: number }>;
  actions: string[];
  empty: string[];
}

/* Runs in the page, as source text: a function passed to evaluate is serialized after tsx has
   wrapped its inner functions in a helper the page does not have. */
const READ_PAGE = `(() => {
  const doc = document;
  const words = text => (text ?? '').replace(/\\s+/g, ' ').trim();
  const shown = element => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  const unique = list => [...new Set(list.filter(Boolean))];
  const headings = unique([...doc.querySelectorAll('h1, h2, h3')].filter(shown).map(element => words(element.textContent)));
  const tables = [...doc.querySelectorAll('table')].filter(shown).map(table => ({
    columns: [...table.querySelectorAll('thead th')].map(cell => words(cell.textContent) || words(cell.getAttribute('aria-label'))).filter(Boolean),
    rows: table.querySelectorAll('tbody tr').length,
  }));
  /* A row's own menu and a column's filter are the table's, not the page's. */
  const buttons = [...doc.querySelectorAll('button, a[role="button"], [role="menuitem"], input[type="submit"]')]
    .filter(element => shown(element) && !element.closest('table, [role="tablist"]'))
    .map(element => words(element.textContent) || words(element.getAttribute('aria-label')) || words(element.getAttribute('title')) || words(element.value));
  const empty = unique([...doc.querySelectorAll('.empty-note, [data-empty]')].filter(shown).map(element => words(element.textContent)));
  return { title: words(doc.title), headings, tables, actions: unique(buttons), empty };
})()`;

export async function readPage(page: Page): Promise<PageText> {
  return page.evaluate(READ_PAGE) as Promise<PageText>;
}

/** One page, as the text `--text` prints: a heading line for the address, then only what the page has. */
export function sayPage(path: string, text: PageText, errors: readonly string[], status?: number): string {
  const lines = [`${path}${status && status >= 400 ? ` (${status})` : ''}`];
  if (text.title) lines.push(`  title: ${text.title}`);
  if (text.headings.length) lines.push(`  headings: ${text.headings.join(' | ')}`);
  for (const table of text.tables)
    lines.push(`  table: ${table.columns.join(', ') || '(no header)'} — ${table.rows} row${table.rows === 1 ? '' : 's'}`);
  if (text.actions.length) lines.push(`  actions: ${text.actions.join(' | ')}`);
  for (const note of text.empty) lines.push(`  empty: ${note}`);
  for (const error of errors) lines.push(`  error: ${error}`);
  return lines.join('\n');
}
