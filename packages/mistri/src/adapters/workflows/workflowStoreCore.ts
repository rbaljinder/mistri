/*
 * The workflow store's rules, written once over a transaction. The SQLite
 * store (workflowStore.ts) and the PostgreSQL store (postgresWorkflowStore.ts)
 * differ only in how they open a transaction and spell a row lock, so the
 * epoch fence, the signal re-check and the retry cut cannot drift apart.
 *
 * Statements use `?` placeholders; the PostgreSQL driver numbers them.
 *
 * On PostgreSQL the store is one App's among several on a database: every
 * statement that reads or changes an instance or a signal is of this
 * namespace's rows only, so an operator, a signal and a wake of one App never
 * reach another's. SQLite holds one App per file and has no namespace column.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowStore } from './workflowStoreContract.js';
import { WORKFLOW_TABLES as t } from './workflowStoreSchema.js';
import {
  LIVE_STATES,
  SIGNAL_PAGE,
  WORKFLOW_ID,
  WORKFLOW_JSON_MAX,
  WORKFLOW_OPERATOR,
  WORKFLOW_STATES,
  workflowFail,
  workflowProblemError,
  workflowRefuse,
  type WorkflowProblemError,
  type StepWrite,
  type WorkflowActionInspection,
  type WorkflowInspection,
  type WorkflowInstance,
  type WorkflowOutcome,
  type WorkflowSignal,
  type WorkflowState,
  type WorkflowStep,
  type WorkflowStepInspection,
} from './workflowStoreTypes.js';

export type Row = Record<string, unknown>;
export interface Db {
  all(sql: string, ...params: unknown[]): Promise<Row[]>;
  /** Rows changed. */
  run(sql: string, ...params: unknown[]): Promise<number>;
}
export type Transaction = <T>(write: boolean, work: (db: Db) => Promise<T>) => Promise<T>;

const live = LIVE_STATES.map((state) => `'${state}'`).join(',');
const INSPECT_LIMIT = 500;
const num = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : workflowFail();
};
const maybeNum = (value: unknown) => (value === null || value === undefined ? null : num(value));
const maybeStr = (value: unknown) => (value === null || value === undefined ? null : String(value));

const instanceOf = (row: Row): WorkflowInstance => ({
  id: String(row.id),
  workflow: String(row.workflow),
  version: num(row.version),
  key: String(row.key),
  state: row.state as WorkflowState,
  epoch: num(row.epoch),
  startEventId: String(row.start_event_id),
  startJson: String(row.start_json),
  signalFloor: num(row.signal_floor),
  waitEvent: maybeStr(row.wait_event),
  wakeAt: maybeNum(row.wake_at),
  currentStep: maybeStr(row.current_step),
  problem: maybeStr(row.problem),
  problemStep: maybeStr(row.problem_step),
  problemJson: maybeStr(row.problem_json),
  resultJson: maybeStr(row.result_json),
  createdAt: num(row.created_at),
  updatedAt: num(row.updated_at),
});
const stepOf = (row: Row): WorkflowStep => ({
  name: String(row.name),
  ordinal: num(row.ordinal),
  kind: row.kind as WorkflowStep['kind'],
  hash: String(row.hash),
  status: row.status as WorkflowStep['status'],
  attempts: num(row.attempts),
  wakeAt: maybeNum(row.wake_at),
  resultJson: maybeStr(row.result_json),
  eventId: maybeStr(row.event_id),
  errorCode: maybeStr(row.error_code),
  createdAt: num(row.created_at),
  updatedAt: num(row.updated_at),
});
const inspectionOf = (row: Row): WorkflowInspection => ({
  id: String(row.id),
  workflow: String(row.workflow),
  version: num(row.version),
  key: String(row.key),
  state: row.state as WorkflowState,
  currentStep: maybeStr(row.current_step),
  waitEvent: maybeStr(row.wait_event),
  wakeAt: maybeNum(row.wake_at),
  problem: maybeStr(row.problem),
  problemStep: maybeStr(row.problem_step),
  ...problemErrorOf(row),
  createdAt: num(row.created_at),
  updatedAt: num(row.updated_at),
});
/* Read back through the same check it was written through: a row is never trusted to hold only a name and a code. */
function problemErrorOf(row: Row): { problemError?: WorkflowProblemError } {
  if (row.problem !== 'workflow_error' || typeof row.problem_json !== 'string') return {};
  try {
    const kept = workflowProblemError((JSON.parse(row.problem_json) as { error?: unknown }).error);
    return kept ? { problemError: kept } : {};
  } catch {
    return {};
  }
}

