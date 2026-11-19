/**
 * A tenant's own domains (docs/tenant-domains.md §4–5): `shop.acme.com` claimed from Settings → Domains or the CLI,
 * proven by two DNS records, re-checked daily, and served once its certificate is active.
 *
 * Proof is DNS, read over DNS-over-HTTPS with `fetch` and never the system resolver: the resolver a server happens to
 * be configured with may be a split-horizon or caching one that answers what the public internet would not, and a
 * domain is the tenant's only if the public internet says so. Two records together: the TXT token says this claim's
 * owner controls the zone, and the CNAME (or, at an apex, addresses that match a target's) says the traffic would
 * actually arrive here. Either alone is not enough — a token without the pointer serves nothing, and a pointer
 * without the token is any CNAME anyone happened to leave at a tenant's subdomain.
 *
 * A host row is presentation, never authority (tenantHosts.ts): a live custom domain draws its tenant's public pages
 * and offers a host sign-in, and the door still authorizes every read against the session's own tenant.
 */
import { isIP } from 'node:net';
import type { TenantHostRow } from './tenantHosts.js';
import type { TenantHostChange } from '../tenant/tenantHostStore.js';
import type { TenantMaintenanceTarget } from '../tenant/tenantMaintenance.js';
import type { TenantDomain } from './tenantHosts.js';

/* ---------- configuration ---------- */

type CertificateMode = 'none' | 'caddy' | 'cloudflare';

/** The suite's `customDomains`, validated; undefined when the suite has none or has `enabled: false`. */
export interface CustomDomainsConfig {
  /** The hostname a tenant's CNAME points at when it has no subdomain (a suite with no `tenantDomain`). */
  readonly target?: string;
  /** How many domains one tenant may claim, pending ones included. */
  readonly limit: number;
  readonly certificates: CertificateMode;
  /** The tenant roles that may add, check and remove domains; when unset, the App's branding editors. */
  readonly editors?: readonly string[];
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ROLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * `customDomains: { enabled: true, target?, limit?, certificates?, editors? }`. A tenant's CNAME needs somewhere to
 * point, so a suite with no `tenantDomain` must name a `target`; and a public origin is required, because the staff
 * host is the one address a custom domain can never take and the place a host sign-in's staff leg lives.
 */
export function validateCustomDomains(
  value: unknown,
  context: { tenantDomain?: TenantDomain; publicOrigin?: string },
): CustomDomainsConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Suite customDomains must be an object: { enabled, target?, limit?, certificates?, editors? }.');
  const raw = value as Record<string, unknown>;
  const unknownKey = Object.keys(raw).find((key) => !['enabled', 'target', 'limit', 'certificates', 'editors'].includes(key));
  if (unknownKey) throw new Error(`Suite customDomains has an unsupported field "${unknownKey}".`);
  if (typeof raw.enabled !== 'boolean') throw new Error('Suite customDomains.enabled must be true or false.');
  if (!raw.enabled) return undefined;
  if (!context.publicOrigin) throw new Error('Suite customDomains needs publicOrigin: the staff host a custom domain never takes.');
  let target: string | undefined;
  if (raw.target !== undefined) {
    if (typeof raw.target !== 'string' || !HOSTNAME.test(raw.target) || isIP(raw.target))
      throw new Error('Suite customDomains.target must be a lowercase hostname, such as "domains.yourapp.com".');
    target = raw.target;
  }
  if (!target && !context.tenantDomain)
    throw new Error("Suite customDomains needs a target, or a tenantDomain whose subdomains a tenant's CNAME can point at.");
  const limit = raw.limit ?? 2;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Suite customDomains.limit must be a whole number from 1 to 100.');
  const certificates = raw.certificates ?? 'none';
  if (certificates !== 'none' && certificates !== 'caddy' && certificates !== 'cloudflare')
    throw new Error('Suite customDomains.certificates must be "none", "caddy" or "cloudflare".');
  let editors: readonly string[] | undefined;
  if (raw.editors !== undefined) {
    if (!Array.isArray(raw.editors) || !raw.editors.length || raw.editors.some((role) => typeof role !== 'string' || !ROLE.test(role)))
      throw new Error('Suite customDomains.editors must be a non-empty list of tenant role names.');
    editors = Object.freeze([...raw.editors] as string[]);
  }
  return Object.freeze({ ...(target ? { target } : {}), limit, certificates, ...(editors ? { editors } : {}) });
}

