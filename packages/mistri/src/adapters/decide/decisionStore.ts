/**
 * What decisions were made, the engine-neutral half of their store: one row a
 * decision a record a trigger, what became of it, and a day's calls, units
 * and cost per tenant — the caps are read from it and the bill made from it;
 * and, for a tenant App, which providers the platform has turned on for each
 * tenant (tenantDecisions.ts).
 *
 * Kept in reserved `__mistri_decision_*` tables beside the App's records,
 * provisioned once by maintenance and attested when an App that declares a
 * decision starts. Every statement names its owner, the App and the tenant
 * ('' outside a tenant App), so a row of another is not found rather than
 * refused.
 *
 * **Values are never stored.** A row holds the names of the inputs sent and a
 * SHA-256 of what was sent (canonical JSON), the answer after its shape check
 * and the probability; "Why this?" reads the record's current values again,
 * as the reader may read them.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { DECIDE_FEATURES, decideFeature, providerOf, TENANT_SWITCH_TABLES } from '../switch/tenantSwitch.js';

export const DECISION_STORE_VERSION = 1;
export const DECISION_PREFIX = '__mistri_decision_';
export const DECISION_TABLES = Object.freeze({
  meta: `${DECISION_PREFIX}meta`,
  record: `${DECISION_PREFIX}record`,
  usage: `${DECISION_PREFIX}usage`,
});
/** A record's decisions, newest last: what the record page and the list read. */
export const DECISION_RECORD_INDEX = `${DECISION_PREFIX}record_on`;
/** The App's decisions by age: what retention and the fourteen-day sweep read. */
export const DECISION_AGE_INDEX = `${DECISION_PREFIX}record_age`;

export const DECISION_LIMITS = Object.freeze({
  app: 128,
  tenant: 128,
  /** The consent reference the platform owner wrote when turning a provider on: words, not a document. */
  consent: 2000,
  /** An answer, as JSON: a list of at most a few hundred keys. */
  answer: 64 * 1024,
});

const OUTCOMES = ['applied', 'suggested', 'accepted', 'corrected', 'ignored', 'below', 'none'] as const;
type DecisionOutcome = (typeof OUTCOMES)[number];
/** Why a decision is `none`, or how an outcome came about. `pending`: asked, not yet answered. */
export type OutcomeReason =
  | ''
  | 'pending'
  | 'timeout'
  | 'error'
  | 'invalid'
  | 'cap'
  | 'refused'
  | 'off'
  | 'filled'
  | 'stale'
  | 'dismissed'
  | 'expired'
  | 'edited';

export class DecisionStoreUnavailable extends Refusal {
  constructor(message = 'The decision store is unavailable or not this version.') {
    super(message);
    this.name = 'DecisionStoreUnavailable';
  }
}

/** Whose a decision is. `tenant` is '' outside a tenant App. */
export interface DecisionOwner {
  readonly app: string;
  readonly tenant: string;
}

/** A decision row as the store keeps it. */
export interface StoredDecision {
  readonly id: string;
  readonly decision: string;
  readonly contractVersion: number;
  readonly resource: string;
  /** The record's key, as canonical JSON of its columns. */
  readonly recordKey: string;
  /** The column it answers. */
  readonly field: string;
  readonly trigger: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly inputsDigest: string;
  readonly inputFields: readonly string[];
  readonly choicesDigest: string;
  readonly answer: unknown;
  readonly probability: number | null;
  readonly outcome: DecisionOutcome;
  readonly outcomeReason: OutcomeReason;
  readonly correctedTo: unknown;
  readonly outcomeBy: string;
  readonly outcomeAt: string;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly units: number;
  readonly createdAt: string;
}

/** What a decision's first attempt writes: its identity, before anything is asked. */
interface DecisionStart {
  readonly id: string;
  readonly decision: string;
  readonly contractVersion: number;
  readonly resource: string;
  readonly recordKey: string;
  readonly field: string;
  readonly trigger: string;
  readonly inputFields: readonly string[];
  readonly createdAt: string;
}

