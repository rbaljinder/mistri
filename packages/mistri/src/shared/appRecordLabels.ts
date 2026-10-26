/**
 * Each table's record name as an App serves it: the resource's template, or
 * — for a table with no name column of its own — its noun and key
 * (recordLabel.ts says how the name is computed).
 */
import { stitchedHop } from '@mistriwork/engine/shared/stitchedPaths.js';
import { labelPath, primaryKey, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { grantsByRole, type AppDef } from './appModel.js';
import { displayWord, vocabularyWord } from '@mistriwork/engine/shared/model.js';
import { recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import {
  isLabelTemplate,
  maskedField,
  nounTemplate,
  parseLabelTemplate,
  wordedField,
  writesMask,
} from '@mistriwork/engine/shared/recordLabel.js';
import { resolvePath } from '@mistriwork/engine/shared/viewPaths.js';

/** Why a record label template cannot name `table`'s rows here, or undefined when every column in it resolves. */
export function labelTemplateProblem(schema: DatabaseSchema, table: TableMeta, template: string): string | undefined {
  if (writesMask(template))
    return `"${template}" writes a mask or words itself; a column's display rule says them (masked, values), in the record's name too.`;
  const parsed = parseLabelTemplate(template);
  if ('problem' in parsed) return parsed.problem;
  for (const path of parsed.paths) {
    try {
      resolvePath(schema, table.id, path);
    } catch (error) {
      return `{${path}}: ${(error as Error).message}`;
    }
    if (stitchedHop(schema, table.id, path)) return stitchedLabelProblem(path);
  }
  return undefined;
}

/** A record's name is part of the statement that reads the record, so it names nothing across a stitched reference (stitchedPaths.ts). */
export const stitchedLabelProblem = (path: string) =>
  `{${path}} goes through a reference to another source, on another connection; a record's name is read in its own database. Name it by its own columns.`;

/**
 * Each table's record-name template, as this catalog serves the App
 * (recordLabel.ts): the resource's own template where it writes one and every
 * column in it resolves here, and — for a table with no name of its own, whose
 * records were titled by their bare key — its noun and key ("Purchase order
 * #{id}"). A resource that names a column or path keeps it; one whose label
 * this reader may not see (`false`) gets none.
 */
export function appLabelTemplates(app: AppDef, schema: DatabaseSchema): Map<string, string> {
  const exact = grantsByRole(app);
  const byTable = new Map<string, { name: string; resource: NonNullable<AppDef['resources']>[string] }>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = exact ? schema.tables.find((candidate) => candidate.id === name) : tableNamed(schema, name);
    if (table && !byTable.has(table.id)) byTable.set(table.id, { name, resource });
  }
  const templates = new Map<string, string>();
  /* An API source reads by its documented parameters and computes nothing,
     so its rows keep the names they have. */
  if (schema.dialect === 'http') return templates;
  /* The display rule of the column a path lands on, where it masks (masked: true, or a prefix). */
  const maskOf = (table: TableMeta, path: string): { prefix?: string } | undefined => {
    let at: { table: TableMeta; column: string };
    try {
      const resolved = resolvePath(schema, table.id, path);
      at = { table: resolved.table, column: resolved.column.name };
    } catch {
      return undefined;
    }
    const rule = byTable.get(at.table.id)?.resource.display?.[at.column];
    return rule?.masked === true ? {} : rule?.masked ? { prefix: rule.masked.prefix } : undefined;
  };
  /* The words a path's stored values are said as, as a cell says them
     (valueModel's groupLabel): the rule's own `values` (a map, or words for all), else a
     vocabulary's value made words — the column's CHECK list, or a value its
     tones name. Only a finite set can be said in the statement, and only
     the values whose word differs are written. */
  const wordsOf = (table: TableMeta, path: string): Record<string, string> | undefined => {
    let at: { table: TableMeta; column: TableMeta['columns'][number] };
    try {
      const resolved = resolvePath(schema, table.id, path);
      at = { table: resolved.table, column: resolved.column };
    } catch {
      return undefined;
    }
    if (at.column.primaryKey || at.column.references || at.column.flag) return undefined;
    const rule = byTable.get(at.table.id)?.resource.display?.[at.column.name];
    if (rule?.format) return undefined;
    const toned = Object.keys(rule?.tone ?? {}).filter((value) => value !== '*' && !/^\s*[<>=]/.test(value));
    const values = [...new Set([...(at.column.allowed ?? []), ...Object.keys(rule?.values ?? {}), ...toned])];
    const vocabulary = Boolean(at.column.allowed?.length || rule?.tone);
    const words = values.flatMap((value) => {
      const word = displayWord(rule, value) ?? (vocabulary ? vocabularyWord(value) : value);
      return word !== value ? [[value, word] as const] : [];
    });
    return words.length ? Object.fromEntries(words) : undefined;
  };
  /* A template with its masked columns marked, so the statement says their
     placeholder, and its worded ones, so it says their words (viewLabels.ts). */
  const masking = (table: TableMeta, template: string): string => {
    const parsed = parseLabelTemplate(template);
    if ('problem' in parsed) return template;
    return parsed.parts
      .map((part) => {
        if ('text' in part) return part.text;
        const mask = maskOf(table, part.path);
        if (mask) return maskedField(part.path, mask.prefix);
        const words = wordsOf(table, part.path);
        return words ? wordedField(part.path, words) : `{${part.path}}`;
      })
      .join('');
  };
  for (const table of schema.tables) {
    if (table.filterable || table.sortable) continue;
    if (table.labelTemplate) {
      templates.set(table.id, table.labelTemplate);
      continue;
    }
    const declared = byTable.get(table.id)?.resource;
    const authored = declared?.recordLabel;
    const key = primaryKey(table);
    const noun = () => (key.length === 1 ? nounTemplate(recordNoun(declared?.noun, table.name), key[0]) : undefined);
    if (authored === false) continue;
    if (isLabelTemplate(authored)) {
      if (!labelTemplateProblem(schema, table, authored)) templates.set(table.id, masking(table, authored));
      continue;
    }
    /* A name read from a masked column is computed instead: a prefix mask
       said in the statement, and a column masked whole — a name that would
       be the same placeholder on every record — gives way to noun and key. */
    const own = authored ?? labelPath(schema, table);
    const mask = own === undefined ? undefined : maskOf(table, own);
    if (own !== undefined && mask) {
      const named = mask.prefix ? maskedField(own, mask.prefix) : noun();
      if (named) templates.set(table.id, named);
      continue;
    }
    /* So is a name read from a column whose stored codes its display rule
       says as words: a card, a crumb and a search say "Identity", as the
       cell does, not the stored "identity". */
    const words = own !== undefined && !key.includes(own) ? wordsOf(table, own) : undefined;
    if (own !== undefined && words) {
      templates.set(table.id, wordedField(own, words));
      continue;
    }
    if (authored !== undefined) continue;
    if (key.length !== 1 || (own !== undefined && !key.includes(own))) continue;
    templates.set(table.id, noun()!);
  }
  return templates;
}

/** The catalog an App serves, each table carrying its record-name template (appLabelTemplates). */
export function withLabelTemplates(app: AppDef, schema: DatabaseSchema): DatabaseSchema {
  const templates = appLabelTemplates(app, schema);
  if (!templates.size) return schema;
  return {
    ...schema,
    tables: schema.tables.map((table) =>
      templates.has(table.id)
        ? {
            ...table,
            labelTemplate: templates.get(table.id)!,
            ...(keyNamed(app, schema, table, templates.get(table.id)!) ? { keyLabel: true as const } : {}),
          }
        : table,
    ),
  };
}

/**
 * Whether the App names this table's records by their key dressed in words
 * it wrote ('SO-{id}'): a template whose every field is the one key column.
 * A grid then shows the key column as the record's name, since that is what
 * the column is to a reader; the noun-and-key a table with no name is given
 * ("Order line #{id}") is not the App's word for it, and stays a number.
 */
function keyNamed(app: AppDef, schema: DatabaseSchema, table: TableMeta, template: string): boolean {
  const key = primaryKey(table);
  if (key.length !== 1) return false;
  const exact = grantsByRole(app);
  const authored = Object.entries(app.resources ?? {}).some(
    ([name, resource]) => resource.recordLabel === template && (exact ? name === table.id : tableNamed(schema, name)?.id === table.id),
  );
  const parsed = parseLabelTemplate(template);
  return authored && !('problem' in parsed) && parsed.paths.every((path) => path === key[0]);
}
