/** Operator-owned host routing is presentation intent, never identity or tenant authority. */
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/** A hostname that shows a tenant's public pages (below). Presentation only: a row names whose pages a
 * host draws and never admits anyone, so it carries no version and takes no part in the membership fence. */
export interface TenantHostRow {
  readonly host: string;
  readonly tenantId: string;
  readonly app: string;
  /** `subdomain` under the platform's `tenantDomain`; `custom` is a domain the tenant owns. */
  readonly kind: 'subdomain' | 'custom';
  readonly status: 'pending' | 'verified' | 'live' | 'suspended';
  /** The tenant's canonical host: at most one per tenant. */
  readonly primary: boolean;
  /** `claimed` when made through a tenant's creation or the CLI, `operator` when seeded from the suite's static `hosts`. */
  readonly source: 'claimed' | 'operator';
  readonly verifyToken: string | null;
  readonly checkedAt: number | null;
  readonly failures: number;
  /** When the row was made: a claimed domain still `pending` a week later is dropped (http/customDomains.ts). */
  readonly createdAt: number;
  /** When the check's answers began being only "DNS unavailable", until a check gets any other answer; null when they are not. */
  readonly unavailableSince: number | null;
}
export interface TenantHostIntent {
  readonly host: string;
  readonly app: string;
  readonly tenant: string;
}

const intents = new WeakMap<IncomingMessage, TenantHostIntent>();

/** Consumers must independently authorize any tenant-scoped read. */
export function getTenantHostIntent(request: IncomingMessage): TenantHostIntent | undefined {
  return intents.get(request);
}

/** The same, for the tenant runtimes, whose request is whatever their host hands them (often not a Node request). */
export function tenantHostIntentOf(request: unknown): TenantHostIntent | undefined {
  return typeof request === 'object' && request !== null ? intents.get(request as IncomingMessage) : undefined;
}

/** Only internally synthesized requests inherit an admitted parent's intent.
 * Forwarding headers cannot establish it, and an existing intent cannot change. */
export function inheritTenantHostIntent(parent: IncomingMessage, child: IncomingMessage): void {
  const intent = intents.get(parent),
    existing = intents.get(child);
  if (existing && existing !== intent) throw new Error('Internal host intent conflicts with its parent.');
  if (intent) intents.set(child, intent);
}

function hostname(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    !value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    throw new Error('Suite host must be a hostname only, without credentials, port, wildcard or URL components.');
  }
  const canonical = value.toLowerCase();
  if (new URL(`http://${canonical}`).hostname !== canonical) throw new Error('Suite host must use its canonical hostname.');
  return canonical;
}

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** Independent of auth/email helpers: callers pass this normalized config value onward. */
export function normalizeSuitePublicOrigin(value: unknown): string {
  if (typeof value !== 'string' || /[\s@%]/.test(value) || !/^https?:\/\/[^/?#\\]+\/?$/.test(value)) {
    throw new Error('Suite publicOrigin must be an HTTPS origin (HTTP is allowed only on loopback).');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid suite publicOrigin.');
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))
  ) {
    throw new Error('Suite publicOrigin must be an HTTPS origin (HTTP is allowed only on loopback).');
  }
  if (url.hostname !== '[::1]') hostname(url.hostname);
  return url.origin;
}

export function validateTenantHosts(value: unknown, apps: readonly string[], publicOrigin?: string): readonly TenantHostIntent[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error('Suite hosts must be a list.');
  const staff = publicOrigin && new URL(publicOrigin).hostname;
  const seen = new Set<string>();
  return Object.freeze(
    value.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !['host', 'app', 'tenant'].includes(key)))
        throw new Error('Invalid suite host mapping.');
      const host = hostname(raw.host);
      if (loopback(host) || isIP(host) || host === staff || seen.has(host))
        throw new Error(`Suite host "${host}" is duplicated or collides with a staff/loopback origin.`);
      if (typeof raw.app !== 'string' || !apps.includes(raw.app)) throw new Error(`Suite host "${host}" names an unknown App.`);
      // eslint-disable-next-line no-control-regex -- Opaque tenant identifiers must exclude ASCII controls.
      if (typeof raw.tenant !== 'string' || !raw.tenant.trim() || raw.tenant !== raw.tenant.trim() || /[\x00-\x1f\x7f]/.test(raw.tenant)) {
        throw new Error(`Suite host "${host}" needs an opaque tenant id.`);
      }
      seen.add(host);
      return Object.freeze({ host, app: raw.app, tenant: raw.tenant });
    }),
  );
}

