import {
  type Adapter,
  type QueryRequest,
  type QueryResult,
  type ScopedReads,
  type WriteTransaction,
  type InsertRequest,
  type UpdateRequest,
  type DeleteRequest,
} from '@mistriwork/engine/adapters/adapter.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import type { RuntimeResources } from './appRuntimeResources.js';
import { snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { runScopedTransactionFacade } from '../policy/scopedTransactionFacade.js';
import { assertScopeCatalog, captureScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
// Plain Workbench/MCP column grants need this facade, but App write rules only
// load when a transaction actually carries them.
import type { AppValidationRules } from './appValidation.js';
import type { AppTransitionRules } from './appTransitions.js';
import type { AppUpdateAction } from '../../shared/app.js';
import { consumesImage, consumesOf, moveConsumed } from './appConsumes.js';

import {
  AppAccessDenied,
  authorizeColumnWrites,
  captureGrant,
  expectedCovers,
  requestData,
  resourceChecks,
  type ColumnGrant,
  type ResourceChecks,
  type WriteRules,
} from '@mistriwork/engine/server/columnGrants.js';
export {
  AppAccessDenied,
  accessibleSchema,
  markStableGrant,
  pruneCounters,
  validateResourceView,
} from '@mistriwork/engine/server/columnGrants.js';

/** A role's grant in an App: the columns it reads and writes (columnGrants.ts), and the App's rules over its writes. */
export interface ResourceAccess extends ColumnGrant {
  /** App-level invariants, independent of a particular form or nav entry. */
  validation?: AppValidationRules;
  /** Declared transitions: columns that change only through the App's actions (appTransitions). */
  transitions?: AppTransitionRules;
  /** A fixed action's stamps ('now', 'me'), resolved with this request's
      moment and person once its transitions are judged (appStamps). */
  stamp?: (request: UpdateRequest, reader: { query: (request: QueryRequest) => Promise<QueryResult> }) => Promise<UpdateRequest>;
  /** A New form's `today`, `now` and `me` defaults, written into a create the
      same way (appStamps stampInsert); never into one the server makes itself. */
  fill?: (request: InsertRequest, reader: { query: (request: QueryRequest) => Promise<QueryResult> }) => Promise<InsertRequest>;
  /** Who `me` is in an action's `when`, looked up through the reader it is given (appMe). */
  me?: (reader: { query: (request: QueryRequest) => Promise<QueryResult> }) => Promise<QueryPerson>;
  /** Fixed actions granted without write (`roles.<role>.actions`), by table id:
      an update to a table outside `writable` is admitted only as one of these. */
  actions?: ReadonlyMap<string, readonly AppUpdateAction[]>;
  /** The App's zone (`ui.timezone`), by whose wall clock a granted action's `when` reads a date phrase. */
  zone?: string;
  /** The person a command runs for, as their own grants read: what a refusal may say of a record the command's
      footprint does not read (a line's `consumes` parent). Resolved only when a refusal is said; absent, the
      grants above are the reader's. */
  reader?: () => Pick<ResourceAccess, 'readable' | 'fields' | 'internal'>;
}

/** This call's grant, its App rules copied beside the columns (columnGrants.ts `captureGrant`). */
function captureAccess(access: ResourceAccess): ResourceAccess {
  return {
    ...captureGrant(access),
    ...(access.validation
      ? { validation: new Map([...access.validation].map(([table, rules]) => [table, Object.freeze([...rules])])) }
      : {}),
    ...(access.transitions ? { transitions: new Map(access.transitions) } : {}),
    ...(access.actions ? { actions: new Map([...access.actions].map(([table, list]) => [table, Object.freeze([...list])])) } : {}),
  };
}

/* A write's rich text columns, read and sanitized before the row is written (appValidation.ts `cleanRichTextValues`). */
async function richTextCleaned<R extends InsertRequest | UpdateRequest>(operationAccess: ResourceAccess, request: R): Promise<R> {
  if (!operationAccess.validation?.has(request.table)) return request;
  const { cleanRichTextValues } = await import('./appValidation.js');
  const values = cleanRichTextValues(operationAccess.validation, request.table, request.values);
  return values === request.values ? request : { ...request, values };
}

/**
 * The grant's checks on an already-owned transaction handle (columnGrants.ts
 * `authorizeColumnWrites`), with the App's rules over each write that passes
 * them: a fixed action's columns, transitions and stamps, a form's defaults,
 * rich text cleaned, the stored row validated, and what a line consumes.
 */
export function authorizeTransaction(full: DatabaseSchema, access: ResourceAccess, writer: WriteTransaction): WriteTransaction {
  return authorizeColumnWrites(full, access, writer, (checks) => appWriteRules(full, writer, checks));
}

function appWriteRules(full: DatabaseSchema, writer: WriteTransaction, checks: ResourceChecks): WriteRules<ResourceAccess> {
  const { assertRead, recordFields, keyFields, assertRelatedWrites } = checks;
  /* A line's `consumes` (appConsumes.ts), held around the write: what the
     refusal may say of the record it takes from is what this reader may read. */
  const parentReadable = (operationAccess: ResourceAccess) => (table: string, column: string) => {
    const reader = operationAccess.reader?.() ?? operationAccess;
    return reader.readable.has(table) && (reader.fields?.get(table)?.read.has(column) ?? true) && !reader.internal?.get(table)?.has(column);
  };
  /* An update that writes a line's reference or amount moves the balance by
     the change: the line is locked first, so its before-image is the one the
     write replaces. */
  const consumedUpdate = async (
    operationAccess: ResourceAccess,
    request: UpdateRequest,
    write: () => Promise<Awaited<ReturnType<WriteTransaction['update']>>>,
  ) => {
    const rules = consumesOf(operationAccess.validation, request.table).filter(
      (rule) => Object.hasOwn(request.values, rule.reference) || (rule.by !== undefined && Object.hasOwn(request.values, rule.by)),
    );
    if (!rules.length) return write();
    if (writer.lockRecord) await writer.lockRecord({ table: request.table, key: request.key });
    const before = await consumesImage(writer, request.table, request.key, rules);
    const result = await write();
    if (result.affected === 1) {
      const { postImageKey } = await import('./appValidation.js');
      const after = await consumesImage(writer, request.table, postImageKey(full, request.table, request.key, result.applied), rules);
      await moveConsumed(writer, rules, before, after, parentReadable(operationAccess));
    }
    return result;
  };
  /* The action's own columns are the write's authority, not the role's field
     grants; the row, its key and what the action's `when` reads must still be
     the principal's to read, and every other check an update gets still runs. */
  const grantedUpdate = (request: UpdateRequest, granted: readonly AppUpdateAction[], operationAccess: ResourceAccess) => {
    assertRead(request.table);
    keyFields(request.table, request.key);
    const declared = full.tables.find((item) => item.id === request.table);
    if (
      !request.values ||
      typeof request.values !== 'object' ||
      Array.isArray(request.values) ||
      Object.keys(request.values).some((column) => !declared?.columns.some((item) => item.name === column && !item.primaryKey)) ||
      Object.values(request.values).some(
        (value) => value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean',
      )
    )
      throw new AppAccessDenied();
    if (request.expected !== undefined) {
      recordFields(request.table, request.expected, 'read');
      if (!expectedCovers(full, request)) throw new AppAccessDenied();
    }
    assertRelatedWrites(request.table, Object.keys(request.values));
    const me = operationAccess.me && (() => operationAccess.me!(writer));
    /* Undo of this principal's own action (journal.revert) puts back the
       recorded before-image of those same columns; nothing a browser sends
       carries `restore`. */
    const judged =
      request.restore === true
        ? Promise.resolve(
            granted.some((action) =>
              Object.keys(request.values).every((column) => Object.hasOwn(action.set, column) || column === action.reason),
            ),
          ).then((ok) => {
            if (!ok) throw new AppAccessDenied();
          })
        : import('./appTransitions.js').then(async ({ assertGrantedAction, assertTransitions }) => {
            await assertGrantedAction(writer, full, granted, request, undefined, me, operationAccess.zone);
            return operationAccess.transitions?.has(request.table)
              ? assertTransitions(writer, full, operationAccess.transitions, request, undefined, undefined, me)
              : undefined;
          });
    const stamped = async (since: Record<string, string> | undefined | void, cleaned: UpdateRequest) => {
      const moved = since ? { ...cleaned, values: { ...cleaned.values, ...since } } : cleaned;
      return operationAccess.stamp && request.restore !== true ? operationAccess.stamp(moved, writer) : moved;
    };
    return judged
      .then(async (since) =>
        consumedUpdate(operationAccess, request, async () =>
          writer.update(await stamped(since, await richTextCleaned(operationAccess, request))),
        ),
      )
      .then(async (result) => {
        if (result.affected === 1 && operationAccess.validation?.has(request.table)) {
          const { validateStoredPostImage, postImageKey } = await import('./appValidation.js');
          await validateStoredPostImage(
            writer,
            full,
            operationAccess.validation,
            request.table,
            postImageKey(full, request.table, request.key, result.applied),
            Object.keys(request.values),
          );
        }
        return result;
      });
  };
  return {
    capture: captureAccess,
    // A recorded update locks its row first, a granted action's included.
    locksUnwritable: (table, access) => access.actions?.has(table) ?? false,
    insert: (request, operationAccess, server) => {
      const insert = (cleaned: InsertRequest, initial?: InsertRequest['values']) =>
        writer.insert(initial ? { ...cleaned, values: { ...cleaned.values, ...initial } } : cleaned);
      /* A value the form takes from a referenced record (`{ from: 'service_id.price' }`), left out, is read here. */
      const filledIn = richTextCleaned(operationAccess, request).then(async (said) => {
        const cleaned = operationAccess.fill && !server ? await operationAccess.fill(said, writer) : said;
        if (!operationAccess.validation?.has(request.table)) return cleaned;
        const { fillDerived } = await import('./appValidation.js');
        const values = await fillDerived(operationAccess.validation, request.table, cleaned.values, (read) => writer.query(read));
        return values === cleaned.values ? cleaned : { ...cleaned, values };
      });
      const written = filledIn.then((cleaned) =>
        operationAccess.transitions?.has(request.table)
          ? import('./appTransitions.js').then(({ assertTransitionInsert }) =>
              insert(cleaned, assertTransitionInsert(operationAccess.transitions, cleaned, full)),
            )
          : insert(cleaned),
      );
      return written.then(async (result) => {
        if (operationAccess.validation?.has(request.table)) {
          const { validateStoredPostImage } = await import('./appValidation.js');
          await validateStoredPostImage(writer, full, operationAccess.validation, request.table, result.key, 'insert');
        }
        const consumed = consumesOf(operationAccess.validation, request.table);
        if (consumed.length)
          await moveConsumed(
            writer,
            consumed,
            undefined,
            await consumesImage(writer, request.table, result.key, consumed),
            parentReadable(operationAccess),
          );
        return result;
      });
    },
    /* A table this principal does not write, where a role runs some of its
       fixed actions: the update is one of those actions or nothing. */
    unwritable: (request, operationAccess) => {
      const granted = operationAccess.actions?.get(request.table);
      return granted ? grantedUpdate(request, granted, operationAccess) : undefined;
    },
    update: (request, operationAccess) => {
      /* Judged on the row before it is written: a declared column moves only through an action. */
      const judged = operationAccess.transitions?.has(request.table)
        ? import('./appTransitions.js').then(({ assertTransitions }) =>
            assertTransitions(
              writer,
              full,
              operationAccess.transitions!,
              request,
              undefined,
              undefined,
              operationAccess.me && (() => operationAccess.me!(writer)),
            ),
          )
        : Promise.resolve(undefined);
      // Judged on the words an action sets, then written as what they mean now, with the machine's `since` where it moved.
      const stamped = async (since: Record<string, string> | undefined, cleaned: UpdateRequest) => {
        const moved = since ? { ...cleaned, values: { ...cleaned.values, ...since } } : cleaned;
        return operationAccess.stamp && request.restore !== true ? operationAccess.stamp(moved, writer) : moved;
      };
      return judged
        .then(async (since) =>
          consumedUpdate(operationAccess, request, async () =>
            writer.update(await stamped(since, await richTextCleaned(operationAccess, request))),
          ),
        )
        .then(async (result) => {
          if (result.affected === 1 && operationAccess.validation?.has(request.table)) {
            const { validateStoredPostImage, postImageKey } = await import('./appValidation.js');
            await validateStoredPostImage(
              writer,
              full,
              operationAccess.validation,
              request.table,
              postImageKey(full, request.table, request.key, result.applied),
              Object.keys(request.values),
            );
          }
          return result;
        });
    },
    remove: (request, access) => {
      // A removed line gives back what it took.
      const consumed = consumesOf(access.validation, request.table);
      if (!consumed.length) return writer.remove(request);
      const readable = parentReadable(captureAccess(access));
      return (async () => {
        if (writer.lockRecord) await writer.lockRecord({ table: request.table, key: request.key });
        const before = await consumesImage(writer, request.table, request.key, consumed);
        const result = await writer.remove(request);
        if (result.affected === 1) await moveConsumed(writer, consumed, before, undefined, readable);
        return result;
      })();
    },
  };
}

/** Request-owned facade. Every executable method checks the server-resolved grant. */
export function authorizeResources(resources: RuntimeResources, access: ResourceAccess, assertActive?: () => void): RuntimeResources {
  // Lifetime enforcement depends on scoped readers and the physical commit
  // boundary; ordinary adapters cannot provide that assurance.
  if (assertActive !== undefined && access.rows === undefined) throw new AppAccessDenied();
  // This baseline belongs to the deployed facade, not a mutable caller catalog.
  // A schema refresh must resolve fresh grants and construct a new facade too.
  const full = access.rows !== undefined ? captureScopeCatalog(resources.schema) : resources.schema;
  const capturedRows = access.rows === undefined ? undefined : snapshotRowScope(full, access.rows);
  // Physical post-image checks also follow outgoing parents. A row predicate
  // must not grant parent visibility that the resource ceiling denied.
  /* A snapshot (rowScope.ts), and the captured one itself where the ceiling
     takes nothing from it: every read the facade binds hands this scope on,
     and a snapshot is checked once rather than copied at each of them. */
  const rows =
    capturedRows === undefined
      ? undefined
      : Object.entries(capturedRows).every(([resource, rule]) => rule === false || access.readable.has(resource))
        ? capturedRows
        : snapshotRowScope(
            full,
            Object.fromEntries(
              Object.entries(capturedRows).map(([resource, rule]) => [resource, access.readable.has(resource) ? rule : false]),
            ),
          );
  if (rows !== undefined) {
    access = { ...access, rows };
    // A table a role runs granted actions on is written through the same scoped writer.
    for (const resource of [...access.writable, ...(access.actions?.keys() ?? [])]) {
      if (!access.readable.has(resource) || !full.tables.some((table) => table.id === resource)) throw new AppAccessDenied();
      const owner = resources.connectionFor(resource);
      if (typeof resources.forConnection(owner).scopeTransaction !== 'function') throw new AppAccessDenied();
    }
  }
  const { schema, assertRead, assertWrite, assertAllFields, queryFor, filterFor, viewFor, breakdownFor } = resourceChecks(full, access);
  const wrap = (underlying: Adapter, owner?: string): Adapter => {
    if (rows !== undefined) {
      if (!underlying.scopeReads) throw new AppAccessDenied();
      // Validate the full merged policy above before selecting this owner's
      // exact merged IDs. Source adapters independently reject foreign rules.
      const scope =
        owner === undefined
          ? rows
          : Object.freeze(Object.fromEntries(Object.entries(rows).filter(([id]) => resources.connectionFor(id) === owner)));
      let pending: Promise<ScopedReads> | undefined;
      const reads = (): Promise<ScopedReads> =>
        (pending ??= Promise.resolve()
          .then(() => underlying.scopeReads!(scope))
          .then((bound) => {
            if (
              !bound ||
              ['query', 'count', 'runView', 'countView', 'runBreakdown', 'countBreakdown'].some(
                (method) => typeof bound[method as keyof ScopedReads] !== 'function',
              )
            )
              throw new AppAccessDenied();
            return bound;
          }));
      const read = <A, R>(check: () => A, run: (bound: ScopedReads, checked: A) => Promise<R>): Promise<R> => {
        assertActive?.();
        const checked = check();
        return reads().then((bound) => {
          assertActive?.();
          const result = run(bound, checked);
          return assertActive
            ? result.then((value) => {
                assertActive();
                return value;
              })
            : result;
        });
      };
      // Capture and check before awaiting a potentially queued capability bind.
      // No unscoped read, introspection estimate or rebinding escapes.
      const guarded: Adapter = {
        dialect: underlying.dialect,
        introspect: async () => {
          assertActive?.();
          return schema;
        },
        close: async () => {},
        query: (request) =>
          read(
            () => queryFor(request),
            (bound, checked) => bound.query(checked),
          ),
        count: (table, filter, limit) =>
          read(
            () => filterFor(table, filter),
            (bound, checked) => bound.count(table, checked, limit),
          ),
        /* One statement for the badges of a source, where its reader can say
           them in one; each item is checked and scoped exactly as `count` is. */
        countEach: (items, limit) =>
          read(
            () => items.map((item) => ({ table: item.table, filter: filterFor(item.table, item.filter) })),
            async (bound, checked) =>
              bound.countEach
                ? bound.countEach(checked, limit)
                : Promise.all(checked.map((item) => bound.count(item.table, item.filter, limit))),
          ),
        runView: (view, offset) =>
          read(
            () => viewFor(view),
            (bound, checked) => bound.runView(checked, offset),
          ),
        countView: (view, limit) =>
          read(
            () => viewFor(view),
            (bound, checked) => bound.countView(checked, limit),
          ),
        runBreakdown: (def, offset) =>
          read(
            () => breakdownFor(def),
            (bound, checked) => bound.runBreakdown(checked, offset),
          ),
        countBreakdown: (def, limit) =>
          read(
            () => breakdownFor(def),
            (bound, checked) => bound.countBreakdown(checked, limit),
          ),
      };
      const writable = [...access.writable, ...(access.actions?.keys() ?? [])].some(
        (resource) => owner === undefined || resources.connectionFor(resource) === owner,
      );
      if (writable) {
        const ownerScope = (connection: string): RowScope =>
          Object.freeze(Object.fromEntries(Object.entries(rows).filter(([id]) => resources.connectionFor(id) === connection)));
        const execute = <T>(
          source: Adapter,
          connection: string,
          policy: RowScope,
          run: (tx: WriteTransaction) => Promise<T>,
        ): Promise<T> => {
          assertActive?.();
          if (typeof source.scopeTransaction !== 'function') throw new AppAccessDenied();
          const ownedAccess = captureAccess(access);
          const ids = new Map(
            full.tables.filter((table) => resources.connectionFor(table.id) === connection).map((table) => [table.id, table.id]),
          );
          const expected = mapScopeCatalog({ ...full, dialect: source.dialect }, ids);
          return source.scopeTransaction(policy, async (records, evidence) => {
            assertActive?.();
            assertScopeCatalog(expected, evidence);
            const authorized = authorizeTransaction(full, { ...ownedAccess, rows: undefined }, records);
            const { assertParentReads } = resourceChecks(full, ownedAccess);
            const readResult = <R>(result: Promise<R>): Promise<R> =>
              assertActive
                ? result.then((value) => {
                    assertActive();
                    return value;
                  })
                : result;
            // These checks execute inside the facade's failure accounting.
            // A callback that catches expiry must still roll back prior writes.
            const result = await runScopedTransactionFacade(
              {
                query: (request) => {
                  assertActive?.();
                  return readResult(authorized.query(request));
                },
                count: (table, filter) => {
                  assertActive?.();
                  return readResult(authorized.count(table, filter));
                },
                insert: (request) => {
                  assertActive?.();
                  assertParentReads(request.table, request.values, true);
                  return authorized.insert(request);
                },
                update: (request) => {
                  assertActive?.();
                  assertParentReads(request.table, request.values, false);
                  return authorized.update(request);
                },
                remove: (request) => {
                  assertActive?.();
                  return authorized.remove(request);
                },
              },
              run,
            );
            // Drain accepted work before the last check, while rollback is
            // still possible. Never turn a completed commit into a refusal.
            assertActive?.();
            return result;
          });
        };
        const single = <R extends { table: string }, T>(input: R, run: (tx: WriteTransaction, request: R) => Promise<T>) => {
          assertActive?.();
          const request = snapshotScopedData(input);
          assertWrite(request.table);
          const connection = resources.connectionFor(request.table);
          if (owner !== undefined && connection !== owner) throw new AppAccessDenied();
          const source = owner === undefined ? resources.forConnection(connection) : underlying;
          return execute(source, connection, ownerScope(connection), (tx) => run(tx, request));
        };
        guarded.insert = (request: InsertRequest) => single(request, (tx, input) => tx.insert(input));
        guarded.update = (request: UpdateRequest) => single(request, (tx, input) => tx.update(input));
        guarded.remove = (request: DeleteRequest) => single(request, (tx, input) => tx.remove(input));
        // A composite reader cannot promise one atomic writer. Only an already
        // anchored/single-source adapter exposes this callback capability.
        if (typeof underlying.scopeTransaction === 'function')
          guarded.transaction = (run) => {
            if (owner === undefined && resources.connections.length !== 1) throw new AppAccessDenied();
            return execute(underlying, owner ?? resources.connections[0], scope, run);
          };
      }
      return guarded;
    }
    const guarded: Adapter = {
      dialect: underlying.dialect,
      introspect: async () => schema,
      close: async () => {},
      query: (request) => underlying.query(queryFor(request)),
      count: (table, filter, limit) => underlying.count(table, filterFor(table, filter), limit),
    };
    if (underlying.estimateCount)
      guarded.estimateCount = (table) => {
        assertRead(table);
        return underlying.estimateCount!(table);
      };
    if (underlying.profile)
      guarded.profile = (table, limits) => {
        assertAllFields(table);
        return underlying.profile!(table, limits);
      };
    if (underlying.runView) guarded.runView = (view, offset) => underlying.runView!(viewFor(view), offset);
    if (underlying.countView) guarded.countView = (view, limit) => underlying.countView!(viewFor(view), limit);
    if (underlying.runBreakdown) guarded.runBreakdown = (def, offset) => underlying.runBreakdown!(breakdownFor(def), offset);
    if (underlying.countBreakdown) guarded.countBreakdown = (def, limit) => underlying.countBreakdown!(breakdownFor(def), limit);
    /* Each item checked as `count` checks one — the table readable, every
       filtered field granted — before any of them reaches the statement. */
    if (underlying.countEach)
      guarded.countEach = (items, limit) =>
        underlying.countEach!(
          requestData(items).map((item) => ({ table: item.table, filter: filterFor(item.table, item.filter) })),
          limit,
        );
    const writes = (writer: WriteTransaction) => authorizeTransaction(full, access, writer);
    const methods = writes({
      query: (request) => underlying.query(request),
      count: (table, filter) => underlying.count(table, filter),
      insert: (request) => underlying.insert!(request),
      update: (request) => underlying.update!(request),
      remove: (request) => underlying.remove!(request),
    });
    if (underlying.insert) guarded.insert = methods.insert;
    if (underlying.update) guarded.update = methods.update;
    if (underlying.remove) guarded.remove = methods.remove;
    if (underlying.transaction) guarded.transaction = (run) => underlying.transaction!((transaction) => run(writes(transaction)));
    // Raw SQL and DDL are deliberately not part of the authorized App adapter.
    return guarded;
  };
  return { ...resources, schema, adapter: wrap(resources.adapter), forConnection: (owner) => wrap(resources.forConnection(owner), owner) };
}
