/**
 * Who may talk to this server: the Host, Origin and proxy-identity checks
 * every transport runs before it reads a request. Moved out of index.ts
 * whole; the tenant servers import from here rather than from the entry.
 */
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { untrustedDatabaseRefusal } from '../../adapters/net/untrustedDatabase.js';
import { serverSettings, type ClientAddressPolicy } from '../../adapters/serverSettings.js';
import { envName, product } from '../product.js';

/** Split an `…_ALLOWED_HOSTS` value (`TABLEWALK_` or `MISTRI_`, product.ts). Commas or spaces, either way. */
export function parseHostList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Refuse a request that another site made on the user's behalf.
 *
 * Binding to loopback keeps tablewalk off the network. It does **not** keep it
 * away from the browser: any page the user has open can `fetch` a localhost
 * port, and while the same-origin policy stops it reading the reply, the
 * request still runs. That was enough to matter here — a page could POST to
 * /api/update and the write would land, on a connection the user never put
 * into write mode, because write mode is a decision the client makes and the
 * server was taking on trust.
 *
 * Three checks, each cheap and each closing a different door:
 *
 *   - **Origin.** A cross-origin POST always carries one. Ours never differs
 *     from the host we are serving on. A request with no Origin at all is a
 *     tool like curl, which is not a confused-deputy risk and is allowed.
 *   - **Content-Type.** Requiring JSON makes a cross-origin request
 *     non-"simple", so the browser must preflight it — and we answer no CORS
 *     headers at all, so the preflight fails before the real request is sent.
 *     This is the check that holds even if a browser stops sending Origin.
 *   - **Host.** Only loopback names, or the interface actually bound. This is
 *     the DNS-rebinding case: an attacker's domain resolving to 127.0.0.1
 *     makes their page same-origin with us, and the Origin check would pass.
 *     It is the one of the three that runs on reads as well — see
 *     `hostRefusal` — because same-origin is exactly what makes a *read*
 *     worth doing, and the schema, the DDL and the saved SQL are all reads.
 *
 * No token, no session, no cookie. The browser already tells us everything we
 * need, and inventing a ceremony on top would be more code guarding the same
 * door.
 *
 * The Host check has one deliberate escape hatch, `allowedHosts`. In a
 * container the server binds 0.0.0.0 while the browser sends whatever name the
 * user typed — `tablewalk.internal`, or a reverse proxy's public name — and
 * neither is loopback nor the bound interface, so nothing would be answered at
 * all — a message about a host nobody set, on the page itself. Naming those
 * hosts explicitly is the fix. It is opt-in and empty by default because
 * each entry is a name whose DNS you are now trusting: if an attacker can make
 * a name on this list resolve to your loopback, the rebinding defence is gone
 * for that name. That is a fair trade for a name you chose and a bad one for a
 * wildcard, which is why there is no wildcard.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

/** What a listener knows about itself, read on every request. */
export interface Bound {
  host: string;
  port: number;
  allowedHosts?: readonly string[];
  /** See `--auth-proxy-header`. */
  identityHeader?: string;
  /** See `--trust-proxy`: proxies the public form rate limit may believe about who they forwarded for. */
  trustedProxies?: readonly ProxyRange[];
  /**
   * A mounting host's `embed.origins` (embed/handler.ts): browser origins
   * other than this one that may call it (CORS) and frame its pages
   * (`?embed=frame`), beside the origins the config file's hosts list
   * (embed/crossOrigin.ts `embedDoorFor`). Never a way past the Origin check
   * below: a write from one passes only on the bearer that origin was given.
   */
  embedOrigins?: readonly string[];
}

/** A socket peer on this machine: the operator's terminal, a health check, or a proxy beside the server. */
function loopbackPeer(address: string | undefined): boolean {
  return /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(address ?? '');
}

const MAX_FORWARDED_HOPS = 32;

/**
 * An address as eight 16-bit groups, or undefined. A zone (`%eth0`) is
 * dropped; a trailing dotted quad is the last two groups. Shared with the
 * limiter, which keys an IPv6 client by its first four.
 */
export function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (isIP(text) !== 6) return undefined;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - before.length - after.length;
  const groups = [...before, ...Array.from({ length: fill }, () => '0'), ...after].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

/* IPv4 is held IPv4-mapped (`::ffff:a.b.c.d`), so a dual-stack socket's
   mapped peer and the bare address are one address, and a v4 range is the
   same comparison 96 bits further in. */
function addressGroups(address: string): number[] | undefined {
  if (isIP(address) === 4) {
    const [a, b, c, d] = address.split('.').map(Number);
    return [0, 0, 0, 0, 0, 0xffff, (a << 8) | b, (c << 8) | d];
  }
  return ipv6Groups(address);
}

