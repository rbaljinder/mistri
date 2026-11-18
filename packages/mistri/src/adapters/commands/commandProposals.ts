/**
 * Proposals and provenance marks in the command journal (layout 5, commandJournalSchema.ts): the statements behind a
 * journal's proposal and mark members, written once over both engines. Every statement runs in the caller's
 * transaction and names the App and tenant, so a journal reaches no other tenant's rows.
 *
 * A proposal leaves 'proposed' by one conditional UPDATE whose WHERE carries the state and the expiry, and its rows
 * affected say whether this call decided it: two approvals at once decide it once on either engine (SQLite's
 * BEGIN IMMEDIATE serialises the writers; on Postgres the second UPDATE waits on the row lock and re-reads the guard).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { beforeCommit } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import { COMMAND_JOURNAL_TABLES, MAKER_KINDS, PROPOSAL_BOUNDS, PROPOSAL_STATES, type ProposalState } from './commandJournalSchema.js';
import { q, tables } from './postgresCommandJournalSchema.js';
import type { CommandProposalRow, ProposalDecision, ProposalEvidence, ProvenanceRow } from './commandJournalTypes.js';

/** A proposal's or a mark's id: 22 characters of base64url, 128 random bits. */
const PROPOSAL_ID = /^[A-Za-z0-9_-]{22}$/;
const EVIDENCE_KINDS = new Set(['record', 'text', 'file', 'url']);
const PROPOSAL_COLUMNS =
  'id, app_id, tenant_id, command, target, input, actor_kind, actor, model, model_version, cost_micros, evidence, reason, state, decided_by, decided_at, receipt_id, created_at, expires_at';
const PROVENANCE_COLUMNS =
  'id, app_id, tenant_id, resource, row_key, field, actor_kind, actor, evidence, created_at, confirmed_by, confirmed_at';

const refuse = (): never => {
  throw new Refusal('Invalid proposal.');
};
const bounded = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= max && !/\p{Cc}/u.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const maker = (value: unknown) => typeof value === 'string' && (MAKER_KINDS as readonly string[]).includes(value);
const id = (value: unknown): value is string => typeof value === 'string' && PROPOSAL_ID.test(value);

/** Evidence as stored: each source a kind, a reference and a label, a quote where it has one; the whole bounded. */
function evidenceJson(evidence: unknown): string {
  if (!Array.isArray(evidence) || evidence.length > 64) return refuse();
  const clean = evidence.map((item: ProposalEvidence) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !EVIDENCE_KINDS.has(item.kind) ||
      !bounded(item.ref, 2048) ||
      !bounded(item.label, 512) ||
      !(item.quote === undefined || (typeof item.quote === 'string' && Buffer.byteLength(item.quote, 'utf8') <= 8192))
    )
      return refuse();
    return { kind: item.kind, ref: item.ref, label: item.label, ...(item.quote === undefined ? {} : { quote: item.quote }) };
  });
  const json = JSON.stringify(clean);
  if (Buffer.byteLength(json, 'utf8') > PROPOSAL_BOUNDS.evidence) refuse();
  return json;
}

function checkProposalRow(row: CommandProposalRow): unknown[] {
  if (
    !row ||
    typeof row !== 'object' ||
    !id(row.id) ||
    !bounded(row.app, 128) ||
    !bounded(row.tenant, 128, true) ||
    !bounded(row.command, 128) ||
    !(row.target === null || bounded(row.target, 8192)) ||
    !row.input ||
    typeof row.input !== 'object' ||
    Array.isArray(row.input) ||
    !maker(row.actorKind) ||
    !bounded(row.actor, 512) ||
    !(row.model === null || bounded(row.model, 256)) ||
    !(row.modelVersion === null || bounded(row.modelVersion, 256)) ||
    !(row.costMicros === null || (Number.isSafeInteger(row.costMicros) && row.costMicros >= 0)) ||
    typeof row.reason !== 'string' ||
    Buffer.byteLength(row.reason, 'utf8') > PROPOSAL_BOUNDS.reason ||
    row.state !== 'proposed' ||
    row.decidedBy !== null ||
    row.decidedAt !== null ||
    row.receiptId !== null ||
    !time(row.createdAt) ||
    !time(row.expiresAt) ||
    row.expiresAt <= row.createdAt
  )
    return refuse();
  const input = JSON.stringify(row.input);
  if (Buffer.byteLength(input, 'utf8') > PROPOSAL_BOUNDS.input) refuse();
  return [
    row.id,
    row.app,
    row.tenant,
    row.command,
    row.target,
    input,
    row.actorKind,
    row.actor,
    row.model,
    row.modelVersion,
    row.costMicros,
    evidenceJson(row.evidence),
    row.reason,
    'proposed',
    null,
    null,
    null,
    row.createdAt,
    row.expiresAt,
  ];
}

