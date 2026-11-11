/**
 * The import a tenant server answers, split from tenantHttp.ts: bound to the
 * App, the contexts that admit its reads and writes, and the clock an App's
 * logic reads.
 */
import type { IncomingMessage } from 'node:http';
import { TransactionOutcomeUnknown, type Adapter, type ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { zonedNow, type AppDef } from '../../shared/app.js';
import { appZone } from '../../shared/appUi.js';
import { appForRoles } from '../../shared/appViewRoles.js';
import { importDeclaration } from '../../shared/appImportDeclaration.js';
import type { TenantContextAssertion, TenantContextReply } from '../../shared/tenantContext.js';
import { ImportUnavailable, readImportRequest, runImport } from '../app/appImport.js';
import { commandActionLabel } from '../recordHistory.js';
import type { createTenantContexts } from './tenantContexts.js';
import type { TenantReadContext } from './tenantReadRuntime.js';
import { tenantServedSchema, withRequestInstant } from './tenantServedSchema.js';
import { TenantWriteFailure } from './tenantWriteSource.js';

/** The contexts a tenant server opens (tenantContexts.ts), as the import reads and writes through them. */
type Contexts = ReturnType<typeof createTenantContexts<IncomingMessage>>;

export function tenantImporter({ app, contexts, appNow }: { app: AppDef; contexts: Contexts; appNow: () => Date }) {
  /**
   * A CSV file imported into a resource the member writes (app/appImport.ts),
   * on this tab's lease: every read it makes is a read in the member's own
   * context, and its rows are written in one transaction of that context, the
   * tenant's ownership injected on each (tenantRecordHistory.ts importRows), or
   * each through the resource's declared command. Nothing in the request names
   * a tenant, an owner or a key the context did not admit.
   */
  return async (
    req: IncomingMessage,
    selectors: readonly string[],
    expected: TenantContextAssertion,
    input: Record<string, unknown>,
    attributed: <T>(work: () => Promise<T>, action?: string) => Promise<T>,
    signal: AbortSignal,
  ) => {
    let last: TenantContextReply | undefined;
    const owned = <T>(answer: { value: T; context: TenantContextReply }): T => {
      last = answer.context;
      return answer.value;
    };
    /* An import is many reads and writes over as long as the file takes: each its own unit of work, at the instant it
       is asked, rather than all at the one the request arrived at. */
    const fresh = <T>(work: () => Promise<T>): Promise<T> => withRequestInstant(appNow(), work);
    const reading = <T>(run: (context: TenantReadContext) => T | Promise<T>) =>
      fresh(() => contexts.withContext(req, selectors, expected, run)).then(owned);
    try {
      const request = readImportRequest(input);
      const { schema, zone } = await reading((context) => ({
        schema: tenantServedSchema(context, app, appNow()),
        zone: context.zone,
      }));
      const call = <K extends keyof ScopedReads>(method: K) =>
        ((...args: unknown[]) =>
          reading((context) => (context.data[method] as (...values: unknown[]) => unknown)(...args))) as ScopedReads[K];
      const reader = Object.freeze({
        dialect: schema.dialect,
        introspect: async () => schema,
        close: async () => denyTenant(),
        query: call('query'),
        count: call('count'),
        runView: call('runView'),
        countView: call('countView'),
        runBreakdown: call('runBreakdown'),
        countBreakdown: call('countBreakdown'),
      }) as unknown as Adapter;
      /* A list that names roles the member does not hold in this tenant imports nothing for them, as one that is not there. */
      const roles = await reading((context) => context.principal.roles);
      const declared = importDeclaration(appForRoles(app, roles), request.table, request.view);
      if (!declared) throw new ImportUnavailable(404, 'This list does not import files.');
      const runtime = {
        app,
        schema,
        reader,
        locale: app.ui.locale ?? 'en-US',
        now: () => zonedNow(appZone(app.ui, zone), appNow()),
        signal,
      };
      const unknownAsUnknown = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch (error) {
          throw error instanceof TenantWriteFailure && error.outcome === 'unknown' ? new TransactionOutcomeUnknown(error) : error;
        }
      };
      const report = declared.def.command
        ? await runImport(
            {
              ...runtime,
              commandLabel: `${commandActionLabel(app, { command: declared.def.command.id }) ?? 'Command'} (import)`,
              commands: {
                prepare: (body) => fresh(() => contexts.prepare(req, selectors, expected, body)).then(owned),
                execute: (body) => fresh(() => attributed(() => contexts.execute(req, selectors, expected, body).then(owned))),
              },
            },
            request,
          )
        : await runImport(
            {
              ...runtime,
              writer: {
                trial: (insert) =>
                  unknownAsUnknown(() =>
                    fresh(() => contexts.importRows(req, selectors, expected, { inserts: [insert], trial: true })).then(owned),
                  ).then(() => {}),
                commit: (inserts) =>
                  unknownAsUnknown(() =>
                    fresh(() => attributed(() => contexts.importRows(req, selectors, expected, { inserts, trial: false }).then(owned))),
                  ).then(() => ({ undo: 'An import is undone record by record here.' })),
              },
            },
            request,
          );
      if (!last) return denyTenant();
      return { report, context: last };
    } catch (error) {
      if (error instanceof ImportUnavailable) return { refused: { status: error.status, message: error.message } };
      throw error;
    }
  };
}
