/**
 * `GET /api/embed/boot`: what `@mistriwork/mistri/react` asks once before it draws.
 *
 * Bare, it says which embed protocol and which release this server speaks,
 * for the package to check (shared/embedProtocol.ts says why). That answer is
 * given beside the orchestrator's probes, before any gate, so a signed-out
 * embed learns that it cannot work rather than being shown a sign-in screen
 * it could never get past. It says `major.minor` and nothing finer: the rule
 * needs no more, and a release's patch number tells a stranger which fixes it
 * lacks.
 *
 * With `?app=` (and the address the element shows, `path` and `search` in
 * their inside form) it is the embed's first page: an embedded shell has no
 * page of the server's to carry its first answers (http/firstPaint.ts), so
 * this carries them instead — who is here, the runtime, the App, its pages
 * and schema, and the first room's reads — and the shell starts on one round
 * trip, not five. That form is answered after the gate, by `embedBootRoute`:
 * it reads nothing itself, and every answer it carries was asked through the
 * whole dispatcher with this request's own headers, so every gate, grant and
 * row policy applies exactly as it would to the fetch it stands for.
 *
 * With `?app=` and `?surface=` it is a headless front end's (`<Provider headless surface>`): no page and no first
 * room, only the surface as this reader may use it (`EmbedSurface`) — its tables in the reader's own catalog, asked
 * through the same loop, and its commands with this reader's grants. A surface no one by that key may use is refused
 * as its requests would be, 403 `{ code: 'surface' }`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EMBED_BOOT_PATH,
  EMBED_PROTOCOL,
  minorVersion,
  type EmbedBoot,
  type EmbedSurface,
  type EmbedSurfaceCommand,
} from '../../shared/embedProtocol.js';
import type { AppSurface } from '../../shared/appModel.js';
import { labelColumn, labelPath, primaryKey, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { FirstPaintData } from '@mistriwork/engine/shared/firstPaint.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { corsHeaders } from './crossOrigin.js';
import { firstPaint, type Loop } from '@mistriwork/engine/server/http/firstPaint.js';
import { APP_PAINT_ROOMS } from '../http/firstPaintRooms.js';
import { send } from '@mistriwork/engine/server/http/reply.js';

const bare = (): EmbedBoot => ({ protocol: EMBED_PROTOCOL, version: minorVersion(runtimeVersion()) });

/**
 * The bare answer, before any gate: true when this answered. A request that
 * names an App is left for the dispatcher (`embedBootRoute`) where `deferred`
 * says this server has one; a preflight is left for the gate's door. `origins`
 * are the browser origins this server answers CORS for (crossOrigin.ts): the
 * bare answer is read cross-origin before any session exists.
 */
export function embedBoot(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL | string,
  options: { origins?: ReadonlySet<string>; deferred?: boolean } = {},
): boolean {
  const path = typeof url === 'string' ? url : url.pathname;
  if (path !== EMBED_BOOT_PATH || req.method === 'OPTIONS') return false;
  if (options.deferred && typeof url !== 'string' && url.searchParams.has('app')) return false;
  const origin = req.headers.origin;
  const cors = typeof origin === 'string' && options.origins?.has(origin) ? corsHeaders(origin) : {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store', ...cors }).end();
    return true;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(bare()));
  return true;
}

/** An inside address the boot may be asked for: an App's, never the server's own or a scheme. */
const INSIDE = /^\/[^/]/;

/**
 * The boot with the first answers in it, for the App `?app=` names: the
 * protocol and version, whether the request is signed in, and `data`, the
 * first-paint block (shared/firstPaint.ts) the shell's reader takes its first
 * requests from. `data` is absent when nothing could be carried — a branded
 * App, whose answers are its record's (as for the served page), or an answer
 * past its budget — and the shell then asks for itself.
 */
