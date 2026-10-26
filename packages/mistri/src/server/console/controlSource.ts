/** Request-bound Console reads. The host supplies suite admission and target
 * services; neither this adapter nor its filters interpret native principals.
 * Recreate the binding on account/target/tenant changes. Admission reobserve
 * must fence that generation as well as the current suite App grant. */
import { createHmac } from 'node:crypto';
import type { Adapter, Filter, QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import { Refusal } from '@mistriwork/engine/shared/refusal.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { FlagValue, FlagOverride } from '../../shared/appFlags.js';
import type { FlagManagementAcknowledgement, FlagManagementChange } from '../flags/management.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';

export interface ConsoleProof {
  readonly reobserve: () => void | Promise<void>;
  /** Owner's synchronous retirement/generation fence, after all awaited checks. */
  readonly assertCurrent: () => void;
}
export interface ConsoleAdmission {
  readonly admit: () => Promise<ConsoleProof>;
}
type ConsoleOperation = 'view' | 'experiment-view' | 'set' | 'kill' | 'revert';
interface ConsoleFlagDTO {
  readonly flagId: string;
  readonly owner: string;
  readonly revision: number;
  readonly value: FlagValue;
  readonly disabled: boolean;
}
interface ConsoleHistoryDTO {
  readonly flagId: string;
  readonly revision: number;
  readonly operation: string;
  readonly reason: string;
  readonly at: string;
  readonly before: FlagOverride | null;
  readonly after: FlagOverride | null;
}
/** Aggregate-only projection; the results owner supplies serialized evidence,
 * retaining epoch, method, maturity, completeness and evidence revision. */
interface ConsoleResultDTO {
  readonly flagId: string;
  readonly revision: number;
  readonly epoch: string;
  readonly method: string;
  readonly mature: number;
  readonly immature: number;
  readonly completeness: string;
  readonly evidence: string;
}
export interface ConsoleRows {
  flags: ConsoleFlagDTO;
  history: ConsoleHistoryDTO;
  results: ConsoleResultDTO;
}
export type ConsoleResource = keyof ConsoleRows;
const CONSOLE_SCAN_LIMIT = 1000;

/** Structural bridge to the deployment owner, NOT a raw store. All methods
 * belong to the same verified request/account and exact target/environment/
 * tenant. Scope is selected through the target membership owner before binding.
 * read returns ONLY authorized DTOs, never snapshots, totals or raw tables.
 * A complete=false batch is refused rather than counted/sorted as complete.
 * Large catalogs/history require a later bounded keyset bridge.
 * change MUST run beforeCommit at its authoritative locked pre-commit fence,
 * in addition to its own freshly derived full target capability checks. */
export interface ConsoleTargetService {
  readonly appId: string;
  readonly name: string;
  readonly environment: string;
  readonly tenantId: string | null;
  /** Null unless at least one flag OR experiment is currently viewable. */
  readonly viewable: () => Promise<ConsoleProof | null>;
  readonly authorize: (flagId: string, operation: ConsoleOperation) => Promise<ConsoleProof | null>;
  readonly read: <R extends ConsoleResource>(
    resource: R,
    request: {
      readonly flagId?: string;
      readonly limit: number;
    },
  ) => Promise<{ readonly rows: readonly ConsoleRows[R][]; readonly complete: boolean }>;
  readonly change: (input: FlagManagementChange, beforeCommit: () => Promise<void>) => Promise<FlagManagementAcknowledgement>;
}
interface ConsoleBinding {
  readonly admission: ConsoleAdmission;
  /** Trusted deployed services, never body-supplied target descriptors. */
  readonly targets: readonly ConsoleTargetService[];
  readonly selected?: ConsoleTargetService;
  /** Stable server secret, at least 32 bytes; never served to the browser. */
  readonly keySecret: Uint8Array;
}
export function consoleDenied(): never {
  throw new Refusal('Console operation unavailable.');
}
export function consoleRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const copy = captureTenantData(value);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy) || Object.keys(copy).some((key) => !keys.includes(key)))
    return consoleDenied();
  return copy as Record<string, unknown>;
}
export function consoleProof(proof: ConsoleProof | null): ConsoleProof {
  if (!proof || typeof proof.reobserve !== 'function' || typeof proof.assertCurrent !== 'function') return consoleDenied();
  const observe = proof.reobserve,
    current = proof.assertCurrent;
  return Object.freeze({ reobserve: () => observe.call(proof), assertCurrent: () => current.call(proof) });
}
const columns = {
  targets: ['id', 'appId', 'name', 'environment', 'tenantId'],
  flags: ['id', 'flagId', 'owner', 'revision', 'value', 'disabled'],
  history: ['id', 'flagId', 'revision', 'operation', 'reason', 'at', 'before', 'after'],
  results: ['id', 'flagId', 'revision', 'epoch', 'method', 'mature', 'immature', 'completeness', 'evidence'],
} as const;
type Table = keyof typeof columns;
type Row = Record<string, unknown>;
const numeric = new Set(['revision', 'mature', 'immature']);
function tableName(value: unknown): Table {
  if (typeof value !== 'string' || !Object.hasOwn(columns, value)) return consoleDenied();
  return value as Table;
}
function bound(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return consoleDenied();
  return value as number;
}
/** Deliberately closed grammar: a single AND group of scalar equality tests.
 * SQL, OR, joins, column comparisons, text matching and binary reads are not
 * approximated. Unknown fields are refused even on an empty relation. */
