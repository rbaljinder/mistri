/**
 * A list view's `editable`, as the definition alone can judge it. Kept
 * beside the list view's parser (appViews.ts) rather than in it: the rule is
 * whole on its own, and the parser is at its size ceiling.
 */
import type { ResourceDef } from './appModel.js';
import type { AppListPresentation } from '@mistriwork/engine/shared/listPresentations.js';

/**
 * A grid's cells edited in place, and its selection's "Set field…": `true`
 * for every shown column the reader may write, or the columns named. Judged
 * here for what the definition alone says; the catalog's half (a local
 * column, not the key, not a document) is resolveListView's. The server
 * judges every cell again as the update it is, so this refuses only what
 * could never be offered: a column no editor may move.
 */
export function parseEditable(
  v: Record<string, unknown>,
  at: string,
  table: string,
  resource: ResourceDef | undefined,
  presentation: AppListPresentation | undefined,
): true | string[] | undefined {
  if (v.editable === undefined || v.editable === false) return undefined;
  if (
    v.editable !== true &&
    (!Array.isArray(v.editable) ||
      !v.editable.length ||
      v.editable.some((c) => typeof c !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.trim())))
  ) {
    throw new Error(`${at}: "editable" must be true (every shown column the reader may write) or a list of the resource's own columns.`);
  }
  /* A split edits its record in the detail pane beside the list, and a card
     presentation draws no cells to edit. */
  if (presentation) {
    throw new Error(
      `${at} has "editable" and a ${presentation.kind} presentation; cells are edited in place on a grid` +
        `${presentation.kind === 'split' ? ', and a split edits its record in the detail pane' : ''}. Remove "editable" or the presentation.`,
    );
  }
  /* An App writes only what says 'write': a cell no reader could ever save
     is not offered as editable. */
  if (resource?.access !== 'write') {
    throw new Error(
      `${at} has "editable", and resources.${table} is not access 'write', so no reader could save a cell. Give it access 'write' or remove "editable".`,
    );
  }
  if (v.editable === true) return true;
  const columns = (v.editable as string[]).map((c) => c.trim());
  if (new Set(columns).size !== columns.length) throw new Error(`${at} has "editable" that names one column twice.`);
  const shown = Array.isArray(v.show)
    ? (v.show as unknown[]).filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim())
    : undefined;
  const file = resource?.file;
  const fileColumns = file ? [file.content, file.name, file.type, file.size, file.object, file.hash].filter(Boolean) : [];
  for (const column of columns) {
    // A reference shown by its record's name ("owner_id.name") is edited as the reference.
    if (shown && !shown.some((entry) => entry === column || entry.startsWith(`${column}.`))) {
      throw new Error(
        `${at}: "editable" names "${column}", which the view does not show. Add it to "show", or leave it out of "editable".`,
      );
    }
    if (resource?.machine && (resource.machine.column === column || resource.machine.since === column)) {
      throw new Error(
        `${at}: "editable" names "${column}", which the machine of resources.${table} moves. ` +
          `Leave it out of "editable"; the record's verbs move it.`,
      );
    }
    if (fileColumns.includes(column)) {
      throw new Error(`${at}: "editable" names "${column}", which holds resources.${table}'s file; a file changes by uploading another.`);
    }
  }
  return columns;
}
