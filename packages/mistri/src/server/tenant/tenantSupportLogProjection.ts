/**
 * Stored support history, projected into what one viewer may see of it.
 *
 * Pure: it takes rows already read and a description of the viewer's grants,
 * and returns the reply. It reads nothing, admits nobody and holds no handle,
 * so the rule about what a dealer is shown can be read — and tested — in one
 * place rather than inferred from a query.
 *
 * Two rules do the work. The dealer's log never carries the operator's email,
 * the native session, a row version, a MAC, a policy id or a receipt id: those
 * are either the lender's business or the store's, and the columns are simply
 * not copied across. And a change shows only the columns this viewer's own
 * grants let it read; the rest are named in `withheld`, so the log says that
 * something changed without showing what.
 */
import type { SupportEntryRow, SupportSessionRow } from './tenantSupportAuditContract.js';
import type { SupportAuditSession, SupportLogChange, SupportLogSession } from '../../shared/tenantSupportLog.js';

/** What one viewer may read, by resource: the columns their roles grant. A
 * resource absent from the map is one they may not read at all; an entry whose
 * set is undefined is a resource with no column restriction. */
export type SupportLogFields = ReadonlyMap<string, ReadonlySet<string> | undefined>;

const CHANGE_KINDS = new Set(['write', 'undo']);

function parsed(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const result: unknown = JSON.parse(value);
    return result !== null && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One side of a change, narrowed to the columns this viewer may read. The
 * names it drops are collected, so the caller can say they were withheld
 * rather than silently showing a shorter row. */
function narrow(
  side: Record<string, unknown> | null,
  allowed: ReadonlySet<string> | undefined,
  withheld: Set<string>,
): Record<string, unknown> | null {
  if (side === null) return null;
  const shown: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(side)) {
    if (allowed !== undefined && !allowed.has(column)) {
      withheld.add(column);
      continue;
    }
    shown[column] = value;
  }
  return shown;
}

function change(entry: SupportEntryRow, fields: SupportLogFields): SupportLogChange | null {
  const resource = entry.resource;
  // A change whose resource this viewer may not read at all is not listed. Its
  // existence is still counted by the session it belongs to.
  if (resource === null || !fields.has(resource)) return null;
  const allowed = fields.get(resource);
  const detail = parsed(entry.detailJson) ?? {};
  const withheld = new Set<string>();
  const before = narrow((detail.before as Record<string, unknown> | null) ?? null, allowed, withheld);
  const after = narrow((detail.after as Record<string, unknown> | null) ?? null, allowed, withheld);
  return {
    at: entry.at,
    resource,
    operation: entry.operation ?? 'update',
    key: narrow(parsed(entry.keyJson), allowed, new Set()),
    before,
    after,
    withheld: [...withheld].sort(),
  };
}

/** The dealer's own view of one session. */
function session(
  row: SupportSessionRow,
  entries: readonly SupportEntryRow[],
  realmLabel: string,
  fields: SupportLogFields,
): SupportLogSession {
  const mine = entries.filter((entry) => entry.sessionId === row.id);
  const changes: SupportLogChange[] = [];
  for (const entry of mine) {
    if (!CHANGE_KINDS.has(entry.kind)) continue;
    const projected = change(entry, fields);
    if (projected) changes.push(projected);
  }
  return {
    supportId: row.id,
    operatorName: row.operatorName,
    realmLabel,
    dealerRole: row.dealerRole,
    reason: row.reason,
    openedAt: row.openedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    state: row.endedAt === null ? 'active' : 'ended',
    reads: mine.filter((entry) => entry.kind === 'read').length,
    changes,
  };
}

/** Every session a dealer may see of its own tenant. The rows are already
 * confined to that tenant by the query that read them; this asserts it again
 * rather than trusting it, because one dealer seeing another's visits is the
 * failure this whole view exists to avoid. */
export function projectSupportLog(
  rows: { sessions: readonly SupportSessionRow[]; entries: readonly SupportEntryRow[] },
  tenantId: string,
  realmLabel: string,
  fields: SupportLogFields,
): readonly SupportLogSession[] {
  const own = rows.sessions.filter((row) => row.tenantId === tenantId);
  const entries = rows.entries.filter((entry) => entry.tenantId === tenantId);
  return own.map((row) => session(row, entries, realmLabel, fields));
}

/** The lender's audit view: every dealer's sessions, each naming its dealer,
 * and the one view that carries an operator's email. Nothing is filtered by
 * tenant here — seeing across dealers is the whole point of it, and the grant
 * that reaches this is a platform role's `supportAudit`, never a dealer's. */
export function projectSupportAudit(
  rows: { sessions: readonly SupportSessionRow[]; entries: readonly SupportEntryRow[] },
  realmLabel: string,
  fields: SupportLogFields,
  email: (accountId: string) => string | null,
): readonly SupportAuditSession[] {
  return rows.sessions.map((row) => ({
    ...session(
      row,
      rows.entries.filter((entry) => entry.tenantId === row.tenantId),
      realmLabel,
      fields,
    ),
    tenantId: row.tenantId,
    accountId: row.accountId,
    operatorEmail: email(row.accountId),
  }));
}