function checkProvenanceRow(row: ProvenanceRow): unknown[] {
  if (
    !row ||
    typeof row !== 'object' ||
    !id(row.id) ||
    !bounded(row.app, 128) ||
    !bounded(row.tenant, 128, true) ||
    !bounded(row.resource, 256) ||
    !bounded(row.rowKey, 2048) ||
    !(row.field === null || bounded(row.field, 256)) ||
    !maker(row.actorKind) ||
    !bounded(row.actor, 512) ||
    !time(row.createdAt) ||
    row.confirmedBy !== null ||
    row.confirmedAt !== null
  )
    return refuse();
  return [
    row.id,
    row.app,
    row.tenant,
    row.resource,
    row.rowKey,
    row.field,
    row.actorKind,
    row.actor,
    evidenceJson(row.evidence),
    row.createdAt,
    null,
    null,
  ];
}

const nullable = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
/** A row as either engine answers it (Postgres bigints arrive as text). */
function proposalOf(raw: Record<string, unknown> | undefined): CommandProposalRow | undefined {
  if (!raw) return undefined;
  return {
    id: String(raw.id),
    app: String(raw.app_id),
    tenant: String(raw.tenant_id),
    command: String(raw.command),
    target: text(raw.target),
    input: JSON.parse(String(raw.input)) as Record<string, unknown>,
    actorKind: String(raw.actor_kind) as CommandProposalRow['actorKind'],
    actor: String(raw.actor),
    model: text(raw.model),
    modelVersion: text(raw.model_version),
    costMicros: nullable(raw.cost_micros),
    evidence: JSON.parse(String(raw.evidence)) as ProposalEvidence[],
    reason: String(raw.reason),
    state: String(raw.state) as ProposalState,
    decidedBy: text(raw.decided_by),
    decidedAt: nullable(raw.decided_at),
    receiptId: text(raw.receipt_id),
    createdAt: Number(raw.created_at),
    expiresAt: Number(raw.expires_at),
  };
}
function provenanceOf(raw: Record<string, unknown>): ProvenanceRow {
  return {
    id: String(raw.id),
    app: String(raw.app_id),
    tenant: String(raw.tenant_id),
    resource: String(raw.resource),
    rowKey: String(raw.row_key),
    field: text(raw.field),
    actorKind: String(raw.actor_kind) as ProvenanceRow['actorKind'],
    actor: String(raw.actor),
    evidence: JSON.parse(String(raw.evidence)) as ProposalEvidence[],
    createdAt: Number(raw.created_at),
    confirmedBy: text(raw.confirmed_by),
    confirmedAt: nullable(raw.confirmed_at),
  };
}