/** The real Host header only; duplicates and URL-shaped authorities fail closed. */
function requestHostname(req: IncomingMessage): string | undefined {
  if (req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length !== 1) return undefined;
  const value = req.headers.host;
  if (!value) return undefined;
  const match = /^(\[::1\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match || (match[2] !== undefined && (+match[2] < 1 || +match[2] > 65535))) return undefined;
  try {
    return match[1] === '[::1]' ? match[1] : hostname(match[1]);
  } catch {
    return undefined;
  }
}

/* ---------- the platform's wildcard parent ---------- */

/** Labels no tenant may claim: the ones a platform keeps for itself. The staff host's own label and the suite's
 * `tenantDomain.reserved` are added to these. */
const BUILT_IN_RESERVED_LABELS: readonly string[] = ['www', 'api', 'app', 'admin', 'mail', 'auth', 'static', 'assets', 'status', 'docs'];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The suite's `tenantDomain`: the parent under which a tenant's subdomain is one label. */
export interface TenantDomain {
  readonly domain: string;
  /** Every label a tenant cannot claim, whole: the built-ins, the suite's own and the staff host's. */
  readonly reserved: readonly string[];
}

/**
 * `tenantDomain: "yourapp.com"` or `{ domain, reserved?: [...] }`; undefined when the suite sets none. The shorter form
 * is the usual one. A registrable hostname only (no IP, port, wildcard or URL), because the wildcard is the platform's
 * to hold in DNS and a certificate, not a pattern the router matches. The staff host, if it is a direct child of the
 * domain, has its label reserved here rather than refused: it could never be claimed, which is what the rule is for.
 */
export function validateTenantDomain(value: unknown, publicOrigin?: string): TenantDomain | undefined {
  if (value === undefined) return undefined;
  let domainValue: unknown = value,
    extra: unknown;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).some((key) => !['domain', 'reserved'].includes(key)))
      throw new Error('Suite tenantDomain takes only domain and reserved.');
    ({ domain: domainValue, reserved: extra } = value as { domain?: unknown; reserved?: unknown });
  }
  if (typeof domainValue !== 'string') throw new Error('Suite tenantDomain must be a domain name, or { domain, reserved }.');
  const domain = hostname(domainValue);
  if (isIP(domain) || loopback(domain) || !domain.includes('.'))
    throw new Error(
      `Suite tenantDomain "${domain}" must be a registrable domain name (such as "yourapp.com"), not an IP address, a bare name or a loopback one.`,
    );
  if (extra !== undefined && (!Array.isArray(extra) || extra.some((label) => typeof label !== 'string' || !LABEL.test(label))))
    throw new Error('Suite tenantDomain reserved must be a list of lowercase single DNS labels.');
  const staff = publicOrigin && new URL(publicOrigin).hostname;
  const staffLabel =
    staff && staff.endsWith(`.${domain}`) && !staff.slice(0, -domain.length - 1).includes('.') ? [staff.slice(0, -domain.length - 1)] : [];
  return Object.freeze({
    domain,
    reserved: Object.freeze([...new Set([...BUILT_IN_RESERVED_LABELS, ...staffLabel, ...((extra as string[] | undefined) ?? [])])]),
  });
}

/** A one-line advisory for the operator, not an error: whether the domain is on the Public Suffix List is not
 * something to look up at startup (no network, no list shipped), and without it browsers treat every tenant's
 * subdomain as one site for cookies, storage and permission prompts. */
export function tenantDomainAdvisory(domain: TenantDomain): string {
  return (
    `Advisory: tenantDomain "${domain.domain}" should be on the Public Suffix List (publicsuffix.org), so that browsers ` +
    `keep each tenant's subdomain apart from the others for cookies, storage and permission prompts.`
  );
}

/** A tenant's name as a DNS label, or undefined when nothing usable is left of it. */
export function slugLabel(name: string): string | undefined {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return LABEL.test(label) ? label : undefined;
}

