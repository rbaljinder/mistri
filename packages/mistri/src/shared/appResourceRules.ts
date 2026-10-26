/**
 * What two resource blocks make of the catalog, beside their parse in
 * appResourceBlocks.ts: a file resource (`file`), whose rows are files, and
 * a resource whose records carry tags (`tags`, rows of another table linked
 * through a third). Each resolves to the tables and columns it names, or to
 * the problems the App has to fix before it starts.
 */
import {
  columnKind,
  isBinaryType,
  labelColumn,
  primaryKey,
  tableNamed,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { FILE_MAX_BYTES_DEFAULT, grantsByRole, type AppDef, type AppFileDef } from './appModel.js';
import type { AppTagRule } from '@mistriwork/engine/shared/servedApp.js';
export type { AppTagRule } from '@mistriwork/engine/shared/servedApp.js';

/** A file resource resolved against the catalog: its table, its name in the App, and the cap an upload meets. */
export interface AppFileRule extends AppFileDef {
  table: string;
  /** The App the rule is of: what a bucket's shared picture copies are filed under, so Apps sharing a prefix never share a sweep. */
  app?: string;
  /** The resource's key in `resources`: what a bucket's keys are filed under, whatever table it binds. */
  resource: string;
  maxBytes: number;
  /**
   * Whether the reader of this resource's files is nobody in particular: the App has no sign-in, or lists the
   * resource under `auth.public.read` (and is not a tenant App, whose every read is a tenant's). Only such a
   * picture may be kept by a shared cache (http/appFileRead.ts); it is also the one made ahead at upload.
   */
  public?: boolean;
}

/**
 * The resources whose rows are files (`file: { content, name, … }`), keyed by
 * table id. Problems are the App's to fix before it starts: the bytes need a
 * binary column, and every named column must exist. `strict` is for the App's
 * own catalog; a reader's leaves out the columns the server keeps to itself.
 */
export function appFileRules(
  app: AppDef,
  schema: DatabaseSchema,
  options: { strict?: boolean } = {},
): { rules: Map<string, AppFileRule>; problems: string[] } {
  const exact = grantsByRole(app);
  const rules = new Map<string, AppFileRule>();
  const problems: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const file = resource.file;
    if (!file) continue;
    const table = exact ? schema.tables.find((candidate) => candidate.id === name) : tableNamed(schema, name);
    if (!table) continue;
    const before = problems.length;
    if (table.isView) problems.push(`resources "${name}": "file" needs a table; ${table.name} is a view.`);
    const content = table.columns.find((column) => column.name === file.content);
    if (!content) problems.push(`resources "${name}": file content "${file.content}" is not a column of ${table.name}.`);
    else if (!isBinaryType(content.type))
      problems.push(
        `resources "${name}": file content "${content.name}" is ${content.type || 'untyped'}; the bytes need a binary column (BLOB, bytea).`,
      );
    if (file.thumbnail) {
      const thumbnail = table.columns.find((column) => column.name === file.thumbnail);
      if (!thumbnail) problems.push(`resources "${name}": file thumbnail "${file.thumbnail}" is not a column of ${table.name}.`);
      else if (!isBinaryType(thumbnail.type))
        problems.push(
          `resources "${name}": file thumbnail "${thumbnail.name}" is ${thumbnail.type || 'untyped'}; a picture needs a binary column (BLOB, bytea).`,
        );
    }
    for (const [role, column] of [
      ['name', file.name],
      ['type', file.type],
      ['size', file.size],
    ] as const) {
      if (column && !table.columns.some((candidate) => candidate.name === column))
        problems.push(`resources "${name}": file ${role} "${column}" is not a column of ${table.name}.`);
    }
    /* A key and a hash are words, so their columns hold text; and with a
       bucket a row's bytes may be elsewhere, so the content column must take
       the null that says so. */
    for (const [role, column] of [
      ['object', file.object],
      ['hash', file.hash],
    ] as const) {
      if (!column) continue;
      const found = table.columns.find((candidate) => candidate.name === column);
      /* A reader's catalog never lists them (appAccess.ts withFileColumns): the server reads them for it.
         Only the App's own catalog, checked strictly, says one is missing. */
      if (!found && options.strict) problems.push(`resources "${name}": file ${role} "${column}" is not a column of ${table.name}.`);
      else if (found && (columnKind(found.type) !== 'text' || isBinaryType(found.type)))
        problems.push(`resources "${name}": file ${role} "${found.name}" is ${found.type || 'untyped'}; it holds text (text, varchar).`);
    }
    if (file.bucket && content && !content.nullable)
      problems.push(
        `resources "${name}": file content "${content.name}" is NOT NULL; with a bucket a row's bytes may be there instead, so the column must allow null.`,
      );
    if (problems.length === before)
      rules.set(table.id, {
        ...file,
        table: table.id,
        resource: name,
        app: app.id,
        maxBytes: file.maxBytes ?? FILE_MAX_BYTES_DEFAULT,
        public: !app.auth || (app.auth.rows !== 'tenant' && Boolean(app.auth.public?.read.includes(name))),
      });
  }
  return { rules, problems };
}

