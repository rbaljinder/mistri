/**
 * A tenant clone's copy and a sandbox's import, on a session
 * whose transaction the caller owns: tenant administration's or mistri
 * maintenance's, each with its receipt in the same transaction. The plan
 * (tenantClonePlan.ts) says what is copied and how each value is rewritten;
 * this reads and writes the rows.
 *
 * Every statement names one tenant in its WHERE or its values: the source or
 * the new tenant for a clone, the sandbox or its live tenant for an import.
 * Nothing here reads a table the plan does not name, or a row of any other
 * tenant, and the callers hold both tenants' rows locked while it runs.
 *
 * An import is all or nothing. For each configuration row the clone copied it
 * kept a base: the row as the clone found it. A sandbox row that differs from
 * its base is a change; it applies only where the live row still matches the
 * base, and is a conflict where the live row moved too. A new sandbox row
 * whose key the live tenant already has, and a sandbox deletion of a row the
 * live tenant changed, are conflicts as well. One conflict refuses the whole
 * import and nothing is written.
 */
import type { AdministrationImportConflictReason, AdministrationImportPlan } from '../../shared/tenantAdministration.js';
import type { CloneRow, CloneTable, CloneValue, TenantClonePlan } from './tenantClonePlan.js';
import { cloneKey, cloneText, copyRow, rowDigest, rowKey } from './tenantClonePlan.js';
import type { SandboxItem, SandboxRows, SandboxSession } from './tenantSandboxStore.js';

/** The most rows one clone copies, or one import reads, in all: the copy is held in memory. */
export const CLONE_ROWS_MOST = 200_000;
/** The most conflicts an import plan lists; past it, `truncated`. */
const IMPORT_CONFLICTS_MOST = 100;

export class TenantCloneConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantCloneConflict';
  }
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
/* PostgreSQL reads every value as its text form and takes it back as an untyped
   parameter the column parses, so a copy is exact whatever the type; SQLite's
   values come back exact (integers as bigint) and go back as they came. */
const selectList = (session: SandboxSession, table: CloneTable) =>
  table.columns
    .map((column) => (session.dialect === 'postgres' ? `${quoted(column)}::text AS ${quoted(column)}` : quoted(column)))
    .join(', ');

async function readTenantRows(session: SandboxSession, table: CloneTable, tenantId: string, budget: { left: number }): Promise<CloneRow[]> {
  const rows = await session.all(
    `SELECT ${selectList(session, table)} FROM ${table.from} WHERE ${quoted(table.tenant)} = ? LIMIT ${budget.left + 1}`,
    [tenantId],
  );
  budget.left -= rows.length;
  if (budget.left < 0)
    throw new TenantCloneConflict(`The tenant has more than ${CLONE_ROWS_MOST} rows to copy; a clone holds them all at once.`);
  return rows;
}

/** The rows in an order where each row's parent (a self reference) comes first. */
function parentsFirst(table: CloneTable, rows: readonly CloneRow[]): CloneRow[] {
  if (!table.self.length) return [...rows];
  const at = new Map<string, number>();
  for (const leg of table.self)
    rows.forEach((row, index) => at.set(JSON.stringify([leg.to, leg.to.map((column) => cloneText(row[column]))]), index));
  const waits = rows.map(() => new Set<number>());
  const waiting = new Map<number, number[]>();
  rows.forEach((row, index) => {
    for (const leg of table.self) {
      const values = leg.from.map((column) => cloneText(row[column]));
      if (values.some((value) => value === null)) continue;
      const parent = at.get(JSON.stringify([leg.to, values]));
      if (parent === undefined || parent === index) continue;
      waits[index].add(parent);
      waiting.set(parent, [...(waiting.get(parent) ?? []), index]);
    }
  });
  const ordered: CloneRow[] = [];
  const ready = rows.map((_, index) => index).filter((index) => !waits[index].size);
  while (ready.length) {
    const index = ready.shift()!;
    ordered.push(rows[index]);
    for (const child of waiting.get(index) ?? []) {
      waits[child].delete(index);
      if (!waits[child].size) ready.push(child);
    }
  }
  if (ordered.length !== rows.length)
    throw new TenantCloneConflict(`Rows of "${table.resource}" reference each other in a cycle; a copy cannot order them.`);
  return ordered;
}

