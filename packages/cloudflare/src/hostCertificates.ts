/**
 * Certificates for a tenant's own domains through Cloudflare for SaaS: a verified domain becomes a custom hostname
 * on the operator's zone (`POST /zones/{zone}/custom_hostnames`, HTTP validation, a DV certificate), its state is
 * read back until Cloudflare says the certificate is active, and the hostname is deleted when the domain is removed. Every hostname made here carries
 * `custom_metadata` naming mistri and the tenant, and one without it (made by someone else with the zone's token) is
 * neither read as a tenant's certificate nor deleted.
 * mistri loads this only when the suite says `customDomains.certificates: "cloudflare"` (http/customDomains.ts).
 *
 * The zone and the API token come from the environment and stay in this closure: they are never logged, stored, or
 * put in an error, which names only the host, the HTTP status and Cloudflare's numeric error codes. The zone's
 * fallback origin (the hostname custom hostnames are served from) is the operator's to set up in Cloudflare; this
 * does not touch it.
 *
 * The shape is mistri's HostCertificates seam, said again here so this package does not import the server.
 */

export type CertificateState = 'pending' | 'active' | 'failed';
export interface HostCertificates {
  request(host: string, tenantId: string): Promise<CertificateState>;
  status(host: string, tenantId: string): Promise<CertificateState>;
  release(host: string, tenantId: string): Promise<void>;
}

interface CloudflareHostCertificatesOptions {
  /** Where `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` are read. */
  environment: Record<string, string | undefined>;
  /** Cloudflare's API root; a test points it at a fake. */
  apiBase?: string;
  fetch?: typeof fetch;
}

const API = 'https://api.cloudflare.com/client/v4';
/** A zone id is 32 hex characters; checked so it can only ever be one path segment. */
const ZONE = /^[0-9a-f]{32}$/i;
/** The certificate states that are still on their way; `active` is done, and anything else (timed out, expired,
 * deleted) will not become active without a new request. */
const UNDER_WAY = new Set(['initializing', 'pending_validation', 'pending_issuance', 'pending_deployment', 'pending']);

interface CustomHostname {
  id: string;
  hostname: string;
  ssl?: { status?: string };
  custom_metadata?: Record<string, unknown> | null;
}
/** What every hostname made here is marked with. The zone may hold hostnames made by anyone else with its token, and a
 * name alone does not say whose a hostname is: only one carrying this marker and the tenant's id is touched. */
const MARKER = 'mistri-tenant-domain';
const metadataOf = (tenantId: string) => ({ mistri: MARKER, tenant: tenantId });
const ours = (found: CustomHostname, tenantId: string) =>
  found.custom_metadata?.mistri === MARKER && found.custom_metadata?.tenant === tenantId;
interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number }[];
  result?: T;
}

function stateOf(found: CustomHostname): CertificateState {
  const status = found.ssl?.status ?? '';
  if (status === 'active') return 'active';
  return UNDER_WAY.has(status) ? 'pending' : 'failed';
}

export function cloudflareHostCertificates(options: CloudflareHostCertificatesOptions): HostCertificates {
  const zone = options.environment.CLOUDFLARE_ZONE_ID?.trim() ?? '';
  const token = options.environment.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  if (!zone || !token)
    throw new Error('Custom domain certificates through Cloudflare need CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN set.');
  if (!ZONE.test(zone)) throw new Error('CLOUDFLARE_ZONE_ID is not a Cloudflare zone id (32 hexadecimal characters).');
  const base = `${(options.apiBase ?? API).replace(/\/+$/, '')}/zones/${zone}/custom_hostnames`;
  const fetcher = options.fetch ?? fetch;

  const call = async <T>(host: string, path: string, init: RequestInit = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`Cloudflare could not be reached for ${host}.`);
    }
    const body = (await response.json().catch(() => ({}))) as Envelope<T>;
    if (!response.ok || body.success === false) {
      const codes = (body.errors ?? []).map((error) => error.code).filter((code) => typeof code === 'number');
      throw new Error(`Cloudflare answered ${response.status} for ${host}${codes.length ? ` (error ${codes.join(', ')})` : ''}.`);
    }
    return body.result as T;
  };
  /* The hostname query is an exact match, but the answer is filtered again: only the row for this host may count. */
  const find = async (host: string): Promise<CustomHostname | undefined> =>
    (await call<CustomHostname[]>(host, `?hostname=${encodeURIComponent(host)}`))?.find((found) => found.hostname === host);

  return Object.freeze({
    /* A domain checked again after a restart or a suspension asks again: the existing hostname is read, not added
       twice, so a second request is not a 409. */
    async request(host: string, tenantId: string) {
      const found = await find(host);
      if (found) {
        // A hostname the zone already holds for someone else is not this domain's certificate, and is left as it is.
        if (!ours(found, tenantId)) throw new Error(`Cloudflare already holds ${host} for something else.`);
        return stateOf(found);
      }
      const made = await call<CustomHostname>(host, '', {
        method: 'POST',
        body: JSON.stringify({ hostname: host, ssl: { method: 'http', type: 'dv' }, custom_metadata: metadataOf(tenantId) }),
      });
      return stateOf(made);
    },
    async status(host: string, tenantId: string) {
      const found = await find(host);
      return found && ours(found, tenantId) ? stateOf(found) : 'failed';
    },
    async release(host: string, tenantId: string) {
      const found = await find(host);
      if (found && ours(found, tenantId)) await call<unknown>(host, `/${encodeURIComponent(found.id)}`, { method: 'DELETE' });
    },
  });
}