function conditions(value: unknown, table: Table): { column: string; value: string | number | boolean }[] {
  if (value === undefined) return [];
  const filter = consoleRecord(value, ['groups']);
  if (!Array.isArray(filter.groups) || filter.groups.length > 1) return consoleDenied();
  if (!filter.groups.length) return [];
  const group: unknown = filter.groups[0];
  if (!Array.isArray(group) || group.length > 8) return consoleDenied();
  return group.map((item) => {
    const condition = consoleRecord(item, ['column', 'op', 'value']);
    if (
      !(columns[table] as readonly unknown[]).includes(condition.column) ||
      condition.op !== '=' ||
      !['string', 'number', 'boolean'].includes(typeof condition.value) ||
      (typeof condition.value === 'number' && !Number.isFinite(condition.value))
    )
      return consoleDenied();
    return { column: condition.column as string, value: condition.value as string | number | boolean };
  });
}

export function createConsoleControlSource(binding: ConsoleBinding): Adapter {
  if (
    binding.keySecret.byteLength < 32 ||
    binding.targets.length > CONSOLE_SCAN_LIMIT ||
    (binding.selected && !binding.targets.includes(binding.selected))
  )
    return consoleDenied();
  const capture = (target: ConsoleTargetService): ConsoleTargetService =>
    Object.freeze({
      appId: target.appId,
      name: target.name,
      environment: target.environment,
      tenantId: target.tenantId,
      viewable: target.viewable.bind(target),
      authorize: target.authorize.bind(target),
      read: target.read.bind(target),
      change: target.change.bind(target),
    });
  const secret = Buffer.from(binding.keySecret),
    targets = binding.targets.map(capture);
  const selected = binding.selected ? targets[binding.targets.indexOf(binding.selected)] : undefined;
  const admission = binding.admission,
    admit = admission.admit;
  let closed = false;
  const begin = async () => {
    if (closed) return consoleDenied();
    const proof = consoleProof(await admit.call(admission));
    await proof.reobserve();
    return proof;
  };
  const key = (target: ConsoleTargetService, table: Table, flagId = '', revision?: number) =>
    createHmac('sha256', secret)
      .update(JSON.stringify([target.appId, target.environment, target.tenantId, table, flagId, revision ?? null]))
      .digest('base64url');
  const current = (proofs: ConsoleProof[], shell: ConsoleProof) => {
    for (const proof of proofs) proof.assertCurrent();
    shell.assertCurrent();
    if (closed) return consoleDenied();
  };
  const finish = async (proofs: ConsoleProof[], shell: ConsoleProof) => {
    for (const proof of proofs) await proof.reobserve();
    await shell.reobserve();
    current(proofs, shell);
  };
  const rows = async (table: Table, filter: ReturnType<typeof conditions>) => {
    const shell = await begin(),
      proofs: ConsoleProof[] = [],
      result: Row[] = [];
    const captured = () => ({
      data: result.filter((row) => filter.every((condition) => row[condition.column] === condition.value)),
      assertCurrent: () => current(proofs, shell),
    });
    if (table === 'targets') {
      for (const target of targets) {
        const visible = await target.viewable();
        if (!visible) continue;
        proofs.push(consoleProof(visible));
        result.push({
          id: key(target, table),
          appId: target.appId,
          name: target.name,
          environment: target.environment,
          tenantId: target.tenantId,
        });
      }
    } else {
      if (!selected) return consoleDenied();
      const flagId = filter.find((condition) => condition.column === 'flagId')?.value;
      if (flagId !== undefined && (typeof flagId !== 'string' || !flagId.length)) return consoleDenied();
      if (table !== 'flags' && typeof flagId !== 'string') return consoleDenied();
      const operation = table === 'results' ? 'experiment-view' : 'view';
      // Exact detail/history/results requests are authorized BEFORE any read.
      if (typeof flagId === 'string') proofs.push(consoleProof(await selected.authorize(flagId, operation)));
      else {
        const visible = await selected.viewable();
        if (!visible) {
          await finish([], shell);
          return captured();
        }
        proofs.push(consoleProof(visible));
      }
      const batch = captureTenantData(
        await selected.read(table, { ...(typeof flagId === 'string' ? { flagId } : {}), limit: CONSOLE_SCAN_LIMIT }),
      );
      if (!batch.complete || batch.rows.length > CONSOLE_SCAN_LIMIT) return consoleDenied();
      for (const dto of batch.rows) {
        if (flagId !== undefined && dto.flagId !== flagId) return consoleDenied();
        const allowed = await selected.authorize(dto.flagId, operation);
        if (!allowed) continue;
        proofs.push(consoleProof(allowed));
        // Explicit projection prevents service metadata or whole-scope totals
        // from becoming adapter columns. Structured values are detached.
        const data = captureTenantData(dto) as unknown as Row;
        const row: Row = { id: key(selected, table, dto.flagId, table === 'flags' ? undefined : dto.revision) };
        for (const column of columns[table]) if (column !== 'id') row[column] = data[column];
        result.push(row);
      }
    }
    await finish(proofs, shell);
    return captured();
  };
  return Object.freeze({
    dialect: 'http' as const,
    async introspect(): Promise<DatabaseSchema> {
      const shell = await begin();
      const schema: DatabaseSchema = {
        dialect: 'http',
        label: 'Console controls',
        readAt: new Date().toISOString(),
        foreignKeys: [],
        tables: Object.entries(columns).map(([id, names]) => ({
          id,
          name: id,
          schema: '',
          isView: true,
          insertable: false,
          deletable: false,
          columns: names.map((name) => ({
            name,
            type: numeric.has(name) ? 'integer' : name === 'disabled' ? 'boolean' : 'text',
            nullable: name === 'tenantId' || ['before', 'after', 'value'].includes(name),
            primaryKey: name === 'id',
            writable: false,
          })),
        })),
      };
      await finish([], shell);
      current([], shell);
      return schema;
    },
    async query(input: QueryRequest): Promise<QueryResult> {
      const request = consoleRecord(input, ['table', 'filter', 'columns', 'orderBy', 'limit', 'offset']);
      const table = tableName(request.table),
        filter = conditions(request.filter, table);
      const limit = bound(request.limit, 1, 100),
        offset = bound(request.offset, 0, CONSOLE_SCAN_LIMIT);
      const names =
        request.columns === undefined || (Array.isArray(request.columns) && !request.columns.length)
          ? [...columns[table]]
          : request.columns;
      if (
        !Array.isArray(names) ||
        names.some((name) => !(columns[table] as readonly unknown[]).includes(name)) ||
        new Set(names).size !== names.length
      )
        return consoleDenied();
      const order = request.orderBy ?? [];
      if (!Array.isArray(order) || order.length > 3) return consoleDenied();
      const sorts = order.map((item) => {
        const sort = consoleRecord(item, ['column', 'direction']);
        if (
          !(columns[table] as readonly unknown[]).includes(sort.column) ||
          !['asc', 'desc'].includes(sort.direction as string) ||
          ['value', 'before', 'after'].includes(sort.column as string)
        )
          return consoleDenied();
        return { column: sort.column as string, direction: sort.direction };
      });
      const captured = await rows(table, filter),
        data = captured.data;
      data.sort((a, b) => {
        for (const sort of [...sorts, { column: 'id', direction: 'asc' }]) {
          const x = a[sort.column] as string | number | null,
            y = b[sort.column] as string | number | null;
          const compared = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
          if (compared) return sort.direction === 'asc' ? compared : -compared;
        }
        return 0;
      });
      const result = {
        columns: names as string[],
        rows: data.slice(offset, offset + limit).map((row) => Object.fromEntries((names as string[]).map((name) => [name, row[name]]))),
        ms: 0,
        sql: { text: '', params: [] },
      };
      captured.assertCurrent();
      return result;
    },
    async count(input: string, filter?: Filter, limit?: number): Promise<number> {
      const table = tableName(input),
        checked = conditions(filter, table);
      const cap = limit === undefined ? CONSOLE_SCAN_LIMIT : bound(limit, 1, CONSOLE_SCAN_LIMIT);
      const captured = await rows(table, checked);
      captured.assertCurrent();
      return Math.min(captured.data.length, cap);
    },
    async close() {
      closed = true;
      secret.fill(0);
    },
  });
}
