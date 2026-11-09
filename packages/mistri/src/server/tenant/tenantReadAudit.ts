/**
 * The read audit on a tenant App: the store refused at startup where it is
 * missing, as branding's is (tenantBrandingStore.ts), and the sink each read
 * runtime sets beside a request's grant. A row carries the tenant whose rows
 * were read and is appended through the deployment's writer, the tenant's
 * fenced source, never the reader: a read snapshot cannot write.
 */
import { recordRefusalCause, TenantUnavailableError } from '@mistriwork/engine/server/evidence.js';
import type { AppDef } from '../../shared/app.js';
import { ReadAuditUnavailable, type ReadAuditRow } from '../../adapters/readAudit/readAudit.js';
import { storesOf } from '../stores/appStores.js';
import type { AuditedAccess, ReadAuditSink } from '../readAudit.js';

/** Whether any of the App's resources audits its reads; nothing below is bound for one that does not. */
export const auditsReads = (app: Pick<AppDef, 'resources'>): boolean =>
  Object.values(app.resources ?? {}).some((resource) => resource.audit?.reads === true);

/* `adapter` is the deployment's writer: a dialect adapter, whose App stores answer (stores/appStores.ts). */
export async function bindTenantReadAuditStore(adapter: object): Promise<void> {
  const store = storesOf(adapter) as { readAuditReady?: () => Promise<boolean> };
  if (typeof store.readAuditReady === 'function' && (await store.readAuditReady())) return;
  throw new ReadAuditUnavailable(
    `This tenant App audits reads of a resource, and its database holds no read audit store. ` +
      `It is provisioned once, never on startup: run \`mistri migrate stores up --app <dir> --policy <file>\` (with the App's --config) while the server is stopped, then start again. ` +
      `A foreign layout is refused, not altered.`,
  );
}

/**
 * `access` with the sink this request's reads are written to, or unchanged
 * where it audits nothing: a kept grant (a runtime's role-set cache) never
 * holds one, since the reader is the request's. A row that cannot be written
 * is the tenant context being unavailable, not a denial: the request is
 * answered 503 (tenantHttp.ts) and the person's context stays theirs.
 */
export function withTenantReadAudit<T extends AuditedAccess>(
  access: T,
  sink: Omit<ReadAuditSink, 'append'>,
  append: ((row: ReadAuditRow) => Promise<void>) | undefined,
): T {
  if (!access.audited?.size) return access;
  return {
    ...access,
    readAudit: {
      ...sink,
      append: async (row) => {
        if (!append) throw new TenantUnavailableError();
        try {
          await append(row);
        } catch (error) {
          throw recordRefusalCause(new TenantUnavailableError(), error);
        }
      },
    },
  };
}
