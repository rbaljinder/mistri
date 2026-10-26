/**
 * The command journal on PostgreSQL.
 *
 * Same logical schema as the SQLite journal, in the runtime schema
 * (`mistri`) without the `__mistri_` prefix the SQLite file needs: a grant
 * on `public` then reaches none of it (shared/runtimeTables.ts). The event
 * tables' foreign key to the receipt table names it qualified, and the
 * catalog description reads it back unqualified (postgresRelations.ts), so
 * the pinned layouts do not depend on a search_path.
 *
 * What is different, and why:
 *
 * - Attestation compares a catalog *description* — columns with their types,
 *   collations and defaults, every constraint and index definition, and the
 *   absence of triggers, rules and policies — against the one the migration
 *   produces. SQLite compares stored CREATE text; Postgres does not keep it.
 * - Serialisation of duplicate deliveries is a transaction-level advisory
 *   lock on the receipt scope, taken in `find` and `commit`. SQLite got this
 *   free from `BEGIN IMMEDIATE`, which serialises every writer in the file.
 *   Postgres writers on different rows must not wait on each other, so the
 *   lock is per scope: two connections executing the same command for the
 *   same actor and key queue behind each other, and the second sees the
 *   first's receipt when its turn comes. The unique constraint stays as the
 *   backstop for a caller that commits without finding.
 * - Identity columns are `COLLATE "C"` so equality and the unique constraint
 *   are byte-exact whatever the database's default collation is, which is
 *   what `COLLATE BINARY` says on SQLite.
 */
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { Refusal, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { beforeCommit } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import { commandJournalValidation as rules } from './commandJournal.js';
import {
  assertPostgresCommandJournal,
  definitions,
  describePostgresRelations,
  JOURNAL_VERSION,
  COMPLETED_AT,
  PREFIX,
  q,
  tables,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from './postgresCommandJournalSchema.js';
import { CommandJournalUnavailable } from './commandJournalSchema.js';
export {
  assertPostgresCommandJournal,
  describePostgresRelations,
  JOURNAL_VERSION,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
};
import type {
  CommandAudit,
  CommandJournal,
  CommandJournalAppScope,
  CommandJournalPlatform,
  CommandJournalTenant,
  CommandReceiptScope,
  StoredCommandReceipt,
} from './commandJournalTypes.js';
import type { CommandEventBatch, CommandEventManifest } from '../events/commandEventTypes.js';
import { captureCommandEventManifest } from '../events/commandEventCapture.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  assertPostgresCommandEventStore,
  assertPostgresCommandEvents,
  postgresCommandEventRows,
} from '../events/postgresCommandEventStore.js';
import { commandEventsAppended } from '../events/commandEventSignal.js';
import { nextPostgresCommandNumber, provisionPostgresCommandSequences } from './postgresCommandSequences.js';

/** Explicit maintenance operation. Never called implicitly when opening an App.
 * No journal gets version 1; any other layout is refused, not altered. */
export async function migratePostgresCommandJournal(url: string): Promise<{ version: 1; migrated: boolean }> {
  return withPostgresMaintenanceTransaction(url, async (client) => {
    const described = await describePostgresRelations(client, PREFIX);
    let result: { version: 1; migrated: boolean } = { version: 1, migrated: false };
    if (!described.length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(tables.meta)} (singleton, version) VALUES (1, $1)`, [JOURNAL_VERSION]);
      result = { version: 1, migrated: true };
    }
    await assertPostgresCommandJournal(client);
    // The sequences a handler numbers from live beside the journal.
    if (await provisionPostgresCommandSequences(client)) result = { version: 1, migrated: true };
    return result;
  });
}

/* ---------- the journal ---------- */

const invalid = (): never => {
  throw new Refusal('Invalid structured operation.');
};
// An `asserts` signature cannot be called through a property; the plain type is enough here.
const validText: (value: unknown, field: string, max: number) => void = rules.text;

/* A savepoint is the one statement that only works inside a transaction
   block. The advisory lock below is transaction-scoped: outside a block it
   would release at the end of its own statement and serialise nothing.
   Both go in one message, one round trip where they took two (it runs four
   times a write): outside a block, the message is an implicit transaction,
   and PostgreSQL refuses a savepoint there just the same. */
const IN_TRANSACTION = 'SAVEPOINT mistri_journal; RELEASE SAVEPOINT mistri_journal';
const SCOPE_LOCK = 'SELECT pg_advisory_xact_lock($1::bigint)';
const FIND_RECEIPT = `SELECT ${rules.receiptRowColumns(COMPLETED_AT)} FROM ${q(tables.receipt)}
        WHERE app_id = $1 AND store_id = $2 AND source_id = $3 AND realm = $4 AND tenant_id = $5
          AND actor_id = $6 AND command_id = $7 AND command_version = $8 AND idempotency_key = $9`;

type JournalOwner = CommandJournalTenant | CommandJournalPlatform | CommandJournalAppScope;

/** A receipt scope's uniqueness columns under `owner`: refused (thrown) for a scope of another App or actor. */
function receiptValues(owner: JournalOwner | undefined) {
  const { tenant: bound, platform, app: appScope } = rules.owner(owner);
  const member = bound ?? platform;
  const namespace = rules.namespaceOf(bound, platform);
  return (scope: CommandReceiptScope) => {
    rules.record(scope, rules.receiptFields); // StoredCommandReceipt is a supported structural subtype.
    const [app, actor, command, version, key] = rules.scopeValues(scope);
    if ((member && (app !== member.appId || actor !== member.actorId)) || (appScope && app !== appScope.appId)) return invalid();
    return [app, ...namespace, actor, command, version, key] as const;
  };
}

/**
 * What the journal's lookup of `scope` sends before it reads an answer: the
 * transaction probe, the scope lock and the receipt read, exactly as `find`
 * sends them, so they can leave behind the transaction's
 * BEGIN (writeAhead.ts). Nothing for a scope it would refuse.
 */
export function postgresCommandLookupAhead(owner: JournalOwner | undefined, scope: unknown) {
  try {
    const values = receiptValues(owner)(scope as CommandReceiptScope);
    return [IN_TRANSACTION, { text: SCOPE_LOCK, values: [scopeLock(values)] }, { text: FIND_RECEIPT, values: [...values] }];
  } catch {
    return [];
  }
}

/** The scope's advisory-lock key: the first eight bytes of a digest over the
 * exact uniqueness columns, as a signed bigint the way Postgres wants it. */
function scopeLock(values: readonly (string | number)[]): string {
  return createHash('sha256').update(canonicalCommandJson(values)).digest().readBigInt64BE(0).toString();
}

type ReceiptRecovery = Readonly<{ receipt: StoredCommandReceipt; targets: readonly Readonly<{ target: string; keyJson: string }>[] }>;
const ordinaryRecovery = new WeakMap<
  CommandJournal,
  (scope: CommandReceiptScope, expectedManifest?: CommandEventManifest) => Promise<ReceiptRecovery | undefined>
>();

/** Private storage projection, not authorization or typed command-key validation.
 * The genuine journal retains its transaction queue and exact scope lock. */
export const isOrdinaryPostgresCommandJournal = (journal: CommandJournal): boolean => ordinaryRecovery.has(journal);

export function recoverPostgresCommandReceipt(
  journal: CommandJournal,
  scope: CommandReceiptScope,
  expectedManifest?: CommandEventManifest,
): Promise<ReceiptRecovery | undefined> {
  const recover = ordinaryRecovery.get(journal);
  if (!recover) return Promise.reject(new CommandJournalUnavailable());
  return recover(scope, expectedManifest);
}

/**
 * The owner supplies an open transaction on the leased write client and the
 * operation queue its records share, exactly as the SQLite journal takes a
 * handle and its queue. A tenant binds the journal to a source owner and
 * enables event batches. Each operation proves the transaction block before
 * it starts; the event store is attested when the adapter first uses it
 * (assertPostgresCommandEventStore), not around every operation.
 */
export function createPostgresCommandJournal(client: PgQuery, operations: TransactionOperations, owner?: JournalOwner): CommandJournal {
  if (!client || typeof client.query !== 'function' || isProxy(client)) return invalid();
  const { tenant: bound, platform, app: appScope } = rules.owner(owner);
  // The platform realm has no event source: its commands declare no events.
  const source = bound ?? appScope,
    member = bound ?? platform;
  const namespace = rules.namespaceOf(bound, platform);
  const values = receiptValues(owner);
  const inTransaction = async () => {
    try {
      await client.query(IN_TRANSACTION);
    } catch {
      throw new CommandJournalUnavailable();
    }
  };
  const verified = async (eventStoreRequired: boolean) => {
    if (eventStoreRequired && !source) throw new CommandJournalUnavailable();
    await inTransaction();
    if (source && eventStoreRequired) await assertPostgresCommandEventStore(client, rules.eventStoreOf(source));
  };
  const invoke = <A, R>(input: A, work: (captured: A) => Promise<R>, eventStoreRequired = false): Promise<R> => {
    let captured: A;
    try {
      captured = rules.capture(input);
    } catch (error) {
      // Capture failures must join the shared queue: catching one cannot allow
      // earlier business writes to commit or later operations to keep running.
      return operations.run(async () => {
        throw error;
      });
    }
    return operations.run(async () => {
      await verified(eventStoreRequired);
      return work(captured);
    });
  };
  const lookup = async (scope: CommandReceiptScope, expectedManifest?: CommandEventManifest): Promise<ReceiptRecovery | undefined> => {
    const lookup = values(scope);
    // Prove event storage before establishing absence. A missing receipt in a
    // damaged/unprovisioned event store cannot authorize fresh execution.
    if (expectedManifest !== undefined) {
      if (!source) throw new CommandJournalUnavailable();
      expectedManifest = captureCommandEventManifest(expectedManifest);
      await assertPostgresCommandEventStore(client, rules.eventStoreOf(source));
    }
    // Held to commit or rollback. A duplicate on another connection waits
    // here, and its SELECT then runs on a snapshot that includes our receipt.
    await client.query(SCOPE_LOCK, [scopeLock(lookup)]);
    const result = await client.query(FIND_RECEIPT, [...lookup]);
    if (result.rows.length > 1) throw new CommandJournalUnavailable();
    const row = result.rows[0];
    if (!row) return undefined;
    // One row holds the receipt, its provenance and every target: one snapshot vouches for all of it.
    const { receipt, audit, targets } = rules.readReceiptRow(row, namespace, member);
    const events = rules.eventOwnerOf(bound, appScope, receipt.actorId);
    if (events) await assertPostgresCommandEvents(client, events, receipt, audit, expectedManifest);
    return Object.freeze({ receipt, targets });
  };
  const journal: CommandJournal = Object.freeze({
    find: (scope: CommandReceiptScope, expectedManifest?: CommandEventManifest) =>
      invoke(
        { scope, expectedManifest },
        async ({ scope, expectedManifest }) => (await lookup(scope, expectedManifest))?.receipt,
        expectedManifest !== undefined,
      ),
    commit: (receipt: StoredCommandReceipt, audit: CommandAudit | readonly CommandAudit[], eventBatch?: CommandEventBatch) => {
      /* The receipt row and its events, said as the statements that write them.
         Reentrant within the transaction: a commit after find takes the scope
         lock again for free; a commit without one still serialises, and then
         the unique constraint refuses the second receipt rather than the row
         overwriting. Every owner before the row: one refused owner writes
         nothing. */
      const written = (receipt: StoredCommandReceipt, audits: ReturnType<typeof rules.auditEntries>, eventBatch?: CommandEventBatch) => {
        rules.validateReceipt(receipt);
        const scope = values(receipt);
        const owners = audits.map((entry) => rules.auditOwner(entry, namespace[2], namespace[3]));
        const row = rules.receiptRow(receipt, scope, member, audits, owners);
        const events =
          eventBatch && postgresCommandEventRows(rules.eventOwnerOf(bound, appScope, receipt.actorId)!, receipt, audits[0], eventBatch);
        const columns = events ? `${rules.RECEIPT_COLUMNS}, manifest_json, event_count, digest, xact_id` : rules.RECEIPT_COLUMNS;
        const placeholders = row.map((_, at) => `$${at + 1}`);
        if (events) placeholders.push(...events.batch.map((_, at) => `$${row.length + at + 1}`), 'pg_current_xact_id()');
        return [
          { text: SCOPE_LOCK, values: [scopeLock(scope)] },
          {
            text: `INSERT INTO ${q(tables.receipt)} (${columns}) VALUES (${placeholders.join(', ')})`,
            values: events ? [...row, ...events.batch] : row,
          },
          ...(events?.statements ?? []),
        ];
      };
      let captured: { receipt: StoredCommandReceipt; audit: CommandAudit | readonly CommandAudit[]; eventBatch?: CommandEventBatch };
      try {
        captured = rules.capture({ receipt, audit, eventBatch });
      } catch (error) {
        return operations.run(async () => {
          throw error;
        });
      }
      return operations.run(async () => {
        const audits = rules.auditEntries(captured.audit, captured.eventBatch);
        if (captured.eventBatch !== undefined) {
          if (!source) throw new CommandJournalUnavailable();
          // Once per adapter and binding (attestOnce): on a warm writer this sends nothing.
          await assertPostgresCommandEventStore(client, rules.eventStoreOf(source));
        }
        const statements = written(captured.receipt, audits, captured.eventBatch);
        /* Nothing reads these answers: on a writer that pipelines they leave
           with the transaction's COMMIT, in its round trip (beforeCommit). Only a
           transaction handle pipelines, so no probe proves the block there. A
           refused one fails the COMMIT, and nothing commits. */
        if (!beforeCommit(client, statements)) {
          await inTransaction();
          for (const statement of statements) await client.query(statement.text, statement.values);
        }
        // Heard by this process's jobs host; a host in another hears the commit's notification.
        if (captured.eventBatch !== undefined) commandEventsAppended();
      });
    },
    // In the journal's namespace, so a tenant's sequences are its own.
    nextNumber: (appId: string, name: string, per: string, start: number) =>
      invoke({ appId, name, per, start }, async (input) => {
        validText(input.appId, 'application', 128);
        if ((member && input.appId !== member.appId) || (appScope && input.appId !== appScope.appId)) return invalid();
        return nextPostgresCommandNumber(client, { appId: input.appId, namespace, name: input.name, per: input.per }, input.start);
      }),
    /* No advisory lock and no savepoint probe (which proves a transaction
       block for the lock's sake): a new key is the common case, and a
       delivery of the same request still in flight is caught by the insert
       below, not here. */
    kept: (appId: string, commandId: string, commandVersion: number) => {
      if (typeof appId !== 'string' || typeof commandId !== 'string' || !Number.isSafeInteger(commandVersion) || commandVersion < 1) {
        return operations.run(async () => invalid());
      }
      return operations.run(
        async () =>
          (
            await client.query(
              `SELECT 1 FROM ${q(tables.receipt)}
        WHERE app_id = $1 AND command_id = $2 AND command_version = $3 LIMIT 1`,
              [appId, commandId, commandVersion],
            )
          ).rows.length > 0,
      );
    },
    taken: (scope: CommandReceiptScope) => {
      let captured: CommandReceiptScope;
      try {
        captured = rules.capture(scope);
      } catch (error) {
        return operations.run(async () => {
          throw error;
        });
      }
      return operations.run(
        async () =>
          (
            await client.query(
              `SELECT 1 FROM ${q(tables.receipt)}
        WHERE app_id = $1 AND store_id = $2 AND source_id = $3 AND realm = $4 AND tenant_id = $5
          AND actor_id = $6 AND command_id = $7 AND command_version = $8 AND idempotency_key = $9 LIMIT 1`,
              [...values(captured)],
            )
          ).rows.length > 0,
      );
    },
    /* One statement: the receipt unless its scope is taken, and every
       target's audit row beside it. A delivery of the same request still in
       flight holds the unique index entry, so this waits for it and then
       writes nothing — false, and the caller replays it. */
    insert: (receipt: StoredCommandReceipt, audit: CommandAudit | readonly CommandAudit[]) => {
      let captured: { receipt: StoredCommandReceipt; audit: CommandAudit | readonly CommandAudit[] };
      try {
        captured = rules.capture({ receipt, audit });
      } catch (error) {
        return operations.run(async () => {
          throw error;
        });
      }
      return operations.run(async () => {
        const { receipt, audit } = captured;
        rules.validateReceipt(receipt);
        const scope = values(receipt);
        const audits = rules.auditEntries(audit, undefined);
        const owners = audits.map((entry) => rules.auditOwner(entry, namespace[2], namespace[3]));
        const row = rules.receiptRow(receipt, scope, member, audits, owners);
        const written = await client.query(
          `INSERT INTO ${q(tables.receipt)} (${rules.RECEIPT_COLUMNS})
          VALUES (${row.map((_, at) => `$${at + 1}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING id`,
          row,
        );
        return Number(written.rowCount ?? 0) === 1;
      });
    },
  });
  if (!member)
    ordinaryRecovery.set(journal, (scope, expectedManifest) =>
      invoke(
        { scope, expectedManifest },
        async ({ scope, expectedManifest }) => lookup(scope, expectedManifest),
        expectedManifest !== undefined,
      ),
    );
  return journal;
}