/* ---------- DNS over HTTPS ---------- */

export type DnsRecordType = 'TXT' | 'CNAME' | 'A' | 'AAAA';
/** The answers of one type at one name ([] when there are none), or 'unavailable' when no resolver answered. */
export interface DnsResolver {
  lookup(name: string, type: DnsRecordType): Promise<readonly string[] | 'unavailable'>;
}

const TYPE_CODE: Record<DnsRecordType, number> = { A: 1, CNAME: 5, TXT: 16, AAAA: 28 };
/** By address, so the lookup does not itself depend on the system resolver it is avoiding. */
const DOH_ENDPOINTS = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/resolve'] as const;
const DOH_TIMEOUT_MS = 5_000;

/** A TXT answer's data is its quoted character-strings; a long value comes split in several, read as one. */
function txtValue(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!.replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : data;
}

/** Cloudflare's 1.1.1.1 first, Google's 8.8.8.8 when it does not answer; each JSON API, each with a timeout. */
export function dohResolver(fetcher: typeof fetch = fetch): DnsResolver {
  return {
    async lookup(name, type) {
      for (const endpoint of DOH_ENDPOINTS) {
        try {
          const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
          const response = await fetcher(url, {
            headers: { accept: 'application/dns-json' },
            signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
            redirect: 'error',
          });
          if (!response.ok) continue;
          const body = (await response.json()) as { Status?: unknown; Answer?: unknown };
          // NXDOMAIN is an answer: there is nothing there. SERVFAIL and the rest are not, so the next resolver is asked.
          if (body.Status === 3) return [];
          if (body.Status !== 0) continue;
          const answers = Array.isArray(body.Answer) ? body.Answer : [];
          return answers
            .filter(
              (answer): answer is { type: number; data: string } => answer?.type === TYPE_CODE[type] && typeof answer.data === 'string',
            )
            .map((answer) => (type === 'TXT' ? txtValue(answer.data) : answer.data.toLowerCase().replace(/\.$/, '')));
        } catch {
          continue;
        }
      }
      return 'unavailable';
    },
  };
}

/** The TXT name that holds a domain's token. */
const verifyName = (host: string) => `_mistri-verify.${host}`;

type DnsVerdict = 'ok' | 'failed' | 'unavailable';

/**
 * Whether `host` carries `token` and points here. Pointing is a CNAME at one of `targets`, or — at an apex, where a
 * CNAME is not allowed and a provider's ALIAS or flattening answers with addresses instead — A/AAAA addresses that
 * are all a target's own. 'unavailable' when the resolvers could not be asked, which is not a failure of the domain.
 */
export async function verifyCustomDomain(
  resolver: DnsResolver,
  host: string,
  token: string,
  targets: readonly string[],
): Promise<DnsVerdict> {
  const txt = await resolver.lookup(verifyName(host), 'TXT');
  if (txt === 'unavailable') return 'unavailable';
  if (!txt.includes(token)) return 'failed';
  const cname = await resolver.lookup(host, 'CNAME');
  if (cname === 'unavailable') return 'unavailable';
  if (cname.some((name) => targets.includes(name))) return 'ok';
  if (cname.length) return 'failed';
  const addresses = async (name: string) => {
    const [a, aaaa] = await Promise.all([resolver.lookup(name, 'A'), resolver.lookup(name, 'AAAA')]);
    return a === 'unavailable' || aaaa === 'unavailable' ? 'unavailable' : [...a, ...aaaa];
  };
  const own = await addresses(host);
  if (own === 'unavailable') return 'unavailable';
  if (!own.length) return 'failed';
  const theirs = new Set<string>();
  for (const target of targets) {
    const each = await addresses(target);
    if (each === 'unavailable') return 'unavailable';
    for (const address of each) theirs.add(address);
  }
  return own.every((address) => theirs.has(address)) ? 'ok' : 'failed';
}

