/**
 * The tenant host's routes that carry a member's files and saved forms, apart from the request handler they are
 * called from (tenantHttp.ts): a signed-in draft's request, the command routes (which add a draft and a staged
 * file to the ordinary four), and the read an upload makes on its lease before its file is placed.
 */
import type { IncomingMessage } from 'node:http';
import { type Adapter, type InsertRequest } from '@mistriwork/engine/adapters/adapter.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';
import { appFileRules, type AppDef } from '../../shared/app.js';
import { TENANT_FILE_MOST } from '@mistriwork/engine/server/http/reply.js';
import type { TenantContextAssertion } from '../../shared/tenantContext.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { lookupTenantPerson } from '../app/appMe.js';
import { stampInsert, type compileAppStamps } from '../app/appStamps.js';
import { uploadValues } from '../http/fileRows.js';
import { bindUploadParent, type readUploadParent } from '../files/uploadParent.js';
import type { createTenantContexts } from './tenantContexts.js';
import type { TenantReadContext } from './tenantReadRuntime.js';
import { tenantServedSchema } from './tenantServedSchema.js';

/**
 * A signed-in saved form's request on the tenant host. A tenant request holds one transaction (tenantRequestRuntime.ts),
 * so a step answers without the draft it saved into (draftHttp.ts `stepSummary`): it is read back here as a resume
 * would, by its owner, in a request of its own. A failed read-back answers as the step's own failure would, and a
 * retry with the same key gets the step's receipt rather than a second write.
 */
async function draftRequest<C>(
  input: Record<string, unknown>,
  run: (body: unknown) => Promise<{ readonly context: C; readonly value: unknown }>,
): Promise<{ readonly context: C; readonly value: unknown }> {
  const stepped = await run(input);
  if (input.op !== 'step') return stepped;
  const resumed = await run({ form: input.form, op: 'resume', ...(input.draft === undefined ? {} : { draft: input.draft }) });
  return {
    context: resumed.context,
    value: { ...(stepped.value as object), draft: (resumed.value as { draft?: unknown } | null)?.draft ?? null },
  };
}

/** One command route's answer: the four ordinary verbs, and a saved form's draft and a staged file for a signed-in member. */
export function tenantCommandRoute(
  contexts: ReturnType<typeof createTenantContexts<IncomingMessage>>,
  route: {
    readonly path: string;
    readonly platform: boolean;
    readonly req: IncomingMessage;
    readonly selectors: readonly string[];
    readonly expected: TenantContextAssertion;
    readonly input: Record<string, unknown>;
    readonly execution: { readonly signal: AbortSignal; readonly locale?: string };
  },
) {
  const { path, platform, req, selectors, expected, input, execution } = route;
  /* A signed-in draft is a member's own root in a tenant's rows; the platform realm has no member
     and no draft, so it refuses as an unknown command would. */
  if (path.endsWith('/files') || path.endsWith('/draft')) {
    if (platform) return Promise.reject(new BusinessCommandExecutionError('forbidden', 'not_applied'));
    return path.endsWith('/files')
      ? contexts.stage(req, selectors, expected, input, execution)
      : draftRequest(input, (body) => contexts.draft(req, selectors, expected, body, execution));
  }
  if (platform) {
    return path.endsWith('/availability')
      ? contexts.availabilityPlatform(req, expected, input, execution)
      : path.endsWith('/prepare')
        ? contexts.preparePlatform(req, expected, input, execution)
        : path.endsWith('/status')
          ? contexts.statusPlatform(req, expected, input, execution)
          : contexts.executePlatform(req, expected, input, execution);
  }
  return path.endsWith('/availability')
    ? contexts.availability(req, selectors, expected, input, execution)
    : path.endsWith('/prepare')
      ? contexts.prepare(req, selectors, expected, input, execution)
      : path.endsWith('/status')
        ? contexts.status(req, selectors, expected, input, execution)
        : contexts.execute(req, selectors, expected, input, execution);
}

/**
 * The record the list hangs off is read on this lease, as this member reads it (their grants, their tenant's
 * rows), and the link is written from what was read, never from the body (files/uploadParent.ts); then the
 * columns the file rule stamps are the server's clock and this session's person (appStamps.ts), as on a
 * single App's upload (http/appRecordWrites.ts). A parent another tenant holds is no record on this lease,
 * and the insert's own transaction proves the link's parent again.
 */
export async function readTenantUpload(
  context: TenantReadContext,
  reader: Adapter,
  upload: {
    readonly app: AppDef;
    readonly input: Record<string, unknown>;
    readonly parent: Exclude<ReturnType<typeof readUploadParent>, { error: string }>['parent'];
    readonly stamps: ReturnType<typeof compileAppStamps>;
    readonly meOwned: boolean;
    readonly now: Date;
    readonly who?: string;
  },
) {
  const { app, input, parent, stamps, meOwned, now, who } = upload;
  const schema = tenantServedSchema(context, app, now);
  const table = findTable(schema, typeof input.table === 'string' ? input.table : '');
  const rule = table ? appFileRules(app, schema).rules.get(table.id) : undefined;
  let values = uploadValues(rule && { ...rule, maxBytes: Math.min(rule.maxBytes, TENANT_FILE_MOST) }, input);
  if (!('error' in values) && parent) {
    const bound = await bindUploadParent(schema, table!.id, parent, values.values, (request) => reader.query(request));
    values = 'error' in bound ? bound : { values: bound.values };
  }
  if (!('error' in values) && rule!.stamps && stamps?.defaults?.has(table!.id)) {
    const account = (context.principal as { accountId?: unknown }).accountId;
    const stamped = await stampInsert(stamps, { table: table!.id, values: values.values } as InsertRequest, {
      now,
      ...(who ? { who } : {}),
      person: async () =>
        (await lookupTenantPerson(app, schema, who ?? null, meOwned && typeof account === 'string' ? account : undefined, reader)).person
          ?.key ?? null,
    });
    values = { values: { ...stamped.values } };
  }
  return { rule, tableId: table?.id, upload: values, tenantId: (context.principal as { tenantId?: unknown }).tenantId };
}
