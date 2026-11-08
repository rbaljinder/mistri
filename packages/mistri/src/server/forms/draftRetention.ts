/**
 * The saved forms' retention as a job: drafts nobody came back to, removed on a
 * schedule rather than only when someone starts a new one (savedForms.ts
 * `purgeExpired`, which this runs). The form declares it as `save.abandoned:
 * 'purge'`; the period is its `resume.days`, written on each draft as its
 * expiry.
 *
 * The job is the server's, not a person's, so it deletes under no row policy,
 * and a policy's rule is kept another way: it never cascades and never takes a
 * row someone else points at. A draft is removed only with the rows of its own
 * footprint that refer to it, and only when nothing else in the schema does
 * (an outbox row, a record a job finalized from it); that draft stays, whole,
 * and is named in the log so someone can finish or release it. Bucket objects
 * are not touched here: the draft's files are left unnamed by their rows going,
 * and the files sweep (filesCli.ts) deletes unnamed objects.
 */
import type { Adapter, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { formCommands, isSavedForm } from '../../shared/appSavedForms.js';
import { isFormView, isTenantApp, type AppDef } from '../../shared/app.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { footprintCatalog, savedFormRoots } from './savedFormChecks.js';
import { purgeExpired } from './savedForms.js';

export const DRAFT_RETENTION_JOB = 'mistri-draft-retention';
/** Hourly: a draft's expiry is in days, so the hour only decides how long past it one lingers. */
export const DRAFT_RETENTION_EVERY = '17 * * * *';

/** Passes a run makes at most per form root: each takes up to ten expired drafts, in a transaction of its own. */
const PASSES = 20;

type Doomed = ReadonlyArray<{ table: string; key: Record<string, string | number> }>;

/** Whether the App has a form whose abandoned drafts are purged: the job has nothing to do otherwise. */
export function keepsDrafts(app: AppDef): boolean {
  return (
    !isTenantApp(app) && Object.values(app.views).some((view) => isFormView(view) && isSavedForm(view) && view.save.abandoned === 'purge')
  );
}

/**
 * Remove every purgeable form's expired drafts. Returns the number removed;
 * `kept` hears each draft that stayed because another row refers to it.
 */
export async function sweepDrafts(
  app: AppDef,
  registry: BusinessCommandRegistry,
  schema: DatabaseSchema,
  adapterFor: (table: string) => Adapter,
  now: Date,
  kept: (table: string, key: string) => void = () => {},
): Promise<number> {
  if (isTenantApp(app)) return 0;
  let removed = 0;
  const named = new Set<string>();
  for (const view of Object.values(app.views)) {
    if (!isFormView(view) || !isSavedForm(view) || view.save.abandoned !== 'purge') continue;
    const start = registry[formCommands(view)[0].id];
    const catalog = start && footprintCatalog(app, start, schema);
    if (!start || !catalog) continue;
    for (const root of savedFormRoots(view, start, catalog)) {
      const adapter = adapterFor(root);
      if (!adapter.transaction) continue;
      const deletable = async (tx: WriteTransaction, rows: Doomed) => {
        const blocker = await referencedElsewhere(tx, schema, rows);
        const key = String(Object.values(rows[rows.length - 1].key)[0]);
        // A later pass meets the same kept draft again: said once.
        if (blocker && !named.has(`${root}:${key}`)) {
          named.add(`${root}:${key}`);
          kept(root, key);
        }
        return !blocker;
      };
      /* A draft a pass leaves whole (referred to, or too large to take) is passed over by the next one, so drafts
         that cannot go never starve the ones behind them that can. */
      let skip = 0;
      for (let pass = 0; pass < PASSES; pass++) {
        const done = await adapter.transaction((tx) =>
          purgeExpired(tx, catalog, root, view, now, undefined, (rows) => deletable(tx, rows), skip),
        );
        removed += done.removed;
        skip += done.left;
        if (done.removed + done.left === 0) break;
      }
    }
  }
  return removed;
}

/** True when a row outside `rows` refers to one of them: the schema's own foreign keys, on every row (no policy sees fewer). */
async function referencedElsewhere(tx: Pick<WriteTransaction, 'query'>, schema: DatabaseSchema, rows: Doomed): Promise<boolean> {
  // Keys compare as text: a driver may hand a number back where the catalog holds a string.
  const last = (name: string) => name.slice(name.lastIndexOf('.') + 1);
  const identity = (table: string, key: Record<string, unknown>) =>
    `${last(table)}\u0000${JSON.stringify(
      Object.entries(key)
        .map(([column, value]) => [column, String(value)])
        .sort(),
    )}`;
  const going = new Set(rows.map((row) => identity(row.table, row.key)));
  for (const row of rows) {
    for (const fk of schema.foreignKeys) {
      if (last(fk.to.table) !== last(row.table)) continue;
      const from = schema.tables.find((table) => table.id === fk.from.table);
      const keyColumns = from ? primaryKey(from) : [];
      // A reference to anything but the row's own key cannot be read from the key alone: kept, the safe way.
      const targets = Object.keys(row.key);
      if (fk.to.columns.length !== targets.length || fk.to.columns.some((column) => !targets.includes(column))) return true;
      const found = await tx.query({
        table: fk.from.table,
        limit: 101,
        offset: 0,
        columns: keyColumns.length ? [...keyColumns] : [fk.from.columns[0]],
        filter: { groups: [fk.from.columns.map((column, at) => ({ column, op: '=' as const, value: row.key[fk.to.columns[at]] }))] },
      });
      if (found.rows.length > 100 || (found.rows.length && !keyColumns.length)) return true;
      for (const other of found.rows)
        if (!going.has(identity(fk.from.table, Object.fromEntries(keyColumns.map((column) => [column, other[column]]))))) return true;
    }
  }
  return false;
}
