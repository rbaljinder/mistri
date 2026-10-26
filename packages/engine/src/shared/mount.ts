/**
 * Where a server's Apps are mounted, and the path it is served under: the one
 * rule every address passes through on its way in and out.
 *
 * Inside tablewalk an App's address is always `/{app}/…` — the walk, the
 * address book (appAddress.ts), the route table and every link the client
 * builds say it so. What the browser shows is decided here, once:
 *
 *   - a server serving one App serves it at the root: `/leases/12`;
 *   - several Apps each keep `/{app}`, and one of them may be the main App at
 *     the root (`--mount main=/`), the others under their own segment;
 *   - an explicit mount (`--mount lintel=/lintel`, config `"mount"`)
 *     overrides either default;
 *   - and the whole server may sit under a prefix a reverse proxy serves it
 *     at (`--base-path /tools`): `https://host/tools/leases/12`.
 *
 * `outward` turns an inside address into the one the browser shows, and
 * `inward` reads one back. The server reads every request through `inward`
 * and writes every address it sends (a redirect, a canonical link, a mail's
 * link, a cookie's path) through `outward`; the client does the same at the
 * address bar, its links and its fetches (client addressMount.js). There are no
 * aliases: whichever form applies is the only spelling, and an address in
 * another form names nothing.
 *
 * The standalone database browser mounts nothing, so every address is its
 * own — only a base path, when one is given, is added and taken off.
 *
 * Pure and dependency-free, so the server, the client and `mistri check`
 * cannot disagree.
 */

export interface AddressMount {
  /** The path the server is served under: '' or `/tools`, never a trailing slash. */
  base: string;
  /** Each served App's mount, by id: '' at the root, else its one segment. */
  apps: Readonly<Record<string, string>>;
}

/** No Apps and no prefix: every address is its own. */
export const NO_MOUNT: AddressMount = Object.freeze({ base: '', apps: Object.freeze({}) });

/**
 * First segments the server answers at its root whatever it serves: the API,
 * the built client's files, `_mistri` — the custom components' host
 * modules and tablewalk's own tools, the dev observer among them — and an
 * orchestrator's `healthz` and `readyz` probes, and a crawler's `robots.txt`
 * and `sitemap.xml` (http/sitemap.ts). No App is mounted at one, and
 * an App at the root cannot route to one.
 */
export const SERVER_SEGMENTS: readonly string[] = ['api', 'assets', '_mistri', 'healthz', 'readyz', 'robots.txt', 'sitemap.xml'];

/** One mount segment: the letters an App id and a route path allow. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * A base path as written — `/tools`, `/tools/`, `tools`, `/a/b` — made
 * canonical (`/tools`), or a refusal that names the fix. '' and '/' are no
 * base at all.
 */
export function parseBasePath(value: string, at = 'the base path'): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '/') return '';
  const segments = trimmed.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.some((segment) => !SEGMENT.test(segment))) {
    throw new Error(`${at}: "${value}" must be a path like /tools — segments of letters, digits, hyphens and underscores.`);
  }
  return `/${segments.join('/')}`;
}

/**
 * One App's mount as written — `/` for the root, `/billing` (or `billing`)
 * for a segment — into its stored form ('' or `billing`).
 */
export function parseMountPath(value: string, at: string): string {
  const trimmed = value.trim();
  if (trimmed === '/') return '';
  const segment = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!SEGMENT.test(segment)) throw new Error(`${at}: "${value}" must be "/" (the root) or one segment, like "/billing".`);
  if (SERVER_SEGMENTS.includes(segment))
    throw new Error(`${at}: "${value}" is the server's own (${SERVER_SEGMENTS.join(', ')}); mount the App elsewhere.`);
  return segment;
}

/**
 * The mounts of the Apps a server serves: one App at the root, several each
 * under its id, and whatever `explicit` says over either. Throws, naming the
 * App, on a mount that names no served App, two Apps at one place, or an
 * App id the server's own paths already hold.
 */
export function appMounts(
  ids: readonly string[],
  explicit: { base?: string; mounts?: Readonly<Record<string, string>> } = {},
): AddressMount {
  const base = explicit.base ?? '';
  const mounts = explicit.mounts ?? {};
  for (const id of Object.keys(mounts)) {
    if (!ids.includes(id))
      throw new Error(`--mount names "${id}", which is not an App this server serves${ids.length ? ` (${ids.join(', ')})` : ''}.`);
  }
  const apps: Record<string, string> = {};
  for (const id of ids) {
    apps[id] = Object.hasOwn(mounts, id) ? mounts[id] : ids.length === 1 ? '' : id;
    if (apps[id] !== '' && SERVER_SEGMENTS.includes(apps[id])) {
      throw new Error(
        `The App "${id}" would be mounted at /${apps[id]}, which is the server's own; mount it elsewhere with --mount ${id}=/<segment>.`,
      );
    }
  }
  const held = new Map<string, string>();
  for (const [id, at] of Object.entries(apps)) {
    const other = held.get(at);
    if (other !== undefined) {
      throw new Error(
        at === ''
          ? `The Apps "${other}" and "${id}" are both mounted at the root; only one App can be the main App.`
          : `The Apps "${other}" and "${id}" are both mounted at /${at}; give one of them another --mount.`,
      );
    }
    held.set(at, id);
  }
  return { base, apps };
}

/**
 * The mounts as a deployment writes them — `--mount`/`--base-path` over the
 * config's `"mount"`/`"basePath"` — for these Apps. The server, `check
 * --routes` and `shot` all start here, so they read one deployment alike.
 */