/** What answering it settles. */
interface DecisionAnswered {
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly inputsDigest: string;
  readonly choicesDigest: string;
  readonly answer: unknown;
  readonly probability: number | null;
  readonly outcome: DecisionOutcome;
  readonly outcomeReason: OutcomeReason;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly units: number;
  readonly at: string;
}

/** A person's or the server's later word on a decision. */
interface DecisionSettled {
  readonly outcome: 'accepted' | 'corrected' | 'ignored' | 'applied';
  readonly reason: OutcomeReason;
  readonly correctedTo?: unknown;
  readonly by: string;
  readonly at: string;
}

/** A tenant's day. */
interface DecisionUsage {
  readonly tenant: string;
  readonly day: string;
  readonly calls: number;
  readonly units: number;
  readonly costMicros: number;
}

/** A tenant's switch for one provider. */
interface DecisionSwitch {
  readonly provider: string;
  readonly enabled: boolean;
  readonly consent: string;
  readonly changedAt: string;
}

export type Row = Record<string, unknown>;
export interface Db {
  all(sql: string, ...params: unknown[]): Promise<Row[]>;
  run(sql: string, ...params: unknown[]): Promise<number>;
}
export type Transaction = <T>(work: (db: Db) => Promise<T>) => Promise<T>;

export interface DecisionStore {
  /** Record a decision's start, once: the row already there (a retry, a second host) is returned as it is. */
  begin(owner: DecisionOwner, start: DecisionStart): Promise<{ row: StoredDecision; fresh: boolean }>;
  /** Settle a started decision's answer; false when it was settled already. */
  answer(owner: DecisionOwner, id: string, answered: DecisionAnswered): Promise<boolean>;
  /** Move a decision on: a suggestion accepted, corrected or ignored; an applied one corrected; a suggestion applied. False when it was not in a state that moves so. */
  settle(owner: DecisionOwner, id: string, settled: DecisionSettled): Promise<boolean>;
  get(owner: DecisionOwner, id: string): Promise<StoredDecision | null>;
  /** A record's decisions, newest first, at most `limit`. */
  ofRecord(owner: DecisionOwner, resource: string, recordKey: string, limit: number): Promise<StoredDecision[]>;
  /** The suggestions waiting on these records of a resource: the newest of each decision on each. */
  waiting(owner: DecisionOwner, resource: string, recordKeys: readonly string[]): Promise<StoredDecision[]>;
  /** Count a call: one more call, its units and cost, on a tenant's day. */
  spend(owner: DecisionOwner, day: string, units: number, costMicros: number): Promise<void>;
  /** A tenant's calls on a day, and the App's across tenants. */
  calls(owner: DecisionOwner, day: string): Promise<{ tenant: number; app: number }>;
  /** Days from `from` on (ISO date), a tenant's or, with no tenant, every tenant's. */
  usage(app: string, tenant: string | undefined, from: string): Promise<DecisionUsage[]>;
  /** A tenant's switches, one a provider it has ever been given. */
  switches(app: string, tenant: string): Promise<DecisionSwitch[]>;
  setSwitch(app: string, tenant: string, provider: string, enabled: boolean, consent: string, at: string): Promise<void>;
  /** A closing tenant's decisions and switches; usage rows stay, for the bill. */
  forgetTenant(app: string, tenant: string): Promise<number>;
  /** Suggestions older than `staleBefore` become ignored (expired); rows older than `before` go. How many went. */
  purge(app: string, before: string, staleBefore: string, at: string): Promise<{ removed: number; expired: number }>;
  close(): Promise<void>;
}

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
function assertOwner(owner: DecisionOwner): void {
  for (const key of ['app', 'tenant'] as const) {
    const value = owner?.[key];
    if (typeof value !== 'string' || bytes(value) > DECISION_LIMITS[key] || (key === 'app' && !value))
      throw new Refusal(`The decision store refuses an owner without a valid ${key}.`);
  }
}
const num = (value: unknown): number => (typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0);
const json = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(value);
  if (bytes(text) > DECISION_LIMITS.answer) throw new Refusal('The decision store refuses an answer past its bound.');
  return text;
};
const parsed = (value: unknown): unknown => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const rowOf = (row: Row): StoredDecision => ({
  id: String(row.id),
  decision: String(row.decision),
  contractVersion: num(row.contract_version),
  resource: String(row.resource),
  recordKey: String(row.record_key),
  field: String(row.field),
  trigger: String(row.trigger),
  provider: String(row.provider),
  model: String(row.model),
  modelVersion: String(row.model_version),
  inputsDigest: String(row.inputs_digest),
  inputFields: (parsed(row.input_fields) as string[] | null) ?? [],
  choicesDigest: String(row.choices_digest),
  answer: parsed(row.answer),
  probability: row.probability === null || row.probability === undefined ? null : num(row.probability),
  outcome: String(row.outcome) as DecisionOutcome,
  outcomeReason: String(row.outcome_reason) as OutcomeReason,
  correctedTo: parsed(row.corrected_to),
  outcomeBy: String(row.outcome_by),
  outcomeAt: String(row.outcome_at),
  latencyMs: num(row.latency_ms),
  costMicros: num(row.cost_micros),
  units: num(row.units),
  createdAt: String(row.created_at),
});
const COLUMNS =
  'id, decision, contract_version, resource, record_key, field, trigger, provider, model, model_version, inputs_digest, input_fields, ' +
  'choices_digest, answer, probability, outcome, outcome_reason, corrected_to, outcome_by, outcome_at, latency_ms, cost_micros, units, created_at';

