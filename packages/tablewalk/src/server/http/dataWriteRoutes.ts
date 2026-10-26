/**
 * The database browser's POST routes that change data beyond a record: raw
 * SQL and Undo. A record's update, insert and delete are both products'
 * (recordWrites.ts), and this product's part of them is `BROWSER_WRITES`:
 * the connection's `writable` flag, and every write journaled for the Undo
 * below. An App has neither: it refuses raw SQL among its diagnostic tools
 * (appConnections.ts), and a save is corrected by another save.
 */
import { clampLimit } from '@mistriwork/engine/adapters/adapter.js';
import { withCancellation } from '@mistriwork/engine/adapters/statementControl.js';
import { attributeAction } from '@mistriwork/engine/adapters/writeAttribution.js';
import { history, latestRevertible, recordWrite as recordJournalWrite, revert, summarise } from '@mistriwork/engine/server/journal.js';
import { writeRefusal } from '@mistriwork/engine/server/http/writeRefusal.js';
import { send, sendResource } from '@mistriwork/engine/server/http/reply.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';
import type { RecordHooks } from '@mistriwork/engine/server/http/recordWrites.js';

/** The record writes in the database browser: the connection's `writable` flag and the grant, said in its own words. */
export const BROWSER_WRITES: RecordHooks = {
  gates: {
    write: (post, tableId, update) => writeRefusal(post.registry, undefined, post.connection, tableId, post.resources, post.access, update),
  },
};

export async function dataWriteRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, connection, who } = post;

  /**
   * Run a statement the user wrote.
   *
   * The safety argument is made in the adapter, not here — see `runSql` in
   * adapter.ts. What this adds is the permission question, which is the same
   * one /api/update asks and gets the same answer: writing needs a connection
   * whose config says so.
   */
  if (path === '/api/sql') {
    if (!adapter.runSql) {
      /* An App whose reads the server authorizes (roles, or hidden columns)
         has no runSql by design: a statement could name what it keeps out. */
      send(res, 501, { error: `${schema.dialect} connections cannot run SQL in this build.` });
      return true;
    }
    const text = String(body.text ?? '').trim();
    if (!text) {
      send(res, 400, { error: 'Nothing to run.' });
      return true;
    }

    const write = body.write === true;
    /* A raw write names no single table; an App server refuses /api/sql before this (appConnections.ts). */
    const refused = write ? writeRefusal(registry, undefined, connection, undefined) : null;
    if (refused) {
      send(res, 403, { error: refused, code: 'forbidden' });
      return true;
    }

    try {
      /* A read runs as the MCP sql tool's does: stoppable, under the same cap. On SQLite that is a process of its own
         (sqlite.ts runSql), so a statement that never ends is killed at the cap, or when the browser leaves,
         instead of blocking every request this server answers. */
      const stop = new AbortController();
      const left = () => {
        if (!res.writableEnded) stop.abort();
      };
      res.once('close', left);
      const result = await withCancellation(stop.signal, () => adapter.runSql!({ text, limit: clampLimit(body.limit), write })).finally(
        () => res.off('close', left),
      );
      /* A raw write is history too — listed, and marked as what it is: a
         statement with no general inverse, which undo will not guess at.
         The MCP `sql` tool never writes; this route was the one place a
         write could land unrecorded, so the browser's history was missing
         exactly the writes least easy to reason back from. */
      if (write) {
        recordJournalWrite(connection!, {
          kind: 'sql',
          ...(who ? { by: who } : {}),
          summary: summarise('sql', [], text.length > 80 ? `${text.slice(0, 77)}…` : text),
          revertible: false,
          reason: 'Raw SQL has no general inverse. Undo what it changed with another statement.',
          steps: [],
        });
      }
      send(res, 200, result);
      return true;
    } catch (err) {
      /* The database's own message, not ours. "cannot execute DELETE in a
         read-only transaction" says exactly what happened and why, and any
         paraphrase would say less. Answered as 200 with `errors` because a
         statement that does not run is the user's to fix, and the client
         renders it beside the editor rather than as a failed request. */
      send(res, 200, { errors: [{ message: (err as Error).message }] });
      return true;
    }
  }

  /**
   * Undo, one door out from the browser's own.
   *
   * The browser used to keep its own stack of what it had written and put the
   * old values back itself. That covered edits made in this tab and nothing
   * else — not an insert, not a delete, and not a single thing an agent did
   * over MCP. The journal is the one record of what happened to this
   * database, so this is where undo lives now and the browser asks.
   */
  if (path === '/api/revert') {
    if (!registry.configOf(connection)?.writable) {
      send(res, 403, {
        ...(body.confirm === true ? { outcome: 'not_applied' } : {}),
        error: `"${registry.configOf(connection)?.name ?? connection}" is read-only, so there is nothing to undo.`,
      });
      return true;
    }
    if (body.confirm === true && (typeof body.expectedId !== 'number' || !Number.isSafeInteger(body.expectedId) || body.expectedId <= 0)) {
      send(res, 400, {
        reverted: false,
        outcome: 'not_applied',
        error: 'Undo requires the positive safe-integer expectedId from the history preview. List the history before confirming.',
      });
      return true;
    }
    const ordered = history(connection, 50);
    const next = latestRevertible(ordered);
    if (body.confirm === true && body.expectedId !== next?.id) {
      send(res, 409, {
        reverted: false,
        outcome: 'not_applied',
        error: 'The undo history changed. This save can no longer be undone here.',
      });
      return true;
    }
    if (body.confirm !== true) {
      sendResource(res, path, 200, {
        reverted: false,
        writes: ordered
          .slice(0, typeof body.limit === 'number' ? Math.max(1, Math.min(50, body.limit)) : 10)
          .map(({ steps: _steps, connection: _c, principal: _principal, app: _app, ...rest }) => rest),
        next: next ? { id: next.id, kind: next.kind, at: next.at, summary: next.summary } : undefined,
      });
      return true;
    }
    if (!next) {
      sendResource(res, path, 200, {
        reverted: false,
        outcome: 'not_applied',
        errors: [{ message: 'Nothing in this session can be undone.' }],
      });
      return true;
    }
    const result = await attributeAction('Undo', () => revert(adapter, next.connection, next));
    const undone = {
      undone: { id: next.id, kind: next.kind, summary: next.summary },
      steps: result.steps,
    };
    if (result.reverted) {
      sendResource(res, path, 200, { ...undone, reverted: true, outcome: result.outcome });
      return true;
    }
    sendResource(res, path, 200, {
      ...undone,
      reverted: false,
      outcome: result.outcome,
      errors: result.errors?.map((message) => ({ message })),
    });
    return true;
  }

  return false;
}