/** One `--trust-proxy` entry: an address or CIDR range, as written and as groups and a prefix. */
export interface ProxyRange {
  readonly text: string;
  readonly groups: readonly number[];
  readonly prefix: number;
}

/**
 * Read `--trust-proxy` values: each an IPv4 or IPv6 address or CIDR range,
 * several to a value when separated by commas or spaces. What is not one is
 * returned by name, for startup to refuse — a list that silently dropped an
 * entry would collapse that proxy's clients into one budget with no word.
 * A zero-length prefix is refused too: it trusts every address, which makes
 * the header anyone's to write.
 */
export function parseTrustedProxies(values: readonly string[]): { ranges: ProxyRange[]; invalid: string[] } {
  const ranges: ProxyRange[] = [];
  const invalid: string[] = [];
  for (const value of values) {
    const entries = value.split(/[,\s]+/).filter(Boolean);
    if (!entries.length) {
      invalid.push(value);
      continue;
    }
    for (const entry of entries) {
      const [address, bits, extra] = entry.split('/');
      const family = address.includes('%') || extra !== undefined ? 0 : isIP(address);
      const groups = family ? addressGroups(address) : undefined;
      const width = family === 4 ? 32 : 128;
      const prefix = bits === undefined ? width : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
      if (!groups || !(prefix >= 1 && prefix <= width)) {
        invalid.push(entry);
        continue;
      }
      ranges.push(Object.freeze({ text: entry, groups: Object.freeze(groups), prefix: family === 4 ? 96 + prefix : prefix }));
    }
  }
  return { ranges, invalid };
}

function inRange(groups: readonly number[], range: ProxyRange): boolean {
  for (let i = 0, bits = range.prefix; i < 8 && bits > 0; i++, bits -= 16) {
    const mask = (0xffff << (16 - Math.min(16, bits))) & 0xffff;
    if ((groups[i] & mask) !== (range.groups[i] & mask)) return false;
  }
  return true;
}

/**
 * A peer whose `X-Forwarded-For` the limiter may read: on this machine
 * (`loopbackPeer`, always), or inside a range the operator listed with
 * `--trust-proxy`. The same list says whose `--auth-proxy-header` value
 * `identityFor` believes.
 */
export function trustedProxyPeer(address: string | undefined, trusted: readonly ProxyRange[] = []): boolean {
  if (loopbackPeer(address)) return true;
  if (!trusted.length || !address) return false;
  const groups = addressGroups(address);
  return !!groups && trusted.some((range) => inRange(groups, range));
}

/*
 * How to name the client behind a managed front end, whose own address cannot
 * be written into `--trust-proxy` (Cloud Run's, Cloudflare's: a changing pool
 * of Google or Cloudflare addresses). Both are the operator's statement about
 * the deployment, off by default, and settled at startup. The limiters that
 * ask `forwardedClient` are spread across every transport and tenant, so the
 * policy is the server's setting (adapters/serverSettings.ts), read from the
 * scope the request runs in: two handlers in one process each key by their
 * own front end.
 */
/**
 * Read `--trust-proxy-hops` and `--trust-proxy-cloudflare`. A hop count that
 * is not a whole number from 1 to 32 comes back as an error for startup to
 * print: a mistyped count would collapse every visitor into one budget, or
 * believe a header the client wrote, with no word.
 */
export function parseClientAddressPolicy(input: {
  hops?: string;
  cloudflare?: boolean;
}): { policy: ClientAddressPolicy } | { error: string } {
  let hops: number | undefined;
  if (input.hops !== undefined) {
    if (!/^\d{1,2}$/.test(input.hops.trim()) || Number(input.hops) < 1 || Number(input.hops) > MAX_FORWARDED_HOPS) {
      return {
        error: `--trust-proxy-hops takes a whole number from 1 to ${MAX_FORWARDED_HOPS} (the proxies in front of the server), not "${input.hops}". It comes from the flag or ${envName('TRUST_PROXY_HOPS')}.`,
      };
    }
    hops = Number(input.hops);
  }
  /* Two answers to one question: Cloudflare's header would win where it was sent and a hop count decide where it was
     not, so a request that bypassed Cloudflare would be keyed by a rule the operator never chose for it. */
  if (hops && input.cloudflare) {
    return {
      error: `--trust-proxy-hops and --trust-proxy-cloudflare are two ways to find the client: name one. Cloudflare in front alone, --trust-proxy-cloudflare; another front end, --trust-proxy-hops. They come from the flags or ${envName('TRUST_PROXY_HOPS')} and ${envName('TRUST_PROXY_CLOUDFLARE')}.`,
    };
  }
  return { policy: { ...(hops ? { hops } : {}), ...(input.cloudflare ? { cloudflare: true } : {}) } };
}