/** The two statements every member needs, over either engine, with `?` placeholders. */
interface Statements {
  readonly proposal: string;
  readonly provenance: string;
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<number>;
}
const sqlite = (db: DatabaseSync): Statements => ({
  proposal: `main."${COMMAND_JOURNAL_TABLES.proposal}"`,
  provenance: `main."${COMMAND_JOURNAL_TABLES.provenance}"`,
  all: async (sql, params) => db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[],
  run: async (sql, params) => Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
});
/* The statements carry no `?` in a literal. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
const postgres = (client: PgQuery): Statements => ({
  proposal: q(tables.proposal),
  provenance: q(tables.provenance),
  all: async (sql, params) => (await client.query(numbered(sql), params)).rows as Record<string, unknown>[],
  run: async (sql, params) => Number((await client.query(numbered(sql), params)).rowCount ?? 0),
});

const checkApp = (appId: unknown) => {
  if (!bounded(appId, 128)) refuse();
};
const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

/** The journal's proposal and provenance members for one tenant's rows of one store. */
interface ProposalStatements {
  create(row: CommandProposalRow): Promise<void>;
  read(appId: string, id: string): Promise<CommandProposalRow | undefined>;
  list(
    appId: string,
    query: { commands: readonly string[]; states?: readonly ProposalState[]; limit: number },
  ): Promise<CommandProposalRow[]>;
  decide(
    appId: string,
    id: string,
    command: string,
    state: 'approved' | 'dismissed' | 'failed',
    by: string,
    now: number,
  ): Promise<ProposalDecision>;
  settle(appId: string, id: string, receiptId: string): Promise<boolean>;
  expire(appId: string, now: number): Promise<number>;
  mark(row: ProvenanceRow): Promise<void>;
  confirm(
    appId: string,
    resource: string,
    rowKey: string,
    field: string | readonly string[] | undefined,
    by: string,
    now: number,
  ): Promise<number>;
  /** One row's unconfirmed marks, or with no row the resource's (newest first, at most UNCONFIRMED_LIMIT). */
  unconfirmed(appId: string, resource: string, rowKey: string | null): Promise<ProvenanceRow[]>;
}

/** A resource's unconfirmed marks, listed for review: more than a person works through at a sitting. */
const UNCONFIRMED_LIMIT = 200;

