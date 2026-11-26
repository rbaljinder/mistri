/**
 * Public pages drawn on the server: which addresses get their content pane
 * as HTML, from what, and the renderer that draws it.
 *
 * A public form, the landing at `/{app}/welcome`, a signed-out visitor's
 * list or record, and a public custom `definePage({ public: true })` are what
 * a search engine, a link preview, and a first-time visitor fetch, and
 * the shell is one static page. So for those, and only those, the page
 * arrives with its content pane drawn (client/ssr/render.tsx): the landing
 * and the form from the very answer the page's data block carries
 * (http/firstPaint.ts), which the client then takes over in place; a room
 * from the words http/publicPage.ts read under the public grant; and a public
 * custom page from its compiled component, first-paint answers, and loopback
 * public reads. A signed-in reader's pages stay the client's to draw.
 *
 * The renderer is client code, so the server never imports it: from the
 * build it is dist/ssr/render.js (config/vite.ssr.config.ts, React inside); under
 * tsx, the source through Vite's server-side loader. Whatever goes wrong —
 * no build of it, a throw, a render past its time — the page is sent
 * without it and the client draws as it always did. MISTRI_SSR=0 turns it
 * off.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FROM_SOURCE, SOURCE_CLIENT, devClient } from '@mistriwork/engine/server/devclient.js';
import { readKey } from '@mistriwork/engine/shared/firstPaint.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { CLIENT_FILES } from './clientFiles.js';
import type { PublicRoom } from '../shared/publicDocument.js';
import type { AppPayloadApp } from '../shared/appPayload.js';
import { appAddressBook, readAppSegments } from '../shared/appAddress.js';
import { viewOrder } from '../shared/appModel.js';
import { componentCode, type CompiledComponents } from './app/appComponents.js';

type PublicPageReader = (
  method: 'GET' | 'POST',
  target: string,
  body?: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<{ status: number; body: unknown }>;

/** What the renderer is asked to draw (client ssr/render.tsx, PublicRenderInput). */
type RenderInput =
  | { kind: 'landing'; mount: string; app: unknown; landing: unknown }
  | { kind: 'form'; mount: string; app: unknown; form: unknown }
  | { kind: 'room'; mount: string; room: PublicRoom }
  | {
      kind: 'page';
      mount: string;
      app: AppPayloadApp;
      schema: DatabaseSchema;
      viewKey: string;
      dashboard: unknown;
      page: unknown;
      place: Record<string, string>;
      code: string;
      answers?: Readonly<Record<string, { body: unknown }>>;
      read: PublicPageReader;
      signal?: AbortSignal;
    };

/** A content pane the server drew, and which kind it is (`data-ssr` on the pane). */
export interface DrawnPane {
  kind: RenderInput['kind'];
  html: string;
}

type Renderer = (input: RenderInput) => Promise<string>;

/* The renderer's source is this package's; Vite, rooted at the kit's page, loads it by its path. */
const SOURCE = fileURLToPath(new URL('../client/ssr/render.tsx', import.meta.url));
/* The built renderer beside the built server; under tsx with the built client, the one `npm run build` left in dist/. */
const BUILT = new URL(FROM_SOURCE ? '../../dist/ssr/render.js' : '../ssr/render.js', import.meta.url);

let built: Promise<Renderer | undefined> | undefined;

async function renderer(base: string): Promise<Renderer | undefined> {
  if (SOURCE_CLIENT) {
    const vite = await devClient(CLIENT_FILES, base);
    const module = await vite.ssrLoadModule?.(SOURCE);
    return module?.renderPublic as Renderer | undefined;
  }
  built ??= import(pathToFileURL(fileURLToPath(BUILT)).href).then(
    (module: { renderPublic?: Renderer }) => module.renderPublic,
    () => undefined,
  );
  return built;
}

async function draw(input: RenderInput, base: string): Promise<DrawnPane | undefined> {
  if (process.env.MISTRI_SSR === '0') return undefined;
  try {
    const render = await renderer(base);
    if (!render) return undefined;
    const html = await render(input);
    return html ? { kind: input.kind, html } : undefined;
  } catch {
    return undefined;
  }
}

/* The addresses the client's public chunk draws (clientSurface.ts, client publicRoutes.js): the landing for anyone, and a public form as it opens — not its status check or account screen, which ask who is here. */
const WELCOME = /^\/([^/@~]+)\/welcome\/?$/;
const FORM = /^\/([^/@~]+)\/form\/([a-z0-9][a-z0-9-]{0,63})\/?$/;

const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

interface PublicPageContext {
  appId: string;
  search: string;
  components?: CompiledComponents;
  read: PublicPageReader;
  /** True only when the current request is a signed-out visitor (never SSR a signed-in user's view). */
  visitor: boolean;
  /** Aborted when the client disconnects before the HTML response finishes. */
  signal?: AbortSignal;
}