/* The moves a decision may make after it is answered: what a later word may say of what it was. */
const MOVES: Readonly<Record<DecisionSettled['outcome'], readonly DecisionOutcome[]>> = {
  accepted: ['suggested'],
  corrected: ['suggested', 'applied'],
  ignored: ['suggested'],
  applied: ['suggested'],
};

/** The store's rules over one engine's transaction; `t` names a reserved table as the engine qualifies it. */
export function createDecisionStore(transaction: Transaction, t: (name: string) => string, close: () => Promise<void>): DecisionStore {
  const { record, usage } = DECISION_TABLES;
  const switches = TENANT_SWITCH_TABLES.tenant;
  const one = async (db: Db, owner: DecisionOwner, id: string) => {
    const rows = await db.all(`SELECT ${COLUMNS} FROM ${t(record)} WHERE id = ? AND app = ? AND tenant = ?`, id, owner.app, owner.tenant);
    return rows.length ? rowOf(rows[0]) : null;
  };
  return {
    async begin(owner, start) {
      assertOwner(owner);
      return transaction(async (db) => {
        const found = await one(db, owner, start.id);
        if (found) return { row: found, fresh: false };
        await db.run(
          `INSERT INTO ${t(record)} (id, app, tenant, decision, contract_version, resource, record_key, field, trigger, provider, model,
            model_version, inputs_digest, input_fields, choices_digest, answer, probability, outcome, outcome_reason, corrected_to,
            outcome_by, outcome_at, latency_ms, cost_micros, units, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', ?, '', NULL, NULL, 'none', 'pending', NULL, '', '', 0, 0, 0, ?)`,
          start.id,
          owner.app,
          owner.tenant,
          start.decision,
          start.contractVersion,
          start.resource,
          start.recordKey,
          start.field,
          start.trigger,
          JSON.stringify(start.inputFields),
          start.createdAt,
        );
        return { row: (await one(db, owner, start.id))!, fresh: true };
      });
    },
    async answer(owner, id, answered) {
      assertOwner(owner);
      if (!(OUTCOMES as readonly string[]).includes(answered.outcome)) throw new Refusal('The decision store refuses an unknown outcome.');
      return transaction(
        async (db) =>
          (await db.run(
            `UPDATE ${t(record)} SET provider = ?, model = ?, model_version = ?, inputs_digest = ?, choices_digest = ?, answer = ?,
              probability = ?, outcome = ?, outcome_reason = ?, latency_ms = ?, cost_micros = ?, units = ?, outcome_at = ?
            WHERE id = ? AND app = ? AND tenant = ? AND outcome = 'none' AND outcome_reason = 'pending'`,
            answered.provider,
            answered.model,
            answered.modelVersion,
            answered.inputsDigest,
            answered.choicesDigest,
            json(answered.answer),
            answered.probability,
            answered.outcome,
            answered.outcomeReason,
            Math.max(0, Math.round(answered.latencyMs)),
            Math.max(0, Math.round(answered.costMicros)),
            Math.max(0, Math.round(answered.units)),
            answered.at,
            id,
            owner.app,
            owner.tenant,
          )) === 1,
      );
    },
    async settle(owner, id, settled) {
      assertOwner(owner);
      const from = MOVES[settled.outcome];
      if (!from) throw new Refusal('The decision store refuses an unknown outcome.');
      return transaction(
        async (db) =>
          (await db.run(
            `UPDATE ${t(record)} SET outcome = ?, outcome_reason = ?, corrected_to = ?, outcome_by = ?, outcome_at = ?
            WHERE id = ? AND app = ? AND tenant = ? AND outcome IN (${from.map(() => '?').join(', ')})`,
            settled.outcome,
            settled.reason,
            json(settled.correctedTo),
            settled.by.slice(0, 1024),
            settled.at,
            id,
            owner.app,
            owner.tenant,
            ...from,
          )) === 1,
      );
    },
    async get(owner, id) {
      assertOwner(owner);
      if (typeof id !== 'string' || id.length > 128) return null;
      return transaction((db) => one(db, owner, id));
    },
    async ofRecord(owner, resource, recordKey, limit) {
      assertOwner(owner);
      const rows = await transaction((db) =>
        db.all(
          `SELECT ${COLUMNS} FROM ${t(record)} WHERE app = ? AND tenant = ? AND resource = ? AND record_key = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
          owner.app,
          owner.tenant,
          resource,
          recordKey,
          Math.max(1, Math.min(200, Math.trunc(limit))),
        ),
      );
      return rows.map(rowOf);
    },
    async waiting(owner, resource, recordKeys) {
      assertOwner(owner);
      const keys = [...new Set(recordKeys)].slice(0, 500);
      if (!keys.length) return [];
      const rows = await transaction((db) =>
        db.all(
          `SELECT ${COLUMNS} FROM ${t(record)} WHERE app = ? AND tenant = ? AND resource = ? AND outcome = 'suggested'
            AND record_key IN (${keys.map(() => '?').join(', ')})
          ORDER BY created_at DESC, id DESC`,
          owner.app,
          owner.tenant,
          resource,
          ...keys,
        ),
      );
      // The newest suggestion of each decision on each record: an older one is what the newer was asked again.
      const seen = new Set<string>();
      return rows.map(rowOf).filter((row) => {
        const mark = `${row.recordKey}\0${row.decision}`;
        if (seen.has(mark)) return false;
        seen.add(mark);
        return true;
      });
    },
    async spend(owner, day, units, costMicros) {
      assertOwner(owner);
      // One statement, so two calls finishing together both count.
      await transaction((db) =>
        db.run(
          `INSERT INTO ${t(usage)} (app, tenant, day, calls, units, cost_micros) VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT (app, tenant, day) DO UPDATE SET calls = ${t(usage)}.calls + 1, units = ${t(usage)}.units + excluded.units,
            cost_micros = ${t(usage)}.cost_micros + excluded.cost_micros`,
          owner.app,
          owner.tenant,
          day,
          Math.max(0, Math.round(units)),
          Math.max(0, Math.round(costMicros)),
        ),
      );
    },
    async calls(owner, day) {
      assertOwner(owner);
      const rows = await transaction((db) => db.all(`SELECT tenant, calls FROM ${t(usage)} WHERE app = ? AND day = ?`, owner.app, day));
      let tenant = 0,
        app = 0;
      for (const row of rows) {
        app += num(row.calls);
        if (row.tenant === owner.tenant) tenant += num(row.calls);
      }
      return { tenant, app };
    },
    async usage(app, tenant, from) {
      assertOwner({ app, tenant: tenant ?? '' });
      const rows = await transaction((db) =>
        tenant === undefined
          ? db.all(
              `SELECT tenant, day, calls, units, cost_micros FROM ${t(usage)} WHERE app = ? AND day >= ? ORDER BY day, tenant`,
              app,
              from,
            )
          : db.all(
              `SELECT tenant, day, calls, units, cost_micros FROM ${t(usage)} WHERE app = ? AND tenant = ? AND day >= ? ORDER BY day`,
              app,
              tenant,
              from,
            ),
      );
      return rows.map((row) => ({
        tenant: String(row.tenant),
        day: String(row.day),
        calls: num(row.calls),
        units: num(row.units),
        costMicros: num(row.cost_micros),
      }));
    },
    async switches(app, tenant) {
      assertOwner({ app, tenant });
      const rows = await transaction((db) =>
        db.all(
          `SELECT feature, enabled, consent, changed_at FROM ${t(switches)} WHERE app = ? AND tenant = ? AND feature LIKE ? ORDER BY feature`,
          app,
          tenant,
          DECIDE_FEATURES,
        ),
      );
      return rows.map((row) => ({
        provider: providerOf(String(row.feature)),
        enabled: num(row.enabled) === 1,
        consent: String(row.consent),
        changedAt: String(row.changed_at),
      }));
    },
    async setSwitch(app, tenant, provider, enabled, consent, at) {
      assertOwner({ app, tenant });
      if (!tenant || !/^[a-z]{1,32}$/.test(provider) || bytes(consent) > DECISION_LIMITS.consent)
        throw new Refusal('The decision store refuses a switch past its bounds.');
      await transaction((db) =>
        db.run(
          `INSERT INTO ${t(switches)} (app, tenant, feature, enabled, consent, changed_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (app, tenant, feature) DO UPDATE SET enabled = excluded.enabled, consent = excluded.consent,
            changed_at = excluded.changed_at`,
          app,
          tenant,
          decideFeature(provider),
          enabled ? 1 : 0,
          consent,
          at,
        ),
      );
    },
    async forgetTenant(app, tenant) {
      assertOwner({ app, tenant });
      if (!tenant) return 0;
      return transaction(async (db) => {
        const removed = await db.run(`DELETE FROM ${t(record)} WHERE app = ? AND tenant = ?`, app, tenant);
        await db.run(`DELETE FROM ${t(switches)} WHERE app = ? AND tenant = ? AND feature LIKE ?`, app, tenant, DECIDE_FEATURES);
        return removed;
      });
    },
    async purge(app, before, staleBefore, at) {
      assertOwner({ app, tenant: '' });
      return transaction(async (db) => {
        const expired = await db.run(
          `UPDATE ${t(record)} SET outcome = 'ignored', outcome_reason = 'expired', outcome_by = 'service:mistri', outcome_at = ?
          WHERE app = ? AND outcome = 'suggested' AND created_at < ?`,
          at,
          app,
          staleBefore,
        );
        const removed = await db.run(`DELETE FROM ${t(record)} WHERE app = ? AND created_at < ?`, app, before);
        return { removed, expired };
      });
    },
    close,
  };
}
