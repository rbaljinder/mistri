/**
 * What a mention's declaration says and whether the catalog can serve it —
 * the half the validators read (command.ts, app.ts, appResourceBlocks.ts),
 * apart from mentionLookup.ts, the query an @ sends, so a first page that
 * only validates does not carry the lookup (the built suite's cold-visit
 * ceiling holds it).
 */
import { isLabelTemplate, parseLabelTemplate, writesMask } from './recordLabel.js';

/** A resource of people or teams an @ names: the resource, the column stored, the column or template shown. */
export interface MentionSource {
  from: string;
  by: string;
  labelColumn?: string;
}

/** The columns a mention's label reads, in order — one column, or each `{column}` of a template — or why it is not one. */
export function mentionLabelColumns(label: string): { columns: string[] } | { problem: string } {
  if (!isLabelTemplate(label)) return { columns: [label] };
  if (writesMask(label)) return { problem: `"${label}" writes a mask or words itself; a column's display rule says them.` };
  const parsed = parseLabelTemplate(label);
  if ('problem' in parsed) return parsed;
  /* Read with the person's row, in the one query the @ sends: a path through a reference is not in it. */
  const far = parsed.paths.find((path) => path.includes('.') || path.includes('+'));
  if (far) return { problem: `{${far}} in "${label}" is not a column; a mention's label names the people's own columns.` };
  return { columns: [...new Set(parsed.paths)] };
}

/** Why a mention's `by` and `labelColumn` cannot be read from `table`, naming the first column it lacks; undefined when they can. */
export function mentionSourceProblem(
  source: MentionSource,
  table: { name: string; columns: readonly { name: string }[] },
): string | undefined {
  const has = (column: string) => table.columns.some((c) => c.name === column);
  if (!has(source.by)) return `"by" names "${source.by}", which is not a column of "${table.name}".`;
  if (source.labelColumn === undefined) return undefined;
  const read = mentionLabelColumns(source.labelColumn);
  if ('problem' in read) return `"labelColumn": ${read.problem}`;
  const missing = read.columns.find((column) => !has(column));
  return missing === undefined
    ? undefined
    : `"labelColumn" ${isLabelTemplate(source.labelColumn) ? `"${source.labelColumn}" names` : 'names'} "${missing}", which is not a column of "${table.name}".`;
}