/** The host a label names under the domain, or an Error saying why it cannot be claimed. */
export function subdomainHost(domain: TenantDomain, label: string): string {
  const lower = label.toLowerCase();
  if (!LABEL.test(lower))
    throw new Error(`"${label}" is not a usable subdomain: one label of a–z, 0–9 and "-", not starting or ending with "-".`);
  if (domain.reserved.includes(lower)) throw new Error(`"${lower}" is reserved and cannot be a tenant's subdomain.`);
  return `${lower}.${domain.domain}`;
}

/** Whether a host is `<one label>.<domain>` with a label a tenant may hold. */
function isSubdomain(domain: TenantDomain | undefined, host: string): boolean {
  if (!domain || !host.endsWith(`.${domain.domain}`)) return false;
  const label = host.slice(0, -domain.domain.length - 1);
  return LABEL.test(label) && !domain.reserved.includes(label);
}

/* ---------- hosts that change: the table, read through a cache ---------- */

/** What the router reads one App's host rows from: its tenant store, behind `listTenantHosts` (tenantMaintenance.ts). */
export interface TenantHostSource {
  list(): Promise<readonly TenantHostRow[]>;
}

const hostChangeListeners = new Set<() => void>();
/** Called after a host row is written, so a router in this process reads the change now rather than at its next
 * refresh. Another process's change waits for the refresh interval. */
export function notifyTenantHostsChanged(): void {
  for (const listener of hostChangeListeners) listener();
}

/** How long a router trusts what it last read, when no write in its own process says otherwise. */
const HOST_REFRESH_MS = 30_000;