/* A generated column (`GENERATED ALWAYS AS (…)`) is the database's to write,
   and either engine refuses a value for it: a copy and an
   import's update name only the columns they may set. Read off the catalog
   the copy writes through, once per table per transaction. */
const generatedBySession = new WeakMap<SandboxSession, Map<string, Promise<ReadonlySet<string>>>>();
function generatedColumns(session: SandboxSession, table: CloneTable): Promise<ReadonlySet<string>> {
  let known = generatedBySession.get(session);
  if (!known) generatedBySession.set(session, (known = new Map()));
  let found = known.get(table.from);
  if (!found) {
    const rows =
      session.dialect === 'postgres'
        ? session.all(
            `SELECT attname AS name FROM pg_catalog.pg_attribute
             WHERE attrelid = (?)::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated <> ''`,
            [table.from],
          )
        : session.all(`SELECT name FROM pragma_table_xinfo(?, 'main') WHERE hidden IN (2, 3)`, [
            table.from
              .replace(/^main\./, '')
              .slice(1, -1)
              .replaceAll('""', '"'),
          ]);
    found = rows.then((list) => new Set(list.map((row) => String(row.name))));
    known.set(table.from, found);
  }
  return found;
}
const written = async (session: SandboxSession, table: CloneTable, columns: readonly string[]) => {
  const generated = await generatedColumns(session, table);
  return columns.filter((column) => !generated.has(column));
};

