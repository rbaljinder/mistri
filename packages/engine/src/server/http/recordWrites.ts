/**
 * The record writes both products serve: update, insert (a file's upload
 * among them) and delete. Every one asks the product's write gate first
 * (`gates.write`: the connection's `writable` flag, then the reader's
 * grant), and every committed write goes through the one recorder that
 * anchors it to the source it touched, then to the product's `after.write`.
 *
 * What an App adds is `RecordRules`: the words its refusals are said in, the
 * label its history gives an edit, what it does not delete, a New form's
 * file, tags and lines, and replies that say no more than an App reader is
 * told. Without them a write is the database browser's: journaled for its
 * Undo, and refused in the database's own words.
 */
import type { ServerResponse } from 'node:http';
import { Refusal, TransactionOutcomeUnknown, WriteConflict, type InsertRequest, type InsertResult } from '../../adapters/adapter.js';
import { attributeAction } from '../../adapters/writeAttribution.js';
import { isPoolBusy } from '../../adapters/poolMetrics.js';
import { lockTimedOut } from '../../adapters/writeLanes.js';
import { deletionDependents, recordedDelete, recordedInsert, recordedUpdate, type LineCollection } from '../recordWriteOperations.js';
import { AppAccessDenied } from '../columnGrants.js';
import { deleteImpact } from '../impact.js';
import { explainWriteFailure, writeFailureOutcome, writeRefusalStatus } from '../constraints.js';
import { findTable } from '../../shared/schema.js';
import { FILE_UPLOAD_PATH, bytesLabelled, send, sendBusy, sendResource, sendRowLocked } from './reply.js';
import type { PostContext } from './context.js';

type Values = Record<string, string | number | boolean | null>;

/** What a write that failed says, in its errors list: a message, and in an App its code and safe fields. */
type WriteFailure = NonNullable<Parameters<typeof sendResource<'/api/insert'>>[3]['errors']>[number];

/** A file placed before its row is written, discarded when the row is not (files/fileStorage.ts). */
interface PlacedValues {
  readonly values: Values;
  discard(): Promise<void>;
}

/** What a New form sends beside its record, judged: the link rows its tags are, and its lines. */
interface Alongside {
  readonly alongside?: (result: InsertResult) => InsertRequest[];
  readonly lines?: LineCollection[];
}

/** An answer a rule gave instead of going on. */
interface Answered {
  readonly status: number;
  readonly error: string;
}

/**
 * An App's rules for its record writes (mistri: http/appRecordWrites.ts).
 * Absent, the database browser's: a write is journaled, the upload, tags and
 * lines of a New form are refused as no App declares them, and a failure is
 * said in the database's own words.
 */
export interface RecordRules {
  /** What the record history calls an edit (recordHistory.ts updateActionLabel). */
  label(post: PostContext, table: string, values: Values): string | undefined;
  /** Whether the App deletes rows of `tableId` at all (appDeletable). */
  deletes(post: PostContext, tableId: string): boolean;
  /** An upload's columns, placed where its resource keeps its bytes. */
  upload(post: PostContext, tableId: string | undefined): Promise<PlacedValues | Answered>;
  /** A New form's tags and lines, judged against what the App declares. */
  alongside(post: PostContext, tableId: string | undefined): Answered | Alongside;
  /** The App's own rules refusing the record (its validation, a line's `consumes`): answered in the App's shape. True when answered. */
  refused(res: ServerResponse, path: '/api/insert' | '/api/update', error: unknown): boolean;
  /** A write that failed, said by code and never in a driver's words (appErrors.ts). */
  failure(post: PostContext, error: unknown, completed: boolean): WriteFailure;
  /** A delete's impact report, when a count fails. */
  impact(error: unknown): string;
  /** A reply cut to what an App reader is told (appResponses.ts). */
  reply(body: Record<string, unknown>, kind: 'read' | 'write'): Record<string, unknown>;
}

/** What a product decides about the record writes. */
export interface RecordHooks {
  readonly gates: {
    /** Why a write to `tableId` is refused, or null. An update may reach a table a role runs fixed actions on. */
    write(post: PostContext, tableId: string | undefined, update?: boolean): string | null;
  };
  readonly after?: {
    /** A committed write's record: its search document follows it, queued and never awaited. */
    write(post: PostContext, table: string, key: Record<string, unknown>): void;
  };
  readonly rules?: RecordRules;
}

