/**
 * A file on a signed-in draft is the draft's, until it is submitted. A step's file is a row beneath the draft's root
 * (savedForms.ts), and the file route reads rows by their key under the reader's grants: a role that may read the
 * file resource would read another person's half-finished application's attachments by guessing a key. So the route
 * asks one more question of a row beneath a signed-in draft: is its root still a draft, and if so is it this
 * person's, by the owner predicate the draft is found by? Anything else is as absent as a file that is not there.
 * A submitted application's files follow the record's normal scope, as any file does.
 *
 * What a root is, is read off the catalog the way the form's check reads it: a table with the form's resume,
 * draft and owner columns. The question is asked of the App's own reader, not the person's: the person may well
 * have no grant on the root table at all, only on the form's commands.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { isFormView, type AppDef } from '../../shared/app.js';
import { isSavedForm } from '../../shared/appSavedForms.js';
import { personKey } from '../app/appMe.js';

/** A table whose rows sit beneath a signed-in draft's root: the column that names the root, and how the root is a draft. */
interface Beneath {
  readonly root: string;
  readonly rootKey: string;
  readonly link: string;
  readonly owner: string;
  readonly state: { readonly column: string; readonly value: string };
}

const scopes = new WeakMap<AppDef, WeakMap<DatabaseSchema, ReadonlyMap<string, readonly Beneath[]>>>();

/** Every table beneath a signed-in draft's root in this catalog, by table id. */
function rowsBeneathDrafts(app: AppDef, schema: DatabaseSchema): ReadonlyMap<string, readonly Beneath[]> {
  const cached = scopes.get(app)?.get(schema);
  if (cached) return cached;
  const found = new Map<string, Beneath[]>();
  for (const view of Object.values(app.views)) {
    if (!isFormView(view) || view.public || !isSavedForm(view)) continue;
    const { save } = view;
    const owner = save.owner;
    if (owner === undefined) continue;
    const needed = [save.resume.token, save.resume.expires, save.resume.progress, save.draft.column, owner];
    for (const root of schema.tables) {
      const [rootKey, ...more] = primaryKey(root);
      if (root.isView || !rootKey || more.length || !needed.every((name) => root.columns.some((column) => column.name === name))) continue;
      for (const fk of schema.foreignKeys) {
        if (fk.to.table !== root.id || fk.from.columns.length !== 1 || fk.to.columns[0] !== rootKey || fk.from.table === root.id) continue;
        const list = found.get(fk.from.table) ?? [];
        list.push({
          root: root.id,
          rootKey,
          link: fk.from.columns[0],
          owner,
          state: { column: save.draft.column, value: save.draft.value },
        });
        found.set(fk.from.table, list);
      }
    }
  }
  const byApp = scopes.get(app) ?? new WeakMap<DatabaseSchema, ReadonlyMap<string, readonly Beneath[]>>();
  byApp.set(schema, found);
  scopes.set(app, byApp);
  return found;
}

/** Whether rows of `table` can sit beneath a signed-in draft at all: a route asks this before it opens a reader. */
export function beneathDraft(app: AppDef, schema: DatabaseSchema, table: string): boolean {
  return (rowsBeneathDrafts(app, schema).get(table)?.length ?? 0) > 0;
}

/**
 * Whether this person may not read the file at `key`: it sits beneath a draft that is still a draft and is not
 * theirs. A question the App's reader cannot answer is a no, since the answer is withheld by default.
 */
export async function draftFileHidden(options: {
  app: AppDef;
  schema: DatabaseSchema;
  reader: Pick<Adapter, 'query'>;
  table: string;
  key: Record<string, string | number>;
  who: string | undefined;
  /** Who the reader is, where `who` alone does not say: a tenant's people are found by account (appMe.ts lookupTenantPerson). */
  person?: () => Promise<string | number | null>;
}): Promise<boolean> {
  const { app, schema, reader, table, key, who } = options;
  const beneath = rowsBeneathDrafts(app, schema).get(table);
  if (!beneath?.length) return false;
  try {
    const meta = schema.tables.find((candidate) => candidate.id === table)!;
    const keys = primaryKey(meta);
    if (!keys.length || keys.some((column) => !Object.hasOwn(key, column))) return false;
    let person: string | number | null | undefined;
    for (const each of beneath) {
      const row = await reader.query({
        table,
        columns: [each.link],
        filter: { groups: [keys.map((column) => ({ column, op: '=' as const, value: key[column] }))] },
        limit: 2,
        offset: 0,
      });
      const link = row.rows.length === 1 ? row.rows[0][each.link] : undefined;
      if (link === undefined || link === null) continue;
      const root = await reader.query({
        table: each.root,
        columns: [each.owner, each.state.column],
        filter: { groups: [[{ column: each.rootKey, op: '=', value: link as string | number }]] },
        limit: 2,
        offset: 0,
      });
      if (root.rows.length !== 1 || String(root.rows[0][each.state.column]) !== each.state.value) continue;
      person ??= options.person ? await options.person() : who === undefined ? null : await personKey(app, schema, who, reader);
      if (person === null || String(root.rows[0][each.owner]) !== String(person)) return true;
    }
    return false;
  } catch {
    return true;
  }
}
