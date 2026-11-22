/**
 * The files a custom component is loaded from: the host modules its bare
 * imports resolve to (`/_mistri/sdk/react.js`, componentSdk.ts) and an
 * App's compiled components (`/{app}/_components/<id>-<hash>.js`, its
 * stylesheet and source map beside it, appComponents.ts).
 *
 * A component is compiled with its imports of React and `@mistriwork/mistri/ui` left
 * bare, and they are written here, as it is served, as absolute paths to the
 * host modules under the server's base path. The page used to resolve them
 * with an import map, and a page has one import map, fixed before its first
 * module loads: a host page that mounts an App (embed/handler.ts) cannot
 * carry ours. An absolute path resolves against the module's own address, so
 * the same file loads at the root, under a base path and from another page.
 *
 * Code, not data, so they are served like the client's own scripts: to
 * whoever can load the page, after the gate's Host check, never with a row
 * in them. Every read a component makes is an ordinary request authorized on
 * its own. A component's files are named for their content and kept for a
 * year; a new compile is new names, which the App payload points at. The host
 * modules depend on the mistri that serves them, so a component names them under
 * the build's content hash (`/_mistri/sdk/<hash>/react.js`, componentSdk.ts
 * hostVersion) and they are kept for a year too; a path with no hash, or another
 * build's, is answered with the current module and asked about each time, so a
 * page left open across a deploy keeps working. A field report: a load fetched
 * all six whole, every time.
 */
import { send } from '@mistriwork/engine/server/http/reply.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { createHash } from 'node:crypto';
import { hostModuleSource, hostVersion } from '../app/componentSdk.js';
import { COMPONENTS_SEGMENT, HOST_MODULES, SDK_PATH } from '../../shared/uiSdk.js';
import { publicFormInputIds } from '../../shared/appComponentPlaces.js';
import { isPublicForm } from '../../shared/app.js';
import type { AppHost } from '../app/apps.js';

const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  map: 'application/json; charset=utf-8',
};
const FILE = new RegExp(`^/([^/]+)/${COMPONENTS_SEGMENT}/([a-z0-9][a-z0-9-]*\\.(js|css|js\\.map))$`);
/* A host module named as a module specifier: `from "react"`, `import "react"`,
   `import("react")`, quoted either way, as the compiler emits an external. */
const HOST_SPECIFIER = new RegExp(
  `(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(["'])(${Object.keys(HOST_MODULES)
    .map((name) => name.replace(/[/]/g, '\\/'))
    .join('|')})\\2`,
  'g',
);
const rewritten = new WeakMap<object, Map<string, string>>();

/** A compiled component's bare host imports as absolute paths under `base`; memoized per compile, since the names are its content's. */
export function withHostPaths(files: Readonly<Record<string, string>>, name: string, base: string): string {
  let made = rewritten.get(files);
  if (!made) rewritten.set(files, (made = new Map()));
  const key = `${base}\0${name}`;
  let code = made.get(key);
  if (code === undefined) {
    code = files[name].replace(
      HOST_SPECIFIER,
      (_match, before: string, quote: string, module: keyof typeof HOST_MODULES) =>
        `${before}${quote}${base}${SDK_PATH}${hostVersion()}/${HOST_MODULES[module]}${quote}`,
    );
    made.set(key, code);
  }
  return code;
}

/** Whether a path is under a `_components` segment, where an App's compiled files are served and nothing else is. */
const underComponents = (path: string) => path.split('/').includes(COMPONENTS_SEGMENT);

/* An address under `_components` that names no file served here is not a page: answered 404 with no body, never the
   HTML shell, which a script tag or a curl would take for the file. */
function missing(ctx: Pick<RequestContext, 'req' | 'res'>): true {
  ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 0, 'x-content-type-options': 'nosniff' });
  ctx.res.end();
  return true;
}

