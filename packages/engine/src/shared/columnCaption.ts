/* What a column is called: the one naming rule the server (record history, imports, anything that names a column) and the client share. */
import { humanName, type AppNoun } from './model.js';
import { headingOf, pluralOf, recordNoun } from './appNoun.js';
import { hasFilterOf, type HasFilterKey } from './listFilters.js';
import { columnKind, findTable, labelColumn, type DatabaseSchema } from './schema.js';

/** The captions the App's resources give, by table id: `resources.<t>.labels`, column or label path → word; and what a record is called. */
type Captions = Readonly<Record<string, { labels?: Record<string, string>; noun?: AppNoun }>>;

const midSentence = (word: string) => (/^[A-Z][a-z]/.test(word) ? word.charAt(0).toLowerCase() + word.slice(1) : word);

/**
 * A list's filter over the rows that point at its record (listFilters.ts),
 * said by those rows: "Opportunity stage"; on a link table, the record its
 * reference names ("Tag"); by one of their segments, "Has open opportunities".
 */
function hasCaption(resources: Captions, schema: DatabaseSchema | null, tableId: string, has: HasFilterKey): string {
  const child = schema ? (findTable(schema, has.child) ?? schema.tables.find((table) => table.name === has.child)) : undefined;
  const id = child?.id ?? has.child;
  const noun = Object.hasOwn(resources, id) ? resources[id].noun : undefined;
  const one = recordNoun(noun, child?.name ?? has.child);
  if (child?.segments && Object.hasOwn(child.segments, has.asks)) {
    return `Has ${midSentence(humanName(has.asks))} ${noun?.many ?? pluralOf(one)}`;
  }
  const caption = columnCaption(resources, schema, id, has.asks);
  const reference = has.asks.includes('.') ? undefined : child?.columns.find((column) => column.name === has.asks)?.references;
  if (reference && reference.table !== tableId) return caption;
  return `${headingOf(one)} ${midSentence(caption)}`;
}

/**
 * The one rule for what a column is called, on a screen and in anything the
 * server words for a person (a record's history, an import's headers): the
 * resource's own caption, else the one the schema implies. The server and the
 * client both read it here, so the history says "Customer" where the screen does.
 * `check` warns (`restated`) on a caption this returns without being told.
 */
export function columnCaption(resources: Captions, schema: DatabaseSchema | null, tableId: string, path: string, contextPath = ''): string {
  const explicit = (table: string, column: string) => {
    const labels = Object.hasOwn(resources, table) ? resources[table].labels : undefined;
    if (!labels || !Object.hasOwn(labels, column)) return undefined;
    return labels[column];
  };
  const named = explicit(tableId, path);
  if (named) return named;
  const has = hasFilterOf(path);
  if (has) return hasCaption(resources, schema, tableId, has);

  const tableAt = (parts: string[]) => {
    let at = tableId;
    for (const part of parts) {
      const fk = schema?.foreignKeys.find((fk) => fk.from.table === at && fk.from.columns.length === 1 && fk.from.columns[0] === part);
      if (!fk) return undefined;
      at = fk.to.table;
    }
    return at;
  };

  // A section already titled for a related record need not repeat that relationship on every field.
  if (contextPath && path.startsWith(`${contextPath}.`)) {
    const context = tableAt(contextPath.split('.'));
    if (context) return columnCaption(resources, schema, context, path.slice(contextPath.length + 1), '');
  }

  const parts = path.split('.');
  const leaf = parts[parts.length - 1];
  const owner = tableAt(parts.slice(0, -1));
  const table = schema && owner ? findTable(schema, owner) : undefined;
  if (parts.length > 1 && table && leaf === labelColumn(table)) {
    return explicit(tableId, parts[0]) || humanName(parts[0].replace(/_(id|sku|code|key)$/, ''));
  }
  const inherited = owner && explicit(owner, leaf);
  if (inherited) return inherited;
  const reference = table?.columns.find((col) => col.name === leaf)?.references;
  if (reference && schema && owner) {
    const target = findTable(schema, reference.table);
    const naming = target && labelColumn(target);
    const single = schema.foreignKeys.some(
      (fk) => fk.from.table === owner && fk.from.columns.length === 1 && fk.from.columns[0] === leaf && fk.to.table === reference.table,
    );
    const projected = naming && single && explicit(owner, `${leaf}.${naming}`);
    if (projected) return projected;
  }
  if (reference) return humanName(leaf.replace(/_id$/, ''));
  // A moment is said by what happened: `ready_at` is "Ready", `due_on` "Due". The suffix is how SQL
  // spells the type, not a word a person reads; a number or a flag named so keeps it.
  const column = table?.columns.find((col) => col.name === leaf);
  const kind = column && !column.flag ? columnKind(column.type ?? '') : undefined;
  if ((kind === 'date' || kind === 'text') && /._(at|on)$/.test(leaf)) return humanName(leaf.replace(/_(at|on)$/, ''));
  return humanName(leaf);
}
