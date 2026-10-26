/**
 * `POST /api/import`: a CSV file checked or written into an App resource
 * (app/appImport.ts). It reads its own body — larger than an ordinary
 * request's, and a file, not a record — then resolves the App the way every
 * other route does and builds the import's writer from what the request is
 * already allowed: the authorized adapter and its journal, the row policy's
 * scoped writer, or the resource's declared command. Nothing here grants a
 * write the reader could not make one record at a time.
 */
import { AppAccessDenied } from '../app/appAccess.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { ImportUnavailable, readImportRequest, runImport, type ImportWriter } from '../app/appImport.js';
import { lookupPerson } from '../app/appMe.js';
import { signedInAs } from '../app/appStamps.js';
import { appWriteWording } from '../app/apps.js';
import { openBusinessCommandCalls } from '../commands/businessCommandHttp.js';
import { commandActionLabel } from '../recordHistory.js';
import { recordedImport } from '@mistriwork/engine/server/recordWriteOperations.js';
import { grantsByRole, zonedNow, type AppDef } from '../../shared/app.js';
import { appZone } from '../../shared/appZone.js';
import { IMPORT_LIMITS } from '../../shared/appImportDeclaration.js';
import { importDeclaration } from '../../shared/appImportDeclaration.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';
import type { InsertRequest } from '@mistriwork/engine/adapters/adapter.js';
import { browserApp } from './appProjection.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import { appIndexed } from './appRecordWrites.js';
import { recordedWrites } from '@mistriwork/engine/server/http/recordWrites.js';
import { writeRefusal } from '@mistriwork/engine/server/http/writeRefusal.js';
import { readJson, send } from '@mistriwork/engine/server/http/reply.js';
import { resolveSource } from './source.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { captureHttpCommandFlags } from '../flags/httpRuntime.js';

const IMPORT_PATH = '/api/import';
/* The file travels as JSON text, where a quote or a line break is written
   with two characters: room for a file of IMPORT_LIMITS.bytes that is all
   of them, and the rest of the request. The file itself is measured again. */
const IMPORT_BODY = IMPORT_LIMITS.bytes * 2 + 64 * 1024;

/** Thrown into a trial's transaction so it always rolls back. */
const TRIAL = new Error('import trial');

export async function importRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, url, path, registry, appHosts, commands, identity, signedIn, policy, policyContext } = ctx;
  if (path !== IMPORT_PATH) return false;
  if (req.method !== 'POST') {
    send(res, 405, { error: 'An import is a POST.' });
    return true;
  }
  if (!ctx.appConfigured) {
    send(res, 404, { error: 'Imports belong to an App.' });
    return true;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    const body = await readJson(req, IMPORT_BODY);
    if (Object.hasOwn(body, 'conn')) {
      send(res, 400, { error: 'Application requests identify an app, not a connection.' });
      return true;
    }
    const inBody = typeof body.app === 'string' ? body.app : undefined;
    const inQuery = url.searchParams.get('app');
    if (body.app !== undefined && typeof body.app !== 'string') {
      send(res, 400, { error: 'Invalid request identity.' });
      return true;
    }
    if (inBody && inQuery && inBody !== inQuery) {
      send(res, 400, { error: 'This request names two different applications.' });
      return true;
    }
    const request = readImportRequest(body);
    const source = await resolveSource(ctx, inBody ?? inQuery);
    if (res.destroyed) return true;
    const host = source.selectedHost!;
    // Signed out, nobody imports: a public grant is reads alone.
    if (grantsByRole(host.app.app) && !identity.id) throw new AppAccessDenied();
    if (source.access && !source.access.readable.has(request.table)) throw new AppAccessDenied();
    const app = (browserApp(ctx, source).visibleApp?.app ?? host.app.app) as AppDef;
    const declared = importDeclaration(app, request.table, request.view);
    const table = findTable(source.schema, request.table);
    if (!declared || !table) throw new ImportUnavailable(404, 'This list does not import files.');
    const who = signedInAs(identity);
    const person = await lookupPerson(host.app.app, source.schema, who, source.adapter).catch(() => undefined);
    const runtime = {
      app,
      schema: source.schema,
      reader: source.adapter,
      locale: source.locale ?? host.app.app.ui.locale ?? 'en-US',
      // A list's standing query is read by the App's wall clock, so an import targets the rows that list shows.
      now: () => zonedNow(appZone(app.ui, source.zone), clockNow()),
      signal: controller.signal,
      ...(person ? { person } : {}),
    };

    if (declared.def.command) {
      const label = `${commandActionLabel(host.app.app, { command: declared.def.command.id }) ?? 'Command'} (import)`;
      // Refused at load on a row-policy App (checkImports); never served around it here.
      if (policyContext || !signedIn?.auth || !identity.id || !commands || commands.appId !== host.app.app.id) throw new AppAccessDenied();
      const connection = appEntrypoint(signedIn, registry);
      if (!connection) throw new ImportUnavailable(403, 'Access to this resource is denied.');
      const calls = await openBusinessCommandCalls({
        registry,
        app: signedIn.app.app,
        commands: commands.registry,
        connection,
        captureFlags: captureHttpCommandFlags,
        actor: {
          id: identity.id,
          appId: signedIn.app.app.id,
          roles: (identity.role ?? '')
            .split(',')
            .map((role) => role.trim())
            .filter(Boolean),
        },
        ...(commands.events ? { events: commands.events } : {}),
        signal: controller.signal,
      });
      try {
        send(res, 200, await runImport({ ...runtime, commands: calls, commandLabel: label }, request));
        return true;
      } finally {
        calls.release();
      }
    }

    let writer: ImportWriter;
    if (policyContext) {
      writer = {
        trial: (insert) => policy!.updates.importTrial(policyContext, insert, controller.signal),
        commit: async (inserts) => {
          const committed = await policy!.updates.importCommit(policyContext, inserts, controller.signal);
          for (const key of committed.keys) policy!.indexed(table.id, key);
          return committed;
        },
      };
    } else {
      const refused = writeRefusal(registry, appWriteWording(appHosts), source.connectionId, table.id, source.resources, source.access);
      if (refused) {
        send(res, 403, { error: refused });
        return true;
      }
      const post = {
        adapter: source.adapter,
        schema: source.schema,
        registry,
        connection: source.connectionId,
        appHosts,
        who: identity.who,
        resources: source.resources,
      };
      const { writeOptions } = recordedWrites(post, !appHosts?.length);
      const indexed = appIndexed(post);
      const options = writeOptions(table.id);
      if (!options.adapter.transaction) throw new ImportUnavailable(403, 'This resource cannot take an import in one transaction.');
      writer = {
        trial: async (insert) => {
          try {
            await options.adapter.transaction!(async (tx) => {
              await tx.insert(insert);
              throw TRIAL;
            });
          } catch (error) {
            if (error !== TRIAL) throw error;
          }
        },
        commit: async (inserts: InsertRequest[]) => {
          const { result } = await recordedImport(options, inserts, () => {
            if (controller.signal.aborted) throw new AppAccessDenied();
          });
          for (const written of result) indexed(table.id, written.key);
        },
      };
    }
    send(res, 200, await runImport({ ...runtime, writer }, request));
    return true;
  } catch (error) {
    if (error instanceof ImportUnavailable) {
      send(res, error.status, { error: error.message });
      return true;
    }
    throw error;
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
}