export function settingsMount(
  ids: readonly string[],
  flags: { mounts?: Readonly<Record<string, string>>; basePath?: string },
  config: { mount?: Readonly<Record<string, string>>; basePath?: string } = {},
): AddressMount {
  const written = { ...config.mount, ...flags.mounts };
  const mounts = Object.fromEntries(Object.entries(written).map(([id, at]) => [id, parseMountPath(at, `--mount ${id}`)]));
  return appMounts(ids, { base: parseBasePath(flags.basePath ?? config.basePath ?? '', '--base-path'), mounts });
}

/** The App mounted at the root, if any. */
export function rootApp(mount: AddressMount): string | undefined {
  return Object.entries(mount.apps).find(([, at]) => at === '')?.[0];
}

/**
 * The words an App at the root cannot route to beyond its own reserved ones:
 * every other App's segment, by its id, which the server reads first.
 */
export function segmentsTakenFrom(mount: AddressMount, app: string): Record<string, string> {
  if (mount.apps[app] !== '') return {};
  return Object.fromEntries(Object.entries(mount.apps).filter(([id, at]) => id !== app && at !== ''));
}

const splitTail = (path: string): [string, string] => {
  const at = path.search(/[?#]/);
  return at < 0 ? [path, ''] : [path.slice(0, at), path.slice(at)];
};
const decoded = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/** An App's home as the browser shows it: `/`, `/billing`, `/tools/`, `/tools/billing`. */
export function appHome(mount: AddressMount, app: string): string {
  return outward(mount, `/${encodeURIComponent(app)}`);
}

/**
 * An inside address as the browser shows it. `/lintel/leases/12` is
 * `/leases/12` with Lintel at the root, `/tools/leases/12` under a base; a
 * server path (`/api/…`) only gains the base. Any `?search` and `#hash` ride
 * along untouched.
 */
export function outward(mount: AddressMount, internal: string): string {
  const [path, tail] = splitTail(internal);
  const first = path.split('/')[1] ?? '';
  const app = first ? decoded(first) : undefined;
  if (app !== undefined && path.startsWith('/') && Object.hasOwn(mount.apps, app)) {
    const rest = path.slice(1 + first.length);
    const at = mount.apps[app];
    const said = `${at ? `/${encodeURIComponent(at)}` : ''}${rest}`;
    return `${mount.base}${said || '/'}${tail}`;
  }
  return `${mount.base}${path}${tail}`;
}

/**
 * An address as the browser sent it, read back to the inside form; undefined
 * for one outside the base path or naming an App the way it is not mounted —
 * the spelling that applies is the only one.
 */
export function inward(mount: AddressMount, external: string): string | undefined {
  const [whole, tail] = splitTail(external);
  let path = whole;
  if (mount.base) {
    if (path !== mount.base && !path.startsWith(`${mount.base}/`)) return undefined;
    path = path.slice(mount.base.length) || '/';
  }
  const ids = Object.keys(mount.apps);
  if (!ids.length) return path + tail;
  const first = path.split('/')[1] ?? '';
  const segment = first ? decoded(first) : undefined;
  const rest = path.slice(1 + first.length);
  if (segment !== undefined && SERVER_SEGMENTS.includes(segment)) return path + tail;
  if (segment !== undefined && segment !== '') {
    const mounted = ids.find((id) => mount.apps[id] === segment);
    if (mounted !== undefined) return `/${encodeURIComponent(mounted)}${rest}${tail}`;
  }
  const root = rootApp(mount);
  if (root !== undefined) return `/${encodeURIComponent(root)}${path === '/' ? '' : path}${tail}`;
  // An App's id where it is mounted under another name is no address of it.
  if (segment !== undefined && ids.includes(segment)) return undefined;
  return path + tail;
}

/** A server path (`/api/…`, `/_mistri/…`) under the base. */
export const serverPath = (mount: AddressMount, path: string): string => `${mount.base}${path}`;

/** A Set-Cookie value with its `Path=/…` said under the base, so the browser sends it back where the proxy serves the server. */
export const cookieUnder = (base: string, cookie: string): string => (base ? cookie.replace(/(;\s*Path=)\//i, `$1${base}/`) : cookie);

/** The mount as a page carries it to the client (client addressMount.js): compact, and nothing but these two. */
export function mountJson(mount: AddressMount): string {
  return JSON.stringify({ base: mount.base, apps: mount.apps });
}

/** A page's mount, read back; anything malformed is no mount, which is how a page with none behaves. */
export function readMountJson(text: string | null | undefined): AddressMount {
  if (!text) return NO_MOUNT;
  try {
    const value = JSON.parse(text) as { base?: unknown; apps?: unknown };
    // Internal hosts such as Console live under the reserved /_mistri
    // segment, optionally below a suite base. Preserve their server-owned base.
    const base =
      typeof value.base === 'string' && (value.base === '' || /^(\/(?:[A-Za-z0-9][A-Za-z0-9_-]*|_mistri))+$/.test(value.base))
        ? value.base
        : '';
    const apps: Record<string, string> = {};
    if (value.apps && typeof value.apps === 'object') {
      for (const [id, at] of Object.entries(value.apps as Record<string, unknown>)) if (typeof at === 'string') apps[id] = at;
    }
    return { base, apps };
  } catch {
    return NO_MOUNT;
  }
}

/**
 * The public URL (MISTRI_PUBLIC_URL) as the root every outward address is
 * appended to: no trailing slash, and without the base path where it was
 * written with it. A link adds the base itself, so `https://host/desk` with
 * `--base-path /desk` became `/desk/desk` — sign-in answered 404 and looped.
 * Both spellings name the one place; a URL that is not one is left as given.
 */
export function publicRoot(url: string, base: string): string {
  const trimmed = url.replace(/\/+$/, '');
  if (!base) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return path === base || path.endsWith(base) ? `${parsed.origin}${path.slice(0, -base.length)}` : trimmed;
}