function reply(
  ctx: Pick<RequestContext, 'req' | 'res'>,
  body: string,
  type: string,
  cache: string,
  extra: Record<string, string> = {},
): true {
  const head = ctx.req.method === 'HEAD';
  ctx.res.writeHead(200, {
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  ctx.res.end(head ? undefined : body);
  return true;
}

/** The host module a path under `/_mistri/sdk/` names, with how long it may be kept; undefined for none. */
function hostModuleAnswer(rest: string): { source: string; cache: string } | undefined {
  const versioned = /^([0-9a-f]{10})\/([^/]+)$/.exec(rest);
  const source = hostModuleSource(versioned ? versioned[2] : rest);
  if (source === undefined) return undefined;
  return { source, cache: versioned?.[1] === hostVersion() ? 'public, max-age=31536000, immutable' : 'no-cache' };
}

const tags = new Map<string, string>();

/* The strong validator of one served source: its content, so a rebuilt module is a new one and an unchanged one is a 304. */
function etagOf(source: string): string {
  let tag = tags.get(source);
  if (tag === undefined) {
    tag = `"${createHash('sha256').update(source).digest('hex').slice(0, 20)}"`;
    tags.set(source, tag);
  }
  return tag;
}

function hostModuleRoute(ctx: Pick<RequestContext, 'req' | 'res'>, path: string): true {
  const answer = hostModuleAnswer(path.slice(SDK_PATH.length));
  if (!answer) {
    send(ctx.res, 404, { error: 'No such module.' });
    return true;
  }
  const tag = etagOf(answer.source);
  const match = ctx.req.headers['if-none-match'];
  if (typeof match === 'string' && match.split(',').some((candidate) => candidate.trim() === tag)) {
    ctx.res.writeHead(304, { etag: tag, 'cache-control': answer.cache, 'x-content-type-options': 'nosniff' });
    ctx.res.end();
    return true;
  }
  return reply(ctx, answer.source, TYPES.js, answer.cache, { etag: tag });
}

/**
 * A tenant App's host (tenant/tenantAuthenticatedHttp.ts): the host modules to
 * anyone, as here, and the App's compiled files, source maps included, to a
 * verified session. A signed-out visitor of an App that opens public reads is
 * served the code of the components its public pages draw (`visitorFiles`,
 * appComponents.ts publicComponentIds), never a source map, which carries the
 * App's own source; every read such a component makes is still
 * the visitor's, placed by its address. `signedIn` is asked only for a path
 * that names one of the App's files. Answers false for a path that is neither.
 */
export async function tenantComponentRoute(
  ctx: Pick<RequestContext, 'req' | 'res'>,
  path: string,
  appId: string,
  files: Readonly<Record<string, string>> | undefined,
  signedIn: () => Promise<boolean>,
  base = '',
  visitorFiles: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false;
  if (path.startsWith(SDK_PATH)) return hostModuleRoute(ctx, path);
  const match = FILE.exec(path);
  if (!match) return underComponents(path) ? missing(ctx) : false;
  let named: string;
  try {
    named = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const visitorMay = match[3] !== 'js.map' && visitorFiles.has(match[2]);
  if (named !== appId || !files || !Object.hasOwn(files, match[2]) || (!visitorMay && !(await signedIn()))) {
    return missing(ctx);
  }
  const extension = match[3] === 'js.map' ? 'map' : match[3];
  const body = extension === 'js' ? withHostPaths(files, match[2], base) : files[match[2]];
  return reply(ctx, body, TYPES[extension], extension === 'map' ? 'private, no-cache' : 'private, max-age=31536000, immutable');
}

const formFiles = new WeakMap<object, ReadonlySet<string>>();

/* The files of the input components an App's public forms draw (appComponentPlaces.ts publicFormInputIds), and its
   control kit's, per compile. */
function publicFormFiles(host: AppHost): ReadonlySet<string> {
  const compiled = host.app.components;
  if (!compiled) return new Set();
  let files = formFiles.get(compiled);
  if (!files) {
    const ids = new Set<string>();
    for (const view of Object.values(host.app.app.views)) if (isPublicForm(view)) for (const id of publicFormInputIds(view)) ids.add(id);
    files = new Set([
      ...Object.entries(compiled.entries)
        .filter(([id, entry]) => ids.has(id) && entry.kind === 'input')
        .flatMap(([, entry]) => [entry.js, ...(entry.css ? [entry.css] : [])]),
      /* The control kit draws the sign-in screen and a public form as it draws every other page, before anyone signs in. */
      ...(compiled.kit ? [compiled.kit.js, ...(compiled.kit.css ? [compiled.kit.css] : [])] : []),
    ]);
    formFiles.set(compiled, files);
  }
  return files;
}

export async function componentRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, path, appHosts } = ctx;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (path.startsWith(SDK_PATH)) return hostModuleRoute(ctx, path);
  const match = FILE.exec(path);
  if (!match) return underComponents(path) ? missing(ctx) : false;
  let appId: string;
  try {
    appId = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const host = appHosts?.find((candidate) => candidate.app.app.id === appId);
  /* In an App that signs people in, a component is drawn for a signed-out
     visitor only over what `auth.public` opens (appComponents.ts), or as one of
     a public form's inputs, so only such an App serves a visitor its compiled
     code — every file where it opens public reads, else the public forms'
     inputs' alone — and never its source map, which carries the App's own
     source. Elsewhere a signed-out visitor is told there is no such file, and a
     shared cache never keeps one. */
  const signsIn = Boolean(host?.auth);
  const signedIn = typeof ctx.identity.id === 'string' && Boolean(ctx.identity.id.trim());
  const opensPublic = Boolean(host?.app.app.auth?.public);
  const visitorMay = match[3] !== 'js.map' && (opensPublic || (host !== undefined && publicFormFiles(host).has(match[2])));
  const files = signsIn && !signedIn && !visitorMay ? undefined : host?.app.components?.files;
  if (!files || !Object.hasOwn(files, match[2])) {
    return missing(ctx);
  }
  const extension = match[3] === 'js.map' ? 'map' : match[3];
  const cache =
    extension === 'map' ? (signsIn ? 'private, no-cache' : 'no-cache') : `${signsIn ? 'private' : 'public'}, max-age=31536000, immutable`;
  return reply(ctx, extension === 'js' ? withHostPaths(files, match[2], ctx.mount.base) : files[match[2]], TYPES[extension], cache);
}