/**
 * Which client a request is from, for keying a limit — never for authority.
 *
 * With `--trust-proxy-cloudflare`, the `CF-Connecting-IP` header, when it is
 * one address: Cloudflare sets it and replaces any the client sent. Without
 * the flag it is never read, because anyone can write it.
 *
 * With `--trust-proxy-hops N`, the address N places from the right of
 * [socket peer, ...X-Forwarded-For read right to left]: the peer is the first
 * proxy, and each appends the address it saw, so what is left of the Nth is
 * the client's own claim and is dropped. Fewer entries than hops, the
 * furthest. This does not look at who the peer is — that is the point, on a
 * front end with no stable address — so it is for a server reachable only
 * through those hops.
 *
 * Otherwise the socket peer, unless that peer is a trusted proxy (`trustedProxyPeer`:
 * loopback, or an address `--trust-proxy` named): then the client is the
 * nearest `X-Forwarded-For` hop that is not a trusted proxy too. Read from
 * the right, because a proxy appends the address it saw and everything to
 * its left is whatever the client chose to send; each trusted hop passed
 * vouches for the one before it. When every hop is trusted, the furthest is
 * the client. From any other peer the header is not read at all — anyone can
 * write one — and a malformed header is ignored whole rather than
 * half-believed. A proxy on another host that nobody listed is its own
 * address, so its clients share one budget.
 */
export function forwardedClient(
  req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
  trusted: readonly ProxyRange[] = [],
): string {
  const peer = req.socket?.remoteAddress || 'unknown';
  const clientPolicy = serverSettings().clientAddress;
  if (clientPolicy.cloudflare) {
    const cf = req.headers?.['cf-connecting-ip'];
    const address = (Array.isArray(cf) ? cf[0] : cf)?.trim();
    if (address && isIP(address) !== 0) return address.toLowerCase();
  }
  if (clientPolicy.hops) {
    const hops = forwardedHops(req.headers?.['x-forwarded-for']);
    if (!hops) return peer;
    const chain = [peer, ...hops.reverse()];
    return chain[Math.min(clientPolicy.hops, chain.length - 1)].toLowerCase();
  }
  if (!trustedProxyPeer(peer, trusted)) return peer;
  const hops = forwardedHops(req.headers?.['x-forwarded-for']);
  if (!hops) return peer;
  for (let i = hops.length - 1; i >= 0; i--) if (!trustedProxyPeer(hops[i], trusted)) return hops[i].toLowerCase();
  return hops[0].toLowerCase();
}

/** The addresses in an X-Forwarded-For value, or undefined when absent or any entry is not one. */
function forwardedHops(raw: string | string[] | undefined): string[] | undefined {
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (!header) return undefined;
  const hops = header.split(',').map((hop) => hop.trim());
  return hops.length > MAX_FORWARDED_HOPS || hops.some((hop) => isIP(hop) === 0) ? undefined : hops;
}

/**
 * Who is asking, when the operator has said which header carries it.
 *
 * `--auth-proxy-header X-Forwarded-User` means a proxy in front signs
 * people in and writes the result into that header on the way through.
 * A request without it did not come through the proxy — or came through
 * one that is misconfigured — and is refused with the header named. So is
 * a request that carries it from a peer that is not the proxy: the header
 * is only a name anyone can type, so a value from an address neither on
 * loopback nor in `--trust-proxy` is a forgery, not a sign-in. Loopback is
 * exempt: the container's own health check, a curl on the box, the
 * operator's terminal. Nothing here is authentication; it is the proxy's
 * decision, carried to the journal.
 */
export function identityFor(
  req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
  bound: Bound,
): { who?: string; refusal?: string } {
  if (!bound.identityHeader) return {};
  const raw = req.headers[bound.identityHeader.toLowerCase()];
  const who = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const peer = req.socket?.remoteAddress;
  if (who && trustedProxyPeer(peer, bound.trustedProxies)) return { who };
  if (loopbackPeer(peer)) return { who: 'local' };
  return {
    refusal: who
      ? `This server expects ${bound.identityHeader} only from its proxy, and this request did not come from the trusted proxy. ` +
        "Reach it through the proxy that signs you in; the proxy's address belongs in --trust-proxy."
      : `This server expects ${bound.identityHeader} from its proxy, and this request carried none. ` +
        'Reach it through the proxy that signs you in.',
  };
}

