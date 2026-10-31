/**
 * An App's part of the record writes (recordWrites.ts `RecordHooks`): its
 * write gate in its own words, the search document that follows a committed
 * write, and its rules — the label its history gives an edit, what it does
 * not delete, a New form's file, tags and lines, its validation's refusals,
 * and failures said by code. And what an App says of the database browser's
 * other writes: it has no Undo.
 */
import { Refusal, type InsertRequest } from '@mistriwork/engine/adapters/adapter.js';
import { appDeletable, appFileRules } from '../../shared/app.js';
import { appTagRules } from '../../shared/appResourceRules.js';
import { isTenantApp } from '../../shared/appModel.js';
import { columnCaption } from '@mistriwork/engine/shared/columnCaption.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';
import { appError, appWriteError } from '../app/appErrors.js';
import { appDataResponse } from '../app/appResponses.js';
import { indexerFor } from '../app/appSearchRuntime.js';
import { AppValidationDenied } from '../app/appValidationDenied.js';
import { appForConnection, appWriteWording } from '../app/apps.js';
import { fileStoreTrouble, placeFile } from '../files/fileStorage.js';
import { updateActionLabel } from '../recordHistory.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';
import { uploadValues } from './fileRows.js';
import { readLines } from './formLinesWrite.js';
import type { RecordHooks, RecordRules } from '@mistriwork/engine/server/http/recordWrites.js';
import { send, sendResource } from '@mistriwork/engine/server/http/reply.js';
import { writeRefusal } from '@mistriwork/engine/server/http/writeRefusal.js';

/** The most tags a New form sends with its record. */
const TAGS_MOST = 50;

type Post = Pick<PostContext, 'appHosts' | 'connection' | 'registry'>;

/** The App that curates this request's connection. */
const hostOf = (post: Post) =>
  post.appHosts?.length ? appForConnection(post.appHosts, post.connection, post.registry.configOf(post.connection)?.name) : undefined;

/**
 * After a committed write the record's search document follows it
 * (appSearchRuntime.ts): queued, never awaited, so a slow engine never slows
 * a save. The import route (importRoutes.ts) follows its rows the same way.
 */
export function appIndexed(post: Post & Pick<PostContext, 'schema' | 'resources'>): (table: string, key: Record<string, unknown>) => void {
  const { schema, registry, connection, resources } = post;
  return (table, key) => {
    const host = hostOf(post);
    const tableId = findTable(schema, table)?.id;
    if (host && tableId)
      indexerFor(registry).touched(
        host.app.app,
        {
          connection: resources?.connectionFor(tableId) ?? connection,
          resource: tableId,
          physical: resources?.toPhysical(tableId) ?? tableId,
        },
        key,
      );
  };
}

/* What the App calls a column, for a refused write's sentence ("Email is required"). */
const captionsOf = (post: PostContext) => {
  const host = hostOf(post);
  const id = findTable(post.schema, String(post.body.table ?? ''))?.id;
  return host && id ? (column: string) => columnCaption(host.app.app.resources ?? {}, post.schema, id, column) : undefined;
};

