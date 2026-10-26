/** Capture placement admission and fence eligibility anchors on the enrolled writer. */
import type { DatabaseSync } from 'node:sqlite';
import { ANSI_STYLE, POSTGRES_STYLE, Refusal, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { ScopeCatalog } from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureRowScope, snapshotRowScope } from '@mistriwork/engine/shared/rowScope.js';
import { isRuntimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { commandJournalValidation as rules } from './commandJournal.js';
import type { PublicPlacementAdmission, PublicPlacementAnchor, PublicPlacementOwner } from './publicPlacementTypes.js';

const ownerFields = ['issuerId', 'sourceIdentity', 'appId', 'form', 'tenant', 'commandId', 'commandVersion'];
const refuse = (): never => {
  throw new Refusal('Public placement admission is unavailable.');
};
const text: (value: unknown, field: string, max: number) => void = rules.text;
const ordered = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function validateOwner(owner: PublicPlacementOwner): void {
  for (const field of ownerFields.filter((field) => field !== 'commandVersion')) {
    text(owner[field as keyof PublicPlacementOwner], field, field === 'sourceIdentity' ? 256 : 128);
  }
  if (!Number.isSafeInteger(owner.commandVersion) || owner.commandVersion < 1 || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(owner.form)) refuse();
}

export function capturePublicPlacementOwner(input: PublicPlacementOwner): PublicPlacementOwner {
  const owner = rules.capture(input);
  rules.record(owner, ownerFields);
  validateOwner(owner);
  return Object.freeze(owner);
}

/** Unlike the portable shared capture, the native entry can detect proxies
 * before any descriptor trap executes. Preserve the existing scope bounds. */
export function capturePublicPlacementScope(input: RowScope): RowScope {
  return captureRowScope(rules.capture(input));
}

/** Synchronous detached capture before any queue or driver wait. */
export function capturePublicPlacementAdmission(input: PublicPlacementAdmission): PublicPlacementAdmission {
  const admission = rules.capture(input);
  rules.record(admission, [...ownerFields, 'epoch', 'anchors']);
  validateOwner(admission);
  text(admission.epoch, 'epoch', 256);
  if (!Array.isArray(admission.anchors) || !admission.anchors.length || admission.anchors.length > 8) refuse();
  const anchors = admission.anchors.map((anchor) => {
    rules.record(anchor, ['table', 'key', 'expected']);
    text(anchor.table, 'anchor table', 256);
    for (const [name, value] of [
      ['key', anchor.key],
      ['expected', anchor.expected],
    ] as const) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).length > 128)
        refuse();
      for (const [column, scalar] of Object.entries(value)) {
        text(column, 'anchor column', 256);
        if (
          !(
            (typeof scalar === 'string' && Buffer.byteLength(scalar) <= 8192) ||
            (typeof scalar === 'number' && Number.isFinite(scalar)) ||
            (name === 'expected' && (scalar === null || typeof scalar === 'boolean'))
          )
        )
          refuse();
      }
    }
    return Object.freeze({ table: anchor.table, key: Object.freeze(anchor.key), expected: Object.freeze(anchor.expected) });
  });
  return Object.freeze({ ...admission, anchors: Object.freeze(anchors) });
}

function scalar(column: ColumnMeta, value: unknown, dialect: string): boolean {
  if (value === null) return column.nullable;
  const type = column.type.toLowerCase().trim();
  if (/^(bool|boolean)$/.test(type)) return typeof value === 'boolean' || (dialect === 'sqlite' && (value === 0 || value === 1));
  if (/^(tinyint|smallint|mediumint|integer|int|bigint|int[248])(?:\(\d+\))?$/.test(type))
    return typeof value === 'number' && Number.isSafeInteger(value);
  if (/^(real|float|double precision|double|numeric|decimal)(?:\([\d, ]+\))?$/.test(type))
    return typeof value === 'number' && Number.isFinite(value);
  if (/^(text|uuid|varchar|character varying|char|character|clob)(?:\(\d+\))?$/.test(type) || column.allowed)
    return typeof value === 'string';
  return false;
}