export async function embedBootRoute(
  ctx: {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    path: string;
    signedIn: boolean;
    carries: (path: string) => boolean;
    /** The surface `key` names, as this reader may use it, or the refusal its requests would get. */
    surface?: (key: string) => SurfaceAnswer;
    /** The loop a surface's catalog is asked through: past the surface's own gate (surfaceGate.ts). */
    surfaceLoop?: () => Loop;
  },
  loop: () => Loop,
): Promise<boolean> {
  const { req, res, url } = ctx;
  if (ctx.path !== EMBED_BOOT_PATH) return false;
  /* Personal: never stored, and never handed to another origin or session by a cache. */
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('vary', 'Origin, Cookie, Authorization');
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    send(res, 405, { error: 'GET the boot.' });
    return true;
  }
  const app = url.searchParams.get('app') ?? '';
  const asked = url.searchParams.get('path') || `/${encodeURIComponent(app)}`;
  const search = url.searchParams.get('search') ?? '';
  if (!app || !INSIDE.test(asked) || asked.length > 2048 || search.length > 4096 || (search && !search.startsWith('?'))) {
    send(res, 400, { error: 'Ask the boot for an App: ?app=<id>, and the inside address it shows as path= and search=.' });
    return true;
  }
  if (url.searchParams.has('surface')) return surfaceBoot(ctx, app, url.searchParams.get('surface') ?? '');
  /* The address must be the App's: the room reads are planned from it, and they are another App's otherwise. */
  const first = asked.split('/')[1] ?? '';
  let named = '';
  try {
    named = decodeURIComponent(first);
  } catch {
    /* said below */
  }
  if (named !== app) {
    send(res, 400, { error: `The boot's path is an address inside "${app}": /${encodeURIComponent(app)}/….` });
    return true;
  }
  const page = ctx.carries(asked) ? await firstPaint({ path: asked, search, loop: loop(), rooms: APP_PAINT_ROOMS }) : {};
  if (res.destroyed || res.writableEnded) return true;
  send(res, 200, {
    ...bare(),
    signedIn: ctx.signedIn,
    ...(page.json ? { data: JSON.parse(page.json) as FirstPaintData } : {}),
  } satisfies EmbedBoot);
  return true;
}

type SurfaceAnswer =
  | { surface: AppSurface; commands: Omit<EmbedSurfaceCommand, 'key'>[] }
  | { status: number; body: { error: string; code?: string } };

/** A headless front end's boot: the surface, its tables in the reader's catalog, and its commands. */
async function surfaceBoot(ctx: Parameters<typeof embedBootRoute>[0], app: string, key: string): Promise<boolean> {
  const { res } = ctx;
  /* Signed out there is nothing a surface may read: the front end signs the person in first. */
  if (!ctx.signedIn) {
    send(res, 200, { ...bare(), signedIn: false } satisfies EmbedBoot);
    return true;
  }
  const answer = ctx.surface?.(key) ?? { status: 403, body: { error: 'This server serves no surfaces.', code: 'surface' } };
  if ('status' in answer) {
    send(res, answer.status, answer.body);
    return true;
  }
  const asked = await ctx.surfaceLoop?.()('GET', `/api/schema?${new URLSearchParams({ app })}`);
  if (res.destroyed || res.writableEnded) return true;
  if (!asked || asked.status !== 200 || !asked.body || typeof asked.body !== 'object') {
    send(res, asked?.status && asked.status >= 400 ? asked.status : 502, {
      error: "The App's catalog could not be read for this surface.",
    });
    return true;
  }
  send(res, 200, {
    ...bare(),
    signedIn: true,
    surface: surfaceFrame(app, answer.surface, answer.commands, asked.body as DatabaseSchema),
  } satisfies EmbedBoot);
  return true;
}

/** The surface in the reader's catalog: only its own tables, each keyed and titled as a kit host would key and title it. */
function surfaceFrame(
  app: string,
  surface: AppSurface,
  commands: readonly Omit<EmbedSurfaceCommand, 'key'>[],
  readable: DatabaseSchema,
): EmbedSurface {
  const tables = surface.reads.flatMap((name) => {
    const table = tableNamed(readable, name);
    return table ? [table] : [];
  });
  return {
    key: surface.key,
    label: surface.label,
    app,
    loader: Boolean(surface.loader),
    declared: [...surface.reads],
    schema: { ...readable, tables },
    reads: tables.map((table) => {
      const key = primaryKey(table);
      return {
        id: table.id,
        name: table.name,
        key,
        title: labelPath(readable, table) ?? labelColumn(table) ?? key[0] ?? '',
      };
    }),
    commands: commands.map((command) => {
      const target = command.target === undefined ? undefined : tableNamed(readable, command.target);
      return target ? { ...command, target: target.id, key: primaryKey(target) } : command;
    }),
  };
}