/**
 * Whether the browser on this listener is the operator.
 *
 * On loopback with no extra hosts, whoever reaches the port started the
 * process, and the connection form may do what the config file may: reference
 * `${PROD_PASSWORD}`, look a password up in the keychain by name, open a
 * SQLite file by path, choose where the config is saved. Bound wider — or
 * answering to a proxy's name — the browser is anyone on the network, and each
 * of those is a way out: an env reference sends this process's secrets to a
 * host the caller names, a keychain lookup attaches a stored password to the
 * caller's URL, a file path reads any database the server user can, and a
 * save path writes JSON wherever it points. The routes that take a target
 * from the client ask this first and refuse those forms when it says no.
 *
 * Nothing here is authentication. It is the line between "your own machine"
 * and "the network" that the README already draws, applied to the one API
 * that takes a database *address* rather than a query.
 */
export function clientTrusted(bound: { host: string; allowedHosts?: readonly string[] }): boolean {
  return LOOPBACK.test(bound.host) && !bound.allowedHosts?.length;
}

/**
 * Why a connection target from an untrusted client is refused, or null when
 * it is a plain network URL that resolves nothing on this machine. A URL that
 * passes is still dialled sealed, to public addresses only
 * (adapters/net/untrustedDatabase.ts).
 */
export function untrustedTargetRefusal(target: string): string | null {
  if (/\$\{?[A-Za-z_]/.test(target)) {
    return (
      'This server is reachable beyond this machine, so a connection added from the browser cannot ' +
      'reference environment variables. Put it in the config file on the server, or type the password.'
    );
  }
  if (!/^[a-z][\w+.-]*:\/\//i.test(target) || /^sqlite:/i.test(target)) {
    return (
      'This server is reachable beyond this machine, so the browser cannot open a SQLite file by ' +
      'path. Name the file in the config file or on the command line.'
    );
  }
  return untrustedDatabaseRefusal(target);
}

/**
 * True when a `Host` header matches one of the extra names we were told to
 * trust.
 *
 * An entry without a port matches the name on any port, because a request
 * through a proxy on 80 or 443 arrives with no port at all and the person
 * writing `--allowed-host tablewalk.internal` means the machine, not one
 * listener on it. An entry *with* a port is taken literally.
 */
function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const lower = host.toLowerCase();
  const withoutPort = lower.replace(/:\d+$/, '');
  return allowed.some((entry) => {
    const want = entry.trim().toLowerCase();
    if (!want) return false;
    return /:\d+$/.test(want) ? lower === want : withoutPort === want;
  });
}

/**
 * The `Host` half, on its own, because it has to run on reads too.
 *
 * This was inside `crossOriginRefusal`, which only ever ran for methods that
 * change something. The reasoning was that a read is harmless — and it is
 * wrong, because the attack this check exists to stop is DNS rebinding, and
 * rebinding's whole trick is to make the request *same-origin* so the
 * response can be read. A page on a name the attacker controls, pointed at
 * 127.0.0.1, could `fetch('/api/schema')` and read the answer: every table,
 * every column, every foreign key. `/api/ddl` handed over `CREATE TABLE`.
 * `/api/connections` named the hosts, users and databases. `/api/queries`
 * gave up the saved SQL. All of it, from any page, on any machine where
 * tablewalk happened to be running.
 *
 * Row data was never reachable — reads that take arguments are POSTs, and
 * those were checked. The schema is not nothing.
 *
 * It runs on the static files too, so a rebinding attempt fails at the page
 * rather than one request later. Reaching tablewalk by any name other than
 * loopback has always needed `--allowed-host` for writes to work; this makes
 * that one rule instead of two.
 *
 * It is the first part of `doorRefusal`, which is what a surface calls.
 */
export function hostRefusal(req: IncomingMessage, bound: Bound): string | null {
  const host = req.headers.host ?? '';
  /* An IPv6 address arrives bracketed in a Host header — `[fe80::1]:4111` —
     and is configured bare; compared as configured, a non-loopback IPv6
     bind could never pass its own check. */
  const expected = `${bound.host.includes(':') && !bound.host.startsWith('[') ? `[${bound.host}]` : bound.host}:${bound.port}`;
  const allowed = bound.allowedHosts ?? [];
  if (!LOOPBACK.test(host) && host !== expected && !hostAllowed(host, allowed)) {
    return (
      `Refused: this request arrived for host "${host}". ${product()} only answers on ${expected}.` +
      ` Add --allowed-host, or set ${envName('ALLOWED_HOSTS')}, to trust another name.`
    );
  }
  return null;
}