/* ---------- certificates ---------- */

export type CertificateState = 'pending' | 'active' | 'failed';
/** Where a verified domain's certificate comes from. `request` asks for one, `status` reads it, `release` gives it up. */
export interface HostCertificates {
  /** `tenantId` is whose domain it is, so a provider can mark what it creates and touch nothing it did not. */
  request(host: string, tenantId: string): Promise<CertificateState>;
  status(host: string, tenantId: string): Promise<CertificateState>;
  release(host: string, tenantId: string): Promise<void>;
}

/** `none`: a proxy in front holds certificates however it likes; `caddy`: Caddy's on-demand TLS issues one at the first
 * handshake, once `/_mistri/tls-allowed` says yes. Neither has anything to wait for, so a verified domain is live. */
export const ACTIVE_ON_VERIFY: HostCertificates = Object.freeze({
  request: async () => 'active' as const,
  status: async () => 'active' as const,
  release: async () => {},
});

/** The suite's certificate provider. Cloudflare's lives in `@mistriwork/cloudflare`, which a Cloudflare deployment
 * already installs; it is loaded only when named, so nothing else depends on it. */
export async function hostCertificatesFor(mode: CertificateMode, environment: NodeJS.ProcessEnv): Promise<HostCertificates> {
  if (mode !== 'cloudflare') return ACTIVE_ON_VERIFY;
  const specifier = '@mistriwork/cloudflare/host-certificates';
  let loaded: { cloudflareHostCertificates(options: { environment: NodeJS.ProcessEnv }): HostCertificates };
  try {
    loaded = await import(specifier);
  } catch {
    throw new Error('Suite customDomains.certificates "cloudflare" needs @mistriwork/cloudflare installed beside mistri.');
  }
  return loaded.cloudflareHostCertificates({ environment });
}

/* ---------- which names a tenant may claim ---------- */

/** Names that never resolve on the public internet, so a claim of one could never be proven and only clutters. */
const SPECIAL_SUFFIXES = ['localhost', 'local', 'invalid', 'internal', 'onion', 'arpa'];

/** Why `host` cannot be claimed, or undefined when it can. Every reason is about the name, never about who holds it. */
export function customHostRefusal(
  host: string,
  context: {
    staffHost?: string;
    tenantDomain?: TenantDomain;
    target?: string;
    /** Whether any App or tenant holds the name already, in any state, as the router last read every table. */
    held: (host: string) => boolean;
  },
): string | undefined {
  if (typeof host !== 'string' || host.length > 253 || !HOSTNAME.test(host) || isIP(host))
    return 'Enter a domain name such as shop.example.com: lowercase, with no scheme, port, path or wildcard.';
  const top = host.slice(host.lastIndexOf('.') + 1);
  if (SPECIAL_SUFFIXES.includes(top) || /^\d+$/.test(top)) return `${host} is not a public domain name.`;
  if (host === context.staffHost || host === context.target) return `${host} is one of this platform's own addresses.`;
  const parent = context.tenantDomain?.domain;
  if (parent && (host === parent || host.endsWith(`.${parent}`)))
    return `${host} is under ${parent}: a subdomain there is claimed as a subdomain, not added as a custom domain.`;
  if (context.held(host)) return `The address ${host} is already taken.`;
  return undefined;
}

/** What a tenant adds at its DNS provider. The CNAME's name is the domain itself; the TXT's is beside it. */
function customDomainRecords(host: string, target: string, token: string) {
  return Object.freeze({
    cname: Object.freeze({ type: 'CNAME' as const, name: host, value: target }),
    txt: Object.freeze({ type: 'TXT' as const, name: verifyName(host), value: token }),
    /** Two labels is a zone's apex, where most providers refuse a CNAME: the panel says to use `www`, or ALIAS. */
    apex: host.split('.').length === 2,
  });
}

/* ---------- the check's state machine ---------- */

/** How long a failing streak may run before it is suspended: three failures inside it, not three in a row forever.
 * It is also how long a check's answers may be only "DNS unavailable" before that counts as a failure. */