const captureId = (id: unknown): string => (typeof id === 'string' && WORKFLOW_ID.test(id) ? id : workflowRefuse('not_found'));
const captureOperator = (operator: unknown): string =>
  typeof operator === 'string' && WORKFLOW_OPERATOR.test(operator) ? operator : workflowRefuse('operator_invalid');
const captureJson = (json: unknown): string =>
  typeof json === 'string' && json.length > 0 && Buffer.byteLength(json) <= WORKFLOW_JSON_MAX ? json : workflowFail();

export function createWorkflowStore(
  transaction: Transaction,
  forUpdate: string,
  close: () => Promise<void>,
  namespace?: string,
  /* Where a table is: quoted in the file on SQLite, in the runtime schema on PostgreSQL. */
  table: (name: string) => string = (name) => `"${name}"`,
): WorkflowStore {
  /* `and` closes a WHERE with this namespace and `ns` is its parameter, last;
     `col`/`val` add the column to an INSERT. Empty on SQLite. */
  const scoped = namespace !== undefined;
  const and = scoped ? ' AND namespace=?' : '',
    ns: unknown[] = scoped ? [namespace] : [];
  const col = scoped ? ',namespace' : '',
    val = scoped ? ',?' : '';
  const instance = async (db: Db, id: string, lock = true): Promise<Row | undefined> =>
    (await db.all(`SELECT * FROM ${table(t.instance)} WHERE id=?${and}${lock ? forUpdate : ''}`, id, ...ns))[0];
  const record = (db: Db, id: string, action: 'cancel' | 'retry', operator: string, now: number) =>
    db.run(`INSERT INTO ${table(t.action)} (instance_id,action,operator,at) VALUES (?,?,?,?)`, id, action, operator, now);
  /** The row this run still owns: the epoch it holds, still running. */
  const owned = async (db: Db, id: string, epoch: number): Promise<Row | undefined> => {
    const row = await instance(db, id);
    return row && row.state === 'running' && num(row.epoch) === epoch ? row : undefined;
  };

  return {
    start: (input, now) =>
      transaction(true, async (db) => {
        const key = captureJson(input.key),
          startJson = captureJson(input.startJson);
        const started = (
          await db.all(
            `SELECT id FROM ${table(t.instance)} WHERE workflow=? AND start_event_id=?${and}`,
            input.workflow,
            input.eventId,
            ...ns,
          )
        )[0];
        if (started) return { id: String(started.id), created: false };
        if (
          (
            await db.all(
              `SELECT id FROM ${table(t.instance)} WHERE workflow=? AND key=? AND state IN (${live})${and}${forUpdate}`,
              input.workflow,
              key,
              ...ns,
            )
          ).length
        )
          return undefined;
        const id = randomUUID();
        await db.run(
          `INSERT INTO ${table(t.instance)} (id,workflow,version,key,state,epoch,start_event_id,start_json,signal_floor,created_at,updated_at${col})
        VALUES (?,?,?,?,'running',0,?,?,(SELECT COALESCE(MAX(seq),0) FROM ${table(t.signal)}),?,?${val})`,
          id,
          input.workflow,
          input.version,
          key,
          input.eventId,
          startJson,
          now,
          now,
          ...ns,
        );
        return { id, created: true };
      }),

    signal: (input, now) =>
      transaction(true, async (db) => {
        // Locked, so a run suspending now either sees this signal or is seen waiting for it.
        const instances = await db.all(
          `SELECT id,state,wait_event FROM ${table(t.instance)} WHERE workflow=? AND state IN (${live})${and}${forUpdate}`,
          input.workflow,
          ...ns,
        );
        if (!instances.length) return [];
        await db.run(
          `INSERT INTO ${table(t.signal)} (workflow,event_id,name,version,payload_json,recorded_at${col}) VALUES (?,?,?,?,?,?${val})
        ON CONFLICT (${scoped ? 'namespace,' : ''}workflow,event_id) DO NOTHING`,
          input.workflow,
          input.eventId,
          input.name,
          input.version,
          captureJson(input.payloadJson),
          now,
          ...ns,
        );
        const wanted = `${input.name}@${input.version}`;
        return instances.filter((row) => row.state === 'waiting' && row.wait_event === wanted).map((row) => String(row.id));
      }),

    begin: (id, now, workflow) =>
      transaction(true, async (db) => {
        const row = await instance(db, captureId(id));
        if (!row || !LIVE_STATES.includes(row.state as WorkflowState) || (workflow !== undefined && row.workflow !== workflow))
          return undefined;
        await db.run(
          `UPDATE ${table(t.instance)} SET state='running',epoch=epoch+1,wait_event=NULL,wake_at=NULL,updated_at=? WHERE id=?${and}`,
          now,
          id,
          ...ns,
        );
        const steps = await db.all(`SELECT * FROM ${table(t.step)} WHERE instance_id=? ORDER BY ordinal`, id);
        return { instance: instanceOf((await instance(db, id, false))!), steps: steps.map(stepOf) };
      }),

    signals: async (workflow, name, version, afterSeq) =>
      transaction(false, async (db) =>
        (
          await db.all(
            `SELECT seq,event_id,name,version,payload_json FROM ${table(t.signal)} WHERE workflow=? AND name=? AND version=? AND seq>?${and}
        ORDER BY seq LIMIT ${SIGNAL_PAGE}`,
            workflow,
            name,
            version,
            afterSeq,
            ...ns,
          )
        ).map((row): WorkflowSignal => ({
          seq: num(row.seq),
          eventId: String(row.event_id),
          name: String(row.name),
          version: num(row.version),
          payloadJson: String(row.payload_json),
        })),
      ),

    step: (id, epoch, write: StepWrite, now) =>
      transaction(true, async (db) => {
        if (!(await owned(db, id, epoch))) return undefined;
        const result = write.resultJson === null ? null : captureJson(write.resultJson);
        const existing = (await db.all(`SELECT name FROM ${table(t.step)} WHERE instance_id=? AND name=?`, id, write.name))[0];
        if (existing) {
          await db.run(
            `UPDATE ${table(t.step)} SET kind=?,hash=?,status=?,attempts=?,wake_at=?,result_json=?,event_id=?,error_code=?,updated_at=?
          WHERE instance_id=? AND name=?`,
            write.kind,
            write.hash,
            write.status,
            write.attempts,
            write.wakeAt,
            result,
            write.eventId,
            write.errorCode,
            now,
            id,
            write.name,
          );
        } else {
          await db.run(
            `INSERT INTO ${table(t.step)} (instance_id,name,ordinal,kind,hash,status,attempts,wake_at,result_json,event_id,error_code,created_at,updated_at)
          VALUES (?,?,(SELECT COALESCE(MAX(ordinal)+1,0) FROM ${table(t.step)} WHERE instance_id=?),?,?,?,?,?,?,?,?,?,?)`,
            id,
            write.name,
            id,
            write.kind,
            write.hash,
            write.status,
            write.attempts,
            write.wakeAt,
            result,
            write.eventId,
            write.errorCode,
            now,
            now,
          );
        }
        await db.run(`UPDATE ${table(t.instance)} SET epoch=epoch+1,current_step=?,updated_at=? WHERE id=?`, write.name, now, id);
        return epoch + 1;
      }),

    suspend: (id, epoch, wait, now) =>
      transaction(true, async (db) => {
        const row = await owned(db, id, epoch);
        if (!row) return undefined;
        if (wait.event) {
          const after = Math.max(wait.seenSeq, num(row.signal_floor));
          if (
            (
              await db.all(
                `SELECT seq FROM ${table(t.signal)} WHERE workflow=? AND name=? AND version=? AND seq>?${and} LIMIT 1`,
                row.workflow,
                wait.event.name,
                wait.event.version,
                after,
                ...ns,
              )
            ).length
          )
            return 'signal' as const;
        }
        await db.run(
          `UPDATE ${table(t.instance)} SET state='waiting',epoch=epoch+1,wait_event=?,wake_at=?,current_step=?,updated_at=? WHERE id=?`,
          wait.event ? `${wait.event.name}@${wait.event.version}` : null,
          wait.wakeAt,
          wait.step,
          now,
          id,
        );
        return { epoch: epoch + 1 };
      }),

    release: (id, epoch, now) =>
      transaction(true, async (db) => {
        if (!(await owned(db, id, epoch))) return undefined;
        await db.run(`UPDATE ${table(t.instance)} SET epoch=epoch+1,updated_at=? WHERE id=?`, now, id);
        return epoch + 1;
      }),

    finish: (id, epoch, outcome: WorkflowOutcome, now) =>
      transaction(true, async (db) => {
        if (!(await owned(db, id, epoch))) return false;
        await db.run(
          `UPDATE ${table(t.instance)} SET state=?,epoch=epoch+1,wait_event=NULL,wake_at=NULL,problem=?,problem_step=?,problem_json=?,result_json=?,updated_at=? WHERE id=?`,
          outcome.state,
          outcome.state === 'completed' ? null : outcome.problem,
          outcome.state === 'completed' ? null : outcome.problemStep,
          outcome.state === 'completed' ? null : (outcome.problemJson ?? null),
          outcome.state === 'completed' && outcome.resultJson !== null ? captureJson(outcome.resultJson) : null,
          now,
          id,
        );
        return true;
      }),

    cancel: (id, operator, now) =>
      transaction(true, async (db) => {
        const who = captureOperator(operator);
        const row = await instance(db, captureId(id));
        if (!row) return workflowRefuse('not_found');
        if (!LIVE_STATES.includes(row.state as WorkflowState)) return { outcome: 'unchanged' as const, state: row.state as WorkflowState };
        await db.run(
          `UPDATE ${table(t.instance)} SET state='cancelled',epoch=epoch+1,wait_event=NULL,wake_at=NULL,updated_at=? WHERE id=?`,
          now,
          id,
        );
        await record(db, String(row.id), 'cancel', who, now);
        return { outcome: 'cancelled' as const, state: 'cancelled' as const };
      }),

    retry: (id, operator, now, admit) =>
      transaction(true, async (db) => {
        const who = captureOperator(operator);
        const row = await instance(db, captureId(id));
        if (!row) return workflowRefuse('not_found');
        const awake = LIVE_STATES.includes(row.state as WorkflowState);
        if (!awake && row.state !== 'failed' && row.state !== 'diverged') return workflowRefuse('not_retryable');
        if (admit && !admit(String(row.workflow))) return workflowRefuse('not_retryable');
        /* A live instance is woken where it is: nothing is forgotten, and the new epoch fences out any run still
           holding the old one, so a wake-up that was lost (a crash between a retry's commit and its enqueue) is
           replaced, and one that was not runs harmlessly beside it. */
        if (awake) {
          await db.run(`UPDATE ${table(t.instance)} SET epoch=epoch+1,updated_at=? WHERE id=?`, now, id);
          await record(db, id, 'retry', who, now);
          return instanceOf((await instance(db, id, false))!);
        }
        // A newer instance of the key may hold it by now: two live ones never share a key.
        if (
          (
            await db.all(
              `SELECT id FROM ${table(t.instance)} WHERE workflow=? AND key=? AND state IN (${live})${and}`,
              row.workflow,
              row.key,
              ...ns,
            )
          ).length
        )
          return workflowRefuse('not_retryable');
        const stopped =
          row.problem_step === null
            ? undefined
            : (await db.all(`SELECT ordinal FROM ${table(t.step)} WHERE instance_id=? AND name=?`, id, row.problem_step))[0];
        if (stopped) await db.run(`DELETE FROM ${table(t.step)} WHERE instance_id=? AND ordinal>=?`, id, num(stopped.ordinal));
        await db.run(
          `UPDATE ${table(t.instance)} SET state='running',epoch=epoch+1,problem=NULL,problem_step=NULL,problem_json=NULL,wait_event=NULL,wake_at=NULL,updated_at=? WHERE id=?`,
          now,
          id,
        );
        await record(db, id, 'retry', who, now);
        return instanceOf((await instance(db, id, false))!);
      }),

    inspect: (filter = {}, limit = 100) =>
      transaction(false, async (db) => {
        if (filter.state !== undefined && !WORKFLOW_STATES.includes(filter.state)) return workflowRefuse('operator_invalid');
        if (!Number.isInteger(limit) || limit < 1 || limit > INSPECT_LIMIT) return workflowRefuse('operator_invalid');
        const where: string[] = [],
          params: unknown[] = [];
        if (filter.state) {
          where.push('state=?');
          params.push(filter.state);
        }
        if (filter.workflow) {
          where.push('workflow=?');
          params.push(filter.workflow);
        }
        if (filter.keyPrefix !== undefined) {
          // One record's runs (a flows runner keys them `<record>|<flow>`): compared whole, never as a LIKE pattern.
          if (typeof filter.keyPrefix !== 'string' || !filter.keyPrefix || filter.keyPrefix.length > 512)
            return workflowRefuse('operator_invalid');
          where.push('substr(key,1,?)=?');
          params.push(filter.keyPrefix.length, filter.keyPrefix);
        }
        if (filter.afterId) {
          where.push('id>?');
          params.push(filter.afterId);
        }
        if (scoped) {
          where.push('namespace=?');
          params.push(namespace);
        }
        return (
          await db.all(
            `SELECT * FROM ${table(t.instance)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id LIMIT ${limit}`,
            ...params,
          )
        ).map(inspectionOf);
      }),

    steps: (id) =>
      transaction(false, async (db) =>
        (
          await db.all(
            `SELECT * FROM ${table(t.step)} WHERE instance_id=?${scoped ? ` AND instance_id IN (SELECT id FROM ${table(t.instance)} WHERE namespace=?)` : ''}
        ORDER BY ordinal`,
            captureId(id),
            ...ns,
          )
        ).map((row): WorkflowStepInspection => {
          const { name, ordinal, kind, status, attempts, wakeAt, errorCode, createdAt, updatedAt } = stepOf(row);
          return { name, ordinal, kind, status, attempts, wakeAt, errorCode, createdAt, updatedAt };
        }),
      ),

    actions: (id) =>
      transaction(false, async (db) =>
        (
          await db.all(
            `SELECT action,operator,at FROM ${table(t.action)} WHERE instance_id=?${scoped ? ` AND instance_id IN (SELECT id FROM ${table(t.instance)} WHERE namespace=?)` : ''}
        ORDER BY seq`,
            captureId(id),
            ...ns,
          )
        ).map((row): WorkflowActionInspection => ({
          action: row.action as WorkflowActionInspection['action'],
          operator: String(row.operator),
          at: num(row.at),
        })),
      ),

    prune: (olderThanMs, now, limit = 500) =>
      transaction(true, async (db) => {
        if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0 || !Number.isInteger(limit) || limit < 1 || limit > INSPECT_LIMIT)
          return workflowRefuse('operator_invalid');
        const old = await db.all(
          `SELECT id FROM ${table(t.instance)} WHERE state IN ('completed','cancelled') AND updated_at<?${and} ORDER BY updated_at,id LIMIT ${limit}`,
          now - olderThanMs,
          ...ns,
        );
        for (const row of old) await db.run(`DELETE FROM ${table(t.instance)} WHERE id=?`, row.id);
        // A signal no live instance can still read: at or below every live floor, or no instance of its workflow is live.
        await db.run(
          `DELETE FROM ${table(t.signal)} WHERE seq<=COALESCE((SELECT MIN(i.signal_floor) FROM ${table(t.instance)} i
        WHERE i.workflow=${table(t.signal)}.workflow${scoped ? ` AND i.namespace=${table(t.signal)}.namespace` : ''} AND i.state IN (${live})),9007199254740991)${and}`,
          ...ns,
        );
        return { pruned: old.length, more: old.length === limit };
      }),

    close,
  };
}
