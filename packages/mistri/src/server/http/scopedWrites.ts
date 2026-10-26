/**
 * Writes under a row policy: the data-changing routes, answered by the
 * policy's own update facade inside its context rather than by the ordinary
 * write path. First in the chain because the context is already open and
 * nothing below it may see these bodies. A file upload is one of them: its
 * row is an insert like any other, so the policy that judges an insert
 * judges it, and nothing else may write a file under a row policy.
 */
import { AppAccessDenied } from '../app/appAccess.js';
import { signedInAs } from '../app/appStamps.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import { attributeAction } from '@mistriwork/engine/adapters/writeAttribution.js';
import { updateActionLabel } from '../recordHistory.js';
import { FILE_UPLOAD_BODY, FILE_UPLOAD_PATH, readJson, send, sendResource } from '@mistriwork/engine/server/http/reply.js';
import { uploadValues } from './fileRows.js';
import { fileStoreTrouble, placeFile, writePlaced } from '../files/fileStorage.js';
import { appFileRules } from '../../shared/appResourceRules.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { judgeLines } from './formLinesWrite.js';
import type { LineCollection } from '@mistriwork/engine/server/recordWriteOperations.js';

export async function scopedWriteRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, policy, policyContext } = ctx;

  if (policyContext && ['/api/update', '/api/insert', '/api/delete', '/api/revert', FILE_UPLOAD_PATH].includes(path)) {
    res.setHeader('x-mistri-app', policy!.appId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      if (req.aborted || res.destroyed) abort();
      const body = await readJson(req, path === FILE_UPLOAD_PATH ? FILE_UPLOAD_BODY : undefined);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppAccessDenied();
      if (Object.hasOwn(body, 'app') && body.app !== policy!.appId) throw new AppAccessDenied();
      // An action's stamps: the server's clock and the verified session's person, never the body's.
      const who = signedInAs(ctx.identity);
      const moment = () => ({ now: clockNow(), ...(who ? { who } : {}) });
      /* A record's lines (formLinesWrite.ts), judged on this principal's own catalog and grants:
         each row is then written as the policy writes that row alone. */
      let lines: LineCollection[] | undefined;
      if (path === '/api/insert' && Object.hasOwn(body, 'lines')) {
        const host = ctx.appHosts?.find((candidate) => candidate.app.app.id === policy!.appId);
        if (!host) throw new AppAccessDenied();
        const { schema } = policyContext;
        const judged = judgeLines(
          {
            app: host.app.app,
            schema,
            refused: (child) => (policy!.updates.canInsert(policyContext, child) ? undefined : 'This App does not add these lines here.'),
          },
          typeof body.table === 'string' ? schema.tables.find((table) => table.id === body.table)?.id : undefined,
          body.lines,
        );
        if ('error' in judged) {
          send(res, judged.status, { error: judged.error });
          return true;
        }
        lines = judged.lines;
        delete body.lines;
      }
      /* Committed: the record's search document follows it, and each line's
         follows that line, as after any other write (dataWriteRoutes.ts). */
      const indexed = (table: string, key: Record<string, unknown>, written?: readonly LineCollection[]) => {
        policy!.indexed(table, key);
        for (const line of written ?? []) for (const lineKey of line.written ?? []) policy!.indexed(line.table, lineKey);
      };
      if (path === '/api/update') {
        const host = ctx.appHosts?.find((candidate) => candidate.app.app.id === policy!.appId);
        const updated = await attributeAction(host && updateActionLabel(host.app.app, body.table, body.values), () =>
          policy!.updates.update(policyContext, body, controller.signal, moment),
        );
        indexed(body.table as string, body.key as Record<string, unknown>);
        sendResource(res, path, 200, updated);
        return true;
      }
      if (path === '/api/insert') {
        const inserted = await policy!.updates.insert(policyContext, body, controller.signal, lines, moment);
        indexed(body.table as string, inserted.key, lines);
        sendResource(res, path, 200, inserted);
        return true;
      }
      if (path === FILE_UPLOAD_PATH) {
        /* Judged before the file is read: a table this principal may not add
           rows to is refused as any insert is, not told why the bytes are
           wrong. The rule is read off the principal's own catalog, so a file
           whose columns it cannot see is not a file it can upload. */
        const table = body.table;
        if (
          Object.keys(body).some((key) => !['app', 'table', 'values', 'file'].includes(key)) ||
          typeof table !== 'string' ||
          !policy!.updates.canInsert(policyContext, table)
        )
          throw new AppAccessDenied();
        const host = ctx.appHosts?.find((candidate) => candidate.app.app.id === policy!.appId);
        const rule = host && appFileRules(host.app.app, policyContext.schema).rules.get(table);
        if (!rule) throw new AppAccessDenied();
        const upload = uploadValues(rule, body);
        if ('error' in upload) {
          send(res, upload.status, { error: upload.error });
          return true;
        }
        /* Into the bucket before the row is written, when the resource keeps its bytes there (files/fileStorage.ts). */
        let placed: Awaited<ReturnType<typeof placeFile>>;
        try {
          placed = await placeFile(rule, upload.values, { app: policy!.appId });
        } catch (error) {
          const trouble = fileStoreTrouble(error, 'stored');
          if (!trouble) throw error;
          send(res, 503, { error: trouble });
          return true;
        }
        const added = await writePlaced(placed, (values) =>
          policy!.updates.insert(policyContext, { table, values: values as typeof upload.values }, controller.signal),
        );
        indexed(table, added.key);
        /* The bytes just sent are not sent back: the reply names the row, and
           the file is read through /api/file like any other. */
        const drop = <Row extends Record<string, unknown>>(row: Row): Row =>
          Object.fromEntries(
            Object.entries(row).filter(([column]) => ![rule.content, rule.thumbnail, rule.object, rule.hash].includes(column)),
          ) as Row;
        sendResource(res, '/api/insert', 200, { key: added.key, row: drop(added.row), applied: drop(added.applied) });
        return true;
      }
      if (path === '/api/delete') {
        const removed = await policy!.updates.remove(policyContext, body, controller.signal);
        // The record is gone: its document goes with it.
        if (removed.deleted) indexed(body.table as string, body.key as Record<string, unknown>);
        sendResource(res, path, 200, removed);
        return true;
      }
      // An App has no Undo: a save is corrected by another save.
      send(res, 404, { error: 'An App has no Undo.' });
      return true;
    } finally {
      req.off('aborted', abort);
      res.off('close', abort);
    }
  }

  return false;
}