function statements(db: Statements, tenant: string): ProposalStatements {
  const P = db.proposal;
  const V = db.provenance;
  const read = async (appId: string, proposal: string) => {
    checkApp(appId);
    if (!id(proposal)) return undefined;
    return proposalOf(
      (await db.all(`SELECT ${PROPOSAL_COLUMNS} FROM ${P} WHERE id = ? AND app_id = ? AND tenant_id = ?`, [proposal, appId, tenant]))[0],
    );
  };
  const checkRow = (appId: unknown, resource: unknown, rowKey: unknown) => {
    if (!bounded(appId, 128) || !bounded(resource, 256) || !bounded(rowKey, 2048)) refuse();
  };
  return {
    async create(row) {
      if (row?.tenant !== tenant) refuse();
      const values = checkProposalRow(row);
      await db.run(`INSERT INTO ${P} (${PROPOSAL_COLUMNS}) VALUES (${placeholders(values)})`, values);
    },
    read,
    async list(appId, query) {
      checkApp(appId);
      const commands = [...(query?.commands ?? [])];
      const states = query?.states ? [...query.states] : undefined;
      const limit = query?.limit;
      if (
        !commands.every((command) => bounded(command, 128)) ||
        !(states === undefined || states.every((state) => (PROPOSAL_STATES as readonly string[]).includes(state))) ||
        !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500)
      )
        refuse();
      if (!commands.length || states?.length === 0) return [];
      const rows = await db.all(
        `SELECT ${PROPOSAL_COLUMNS} FROM ${P} WHERE app_id = ? AND tenant_id = ? AND command IN (${placeholders(commands)})${
          states ? ` AND state IN (${placeholders(states)})` : ''
        } ORDER BY created_at DESC, id LIMIT ?`,
        [appId, tenant, ...commands, ...(states ?? []), limit],
      );
      return rows.map((raw) => proposalOf(raw)!);
    },
    async decide(appId, proposal, command, state, by, now) {
      checkApp(appId);
      if (!bounded(command, 128) || !['approved', 'dismissed', 'failed'].includes(state) || !bounded(by, 512) || !time(now)) refuse();
      if (!id(proposal)) return 'missing';
      /* Approved and dismissed leave 'proposed' only while it is live; failed is said of an approval this same person's
         run just refused, which may have outlived the window while it ran, so it takes the row in either case. */
      const live = state === 'failed' ? '' : ' AND expires_at > ?';
      const changed = await db.run(
        `UPDATE ${P} SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND app_id = ? AND tenant_id = ? AND command = ? AND state = 'proposed'${live}`,
        [state, by, now, proposal, appId, tenant, command, ...(live ? [now] : [])],
      );
      if (changed === 1) return 'decided';
      const found = await read(appId, proposal);
      if (!found || found.command !== command) return 'missing';
      if (found.state === 'proposed') {
        await db.run(
          `UPDATE ${P} SET state = 'expired', decided_at = ? WHERE id = ? AND app_id = ? AND tenant_id = ? AND state = 'proposed'`,
          [now, proposal, appId, tenant],
        );
        return 'expired';
      }
      return found.state === 'expired' ? 'expired' : 'taken';
    },
    async settle(appId, proposal, receiptId) {
      checkApp(appId);
      if (!id(proposal) || !bounded(receiptId, 128)) refuse();
      return (
        (await db.run(
          `UPDATE ${P} SET receipt_id = ? WHERE id = ? AND app_id = ? AND tenant_id = ? AND state = 'approved' AND receipt_id IS NULL`,
          [receiptId, proposal, appId, tenant],
        )) === 1
      );
    },
    async expire(appId, now) {
      checkApp(appId);
      if (!time(now)) refuse();
      return db.run(
        `UPDATE ${P} SET state = 'expired', decided_at = ? WHERE app_id = ? AND tenant_id = ? AND state = 'proposed' AND expires_at <= ?`,
        [now, appId, tenant, now],
      );
    },
    async mark(row) {
      if (row?.tenant !== tenant) refuse();
      const values = checkProvenanceRow(row);
      await db.run(`INSERT INTO ${V} (${PROVENANCE_COLUMNS}) VALUES (${placeholders(values)})`, values);
    },
    async confirm(appId, resource, rowKey, field, by, now) {
      checkRow(appId, resource, rowKey);
      /* A list is the fields one write set: a person's run confirms them all in one statement (businessCommandExecution.ts). */
      const fields = field === undefined ? undefined : typeof field === 'string' ? [field] : [...field];
      if (
        !(fields === undefined || (fields.length > 0 && fields.length <= 256 && fields.every((one) => bounded(one, 256)))) ||
        !bounded(by, 512) ||
        !time(now)
      )
        refuse();
      /* A field's confirmation confirms the row's own mark with it: what the row mark said of it is now a person's word. */
      return db.run(
        `UPDATE ${V} SET confirmed_by = ?, confirmed_at = ? WHERE app_id = ? AND tenant_id = ? AND resource = ? AND row_key = ? AND confirmed_by IS NULL${
          fields === undefined ? '' : ` AND (field IN (${placeholders(fields)}) OR field IS NULL)`
        }`,
        [by, now, appId, tenant, resource, rowKey, ...(fields ?? [])],
      );
    },
    async unconfirmed(appId, resource, rowKey) {
      if (rowKey === null) {
        checkRow(appId, resource, '-');
        const rows = await db.all(
          `SELECT ${PROVENANCE_COLUMNS} FROM ${V} WHERE app_id = ? AND tenant_id = ? AND resource = ? AND confirmed_by IS NULL ORDER BY created_at DESC, id LIMIT ?`,
          [appId, tenant, resource, UNCONFIRMED_LIMIT],
        );
        return rows.map(provenanceOf);
      }
      checkRow(appId, resource, rowKey);
      const rows = await db.all(
        `SELECT ${PROVENANCE_COLUMNS} FROM ${V} WHERE app_id = ? AND tenant_id = ? AND resource = ? AND row_key = ? AND confirmed_by IS NULL ORDER BY created_at, id`,
        [appId, tenant, resource, rowKey],
      );
      return rows.map(provenanceOf);
    },
  };
}

export const sqliteProposals = (db: DatabaseSync, tenant: string): ProposalStatements => statements(sqlite(db), tenant);
export const postgresProposals = (client: PgQuery, tenant: string): ProposalStatements => statements(postgres(client), tenant);
/**
 * The same members, their writes held for the transaction's COMMIT where the writer pipelines (beforeCommit): for a
 * write whose answer nobody reads, so it costs no round trip of its own. A refused one fails the COMMIT. Where the
 * writer does not pipeline, the write is sent in its turn and answers as usual; held, it answers 0.
 */
export const postgresProposalsAtCommit = (client: PgQuery, tenant: string): ProposalStatements =>
  statements(
    {
      ...postgres(client),
      run: async (sql, params) =>
        beforeCommit(client, [{ text: numbered(sql), values: params }])
          ? 0
          : Number((await client.query(numbered(sql), params)).rowCount ?? 0),
    },
    tenant,
  );
