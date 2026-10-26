/** Whose look and words a request is dressed in: a tenant, chosen by host or membership, never by a header alone. */
import type { IncomingMessage } from 'node:http';
import type { AppDef, AppUi } from '../../shared/app.js';
import type { RecordBrandingSpec } from '../../shared/branding.js';
import { getTenantHostIntent } from './tenantHosts.js';

export const recordBrandingSpec = (app: { ui: AppUi }): RecordBrandingSpec | undefined =>
  (app.ui as AppUi & { branding?: RecordBrandingSpec }).branding;

/** Host intent never wins over a disagreeing selected tenant. `admitted` must
 * come from the caller's genuine context, never a request header. */
export function brandingTenant(req: IncomingMessage, app: AppDef, url: URL, admitted?: string, allowHint = false): string | null {
  const spec = recordBrandingSpec(app);
  const host = getTenantHostIntent(req);
  const hints = url.searchParams.getAll('tenant');
  if ((host && host.app !== app.id) || hints.length > 1 || hints.some((value) => !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value))) return null;
  const hinted = hints[0];
  if (host && ((hinted && hinted !== host.tenant) || (admitted && admitted !== host.tenant))) return null;
  if (admitted && hinted && admitted !== hinted) return null;
  if (spec?.by === 'host') return host?.tenant ?? null;
  return admitted ?? (allowHint ? hinted : undefined) ?? null;
}
