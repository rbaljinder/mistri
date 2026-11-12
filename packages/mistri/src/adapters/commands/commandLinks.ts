/**
 * Capability links in the command journal (layout 3, commandJournalSchema.ts):
 * the statements behind a journal's mintLink, revokeLinks, openLink and
 * readLink, one per engine. A link is minted in the command's own transaction,
 * so a command that rolls back leaves no link behind; it is opened in one
 * UPDATE that takes a use and records the open together, so a single-use link
 * opened twice at once opens once.
 *
 * The row holds no secret (server/links/linkToken.ts derives it from the form
 * key and the id), and a row is only ever looked up by its App and id: an id
 * read out of the database opens nothing by itself.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { COMMAND_JOURNAL_TABLES } from './commandJournalSchema.js';
import { q, tables } from './postgresCommandJournalSchema.js';
import type { CommandLinkRow } from './commandJournalTypes.js';

/** A link id: 22 characters of base64url, 128 random bits (server/links/linkToken.ts). */
export const LINK_ID = /^[A-Za-z0-9_-]{22}$/;
const COLUMNS =
  'id, app_id, tenant_id, resource, row_key, name, expires_at, uses_left, revoked_at, created_at, created_by, command, receipt, opens, last_opened_at';

const refuse = (): never => {
  throw new Refusal('Invalid capability link.');
};
const bounded = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= max && !/\p{Cc}/u.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** A row to write, checked whole: the journal writes nothing it would not read back as a link. */
function checkLinkRow(row: CommandLinkRow): readonly SQLInputValue[] {
  if (
    !row ||
    typeof row !== 'object' ||
    typeof row.id !== 'string' ||
    !LINK_ID.test(row.id) ||
    !bounded(row.app, 128) ||
    !bounded(row.tenant, 128, true) ||
    !bounded(row.resource, 256) ||
    !bounded(row.rowKey, 2048) ||
    !bounded(row.name, 128) ||
    !time(row.expiresAt) ||
    !(row.usesLeft === null || (Number.isSafeInteger(row.usesLeft) && row.usesLeft >= 1)) ||
    row.revokedAt !== null ||
    !time(row.createdAt) ||
    row.expiresAt <= row.createdAt ||
    !bounded(row.createdBy, 512) ||
    !bounded(row.command, 128) ||
    !bounded(row.receipt, 128) ||
    row.opens !== 0 ||
    row.lastOpenedAt !== null
  )
    return refuse();
  return [
    row.id,
    row.app,
    row.tenant,
    row.resource,
    row.rowKey,
    row.name,
    row.expiresAt,
    row.usesLeft,
    null,
    row.createdAt,
    row.createdBy,
    row.command,
    row.receipt,
    0,
    null,
  ];
}

const nullable = (value: unknown) => (value === null || value === undefined ? null : Number(value));
/** A row as either engine answers it (Postgres bigints arrive as text). */
function rowOf(raw: Record<string, unknown> | undefined): CommandLinkRow | undefined {
  if (!raw) return undefined;
  return {
    id: String(raw.id),
    app: String(raw.app_id),
    tenant: String(raw.tenant_id),
    resource: String(raw.resource),
    rowKey: String(raw.row_key),
    name: String(raw.name),
    expiresAt: Number(raw.expires_at),
    usesLeft: nullable(raw.uses_left),
    revokedAt: nullable(raw.revoked_at),
    createdAt: Number(raw.created_at),
    createdBy: String(raw.created_by),
    command: String(raw.command),
    receipt: String(raw.receipt),
    opens: Number(raw.opens),
    lastOpenedAt: nullable(raw.last_opened_at),
  };
}

const checkLookup = (appId: unknown, id: unknown, now: unknown) => {
  if (!bounded(appId, 128) || typeof id !== 'string' || !LINK_ID.test(id) || !time(now)) refuse();
};
const checkRevoke = (appId: unknown, resource: unknown, rowKey: unknown, name: unknown, now: unknown) => {
  if (
    !bounded(appId, 128) ||
    !bounded(resource, 256) ||
    !bounded(rowKey, 2048) ||
    !(name === undefined || bounded(name, 128)) ||
    !time(now)
  )
    refuse();
};

const S = `main."${COMMAND_JOURNAL_TABLES.link}"`;
/* Live: not revoked, not past its time, a use left where uses are counted. */
const LIVE = 'revoked_at IS NULL AND expires_at > ? AND (uses_left IS NULL OR uses_left > 0)';