export const SUSPEND_WINDOW_MS = 72 * 60 * 60 * 1000;
export const SUSPEND_AFTER = 3;
/** A claimed domain no check has verified is dropped this long after it was added: a claim is stored with no DNS
 * proof, so without an end it would hold a name suite-wide for as long as anyone kept it. */
export const PENDING_DOMAIN_DAYS = 7;
export const PENDING_EXPIRY_MS = PENDING_DOMAIN_DAYS * 24 * 60 * 60 * 1000;

/**
 * What one check makes of a row. A pending domain only records that it was looked at: it serves nothing, so there
 * is nothing to suspend. A verified or live one that fails counts toward suspension, the streak starting over when
 * its last check is older than the window; a suspended one waits for a check that passes, which restores it.
 */
export function nextHostState(
  row: Pick<TenantHostRow, 'status' | 'checkedAt' | 'failures'>,
  verdict: Exclude<DnsVerdict, 'unavailable'>,
  certificate: CertificateState | undefined,
  now: number,
): TenantHostChange {
  if (verdict === 'ok')
    return {
      status: certificate === 'active' ? 'live' : row.status === 'pending' ? 'verified' : row.status === 'live' ? 'live' : 'verified',
      checkedAt: now,
      failures: 0,
      unavailableSince: null,
    };
  if (row.status === 'pending' || row.status === 'suspended')
    return { status: row.status, checkedAt: now, failures: row.failures, unavailableSince: null };
  const streak = row.checkedAt !== null && now - row.checkedAt <= SUSPEND_WINDOW_MS && row.failures > 0 ? row.failures + 1 : 1;
  return { status: streak >= SUSPEND_AFTER ? 'suspended' : row.status, checkedAt: now, failures: streak, unavailableSince: null };
}

/* ---------- the service a Domains panel and the CLI share ---------- */

/** What a session may ask of its tenant's Domains routes (tenant/tenantHttp.ts): a check of one domain this often, and
 * this many adds, removals and primary changes a minute. A check reads DNS and calls the certificate provider. */
export const DOMAIN_CHECK_EVERY_MS = 30_000;
export const DOMAIN_CHANGES_PER_MINUTE = 10;

interface CustomDomainView {
  readonly host: string;
  readonly kind: TenantHostRow['kind'];
  readonly status: TenantHostRow['status'];
  readonly primary: boolean;
  /** Whether the tenant added it (and so may remove it), as against a host the operator set up. */
  readonly claimed: boolean;
  readonly checkedAt: number | null;
  readonly failures: number;
  /** For a `pending` claim, when it is dropped unless a check has verified it by then. */
  readonly expiresAt?: number;
  readonly records?: ReturnType<typeof customDomainRecords>;
}

export class CustomDomainRefusal extends Error {
  constructor(
    message: string,
    readonly status: number = 422,
  ) {
    super(message);
  }
}

type Maintenance = typeof import('../tenant/tenantMaintenance.js');
export interface TenantDomainsStore {
  readonly where: TenantMaintenanceTarget;
  readonly owner: { appId: string; source: { id: string; connection: string }; storeId: string };
}

