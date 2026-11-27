/**
 * A tenant's read audit as a page component asks for it (`useReadAudit()`): over /api/reads, the route the Settings
 * Reads room uses (tenantReadsRoute.ts), never a route of its own. The route answers for the lease's tenant alone and
 * only to its admins, so what this reads is exactly what that room shows; a reader outside the gate hears the route's
 * 403 as an error. Nothing here is authority; every request is judged on the server.
 *
 * Outside a tenant App (no tenant lease) the log is empty and nothing is requested.
 */
import { api } from '@mistriwork/kit/client/core.js';
import { captureSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { EMPTY_READS, type ReadAuditAccess, type ReadAuditFilters, type ReadAuditPage } from './readAuditTypes.js';
import { say } from './copy/tenancy/readAuditAccess.js';

export type { ReadAuditAccess };

/* The route's own filter names: anything else a page passes is left behind rather than refused there. */
const TEXT = ['actor', 'resource', 'record', 'since', 'until'] as const;

export function createReadAuditAccess(): ReadAuditAccess {
  return {
    async read(filters: ReadAuditFilters): Promise<ReadAuditPage> {
      const owner = captureSessionIdentity();
      if (owner.mode !== 'authenticated' || !owner.tenant?.tenantId || owner.tenant.realm) return EMPTY_READS;
      const body: Record<string, unknown> = {};
      for (const key of TEXT) if (typeof filters[key] === 'string' && filters[key] !== '') body[key] = filters[key];
      if (
        filters.parent &&
        typeof filters.parent.resource === 'string' &&
        filters.parent.resource !== '' &&
        typeof filters.parent.record === 'string' &&
        filters.parent.record !== ''
      ) {
        body.parent = { resource: filters.parent.resource, record: filters.parent.record };
      }
      if (typeof filters.before === 'number') body.before = filters.before;
      /* The tenant transport throws a refusal with its status and code (403 forbidden for a reader outside the gate);
         a reply that carries an error all the same is one too. */
      const reply = (await api('/api/reads', body)) as Record<string, unknown>;
      if (typeof reply?.error === 'string') throw Object.assign(new Error(reply.error), { code: reply.code });
      if (!Array.isArray(reply?.reads)) throw new Error(say('unreadable'));
      return reply as unknown as ReadAuditPage;
    },
  };
}