/* A failed insert or update's status. The database refusing it for good — a key taken, a reference to nothing, a
   value its column cannot hold — is 409 or 422 (constraints.ts writeRefusalStatus); it was a 200 whose body alone
   said `rejected`, and a client that read the status took a refused write for a saved one (a live load test). One
   that may have landed, or that nothing recognizes as refused, keeps the 200 and its `unknown` outcome. */
const refusedStatus = (err: unknown, completed: boolean): number => (completed ? 200 : (writeRefusalStatus(err) ?? 200));

/**
 * What every write on this request shares: the options the recorded
 * operations take — the source's own adapter, and whether the write is
 * journaled. The database browser journals every write, for its Undo; an App
 * has no Undo and journals none (recordWriteOperations.ts `unrecorded`). The
 * import route (importRoutes.ts) writes through the same.
 */
export function recordedWrites(post: Pick<PostContext, 'adapter' | 'connection' | 'who' | 'resources'>, journal: boolean) {
  const { adapter, connection, who, resources } = post;
  // resources has already been authorized. Anchor the write to the exact
  // source without reopening an unguarded registry adapter or using its default.
  const writeOptions = (table: string) => {
    const owner = resources?.connectionFor(table) ?? connection;
    return { adapter: resources?.forConnection(owner) ?? adapter, connection: owner, by: who, journal };
  };
  return { writeOptions };
}