export function createTenantHostRouter(
  hosts: readonly TenantHostIntent[],
  publicOrigin?: string,
  options: { tenantDomain?: TenantDomain; refreshMs?: number; warn?: (message: string) => void } = {},
) {
  const mapped = new Map(hosts.map((intent) => [intent.host, Object.freeze({ ...intent })]));
  const staff = publicOrigin && new URL(publicOrigin).hostname;
  const { tenantDomain, warn = (message: string) => console.warn(message) } = options;
  /* The table is read as a whole into memory, and the door asks that snapshot, never the database, so the door stays
     synchronous and a flood of requests for hosts that are not rows costs nothing: an unknown host is a miss in a map
     (which is the negative cache), not a query. The snapshot is replaced every refresh interval and at once on a write
     made in this process (notifyTenantHostsChanged); a write by another process, the CLI's, shows within the interval.
     A read that fails keeps the last snapshot, so a database blip does not take every tenant's site down, and says so. */
  const sources = new Map<string, TenantHostSource>();
  const snapshots = new Map<string, readonly TenantHostRow[]>();
  let live = new Map<string, TenantHostIntent>();
  let primaries = new Map<string, string>();
  const rebuild = () => {
    const next = new Map<string, TenantHostIntent>();
    const first = new Map<string, string>();
    /* Each App's table keys its own hosts, so two Apps could each hold one name live (a custom domain added to both
       before either refresh saw the other). Such a host is served by neither, rather than by whichever was read last. */
    const holders = new Map<string, number>();
    for (const rows of snapshots.values())
      for (const row of rows) if (row.status === 'live') holders.set(row.host, (holders.get(row.host) ?? 0) + 1);
    for (const [app, rows] of snapshots) {
      for (const row of rows) {
        if (row.status !== 'live' || row.app !== app || mapped.has(row.host) || row.host === staff || holders.get(row.host) !== 1) continue;
        if (row.kind === 'subdomain' && !isSubdomain(tenantDomain, row.host)) continue;
        try {
          hostname(row.host);
        } catch {
          continue;
        }
        // One object per host while its row is unchanged: a request is admitted under one intent for its whole life.
        const known = live.get(row.host);
        next.set(
          row.host,
          known && known.app === app && known.tenant === row.tenantId
            ? known
            : Object.freeze({ host: row.host, app, tenant: row.tenantId }),
        );
        if (row.primary) first.set(`${app}\0${row.tenantId}`, row.host);
      }
    }
    live = next;
    primaries = first;
  };
  let inflight: Promise<void> | undefined,
    again = false,
    closed = false;
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        again = false;
        await Promise.all(
          [...sources].map(async ([app, source]) => {
            try {
              snapshots.set(app, await source.list());
            } catch (error) {
              warn(
                `mistri: the host table of "${app}" could not be read; keeping the hosts last read. ${(error as Error).message.split('\n')[0]}`,
              );
            }
          }),
        );
        rebuild();
      } while (again && !closed);
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
  const changed = () => void refresh();
  hostChangeListeners.add(changed);
  let timer: NodeJS.Timeout | undefined;
  return {
    /** The hosts the App's own children list as theirs (a static list: staff and configuration), which is what
     * `bound.allowedHosts` holds. The host table's are asked through `allows`. */
    listedHosts(app: string): readonly string[] {
      return Object.freeze([
        ...new Set([
          ...(staff ? [staff] : []),
          ...[...mapped.values()].filter((intent) => intent.app === app).map((intent) => intent.host),
        ]),
      ]);
    },
    /** Whether a request for `host` (a name, lowercase, no port) is one this App answers: the staff host, a host the
     * configuration maps to it, or a live row of its table. */
    allows(app: string, host: string): boolean {
      const name = host.toLowerCase().replace(/:\d+$/, '');
      return name === staff || mapped.get(name)?.app === app || live.get(name)?.app === app;
    },
    /** What a host shows of this App, from the configuration or a live row only: the one place a sign-in handed to a
     * tenant's host learns where to send the person, so a host named in a request is never itself the target. */
    intentFor(app: string, host: string): TenantHostIntent | undefined {
      const name = host.toLowerCase().replace(/:\d+$/, '');
      const intent = mapped.get(name) ?? live.get(name);
      return intent?.app === app ? intent : undefined;
    },
    /** Whether a host is a subdomain of the deployment's own `tenantDomain`: a name the platform hands out, as against
     * a custom domain a tenant brought, which a host sign-in asks the person to confirm before it is handed a session. */
    platformHost(host: string): boolean {
      return isSubdomain(tenantDomain, host.toLowerCase().replace(/:\d+$/, ''));
    },
    /** Which App and tenant hold a host in any state, as last read: so a domain one App's tenant has added is refused
     * to another App's. Each App's own table refuses its own duplicates; this covers the tables beside it. */
    heldBy(host: string): Readonly<{ app: string; tenant: string; row?: TenantHostRow }> | undefined {
      for (const [app, rows] of snapshots) {
        const row = rows.find((each) => each.host === host);
        if (row) return { app, tenant: row.tenantId, row };
      }
      return mapped.has(host) ? { app: mapped.get(host)!.app, tenant: mapped.get(host)!.tenant } : undefined;
    },
    /** Whether any App's table holds `host` as a custom domain that is verified or live: Caddy's question before it
     * issues a certificate. Every row is asked, not the first found: two Apps may hold the name (each table refuses only
     * its own duplicates), and one's pending claim must not hide the other's proven one. */
    certificateWanted(host: string): boolean {
      for (const rows of snapshots.values())
        if (rows.some((row) => row.host === host && row.kind === 'custom' && (row.status === 'verified' || row.status === 'live')))
          return true;
      return false;
    },
    /** One App's host rows as last read, for a panel's plain list: undefined until the first read. */
    rowsOf(app: string): readonly TenantHostRow[] | undefined {
      return snapshots.get(app);
    },
    /** A tenant's primary live host, where its links are written; undefined when it has none. */
    primaryHost(app: string, tenant: string): string | undefined {
      return primaries.get(`${app}\0${tenant}`);
    },
    /** An App's host table, read now and then every refresh interval. */
    async register(app: string, source: TenantHostSource): Promise<void> {
      sources.set(app, source);
      await refresh();
    },
    refresh,
    /** Starts the refresh interval; stopped by `close`. */
    start() {
      if (!timer && sources.size) {
        timer = setInterval(changed, options.refreshMs ?? HOST_REFRESH_MS);
        timer.unref();
      }
    },
    close() {
      closed = true;
      hostChangeListeners.delete(changed);
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    accept(req: IncomingMessage): boolean {
      const host = requestHostname(req);
      if (!host) return false;
      const intent = mapped.get(host) ?? live.get(host);
      if (intent) {
        const existing = intents.get(req);
        if (existing && existing !== intent) return false;
        intents.set(req, intent);
        return true;
      }
      return loopback(host) || host === staff;
    },
  };
}
