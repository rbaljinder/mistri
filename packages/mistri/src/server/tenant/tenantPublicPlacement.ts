/**
 * Where a tenant App's public request lands: one rule for a public form's read, its submission and every saved step
 * (tenantPublicHttp.ts), and for the flags and experiments its page reads (tenantAuthenticatedHttp.ts). On the shared
 * host, the address the request carries places it — a form's link `?via=`, a page's experiment selection header. On this
 * App's mapped host, the host names the tenant and places it by that tenant's own intake address, which the intake
 * resolves and fences as it does a link's. A request there that carries an address too would name a second tenant, and
 * what was drawn under one tenant's host would land with another, so it is refused (`conflict`) before anything else.
 */
import type { IncomingMessage } from 'node:http';
import { getTenantHostIntent } from '../http/tenantHosts.js';

interface TenantPublicPlacement {
  /** This App's mapped host and an address the request carries at once: two tenants named, answered 400. */
  readonly conflict: boolean;
  /** The intake address the request lands by; a tenant that holds none, or a read of it that fails, places nothing. */
  address(): Promise<string | undefined>;
}

export function tenantPublicPlacement(
  req: IncomingMessage,
  app: string,
  /** The address the request carries, `undefined` when it carries none (an empty one is still carried). */
  carried: string | undefined,
  /** A tenant's own intake address, for the mapped host; absent where the deployment has no intake. */
  hostAddress?: (tenant: string) => Promise<string | undefined>,
): TenantPublicPlacement {
  const host = getTenantHostIntent(req);
  const mapped = host?.app === app ? host : undefined;
  return Object.freeze({
    conflict: mapped !== undefined && carried !== undefined,
    async address() {
      if (!mapped) return carried;
      try {
        return await hostAddress?.(mapped.tenant);
      } catch {
        return undefined;
      }
    },
  });
}