export async function recordWriteRoutes(post: PostContext, hooks: RecordHooks): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, access, wholeRowWrites } = post;
  const rules = hooks.rules;
  const { writeOptions } = recordedWrites(post, !rules);
  const indexed = (table: string, key: Record<string, unknown>) => hooks.after?.write(post, table, key);
  /* A record's lines are records of their own, and what follows a write follows them too. */
  const linesIndexed = (lines: readonly LineCollection[] | undefined) => {
    for (const line of lines ?? []) for (const key of line.written ?? []) indexed(line.table, key);
  };
  /* A file's object and hash are written for the reader and never shown to it (appAccess.ts withFileColumns). */
  const internal = access?.internal?.get(String(body.table ?? ''));
  const shown = (record: unknown) =>
    internal && record && typeof record === 'object' && !Array.isArray(record)
      ? Object.fromEntries(Object.entries(record).filter(([column]) => !internal.has(column)))
      : record;
  const sendData = (value: Record<string, unknown>) => {
    const reply: Record<string, unknown> = { ...value };
    for (const field of ['applied', 'row', 'before']) if (field in reply) reply[field] = bytesLabelled(shown(reply[field]));
    send(res, 200, rules ? rules.reply(reply, 'write') : reply);
  };
  const failureOf = async (err: unknown, completed: boolean, values: Values) =>
    rules
      ? rules.failure(post, err, completed)
      : { message: await explainWriteFailure(adapter, schema, String(body.table ?? ''), values, (err as Error).message) };

  /**
   * Update one record through the shared transaction and history service.
   *
   * Note what is *not* checked here: whether the client thinks it is in write
   * mode. That toggle is a UI affordance, and a guard that lives in the
   * browser is not a guard. The adapter independently verifies the key is the
   * whole primary key, counts the matching rows, and refuses anything other
   * than exactly one.
   */
  if (path === '/api/update') {
    /* The gate the server can actually enforce.

       Write mode in the browser is a deliberate act before typing, and it is
       not a permission — the client decides whether to *offer* editing, and a
       guard in the browser is not a guard. Until a connection says it is
       writable, anything that could reach this endpoint could write to it —
       and an app may narrow that to the tables it names. */
    const refused = hooks.gates.write(post, findTable(schema, String(body.table ?? ''))?.id, true);
    if (refused) {
      send(res, 403, { error: refused, code: 'forbidden' });
      return true;
    }
    if (!adapter.update) {
      send(res, 501, { error: `${schema.dialect} connections are read-only in this build.` });
      return true;
    }
    /* `values` is the real shape; `column`/`value` is accepted as the
       one-field form so a single edit does not have to build an object. */
    const values = (body.values ?? (body.column ? { [String(body.column)]: body.value ?? null } : {})) as Values;
    let completed = false;
    try {
      const table = String(body.table ?? '');
      const key = (body.key ?? {}) as Record<string, string | number>;
      const expected = body.expected as Values | undefined;
      const { result, undoId } = await attributeAction(rules?.label(post, table, values), () =>
        recordedUpdate(writeOptions(table), { table, key, values, ...(expected === undefined ? {} : { expected }) }),
      );
      completed = true;
      indexed(table, key);
      sendData({ ...result, ...(undoId === undefined ? {} : { undoId }) });
      return true;
    } catch (err) {
      if (!completed && lockTimedOut(err)) {
        sendRowLocked(res);
        return true;
      }
      if (!completed && isPoolBusy(err)) {
        sendBusy(res, {}, true, err);
        return true;
      }
      if (!completed && rules?.refused(res, path, err)) return true;
      if (!completed && (err instanceof Refusal || err instanceof WriteConflict)) throw err;
      /* Pointing an existing row at a row that is not there is the same
         mistake as inserting one, and gets the same answer. */
      const failure = await failureOf(err, completed, values);
      sendResource(res, path, refusedStatus(err, completed), {
        errors: [failure],
        outcome: completed ? 'unknown' : writeFailureOutcome(err),
      });
      return true;
    }
  }

  /**
   * Add a row. The same gate as /api/update, because it is the same act one
   * tense earlier. Refusals — a column that does not exist, null into NOT
   * NULL — are 400s the adapter words; a constraint the *database* enforces
   * comes back with its own message in the `rejected` envelope, because a
   * UNIQUE violation is the user's to fix and the engine names the constraint
   * better than a paraphrase would — at 409 or 422 (refusedStatus), never a
   * 2xx a client reading only the status would take for a save. The outcome
   * distinguishes recognized constraint rejections from unconfirmed failures
   * that must not invite a blind retry.
   */
  if (path === '/api/insert' || path === FILE_UPLOAD_PATH) {
    const tableId = findTable(schema, String(body.table ?? ''))?.id;
    const refused = hooks.gates.write(post, tableId);
    if (refused) {
      send(res, 403, { error: refused, code: 'forbidden' });
      return true;
    }
    if (!adapter.insert) {
      send(res, 501, { error: `${schema.dialect} connections are read-only in this build.` });
      return true;
    }
    let values: Values;
    let placed: PlacedValues | undefined;
    if (path === FILE_UPLOAD_PATH) {
      /* A file is a row like any other: one insert on this path, with the
         grants, validation and history an insert gets, and the upload's bytes,
         name, type and size in the columns the resource's `file` names. */
      const upload = rules ? await rules.upload(post, tableId) : { status: 404, error: 'This resource does not hold files.' };
      if ('error' in upload) {
        send(res, upload.status, { error: upload.error });
        return true;
      }
      placed = upload;
      values = placed.values;
    } else {
      if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
        send(res, 400, { error: 'Insert values must be an object. Use {} explicitly to insert database defaults.' });
        return true;
      }
      values = body.values as Values;
    }
    /* A record's tags and its lines, sent with it from a New form: each written
       in the record's transaction, so the record never stands without them. */
    let alongside: Alongside = {};
    if (path === '/api/insert' && (body.tags !== undefined || body.lines !== undefined)) {
      const judged: Answered | Alongside = rules
        ? rules.alongside(post, tableId)
        : body.tags !== undefined
          ? { status: 400, error: 'This resource carries no tags.' }
          : { status: 400, error: 'Lines are saved with a record of an App that declares them.' };
      if ('error' in judged) {
        send(res, judged.status, { error: judged.error });
        return true;
      }
      alongside = judged;
    }
    let completed = false;
    try {
      const table = String(body.table ?? '');
      const { result, undoId } = await recordedInsert(writeOptions(table), { table, values }, alongside.alongside, alongside.lines);
      completed = true;
      indexed(table, result.key);
      linesIndexed(alongside.lines);
      sendData({ ...result, ...(undoId === undefined ? {} : { undoId }) });
      return true;
    } catch (err) {
      // A row that was not written leaves no object behind; one that may have been keeps it for the sweep to judge.
      if (placed && !completed && !(err instanceof TransactionOutcomeUnknown)) await placed.discard();
      if (!completed && lockTimedOut(err)) {
        sendRowLocked(res);
        return true;
      }
      if (!completed && isPoolBusy(err)) {
        sendBusy(res, {}, true, err);
        return true;
      }
      if (!completed && rules?.refused(res, '/api/insert', err)) return true;
      if (!completed && err instanceof Refusal) throw err;
      /* "FOREIGN KEY constraint failed" names nothing on SQLite. The graph
         is right here, and one lookup on the failure path turns it into the
         column, the value and the row that is missing. */
      const failure = await failureOf(err, completed, values);
      sendResource(res, '/api/insert', refusedStatus(err, completed), {
        errors: [failure],
        outcome: completed ? 'unknown' : writeFailureOutcome(err),
      });
      return true;
    }
  }

  /**
   * Remove a row, having first said what removing it would do.
   *
   * This is the endpoint tablewalk can do better than most clients, and the
   * reason is structural rather than clever: it already counts what points at a
   * row, so it can answer "what breaks" *before* the delete rather than
   * reporting a constraint violation afterwards.
   *
   * The count alone is not the answer. Three rows pointing at this one means
   * three rows deleted under `cascade`, three rows left with a hole under `set
   * null`, and a refused delete under `restrict` — three different outcomes
   * behind one number. So the impact report carries the rule beside the count,
   * and a rule the adapter could not determine is reported as unknown rather
   * than assumed harmless.
   *
   * Two calls, deliberately. Without `confirm` this only reports; with it, it
   * deletes. A destructive endpoint that also happens to be the way you ask
   * about the damage is one typo away from doing it.
   */
  if (path === '/api/delete') {
    if (!adapter.remove) {
      send(res, 501, { error: `${schema.dialect} connections cannot delete in this build.` });
      return true;
    }
    const refused = hooks.gates.write(post, findTable(schema, String(body.table ?? ''))?.id);
    if (refused) {
      send(res, 403, { error: refused, code: 'forbidden' });
      return true;
    }
    if (rules && !rules.deletes(post, findTable(schema, String(body.table ?? ''))?.id ?? '')) {
      send(res, 403, { error: 'This app does not delete these records.' });
      return true;
    }

    const tableId = String(body.table ?? '');
    const key = (body.key ?? {}) as Record<string, string | number>;
    const table = findTable(schema, tableId);
    if (!table) {
      send(res, 404, { error: `Unknown table "${tableId}"` });
      return true;
    }
    if (wholeRowWrites && !wholeRowWrites.has(tableId)) throw new AppAccessDenied();

    const impact = await deleteImpact(adapter, schema, tableId, key, rules ? (error) => rules.impact(error) : undefined);

    if (body.confirm !== true) {
      sendResource(res, path, 200, { impact, deleted: false });
      return true;
    }

    /* `restrict` and `no action` are left to the database rather than refused
       here. The engine enforces them and its message names the constraint;
       a second implementation of the same rule is how the two come to
       disagree, and tablewalk would be the one that was wrong. */
    let completed = false;
    try {
      const options = writeOptions(tableId);
      /* What the deletion may change, for the journal's Undo, is read off
         the database's own catalog. An App journals nothing. */
      const dependents = options.journal
        ? deletionDependents((await registry.open(options.connection)).schema, tableId, (table) => table)
        : undefined;
      const { result, undoId } = await recordedDelete(options, { table: tableId, key }, dependents);
      completed = true;
      indexed(tableId, key);
      sendData({ impact, deleted: true, ...result, ...(undoId === undefined ? {} : { undoId }) });
      return true;
    } catch (err) {
      if (!completed && lockTimedOut(err)) {
        sendRowLocked(res, { impact, deleted: false });
        return true;
      }
      if (!completed && isPoolBusy(err)) {
        sendBusy(res, { impact, deleted: false }, true, err);
        return true;
      }
      const outcome = completed ? 'unknown' : err instanceof Refusal ? 'rejected' : writeFailureOutcome(err);
      const errors = [rules ? rules.failure(post, err, completed) : { message: (err as Error).message }];
      sendResource(
        res,
        path,
        outcome === 'unknown' ? 200 : (writeRefusalStatus(err) ?? 400),
        outcome === 'unknown' ? { impact, deleted: null, outcome, errors } : { impact, deleted: false, outcome, errors },
      );
      return true;
    }
  }

  return false;
}