async function insertRow(session: SandboxSession, table: CloneTable, row: CloneRow): Promise<void> {
  const columns = await written(session, table, table.columns);
  await session.run(
    `INSERT INTO ${table.from} (${columns.map(quoted).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => row[column] ?? null),
  );
}

interface CloneCopied {
  /** Rows copied, by resource. */
  readonly rows: Readonly<Record<string, number>>;
}

/**
 * Copy the source tenant's rows into `tenantId`, which the caller has just
 * created and recorded as a sandbox. Configuration rows are recorded in the
 * item map with their base; sample rows are copied and not tracked, since an
 * import carries configuration back, never samples.
 */
export async function copyTenant(
  session: SandboxSession,
  plan: TenantClonePlan,
  sandboxes: SandboxRows,
  input: Readonly<{ sourceTenantId: string; tenantId: string; samples: boolean }>,
): Promise<CloneCopied> {
  if (input.sourceTenantId === input.tenantId) throw new TenantCloneConflict('A tenant is not cloned into itself.');
  const budget = { left: CLONE_ROWS_MOST };
  const counts: Record<string, number> = {};
  for (const table of plan.tables) {
    if (table.copy === 'sample' && !input.samples) continue;
    const source = await readTenantRows(session, table, input.sourceTenantId, budget);
    for (const row of parentsFirst(table, source)) {
      const copy = copyRow(table, row, input.tenantId);
      await insertRow(session, table, copy);
      if (table.copy === 'config')
        await sandboxes.putItem(input.tenantId, table.resource, {
          sandboxKey: rowKey(table, copy),
          liveKey: rowKey(table, row),
          base: rowDigest(table, row),
        });
    }
    counts[table.resource] = source.length;
  }
  return Object.freeze({ rows: Object.freeze(counts) });
}

/* ---------- import ---------- */

type ImportConflictReason = AdministrationImportConflictReason;
type ImportConflict = AdministrationImportPlan['conflicts'][number];
export type ImportPlan = AdministrationImportPlan;
interface Planned {
  readonly summary: ImportPlan;
  apply(): Promise<void>;
}

/**
 * What importing the sandbox into its live tenant would change, and what
 * conflicts. `apply` writes it — only when there is no conflict — and moves
 * each item's base on, so the next import starts from this one.
 */
export async function planImport(
  session: SandboxSession,
  plan: TenantClonePlan,
  sandboxes: SandboxRows,
  input: Readonly<{ tenantId: string; sandboxTenantId: string }>,
): Promise<Planned> {
  const tables = plan.tables.filter((table) => table.copy === 'config');
  const budget = { left: CLONE_ROWS_MOST };
  const items = new Map<string, ReadonlyMap<string, SandboxItem>>();
  /* A hashed key's way back: the sandbox id of each copied row to its live id. */
  const back = new Map<string, Map<string, string>>();
  const sandboxRowsOf = new Map<string, CloneRow[]>();
  for (const table of tables) {
    const found = await sandboxes.items(input.sandboxTenantId, table.resource);
    items.set(table.resource, found);
    sandboxRowsOf.set(table.resource, await readTenantRows(session, table, input.sandboxTenantId, budget));
    if (table.rules[table.keys[0]]?.kind === 'hashed' && table.keys.length === 1) {
      const map = new Map<string, string>();
      for (const item of found.values()) map.set(JSON.parse(item.sandboxKey)[0], JSON.parse(item.liveKey)[0]);
      /* A row the sandbox made has no live id yet. Its own id is the
         sandbox's row in the same table, so it takes one in the live
         tenant's space, as a clone gives one: derived, so a reference to it
         from another new row lands on the same id. */
      for (const row of sandboxRowsOf.get(table.resource)!) {
        const id = cloneText(row[table.keys[0]]);
        if (id !== null && !map.has(id)) map.set(id, cloneKey(input.tenantId, table.resource, id));
      }
      back.set(table.resource, map);
    }
  }
  /* A sandbox row in the live tenant's terms. */
  const toLive = (table: CloneTable, row: CloneRow): CloneRow => {
    const live: Record<string, CloneValue> = {};
    for (const column of table.columns) {
      const rule = table.rules[column],
        value = row[column];
      if (rule.kind === 'tenant') live[column] = input.tenantId;
      else if (rule.kind === 'clear') live[column] = null;
      else if (rule.kind === 'hashed' && value !== null) live[column] = back.get(rule.resource)?.get(cloneText(value)!) ?? cloneText(value);
      else live[column] = value;
    }
    return live;
  };

  type Change = { table: CloneTable; kind: 'insert' | 'update' | 'delete'; row: CloneRow; live?: CloneRow; sandboxKey: string };
  const changes: Change[] = [];
  const conflicts: ImportConflict[] = [];
  const conflict = (resource: string, key: string, reason: ImportConflictReason) => conflicts.push({ resource, key, reason });
  /* Every live key, and every key an insert adds: what a hashed reference must land on. */
  const present = new Map<string, Set<string>>();
  const pending: { table: CloneTable; row: CloneRow; key: string }[] = [];
  for (const table of tables) {
    const tracked = items.get(table.resource)!;
    const sandbox = sandboxRowsOf.get(table.resource)!;
    const liveRows = new Map((await readTenantRows(session, table, input.tenantId, budget)).map((row) => [rowKey(table, row), row]));
    present.set(table.resource, new Set(liveRows.keys()));
    const seen = new Set<string>();
    for (const row of sandbox) {
      const sandboxKey = rowKey(table, row),
        live = toLive(table, row),
        key = rowKey(table, live);
      const item = tracked.get(sandboxKey);
      pending.push({ table, row: live, key });
      if (!item) {
        if (liveRows.has(key)) conflict(table.resource, key, 'taken');
        else {
          changes.push({ table, kind: 'insert', row: live, sandboxKey });
          present.get(table.resource)!.add(key);
        }
        continue;
      }
      seen.add(sandboxKey);
      if (rowDigest(table, live) === item.base) continue;
      const current = liveRows.get(item.liveKey);
      if (!current) conflict(table.resource, item.liveKey, 'removed');
      else if (rowDigest(table, current) !== item.base) conflict(table.resource, item.liveKey, 'changed');
      else changes.push({ table, kind: 'update', row: live, live: current, sandboxKey });
    }
    for (const [sandboxKey, item] of tracked) {
      if (seen.has(sandboxKey)) continue;
      const current = liveRows.get(item.liveKey);
      if (!current) continue;
      if (rowDigest(table, current) !== item.base) conflict(table.resource, item.liveKey, 'changed');
      else changes.push({ table, kind: 'delete', row: current, sandboxKey });
    }
  }
  /* A sandbox row may name a row by a hashed id that the live tenant does not
     have — one its own sandbox member typed in. The foreign key alone would
     accept another tenant's row there, so each is checked against this
     tenant's own keys before anything is written. */
  for (const { table, row, key } of pending)
    for (const column of table.columns) {
      const rule = table.rules[column];
      // The row's own id is no reference; a parent row of its own table is.
      if (rule.kind !== 'hashed' || (rule.resource === table.resource && column === table.keys[0]) || row[column] === null) continue;
      if (!present.get(rule.resource)?.has(JSON.stringify([cloneText(row[column])]))) conflict(table.resource, key, 'reference');
    }

  const resources: Record<string, { inserted: number; updated: number; deleted: number }> = {};
  for (const change of changes) {
    const counts = (resources[change.table.resource] ??= { inserted: 0, updated: 0, deleted: 0 });
    counts[change.kind === 'insert' ? 'inserted' : change.kind === 'update' ? 'updated' : 'deleted']++;
  }
  const summary: ImportPlan = Object.freeze({
    inserted: changes.filter((change) => change.kind === 'insert').length,
    updated: changes.filter((change) => change.kind === 'update').length,
    deleted: changes.filter((change) => change.kind === 'delete').length,
    resources: Object.freeze(resources),
    conflicts: Object.freeze(conflicts.slice(0, IMPORT_CONFLICTS_MOST)),
    truncated: conflicts.length > IMPORT_CONFLICTS_MOST,
  });
  return {
    summary,
    async apply() {
      if (conflicts.length) throw new TenantCloneConflict('The import conflicts with the live tenant; nothing was written.');
      const where = (table: CloneTable, row: CloneRow) => ({
        sql: [quoted(table.tenant), ...table.keys.map(quoted)].map((column) => `${column} = ?`).join(' AND '),
        params: [input.tenantId, ...table.keys.map((key) => row[key] ?? null)],
      });
      /* Inserts referenced-first, parents first; then updates; then deletes in reverse. */
      for (const table of tables) {
        const rows = changes.filter((change) => change.table === table && change.kind === 'insert');
        for (const row of parentsFirst(
          table,
          rows.map((change) => change.row),
        )) {
          await insertRow(session, table, row);
          const change = rows.find((candidate) => candidate.row === row)!;
          await sandboxes.putItem(input.sandboxTenantId, table.resource, {
            sandboxKey: change.sandboxKey,
            liveKey: rowKey(table, row),
            base: rowDigest(table, row),
          });
        }
      }
      for (const change of changes.filter((candidate) => candidate.kind === 'update')) {
        const { table } = change;
        const set = await written(
          session,
          table,
          table.columns.filter((column) => column !== table.tenant && table.rules[column].kind !== 'clear'),
        );
        const target = where(table, change.live!);
        const updated = await session.run(
          `UPDATE ${table.from} SET ${set.map((column) => `${quoted(column)} = ?`).join(', ')} WHERE ${target.sql}`,
          [...set.map((column) => change.row[column] ?? null), ...target.params],
        );
        if (updated !== 1) throw new TenantCloneConflict('A live row moved while the import was written; nothing was written.');
        await sandboxes.putItem(input.sandboxTenantId, table.resource, {
          sandboxKey: change.sandboxKey,
          liveKey: rowKey(table, change.row),
          base: rowDigest(table, change.row),
        });
      }
      for (const table of [...tables].reverse())
        for (const change of changes.filter((candidate) => candidate.table === table && candidate.kind === 'delete')) {
          const target = where(table, change.row);
          if ((await session.run(`DELETE FROM ${table.from} WHERE ${target.sql}`, target.params)) !== 1)
            throw new TenantCloneConflict('A live row moved while the import was written; nothing was written.');
          await sandboxes.deleteItem(input.sandboxTenantId, table.resource, change.sandboxKey);
        }
    },
  };
}