/** Validate a serialized browser Origin, independently of JSON body policy.
 * Missing Origin remains available to non-browser clients. This compares hosts,
 * not the serving socket's scheme: TLS proxies may terminate HTTPS upstream.
 * Full scheme equality needs explicitly trusted external-origin metadata.
 * A part of `doorRefusal`, which is what a surface calls; `ownOrigin` asks it as a question. */
export function originRefusal(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return `Refused: "${origin}" is not a valid origin.`;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      return `Refused: "${origin}" is not a valid origin.`;
    }
    if (parsed.host !== req.headers.host) {
      return `Refused: a page at ${origin} tried to make this request. ${product()} only accepts requests from its own page.`;
    }
  }
  return null;
}

/* Requests a host's page on another origin made with the bearer it was given
   (embed/crossOrigin.ts): that door has checked the Origin against the one
   the bearer was issued to, and replaced the cookies with the bearer's
   session. The Host and the JSON body are still required below. */
const vouched = new WeakSet<IncomingMessage>();

/** Mark a request whose Origin the embed door admitted on its bearer. */
export function vouchForOrigin(req: IncomingMessage): void {
  vouched.add(req);
}

/** A write's door, as one sentence or null: `doorRefusal` with `{ writing: true }`. Kept for its unit tests; surfaces call `doorRefusal`. */
export function crossOriginRefusal(req: IncomingMessage, bound: Bound): string | null {
  return doorRefusal(req, bound, { writing: true })?.error ?? null;
}

/** Whether a request can change something: anything but a GET or a HEAD. */
export function writes(req: IncomingMessage): boolean {
  return req.method !== 'GET' && req.method !== 'HEAD';
}

/** Whether the request's Origin, if it sent one, is this page's (`originRefusal`): a question, not a door. */
export function ownOrigin(req: IncomingMessage): boolean {
  return originRefusal(req) === null;
}

/**
 * What a surface asks of the door (`doorRefusal`). Every check it leaves out
 * is left out here, by name, with the reason beside the call — never by not
 * calling one.
 */
export interface DoorRule {
  /**
   * The request can change something, so its Origin must be this page's and
   * its body JSON (see `crossOriginRefusal`). False for a read, and where a
   * dispatcher further in holds the write's line — the call says which.
   */
  readonly writing: boolean;
  /**
   * When the Origin is checked:
   *
   *   - `'writes'` (the default): on a write, where an Origin the embed door
   *     admitted on its bearer (`vouchForOrigin`) passes;
   *   - `'always'`: on reads as well, and a vouch never passes — for a surface
   *     whose reads are an account's own (a flag's history, an administrator's
   *     list), which no host's bearer stands for;
   *   - `'none'`: never — the surface proves its caller another way (a
   *     provider's signature, a signed link, a token), said beside the call.
   */
  readonly origin?: 'writes' | 'always' | 'none';
  /**
   * Also refuse `Sec-Fetch-Site: cross-site` wherever the Origin is checked:
   * for a surface a browser may reach without an Origin a page chose — a
   * beacon, a form, a credential's ceremony.
   */
  readonly sameSite?: boolean;
  /** Whether a write's body must be JSON; the default is `writing`. False only beside a reason. */
  readonly json?: boolean;
}

/** Which check refused, for a surface that answers them differently, and the sentence it refused with. */
interface DoorRefusal {
  readonly check: 'host' | 'site' | 'origin' | 'json';
  readonly error: string;
}

/**
 * The one door every HTTP surface holds a request to, before it reads
 * anything else of it: the Host (`hostRefusal`, on reads too), then, where
 * `rule` says, the browser's fetch site and the Origin, then a write's JSON
 * body. The gate (gate.ts) asks it twice, either side of the proxy identity
 * and the embed door, because that door decides whether an Origin is vouched
 * for; every other surface asks once.
 */
export function doorRefusal(req: IncomingMessage, bound: Bound, rule: DoorRule): DoorRefusal | null {
  const wrongHost = hostRefusal(req, bound);
  if (wrongHost) return { check: 'host', error: wrongHost };
  const origin = rule.origin ?? 'writes';
  if (origin === 'always' || (origin === 'writes' && rule.writing)) {
    if (rule.sameSite && req.headers['sec-fetch-site'] === 'cross-site')
      return {
        check: 'site',
        error: 'Refused: another site made this request. ' + product() + ' only accepts requests from its own page.',
      };
    const wrongOrigin = origin === 'writes' && vouched.has(req) ? null : originRefusal(req);
    if (wrongOrigin) return { check: 'origin', error: wrongOrigin };
  }
  if (rule.writing && (rule.json ?? true) && !jsonBody(req))
    return { check: 'json', error: 'Refused: this endpoint takes application/json.' };
  return null;
}

function jsonBody(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}
