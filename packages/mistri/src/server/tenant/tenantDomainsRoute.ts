/**
 * A tenant's custom domains, served on its own lease (tenantHttp.ts): read by any member and changed only by the
 * roles the suite names as their editors (the App's branding editors when it names none), in their own tenant. Not in
 * the platform realm, and never by a support operator: an address is the tenant's to point. A member who is not an
 * editor sees the domains without their records, which carry the verification token.
 */
import { FixedWindowLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { CustomDomainRefusal, DOMAIN_CHANGES_PER_MINUTE, DOMAIN_CHECK_EVERY_MS, type TenantDomainsService } from '../http/customDomains.js';
import type { VerifiedSessionInstance } from '../auth/auth.js';
import type { TenantBrandingService } from './tenantBranding.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';

const PATHS = new Set(['/api/domains', '/api/domains/add', '/api/domains/check', '/api/domains/remove', '/api/domains/primary']);

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

export function tenantDomainsRoute(tenantDomains: TenantDomainsService, tenantBranding: TenantBrandingService | undefined) {
  /* The panel's changes are counted per session and tenant, so one person's clicking (or a script holding a session)
     cannot make the server do DNS and provider calls without end: a check of one domain once in 30 seconds, and ten
     adds, removals and primary changes a minute together. In this process, like the public forms' limits. */
  const checks = new FixedWindowLimiter([{ limit: 1, ms: DOMAIN_CHECK_EVERY_MS }], Date.now, { whenFull: 'evict' });
  const changes = new FixedWindowLimiter([{ limit: DOMAIN_CHANGES_PER_MINUTE, ms: 60_000 }], Date.now, { whenFull: 'evict' });
  const reply = (body: unknown): Answer => ({ status: 200, body });
  return {
    serves: (path: string) => PATHS.has(path),
    async answer(
      path: string,
      input: Record<string, unknown>,
      principal: { roles: readonly string[] },
      where: { platform: boolean; onSupport: boolean },
      verified: () => Promise<VerifiedSessionInstance | null>,
    ): Promise<Answer> {
      const tenantId = (principal as { tenantId?: unknown }).tenantId;
      if (where.platform || where.onSupport || typeof tenantId !== 'string')
        return { status: 404, body: { error: 'Not found.', code: 'not_found' } };
      const editors = tenantDomains.editors ?? tenantBranding?.declaration.editors ?? [];
      const editor = principal.roles.some((role) => editors.includes(role));
      const listed = async (fresh = false) => {
        const domains = await tenantDomains.list(tenantId, fresh);
        return {
          domains: editor ? domains : domains.map(({ records: _records, ...rest }) => rest),
          limit: tenantDomains.limit,
          editor,
        };
      };
      if (path === '/api/domains') return reply(await listed());
      if (!editor)
        return {
          status: 403,
          body: { error: "Only this organization's admins may change its domains.", code: 'forbidden', outcome: 'not_applied' },
        };
      const session = await verified();
      if (!session) return denyTenant();
      const host = typeof input.host === 'string' ? input.host : '';
      const actor = session.identity.id;
      const decision = (path === '/api/domains/check' ? checks : changes).take(
        `${session.sessionId}\n${tenantId}${path === '/api/domains/check' ? `\n${host}` : ''}`,
      );
      if (!decision.ok)
        return {
          status: 429,
          body: { error: 'Too many domain changes just now: try again shortly.', code: 'rate_limited', outcome: 'not_applied' },
          headers: { 'retry-after': String(decision.retryAfterSeconds) },
        };
      try {
        if (path === '/api/domains/add') await tenantDomains.add(tenantId, host, actor);
        else if (path === '/api/domains/remove') await tenantDomains.remove(tenantId, host, actor);
        else if (path === '/api/domains/primary') await tenantDomains.primary(tenantId, host, actor);
        else {
          const checked = await tenantDomains.check(tenantId, host, actor);
          return reply({ ...(await listed(true)), outcome: checked.outcome });
        }
      } catch (error) {
        if (error instanceof CustomDomainRefusal)
          return { status: error.status, body: { error: error.message, code: 'domain_refused', outcome: 'not_applied' } };
        throw error;
      }
      return reply(await listed(true));
    },
  };
}
