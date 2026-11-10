/**
 * What a member's lease reads out whole, as a file: one stored file of a file
 * resource, and a list's streamed export. Apart from the routes that admit
 * them (tenantHttp.ts), which hand each its lease's reader and context.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appTime } from '@mistriwork/engine/server/http/clock.js';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { exportFile } from '@mistriwork/engine/server/http/exportRoute.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import { findTable, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { appFileRules, zonedNow, type AppDef } from '../../shared/app.js';
import { appZone } from '../../shared/appUi.js';
import type { TenantContextReply } from '../../shared/tenantContext.js';
import { readMeSets, textsMentionMe } from '../app/appMe.js';
import { fileStoreTrouble, type FileScope } from '../files/fileStorage.js';
import { appCsvAmounts, appExportsTable } from '../http/appExport.js';
import { readStoredFile } from '../http/fileRows.js';
import { sniffImage } from '../http/imageSniff.js';
import { ownerHeaders, send } from './tenantWire.js';
import { tenantDraftReaderOf } from './tenantReadRuntime.js';
import { beneathDraft, draftFileHidden } from '../forms/draftFiles.js';

/**
 * One file of a file resource, read on the lease: through the context's own
 * reader, so the member's grants and the tenant's rows are the only ones it
 * can reach. The bytes come back as base64 with the type the bytes say when
 * they are a picture asked for in place, and as a download otherwise — the
 * page makes a blob of it, never a link.
 */
export async function tenantFileRead(
  app: AppDef,
  reader: Adapter,
  schema: DatabaseSchema,
  input: Record<string, unknown>,
  scope: FileScope,
  draft?: { readonly context: object; readonly person: () => Promise<string | number | null> },
): Promise<{ status: number; body: unknown }> {
  const table = findTable(schema, typeof input.table === 'string' ? input.table : '');
  const rule = table ? appFileRules(app, schema).rules.get(table.id) : undefined;
  if (!table || !rule) return { status: 404, body: { error: 'This resource does not hold files.' } };
  /* A file beneath a signed-in draft is the draft's person's alone until it is submitted (forms/draftFiles.ts), asked
     of the context's draft reader, which sees the root whatever the member's grants. A visitor is nobody's person. */
  const drafts = draft ? tenantDraftReaderOf(draft.context) : undefined;
  if (drafts && input.key && typeof input.key === 'object' && beneathDraft(app, drafts.schema, table.id)) {
    const hidden = await draftFileHidden({
      app,
      schema: drafts.schema,
      reader: drafts.reader,
      table: table.id,
      key: input.key as Record<string, string | number>,
      who: undefined,
      person: draft!.person,
    });
    if (hidden) return { status: 404, body: { error: 'No file here.' } };
  }
  let stored: Awaited<ReturnType<typeof readStoredFile>>;
  try {
    stored = await readStoredFile(reader, table, rule, input.key, input.variant, scope);
  } catch (error) {
    const trouble = fileStoreTrouble(error, 'read');
    if (!trouble) throw error;
    return { status: 503, body: { error: trouble } };
  }
  if ('error' in stored) return { status: stored.status, body: { error: stored.error } };
  const image = input.inline === true ? sniffImage(stored.bytes) : undefined;
  return {
    status: 200,
    body: { name: stored.name, type: image ?? 'application/octet-stream', data: Buffer.from(stored.bytes).toString('base64') },
  };
}

/** What the export needs of a lease's context: its member's roles and, for a tenant, its zone. */
interface ExportingContext {
  readonly principal: { readonly roles: readonly string[] };
  readonly zone?: string;
}

/**
 * The streamed export on a lease (engine http/exportRoute.ts): each batch a
 * read of the lease's own reader — this tenant's rows (or the platform
 * realm's) under the member's grants and row scope, ANDed into every batch as
 * into a list's page — paged by key with no ceiling. `within` holds the
 * lease's context for the whole file, as for any read, so a lease that ends
 * mid-file cuts it; the file's last write, and any answer that is not the
 * file, wait for the context to settle (`settled`), and the client keeps the
 * file only where it names this lease.
 */
export async function tenantExport<C extends ExportingContext>(asked: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly body: Record<string, unknown>;
  readonly app: AppDef;
  readonly now: () => number;
  readonly within: (exporting: (context: C, lease: TenantContextReply) => Promise<void>) => Promise<unknown>;
  readonly schemaOf: (context: C) => DatabaseSchema;
  readonly reader: (context: C) => Adapter;
  readonly person: (context: C, schema: DatabaseSchema) => Promise<QueryPerson>;
  readonly settled: () => void;
}): Promise<void> {
  const { req, res, app } = asked;
  let end: (() => void) | undefined;
  let answered: { status: number; value: unknown } | undefined;
  try {
    await asked.within(async (context, lease) => {
      const schema = asked.schemaOf(context);
      const reader = asked.reader(context);
      end = await exportFile({
        res,
        body: asked.body,
        adapter: reader,
        schema,
        now: () => zonedNow(appZone(app.ui, context.zone), appTime(asked.now())),
        may: appExportsTable(app, schema, context.principal.roles, true),
        person: async (text) =>
          textsMentionMe([text], schema) ? readMeSets(await asked.person(context, schema), [text], schema, reader) : undefined,
        amounts: (tableId) => appCsvAmounts(app, schema, tableId),
        headers: ownerHeaders(lease),
        answer: (status, value) => {
          answered = { status, value };
        },
      });
    });
  } catch (error) {
    /* Past the file's first byte its status cannot change: the connection is cut, never ended as if whole. */
    if (res.headersSent) return void res.destroy();
    throw error;
  }
  asked.settled();
  if (req.aborted || res.destroyed) return;
  if (answered) return send(req, res, answered.status, answered.value);
  end?.();
}