/**
 * The resources whose records carry tags (`tags: { through, to }`): rows of
 * `to` linked through a table with exactly one reference to each side. A tag
 * is added by inserting a link row and removed by deleting one, so the link
 * table needs a key. Problems are the App's to fix before it starts.
 */
export function appTagRules(app: AppDef, schema: DatabaseSchema): { rules: Map<string, AppTagRule>; problems: string[] } {
  const exact = grantsByRole(app);
  const find = (name: string) => (exact ? schema.tables.find((candidate) => candidate.id === name) : tableNamed(schema, name));
  const rules = new Map<string, AppTagRule>();
  const problems: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const tags = resource.tags;
    if (!tags) continue;
    const table = find(name);
    if (!table) continue;
    const through = find(tags.through);
    const to = find(tags.to);
    if (!through) {
      problems.push(`resources "${name}": tags through "${tags.through}" is not a table.`);
      continue;
    }
    if (!to) {
      problems.push(`resources "${name}": tags to "${tags.to}" is not a table.`);
      continue;
    }
    const single = (target: TableMeta) =>
      schema.foreignKeys.filter((fk) => fk.from.table === through.id && fk.to.table === target.id && fk.from.columns.length === 1);
    const back = single(table);
    const out = single(to);
    const before = problems.length;
    if (back.length !== 1)
      problems.push(
        `resources "${name}": tags need ${through.name} to reference ${table.name} by exactly one column; it does by ${back.length}.`,
      );
    if (out.length !== 1)
      problems.push(
        `resources "${name}": tags need ${through.name} to reference ${to.name} by exactly one column; it does by ${out.length}.`,
      );
    if (!primaryKey(through).length)
      problems.push(`resources "${name}": tags need a key on ${through.name}; a tag is removed by deleting its link row.`);
    // A tag is read and written in one statement: a reference to another source is in another database.
    if ([...back, ...out].some((fk) => fk.stitched))
      problems.push(
        `resources "${name}": tags need ${through.name}, ${table.name} and ${to.name} in one database; a reference between them crosses to another source.`,
      );
    const label = labelColumn(to) ?? primaryKey(to)[0];
    if (!label) problems.push(`resources "${name}": tags need a column of ${to.name} that names a tag.`);
    if (tags.toneOf && !to.columns.some((column) => column.name === tags.toneOf))
      problems.push(`resources "${name}": tags toneOf "${tags.toneOf}" is not a column of ${to.name}.`);
    if (problems.length > before || !label) continue;
    rules.set(table.id, {
      through: through.id,
      to: to.id,
      from: back[0].from.columns[0],
      key: back[0].to.columns[0],
      via: out[0].from.columns[0],
      tagKey: out[0].to.columns[0],
      label,
      ...(tags.toneOf ? { tone: tags.toneOf } : {}),
      ...(tags.add && tags.remove ? { add: tags.add, remove: tags.remove } : {}),
    });
  }
  return { rules, problems };
}