function anchorsFor(catalog: ScopeCatalog, scope: RowScope, admission: PublicPlacementAdmission) {
  snapshotRowScope(catalog.schema, scope);
  for (const id of Object.keys(scope)) {
    const table = catalog.schema.tables.find((table) => table.id === id);
    if (!table || isRuntimeTable(table.name)) refuse();
  }
  const anchors = admission.anchors
    .map((anchor) => {
      const table = catalog.schema.tables.find((table) => table.id === anchor.table);
      // An anchor must belong to this exact physical source and enrolled scope,
      // and be an ordinary, clean, pinned table, never a view or runtime table.
      if (
        !table ||
        !Object.hasOwn(scope, table.id) ||
        scope[table.id] === false ||
        isRuntimeTable(table.name) ||
        table.isView ||
        !catalog.writable.has(table.id)
      )
        return refuse();
      const pk = table.columns
        .filter((column) => column.primaryKey)
        .map((column) => column.name)
        .sort(ordered);
      if (!pk.length || pk.length !== Object.keys(anchor.key).length || pk.some((key) => !Object.hasOwn(anchor.key, key))) refuse();
      for (const values of [anchor.key, anchor.expected])
        for (const [name, value] of Object.entries(values)) {
          const column = table.columns.find((column) => column.name === name);
          if (!column || !scalar(column, value, catalog.schema.dialect)) refuse();
        }
      return { anchor, table, pk, order: JSON.stringify([table.id, pk.map((key) => [key, anchor.key[key]])]) };
    })
    .sort((a, b) => ordered(a.order, b.order));
  if (anchors.some((anchor, index) => index > 0 && anchor.order === anchors[index - 1].order)) refuse();
  return anchors;
}

function check(row: Record<string, unknown> | undefined, anchor: PublicPlacementAnchor, table: TableMeta, dialect: string): void {
  if (!row) refuse();
  for (const [name, expected] of [...Object.entries(anchor.key), ...Object.entries(anchor.expected)]) {
    let actual = row![name];
    const column = table.columns.find((column) => column.name === name)!;
    if (dialect === 'sqlite' && /^(bool|boolean)$/i.test(column.type) && typeof expected === 'boolean') {
      actual = actual === 1 ? true : actual === 0 ? false : actual;
    }
    // pg's int8 parser deliberately preserves precision as text. Only an
    // exactly spelled safe integer may agree with a numeric anchor.
    if (
      typeof expected === 'number' &&
      (typeof actual === 'bigint' || typeof actual === 'string') &&
      Number.isSafeInteger(expected) &&
      String(actual) === String(expected)
    )
      actual = expected;
    if (actual !== expected) refuse();
  }
}

export function admitSqlitePublicPlacement(
  db: DatabaseSync,
  catalog: ScopeCatalog,
  scope: RowScope,
  admission: PublicPlacementAdmission,
): void {
  if (!db.isTransaction) refuse(); // caller owns BEGIN IMMEDIATE
  for (const { anchor, table, pk } of anchorsFor(catalog, scope, admission)) {
    const columns = [...new Set([...pk, ...Object.keys(anchor.expected)])].map(ANSI_STYLE.quote).join(', ');
    const row = db
      .prepare(
        `SELECT ${columns} FROM main.${ANSI_STYLE.quote(table.name)} WHERE ${pk.map((key) => `${ANSI_STYLE.quote(key)} = ?`).join(' AND ')}`,
      )
      .get(...pk.map((key) => anchor.key[key]));
    check(row, anchor, table, 'sqlite');
  }
}

export async function admitPostgresPublicPlacement(
  db: PgQuery,
  catalog: ScopeCatalog,
  scope: RowScope,
  admission: PublicPlacementAdmission,
): Promise<void> {
  const anchors = anchorsFor(catalog, scope, admission);
  const q = POSTGRES_STYLE.quote;
  // First take all locks in deterministic order, then re-read on this writer.
  const statements = anchors.map(({ anchor, table, pk }) => ({
    anchor,
    table,
    columns: [...new Set([...pk, ...Object.keys(anchor.expected)])].map(q).join(', '),
    from: `FROM ${q(table.schema)}.${q(table.name)} WHERE ${pk.map((key, index) => `${q(key)} = $${index + 1}`).join(' AND ')}`,
    params: pk.map((key) => anchor.key[key]),
  }));
  for (const statement of statements) await db.query(`SELECT 1 ${statement.from} FOR UPDATE`, statement.params);
  for (const statement of statements) {
    const result = await db.query(`SELECT ${statement.columns} ${statement.from}`, statement.params);
    if (result.rows.length !== 1) refuse();
    check(result.rows[0], statement.anchor, statement.table, 'postgres');
  }
}

/** Installed BENEATH the adapter's operation queue, so refused mutations
 * poison the shared transaction even when caught. */
export function publicPlacementRecords(records: WriteTransaction): WriteTransaction {
  const denied = async () => refuse();
  return Object.freeze({ query: records.query, count: records.count, insert: records.insert, update: denied, remove: denied });
}
