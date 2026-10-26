/**
 * Where a composer session lives in the URL: a tab on a table (composer.js
 * says why). Read by the entry point on every navigation and by the composer.
 */

/** The view id encoded in a stack entry's tab, or null if it is not a view. */
export function viewTabOf(entry) {
  if (!entry || entry.kind !== 'table') return null;
  const tab = entry.tab ?? 'rows';
  if (tab === 'view') return '';
  /* Two forms, and the leading character says which. `view:<id>` names
     something saved; `view+<text>` carries the view itself, so a composer
     session that was never saved is still a link you can send someone. */
  if (tab.startsWith('view:')) return tab.slice(5);
  if (tab.startsWith('view+')) return `+${tab.slice(5)}`;
  return null;
}