const RULES: RecordRules = {
  label: (post, table, values) => {
    const host = hostOf(post);
    return host && updateActionLabel(host.app.app, table, values);
  },
  deletes: (post, tableId) => {
    const host = hostOf(post);
    return !host || appDeletable(host.app.app, post.schema).has(tableId);
  },
  upload: async (post, tableId) => {
    const host = appForConnection(post.appHosts ?? [], post.connection, post.registry.configOf(post.connection)?.name);
    const rule = host && tableId ? appFileRules(host.app.app, post.schema).rules.get(tableId) : undefined;
    const upload = uploadValues(rule, post.body);
    if ('error' in upload) return upload;
    /* Into the bucket before the row is written, when the resource keeps its bytes there (files/fileStorage.ts). */
    try {
      const placed = await placeFile(rule!, upload.values, { app: host!.app.app.id });
      // Bytes are outside the JSON value union; every adapter binds them as BLOB or bytea.
      return { values: placed.values as Record<string, string | number | boolean | null>, discard: () => placed.discard() };
    } catch (error) {
      const trouble = fileStoreTrouble(error, 'stored');
      if (!trouble) throw error;
      return { status: 503, error: trouble };
    }
  },
  alongside: (post, tableId) => {
    const { body, schema, registry, connection, appHosts, resources, access } = post;
    /* A record's tags, sent with it from a New form (tagLists.ts): each a key
       of the tag table, inserted as a link row in the record's transaction, so
       the record never stands without the tags it was made with. The link rows
       are writes like any other, held to the reader's grant on the link table. */
    let alongside: ((result: { key?: Record<string, unknown>; row?: Record<string, unknown> }) => InsertRequest[]) | undefined;
    if (body.tags !== undefined) {
      const host = appForConnection(appHosts ?? [], connection, registry.configOf(connection)?.name);
      const rule = host && tableId ? appTagRules(host.app.app, schema).rules.get(tableId) : undefined;
      const tags = Array.isArray(body.tags) ? [...new Set(body.tags)] : undefined;
      if (!rule) return { status: 400, error: 'This resource carries no tags.' };
      /* A tenant App's insert stamps the row's tenant; its link rows are not stamped yet. */
      if (isTenantApp(host!.app.app))
        return { status: 400, error: 'A tenant App does not take tags with a new record yet; add them on the record.' };
      if (!tags || tags.length > TAGS_MOST || tags.some((tag) => (typeof tag !== 'string' || !tag) && typeof tag !== 'number'))
        return { status: 400, error: `Tags are a list of at most ${TAGS_MOST} keys of ${rule.to}.` };
      const linkRefused = writeRefusal(registry, appWriteWording(appHosts), connection, rule.through, resources, access);
      if (linkRefused) return { status: 403, error: linkRefused };
      alongside = (result) => {
        const parent = result.key?.[rule.key] ?? result.row?.[rule.key];
        if (typeof parent !== 'string' && typeof parent !== 'number')
          throw new Refusal("The new record's key was not read back, so its tags cannot be linked to it.");
        return tags.map((tag) => ({ table: rule.through, values: { [rule.from]: parent, [rule.via]: tag as string | number } }));
      };
    }
    /* A New form's lines (`form.lines`), inserted with the record in its transaction (formLinesWrite.ts). */
    if (body.lines === undefined) return { ...(alongside ? { alongside } : {}) };
    const read = readLines(post, tableId, body.lines);
    if ('error' in read) return read;
    return { ...(alongside ? { alongside } : {}), lines: read.lines };
  },
  /* An App's root `validation` refusing a write is the user's to fix, like a
     constraint the database enforces: the same envelope with a `rejected`
     outcome, so the form keeps the draft and marks the fields. Rethrown as a
     plain Refusal it became a 400 mapped for reads, which dropped the field
     names the error carries. Only field names cross; never values or rule text.
     At 422, as a line's `consumes` refusing is and every other door (a command,
     the App API) answers it: it was a 200, and a caller that reads only the
     status took the refused record for a saved one (a live load test). */
  refused: (res, path, error) => {
    if (!(error instanceof AppValidationDenied)) return false;
    sendResource(res, path, 422, { errors: [appError(error, 'write')], outcome: 'rejected' });
    return true;
  },
  failure: (post, error, completed) => appWriteError(error, completed, captionsOf(post)),
  impact: (error) => appError(error, 'read').message,
  reply: (body, kind) => appDataResponse(body, true, kind),
};

/** The record writes in an App. */
export const APP_WRITES: RecordHooks = {
  gates: {
    write: (post, tableId, update) =>
      writeRefusal(post.registry, appWriteWording(post.appHosts), post.connection, tableId, post.resources, post.access, update),
  },
  after: { write: (post, table, key) => appIndexed(post)(table, key) },
  rules: RULES,
};

/** The database browser's other writes, on an App server. True when answered. */
export function appWriteRoutes(post: PostContext): boolean {
  // An App has no Undo: a save is corrected by another save.
  if (post.path !== '/api/revert') return false;
  send(post.res, 404, { error: 'An App has no Undo.' });
  return true;
}