interface CustomDomainsSeams {
  readonly config: CustomDomainsConfig;
  readonly certificates: HostCertificates;
  readonly resolver: DnsResolver;
  readonly staffHost?: string;
  readonly tenantDomain?: TenantDomain;
  /** Which App and tenant hold a name in any state, across every App's table: read fresh, since a claim depends on it. */
  readonly heldBy: (host: string) => Promise<Readonly<{ app: string; tenant: string }> | undefined>;
  /** One App's host rows as the router last read them, or undefined before it has: what a plain list is served from,
   * so reading the panel opens no transaction. */
  readonly snapshot?: (appId: string) => readonly TenantHostRow[] | undefined;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

export interface TenantDomainsService {
  readonly limit: number;
  readonly editors: readonly string[] | undefined;
  /** From the router's snapshot when there is one, unless `fresh`: a change's own reply reads the table itself. */
  list(tenantId: string, fresh?: boolean): Promise<readonly CustomDomainView[]>;
  add(tenantId: string, host: string, actor: string): Promise<CustomDomainView>;
  /** `from` is the status before this check: a panel or a log tells a transition by it differing from `status`. */
  check(tenantId: string, host: string, actor: string): Promise<CustomDomainView & { outcome: DnsVerdict; from: TenantHostRow['status'] }>;
  remove(tenantId: string, host: string, actor: string): Promise<void>;
  primary(tenantId: string, host: string, actor: string): Promise<void>;
  /** Every verified, live and suspended custom domain not checked in the last `dueAfterMs`, checked once, and every
   * claim still `pending` after PENDING_EXPIRY_MS dropped: the hourly job. */
  recheckDue(dueAfterMs: number): Promise<{
    checked: number;
    suspended: readonly Readonly<{ host: string; tenantId: string }>[];
    /** Domains that became live in this pass (a verified one whose certificate went active, or a suspended one restored). */
    live: readonly Readonly<{ host: string; tenantId: string; from: TenantHostRow['status'] }>[];
    expired: readonly Readonly<{ host: string; tenantId: string }>[];
  }>;
}

/** A maintenance operator name from a session's account id, which may hold characters the receipt's actor does not. */
function domainOperator(actor: string): string {
  const cleaned = actor
    .replace(/[^A-Za-z0-9._@-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128);
  return cleaned || 'tenant-admin';
}

export function createTenantDomains(store: TenantDomainsStore, seams: CustomDomainsSeams): TenantDomainsService {
  const { config, certificates, resolver } = seams;
  const now = seams.now ?? Date.now;
  const warn = seams.warn ?? ((message: string) => console.warn(message));
  const maintenance = (): Promise<Maintenance> => import('../tenant/tenantMaintenance.js');
  const rows = async () => (await maintenance()).listTenantHosts(store.where, store.owner);
  const appId = store.owner.appId;
  /* Where a tenant's CNAME points: its own subdomain, the address its pages already answer on, when it has a live
     one; otherwise the operator's target. Both are accepted on a check, so a tenant that later gets a subdomain is
     not made to change a record that already works. */
  const targetsOf = (all: readonly TenantHostRow[], tenantId: string) => {
    const subdomains = all
      .filter((row) => row.tenantId === tenantId && row.kind === 'subdomain' && row.status === 'live')
      .sort((a, b) => Number(b.primary) - Number(a.primary))
      .map((row) => row.host);
    return [...subdomains, ...(config.target ? [config.target] : [])];
  };
  const viewOf = (row: TenantHostRow, targets: readonly string[]): CustomDomainView =>
    Object.freeze({
      host: row.host,
      kind: row.kind,
      status: row.status,
      primary: row.primary,
      claimed: row.source === 'claimed',
      checkedAt: row.checkedAt,
      failures: row.failures,
      ...(row.kind === 'custom' && row.source === 'claimed' && row.status === 'pending'
        ? { expiresAt: row.createdAt + PENDING_EXPIRY_MS }
        : {}),
      ...(row.kind === 'custom' && row.verifyToken && targets[0]
        ? { records: customDomainRecords(row.host, targets[0], row.verifyToken) }
        : {}),
    });
  const own = async (tenantId: string, host: string) => {
    const all = await rows();
    const row = all.find((each) => each.host === host);
    // Another tenant's row reads as no row: the refusal is the same either way, so it tells nothing about who holds it.
    if (!row || row.tenantId !== tenantId) throw new CustomDomainRefusal(`${host} is not one of this organization's domains.`, 404);
    return { all, row };
  };
  const refusing = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CustomDomainRefusal) throw error;
      const { TenantMaintenanceRefusal } = await maintenance();
      if (error instanceof TenantMaintenanceRefusal) throw new CustomDomainRefusal(error.message, 409);
      throw error;
    }
  };

  /** One check: DNS and the certificate outside a transaction, the outcome written compare-and-set on what was read. */
  const checkRow = async (row: TenantHostRow, all: readonly TenantHostRow[], operator: string) => {
    if (row.kind !== 'custom' || row.source !== 'claimed' || !row.verifyToken)
      throw new CustomDomainRefusal(`${row.host} was set up by the operator and is not checked here.`, 409);
    const verdict = await verifyCustomDomain(resolver, row.host, row.verifyToken, targetsOf(all, row.tenantId));
    let counted: Exclude<DnsVerdict, 'unavailable'> | undefined = verdict === 'unavailable' ? undefined : verdict;
    if (verdict === 'unavailable') {
      // Nothing was learned about the domain, and a pending or suspended one serves nothing there is to lose.
      if (row.status === 'pending' || row.status === 'suspended') return { row, verdict };
      const since = row.unavailableSince ?? now();
      if (now() - since < SUSPEND_WINDOW_MS) {
        if (row.unavailableSince !== null) return { row, verdict };
        // The streak begins: said once, with the name and no more (no token, no record values).
        warn(
          `Custom domain ${row.host} (${appId}): DNS could not be read; it counts as failing if that lasts ${SUSPEND_WINDOW_MS / 3_600_000} hours.`,
        );
        const next: TenantHostChange = { status: row.status, checkedAt: row.checkedAt, failures: row.failures, unavailableSince: since };
        await (
          await maintenance()
        ).recordTenantHostCheck(store.where, store.owner, { tenantId: row.tenantId, host: row.host, operator, read: row, next });
        return { row: Object.freeze({ ...row, ...next }), verdict };
      }
      // Nothing but "unavailable" for the whole window: as good as a failed check, and on the same path to suspension.
      counted = 'failed';
    }
    let certificate: CertificateState | undefined;
    if (counted === 'ok') {
      try {
        certificate =
          row.status === 'pending' || row.status === 'suspended'
            ? await certificates.request(row.host, row.tenantId)
            : await certificates.status(row.host, row.tenantId);
        if (certificate === 'failed') certificate = await certificates.request(row.host, row.tenantId);
      } catch (error) {
        // A provider's error is the provider's; the domain stays verified and the next check asks again.
        warn(`Custom domain ${row.host}: the certificate request did not complete (${(error as Error).name}).`);
        certificate = 'pending';
      }
    }
    const decided = nextHostState(row, counted!, certificate, now());
    // A streak of "unavailable" that is being counted as failures stays on the row until a real answer ends it.
    const next: TenantHostChange = verdict === 'unavailable' ? { ...decided, unavailableSince: row.unavailableSince } : decided;
    if (
      next.status === row.status &&
      next.checkedAt === row.checkedAt &&
      next.failures === row.failures &&
      next.unavailableSince === row.unavailableSince
    )
      return { row, verdict };
    await (
      await maintenance()
    ).recordTenantHostCheck(store.where, store.owner, { tenantId: row.tenantId, host: row.host, operator, read: row, next });
    return { row: Object.freeze({ ...row, ...next }), verdict };
  };

  return {
    limit: config.limit,
    editors: config.editors,
    async list(tenantId, fresh = false) {
      const all = (!fresh && seams.snapshot?.(appId)) || (await rows());
      const targets = targetsOf(all, tenantId);
      return Object.freeze(all.filter((row) => row.tenantId === tenantId).map((row) => viewOf(row, targets)));
    },
    async add(tenantId, input, actor) {
      const host = typeof input === 'string' ? input.trim().toLowerCase().replace(/\.$/, '') : '';
      const holder = HOSTNAME.test(host) ? await seams.heldBy(host) : undefined;
      const refusal = customHostRefusal(host, {
        ...(seams.staffHost ? { staffHost: seams.staffHost } : {}),
        ...(seams.tenantDomain ? { tenantDomain: seams.tenantDomain } : {}),
        ...(config.target ? { target: config.target } : {}),
        held: () => holder !== undefined,
      });
      if (refusal) throw new CustomDomainRefusal(refusal);
      const all = await rows();
      if (!targetsOf(all, tenantId).length)
        throw new CustomDomainRefusal('This organization has no address for a domain to point at yet: ask the operator for one.', 409);
      await refusing(async () =>
        (await maintenance()).addCustomTenantHost(store.where, store.owner, {
          tenantId,
          host,
          operator: domainOperator(actor),
          limit: config.limit,
        }),
      );
      const after = await rows();
      const row = after.find((each) => each.host === host)!;
      return viewOf(row, targetsOf(after, tenantId));
    },
    async check(tenantId, host, actor) {
      return refusing(async () => {
        const { all, row } = await own(tenantId, host);
        const checked = await checkRow(row, all, domainOperator(actor));
        return Object.freeze({ ...viewOf(checked.row, targetsOf(all, tenantId)), outcome: checked.verdict, from: row.status });
      });
    },
    async remove(tenantId, host, actor) {
      const { row } = await own(tenantId, host);
      // The subdomain and any host the operator configured are the operator's; only a claimed domain is the tenant's.
      if (row.kind !== 'custom' || row.source !== 'claimed')
        throw new CustomDomainRefusal(`${host} is the platform's address for this organization and is not removed here.`, 409);
      const removed = await refusing(async () =>
        (await maintenance()).removeTenantHost(store.where, store.owner, { host, operator: domainOperator(actor), tenantId }),
      );
      if (certificateRequested(removed)) await releaseCertificate(certificates, host, removed.tenantId, warn);
    },
    async primary(tenantId, host, actor) {
      await own(tenantId, host);
      await refusing(async () =>
        (await maintenance()).setPrimaryTenantHost(store.where, store.owner, { tenantId, host, operator: domainOperator(actor) }),
      );
    },
    async recheckDue(dueAfterMs) {
      const all = await rows();
      const suspended: { host: string; tenantId: string }[] = [];
      const live: { host: string; tenantId: string; from: TenantHostRow['status'] }[] = [];
      const expired: { host: string; tenantId: string }[] = [];
      let checked = 0;
      const due = now() - dueAfterMs;
      for (const row of all) {
        if (row.kind === 'custom' && row.source === 'claimed' && row.status === 'pending' && now() - row.createdAt >= PENDING_EXPIRY_MS) {
          try {
            if (
              await (
                await maintenance()
              ).expirePendingTenantHost(store.where, store.owner, {
                host: row.host,
                operator: 'domain-expiry',
                madeBefore: now() - PENDING_EXPIRY_MS,
              })
            )
              expired.push({ host: row.host, tenantId: row.tenantId });
          } catch (error) {
            warn(`Custom domain ${row.host} (${appId}): dropping its unverified claim did not complete: ${(error as Error).message}`);
          }
          continue;
        }
        if (row.kind !== 'custom' || row.source !== 'claimed' || !row.verifyToken || row.status === 'pending') continue;
        if (row.checkedAt !== null && row.checkedAt > due) continue;
        try {
          const result = await checkRow(row, all, 'domain-check');
          checked++;
          if (row.status !== 'suspended' && result.row.status === 'suspended') suspended.push({ host: row.host, tenantId: row.tenantId });
          if (row.status !== 'live' && result.row.status === 'live')
            live.push({ host: row.host, tenantId: row.tenantId, from: row.status });
        } catch (error) {
          warn(`Custom domain ${row.host} (${appId}): the daily check did not complete: ${(error as Error).message}`);
        }
      }
      return { checked, suspended, live, expired };
    },
  };
}

/** Whether a removed row ever asked the provider for a certificate: a tenant's own domain that a check had verified.
 * A pending claim never did, and an operator's host was never ours to ask for, so neither has one to give up: releasing
 * by name would delete a certificate that is someone else's. */
export function certificateRequested(row: Pick<TenantHostRow, 'kind' | 'source' | 'status'>): boolean {
  return row.kind === 'custom' && row.source === 'claimed' && row.status !== 'pending';
}

/** Release is best effort: a removal never waits on, or fails because of, the certificate provider. */
export async function releaseCertificate(
  certificates: HostCertificates,
  host: string,
  tenantId: string,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await certificates.release(host, tenantId);
  } catch (error) {
    warn(`Custom domain ${host}: releasing its certificate failed (${(error as Error).name}); the domain is removed regardless.`);
  }
}
