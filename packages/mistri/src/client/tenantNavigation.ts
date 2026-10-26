import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { invalidateSession } from '@mistriwork/kit/client/sessionLifecycle.js';
import { parseTenantLink } from './tenantLink.js';

interface TenantNavigationHost {
  currentHref: () => string;
  replace: (href: string) => void;
  apply: (href: string) => void;
  canLeave: () => Promise<boolean>;
  reload: () => void;
  invalid: () => void;
}
let generation = 0;

/** Back/Forward cannot reinterpret a foreign or unqualified link in the current
 * tenant. Fresh document entry rechecks native auth and requires explicit choice;
 * header switching remains the separate in-place CAS workflow. */
export async function followTenantHistory(href: string, host: TenantNavigationHost, ready = true): Promise<void> {
  const ticket = ++generation,
    owner = sessionIdentity();
  if (!owner.tenantRequired) return;
  // No confirmed walk exists during initial boot or switch recovery. Retire
  // its callbacks before a fresh entry can act on the new browser address.
  if (!owner.tenant || !ready) {
    invalidateSession('unavailable', false);
    host.reload();
    return;
  }
  let link: ReturnType<typeof parseTenantLink>;
  const previous = host.currentHref();
  try {
    link = parseTenantLink(href, owner.tenant.appId);
  } catch {
    host.replace(previous);
    host.invalid();
    return;
  }
  if (link.tenantId === owner.tenant.tenantId) {
    host.apply(href);
    return;
  }
  // While an editing-exit decision is pending, URL and rendered owner must agree.
  host.replace(previous);
  let allowed = false;
  try {
    allowed = await host.canLeave();
  } catch {
    /* Stay with the confirmed owner. */
  }
  if (!allowed || ticket !== generation || sessionIdentity() !== owner) return;
  host.replace(href);
  invalidateSession('unavailable', false);
  host.reload();
}