export function mintSqliteLink(db: DatabaseSync, row: CommandLinkRow): void {
  const values = checkLinkRow(row);
  db.prepare(`INSERT INTO ${S} (${COLUMNS}) VALUES (${values.map(() => '?').join(', ')})`).run(...values);
}
export function revokeSqliteLinks(
  db: DatabaseSync,
  appId: string,
  tenant: string,
  resource: string,
  rowKey: string,
  name: string | undefined,
  now: number,
): number {
  checkRevoke(appId, resource, rowKey, name, now);
  const result = db
    .prepare(
      `UPDATE ${S} SET revoked_at = ? WHERE app_id = ? AND tenant_id = ? AND resource = ? AND row_key = ? AND revoked_at IS NULL${name === undefined ? '' : ' AND name = ?'}`,
    )
    .run(now, appId, tenant, resource, rowKey, ...(name === undefined ? [] : [name]));
  return Number(result.changes);
}
/* BEGIN IMMEDIATE serialises writers in the file, and the guard is in the UPDATE itself: the last use is taken once. */
export function openSqliteLink(db: DatabaseSync, appId: string, tenant: string, id: string, now: number): CommandLinkRow | undefined {
  checkLookup(appId, id, now);
  return rowOf(
    db
      .prepare(
        `UPDATE ${S} SET uses_left = CASE WHEN uses_left IS NULL THEN NULL ELSE uses_left - 1 END, opens = opens + 1, last_opened_at = ?
      WHERE id = ? AND app_id = ? AND tenant_id = ? AND ${LIVE} RETURNING ${COLUMNS}`,
      )
      .get(now, id, appId, tenant, now) as Record<string, unknown> | undefined,
  );
}
export function readSqliteLink(db: DatabaseSync, appId: string, tenant: string, id: string, now: number): CommandLinkRow | undefined {
  checkLookup(appId, id, now);
  return rowOf(
    db
      .prepare(`SELECT ${COLUMNS} FROM ${S} WHERE id = ? AND app_id = ? AND tenant_id = ? AND revoked_at IS NULL AND expires_at > ?`)
      .get(id, appId, tenant, now) as Record<string, unknown> | undefined,
  );
}

const P = () => q(tables.link);
export async function mintPostgresLink(client: PgQuery, row: CommandLinkRow): Promise<void> {
  const values = checkLinkRow(row);
  await client.query(`INSERT INTO ${P()} (${COLUMNS}) VALUES (${values.map((_, at) => `$${at + 1}`).join(', ')})`, values as unknown[]);
}
export async function revokePostgresLinks(
  client: PgQuery,
  appId: string,
  tenant: string,
  resource: string,
  rowKey: string,
  name: string | undefined,
  now: number,
): Promise<number> {
  checkRevoke(appId, resource, rowKey, name, now);
  const result = await client.query(
    `UPDATE ${P()} SET revoked_at = $1 WHERE app_id = $2 AND tenant_id = $3 AND resource = $4 AND row_key = $5 AND revoked_at IS NULL${name === undefined ? '' : ' AND name = $6'}`,
    [now, appId, tenant, resource, rowKey, ...(name === undefined ? [] : [name])],
  );
  return Number(result.rowCount ?? 0);
}
/* The row lock the UPDATE takes makes a second open wait, then re-check the guard against the first one's use. */
export async function openPostgresLink(
  client: PgQuery,
  appId: string,
  tenant: string,
  id: string,
  now: number,
): Promise<CommandLinkRow | undefined> {
  checkLookup(appId, id, now);
  const result = await client.query(
    `UPDATE ${P()} SET uses_left = CASE WHEN uses_left IS NULL THEN NULL ELSE uses_left - 1 END, opens = opens + 1, last_opened_at = $1
      WHERE id = $2 AND app_id = $3 AND tenant_id = $4 AND revoked_at IS NULL AND expires_at > $1 AND (uses_left IS NULL OR uses_left > 0)
      RETURNING ${COLUMNS}`,
    [now, id, appId, tenant],
  );
  return rowOf(result.rows[0] as Record<string, unknown> | undefined);
}
export async function readPostgresLink(
  client: PgQuery,
  appId: string,
  tenant: string,
  id: string,
  now: number,
): Promise<CommandLinkRow | undefined> {
  checkLookup(appId, id, now);
  const result = await client.query(
    `SELECT ${COLUMNS} FROM ${P()} WHERE id = $1 AND app_id = $2 AND tenant_id = $3 AND revoked_at IS NULL AND expires_at > $4`,
    [id, appId, tenant, now],
  );
  return rowOf(result.rows[0] as Record<string, unknown> | undefined);
}
