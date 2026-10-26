/**
 * Where a socket this process opens on the operator's behalf may go.
 *
 * Every outbound connection a config file can point somewhere — an API
 * (egress.ts), a cache, a search service — resolves its host through
 * `checkedLookup`, so the address checked is the address connected: a name
 * that resolves somewhere else a moment later (DNS rebinding) changes
 * nothing. One set of ranges, one rule, whichever protocol rides on top.
 *
 * Private networks are reachable by default, because internal services are
 * the common case and these connections only ever come from the operator's
 * config, never from a browser. Link-local addresses, where cloud metadata
 * services answer, are not, unless the connection says so: they hand out
 * credentials to whoever asks.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

type LookupCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
/** `node:dns` lookup with `{ all: true }`, injectable so a test can resolve a name to any address it likes. */
export type Resolver = (hostname: string, options: { all: true }, callback: LookupCallback) => void;

export interface NetworkPolicy {
  /** Loopback and private ranges (RFC 1918, CGNAT, ULA). Reachable unless a connection opts out. */
  allowPrivate: boolean;
  /** Link-local ranges, where cloud metadata services answer. Unreachable unless a connection opts in. */
  allowLinkLocal: boolean;
  resolver?: Resolver;
}

const ranges = (entries: Array<[string, number]>) => {
  const list = new BlockList();
  for (const [address, prefix] of entries) list.addSubnet(address, prefix, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  return list;
};
/* An unspecified address reaches whatever listens on this machine; never a destination. */
const NEVER = ranges([
  ['0.0.0.0', 8],
  ['::', 128],
  // NAT64's local-use prefix (RFC 8215): the IPv4 address sits where the operator's gateway puts it, so none can be vouched for.
  ['64:ff9b:1::', 48],
]);
const LINK_LOCAL = ranges([
  ['169.254.0.0', 16],
  ['fe80::', 10],
  ['fd00:ec2::254', 128],
]);
const PRIVATE = ranges([
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['::1', 128],
  ['fc00::', 7],
]);

/* The sixteen bytes of an IPv6 address, or undefined when it is not one (a zone id, `::`, and a dotted tail are read). */
function sixteen(address: string): number[] | undefined {
  const bare = address.split('%')[0].toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = tail
    ? bare.slice(0, bare.length - tail[0].length) +
      [(+tail[1] << 8) | +tail[2], (+tail[3] << 8) | +tail[4]].map((n) => n.toString(16)).join(':')
    : bare;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...rest];
  if (all.length !== 8 || all.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return all.flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 255]);
}

/* The IPv4 address an IPv6 spelling carries inside it, which is the address a gateway or a tunnel then connects to:
   NAT64 (64:ff9b::/96), 6to4 (2002::/16) and the long-retired IPv4-compatible form (::/96). BlockList already reads the
   IPv4-mapped spelling (`::ffff:a.b.c.d`) by its IPv4 rules. */
function embedded(address: string): string | undefined {
  const bytes = sixteen(address);
  if (!bytes) return undefined;
  const v4 = (at: number) => bytes.slice(at, at + 4).join('.');
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4(2);
  if (bytes.slice(0, 12).every((byte, index) => byte === [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0][index])) return v4(12);
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return v4(12);
  return undefined;
}

function reachable(address: string, policy: NetworkPolicy): boolean {
  const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  if (NEVER.check(address, type)) return false;
  if (!policy.allowLinkLocal && LINK_LOCAL.check(address, type)) return false;
  if (!policy.allowPrivate && PRIVATE.check(address, type)) return false;
  // An address that wraps another is as reachable as the one inside it.
  const inside = type === 'ipv6' ? embedded(address) : undefined;
  return inside === undefined || reachable(inside, policy);
}

/**
 * A host written as an address is never looked up, so it is checked before
 * any socket opens: the address it names when that address is refused,
 * undefined when it is a name or a reachable address.
 */
export function refusedLiteral(hostname: string, policy: NetworkPolicy): string | undefined {
  const literal = hostname.replace(/^\[|\]$/g, '');
  return isIP(literal) && !reachable(literal, policy) ? literal : undefined;
}

/**
 * The lookup a socket uses: resolve, keep only reachable addresses, and hand
 * those back, so the address checked is the address connected. Node asks for
 * one address or for all (happy eyeballs); both are answered. `refuse` makes
 * the caller's own error for a name that resolves only to refused addresses.
 */
export function checkedLookup(policy: NetworkPolicy, refuse: (host: string, addresses: string[]) => Error) {
  const resolve: Resolver = policy.resolver ?? ((hostname, options, callback) => dnsLookup(hostname, options, callback));
  return (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error);
      const allowed = addresses.filter((each) => reachable(each.address, policy));
      if (!allowed.length)
        return callback(
          refuse(
            hostname,
            addresses.map((each) => each.address),
          ),
        );
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0].address, allowed[0].family);
    });
  };
}