/** Resolve which public custom `definePage` (if any) a path opens, along with its initial address params. */
function resolvePublicCustomPage(
  app: AppPayloadApp,
  schema: DatabaseSchema,
  path: string,
  search: string,
):
  | {
      viewKey: string;
      dashboard: Record<string, unknown>;
      page: Record<string, unknown>;
      componentId: string;
      place: Record<string, string>;
    }
  | undefined {
  const segments = path.split('/').filter(Boolean).slice(1);
  let viewKey: string | undefined;
  let routePlace: Record<string, string> | undefined;
  if (!segments.length) {
    viewKey = app.home;
  } else {
    const book = appAddressBook({
      views: app.views as never,
      order: viewOrder(app),
      resources: app.resources,
      pages: app.pages ?? [],
      tables: schema.tables,
      inbox: app.inbox === true,
      assistant: app.assistant?.page === true,
      directory: app.directory !== undefined,
      projected: true,
    });
    const parsed = readAppSegments(book, segments);
    if (parsed?.kind === 'route' && parsed.target.kind === 'dashboard') {
      viewKey = parsed.target.view;
    } else if (parsed?.kind === 'record' && parsed.target.kind === 'dashboard' && !parsed.natural) {
      viewKey = parsed.target.view;
      const pkVal = Object.values(parsed.key)[0];
      if (pkVal !== undefined && pkVal !== null) {
        const param = parsed.target.recordParam ?? Object.keys(parsed.key)[0] ?? 'id';
        routePlace = { [param]: String(pkVal) };
      }
    }
  }
  if (!viewKey || !Object.hasOwn(app.views, viewKey)) return undefined;
  const view = app.views[viewKey] as unknown as Record<string, unknown>;
  if (!Array.isArray(view.sections)) return undefined;
  const page = view.page as { public?: true; params?: readonly string[] } | undefined;
  if (page?.public !== true) return undefined;
  const sections = view.sections;
  const componentId = (sections[0] as { component?: { id?: string } } | undefined)?.component?.id;
  if (!componentId) return undefined;
  const said = new URLSearchParams(search);
  const place: Record<string, string> = {};
  for (const name of page.params ?? []) {
    const value = said.get(name) ?? routePlace?.[name] ?? null;
    if (value !== null && !value.includes(';')) place[name] = value;
  }
  return { viewKey, dashboard: { id: viewKey, ...view }, page: page as Record<string, unknown>, componentId, place };
}

/**
 * How this page's content pane is drawn on the server, if it is: a function
 * of the page's carried answers (by request, as firstPaint.ts keys them),
 * or undefined for a page the server leaves to the client.
 */
export function publicPane(
  path: string,
  room: PublicRoom | undefined,
  mount: { base: string; json: string },
  /** The name the page's public branding wears (a tenant's saved name), which the client says over the App's. */
  worn?: string,
  /** Context for rendering a public custom `definePage` on the server. */
  customPage?: PublicPageContext,
): ((answers: Readonly<Record<string, { body: unknown }>> | undefined) => Promise<DrawnPane | undefined>) | undefined {
  const welcome = WELCOME.exec(path);
  if (welcome) {
    const app = decoded(welcome[1]);
    return async (answers) => {
      const found = answers?.[readKey('GET', '/api/landing')]?.body as
        | { app?: { id?: unknown; name?: unknown }; landing?: unknown }
        | undefined;
      // As the client checks it (publicSurface.js): this App's landing, or the client draws something else.
      if (!found?.landing || found.app?.id !== app) return undefined;
      const named = typeof found.app?.name === 'string' ? { ...found.app, name: worn ?? found.app.name } : found.app;
      return draw({ kind: 'landing', mount: mount.json, app: named, landing: found.landing }, mount.base);
    };
  }
  const form = FORM.exec(path);
  if (form) {
    const [app, id] = [decoded(form[1]), form[2]];
    return async (answers) => {
      const found = answers?.[readKey('GET', `/api/forms/${encodeURIComponent(id)}`)]?.body as
        | { app?: { id?: unknown; name?: unknown }; form?: { id?: unknown; save?: unknown; steps?: unknown } }
        | undefined;
      /* Only the form the plain surface draws (client publicForm.js): a form saved on every step, or one placed, draws its own. */
      if (!found?.form || found.form.id !== id || found.app?.id !== app || typeof found.app?.name !== 'string') return undefined;
      if ('placement' in found || (found.form.save && found.form.steps)) return undefined;
      /* In the name the client draws it in (publicForm.js), or the page it takes over says another. */
      const named = { ...found.app, name: worn ?? found.app.name };
      return draw({ kind: 'form', mount: mount.json, app: named, form: found.form }, mount.base);
    };
  }
  /* Public custom `definePage({ public: true })` takes precedence over plain PublicRoom fallback when the route
     targets a compiled public custom page (including record-bound custom pages like `/car/1-1969-ford-mustang`). */
  if (customPage?.visitor && customPage.components) {
    return async (answers) => {
      const scoped = (route: string) => `${route}?${new URLSearchParams({ app: customPage.appId })}`;
      const appPayload = answers?.[readKey('GET', scoped('/api/app'))]?.body as { app?: AppPayloadApp; appId?: string } | undefined;
      const schemaPayload = answers?.[readKey('GET', scoped('/api/schema'))]?.body as DatabaseSchema | undefined;
      const servedApp = appPayload?.appId === customPage.appId ? appPayload.app : undefined;
      if (servedApp && schemaPayload) {
        const resolved = resolvePublicCustomPage(servedApp, schemaPayload, path, customPage.search);
        if (resolved) {
          const code = componentCode(customPage.components, resolved.componentId);
          if (code) {
            const namedApp = worn ? { ...servedApp, name: worn } : servedApp;
            const drawn = await draw(
              {
                kind: 'page',
                mount: mount.json,
                app: namedApp,
                schema: schemaPayload,
                viewKey: resolved.viewKey,
                dashboard: resolved.dashboard,
                page: resolved.page,
                place: resolved.place,
                code,
                answers,
                read: customPage.read,
                ...(customPage.signal ? { signal: customPage.signal } : {}),
              },
              mount.base,
            );
            if (drawn) return drawn;
          }
        }
      }
      return room ? draw({ kind: 'room', mount: mount.json, room }, mount.base) : undefined;
    };
  }
  if (room) return () => draw({ kind: 'room', mount: mount.json, room }, mount.base);
  return undefined;
}
