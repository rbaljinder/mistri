/**
 * `@mistriwork/engine/host`: what the database browser opens a database and
 * works with it through, as one entry point instead of the engine's own files.
 *
 * It holds exactly the names the browser's server modules take from the
 * engine for five things, and nothing it does not use:
 *
 * - connect: a connection string becomes an adapter (`connect`), or a set of
 *   configured connections a `Registry` opens on demand, with the config file
 *   and the secrets it names kept out of what is said;
 * - schema: the catalog the adapter reads, and the helpers that walk it;
 * - reads: a query-language read, a saved view, a count and a breakdown, with
 *   the parser and the explainer an agent is shown;
 * - writes: the recorded insert, update and delete the browser's write mode
 *   and its agent tools make, what a delete would reach, why a write failed,
 *   the write journal behind Undo and revert, and its store's provisioning;
 * - the agent tools' support: cancellation and the statement deadline, the
 *   schema in words, and the nearest name to a wrong one.
 *
 * Preview, as the rest of the engine is: it is promoted once the browser has
 * moved onto it, and a name is added here when the browser needs it, not
 * because it is exported below. The serving, the CLI and the HTTP plumbing
 * stay on the engine's deeper paths. test/engine-host-contract.test.ts
 * imports this entry alone and does with it what the browser does.
 */

/* ---------- connect ---------- */
export { connect } from './adapters/connect.js';
export { UNTRUSTED_NETWORK } from './adapters/net/untrustedDatabase.js';
export { Registry, redact, saveConfig, scrubSecrets, storeSecret } from './server/connections.js';
export { resolveConnection } from './server/auth/credentials.js';

/* ---------- the adapter ---------- */
export {
  Refusal,
  TransactionOutcomeUnknown,
  clampLimit,
  type Adapter,
  type Filter,
  type InsertResult,
  type UpdateRequest,
  type WriteTransaction,
} from './adapters/adapter.js';

/* ---------- schema ---------- */
export {
  findTable,
  labelPath,
  primaryKey,
  referencesFrom,
  referencesTo,
  renderDDL,
  tableNamed,
  type DatabaseSchema,
  type DeleteRule,
  type ForeignKey,
  type TableMeta,
} from './shared/schema.js';
export { toMarkdown } from './shared/schematext.js';
export { describeSchema } from './shared/shape.js';

/* ---------- reads ---------- */
export { readBreakdown, readCount, readRecords, readView } from './server/resourceReadOperations.js';
export { explain, parseQuery, quoteValue } from './shared/query.js';
export { textToView } from './shared/viewtext.js';
export { looksLikeBreakdown, textToBreakdown } from './shared/breakdowntext.js';
export type { ViewDef } from './shared/view.js';

/* ---------- writes and the write journal ---------- */
export { changingReferences, recordedDelete, recordedInsert, recordedUpdate } from './server/recordWriteOperations.js';
export { deleteImpact, inBatches } from './server/impact.js';
export { explainWriteFailure, writeFailureOutcome } from './server/constraints.js';
export { attributeAction, attributeWrites } from './adapters/writeAttribution.js';
export { history, lastRevertible, latestRevertible, recordWrite, revert, summarise } from './server/journal.js';
export { provisionPostgresWriteJournal, provisionSqliteWriteJournal } from './server/journalStore.js';

/* ---------- the agent tools' support ---------- */
export { STATEMENT_TIMEOUT_MS, StatementStopped, stoppedReason, throwIfCancelled, withCancellation } from './adapters/statementControl.js';
export { distance } from './shared/suggest.js';
