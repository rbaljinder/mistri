/**
 * Hand the walk to an agent.
 *
 * The MCP server is the agent→database half of this tool. This is the other
 * half: a person walks to something interesting — three joins deep, a filter
 * they arrived at by clicking — and now wants an agent to carry on from
 * exactly there. Retyping the position into a chat window is where that
 * hand-off usually dies, because the query is the easy part and the shape,
 * the connection and the keys are the parts people leave out.
 *
 * What it writes is deliberately not the rows. The rows are on screen and
 * the person can copy them; pasting them into a chat window sends them
 * somewhere, and that should stay a decision rather than a side effect of
 * clicking "copy". What it writes is everything an agent needs to fetch the
 * rows itself, against the same connection, with the same question.
 */

/** `name → type` with the markers the rest of the tool uses for keys and references. */
import { say } from './copy/workbench/handoff.js';

function columnLine(column) {
  const parts = [column.name];
  if (column.type) parts.push(column.type);
  if (column.primaryKey) parts.push('key');
  if (column.nullable === false && !column.primaryKey) parts.push('not null');
  if (column.references) parts.push(`→ ${column.references.table}.${column.references.column}`);
  return `- ${parts.join(' · ')}`;
}

/**
 * The walk position as markdown, ready to paste into an agent.
 *
 * Pure so it can be pinned without a browser — the failure this feature has
 * is silently omitting a field, and the only way to see that is to read the
 * whole document a test wrote.
 */
export function agentContext(position) {
  const { connection, dialect, table, query, columns = [], shown, total, meta, trail = [], record } = position;
  const lines = [];

  lines.push(say('aPositionInTablewalk', { table }));
  lines.push('');
  lines.push(say('connectionNamed', { connection: connection ?? say('defaultConnectionName'), dialect: dialect ? ` (${dialect})` : '' }));
  lines.push('');

  if (record) {
    lines.push(say('oneRow', { table, label: record.label }));
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(record.key));
    lines.push('```');
    lines.push('');
  } else {
    lines.push(say('theQuestionOnScreen'));
    lines.push('');
    lines.push('```');
    lines.push(query);
    lines.push('```');
    lines.push('');
  }

  if (!record && typeof shown === 'number') {
    const of = typeof total === 'number' && total > shown ? say('ofMatching', { total: total.toLocaleString() }) : '';
    lines.push(say('showingRows', { count: shown, of }));
    lines.push('');
  }

  /* The columns the *query* returned, not the whole table: a projection is
     part of the position, and an agent handed the full table would widen the
     question without being told it had. */
  if (!record && columns.length) {
    lines.push(say('columnsOnScreen', { columns: columns.join(', ') }));
    lines.push('');
  }

  if (meta?.columns?.length) {
    lines.push(`## ${meta.id ?? table}`);
    lines.push('');
    for (const column of meta.columns) lines.push(columnLine(column));
    lines.push('');
  }

  /* How they got here. A filter arrived at by three clicks reads as one
     opaque `where` clause, and the trail is what makes it a story again. */
  if (trail.length > 1) {
    lines.push('## The walk');
    lines.push('');
    for (const step of trail) lines.push(`- ${step}`);
    lines.push('');
  }

  lines.push('## Carry on from here');
  lines.push('');
  lines.push(say('thisDatabaseIsAvailable', { next: record ? say('toReadThisRow') : say('toSeeTheSame') }));
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      record
        ? { name: 'record', arguments: { connection: connection ?? undefined, table, key: record.key } }
        : { name: 'query', arguments: { connection: connection ?? undefined, q: query, limit: shown ?? 20 } },
      null,
      2,
    ),
  );
  lines.push('```');
  lines.push('');
  lines.push(say('tableDescribesATable') + say('queryRunsTheSame') + say('notIncludedHereFetch'));

  return lines.join('\n');
}

/**
 * Everything the current walk knows about where it is.
 *
 * Reads `state` rather than taking it apart at each call site, because the
 * two callers — a result and a record — differ in one field and agreeing on
 * the other seven by hand is how they drift.
 */
export function positionOf(state, entry, extra = {}) {
  const meta = state.schema?.tables?.find((t) => t.id === entry.table) ?? null;
  return {
    connection: state.activeConnection ?? state.schema?.label ?? null,
    dialect: state.schema?.dialect ?? null,
    table: entry.table,
    query: entry.query ?? entry.table,
    meta,
    /* The trail as it reads in the breadcrumb: the query for a result, the
       row's name for a record. */
    trail: (state.stack ?? []).map((step) => (step.kind === 'table' ? step.query : step.label)),
    ...extra,
  };
}

/**
 * Copy a position, and say so.
 *
 * The clipboard can be refused — an insecure origin, a permission denied —
 * and a button that silently does nothing is worse than one that says it
 * could not. The text is not shown as a fallback because it is a page long.
 */
export async function copyPosition(position, toast) {
  try {
    await navigator.clipboard.writeText(agentContext(position));
    toast(say('positionCopiedPasteItInto'), 'info');
  } catch {
    toast(say('common.theBrowserRefusedClipboard'), 'error');
  }
}
