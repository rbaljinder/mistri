/**
 * Public pages drawn on the server: which addresses get their content pane
 * as HTML, from what, and the renderer that draws it.
 *
 * A public form, the landing at `/{app}/welcome` and a signed-out visitor's
 * list or record are what a search engine and a link preview fetch, and
 * the shell is one static page. So for those, and only those, the page
 * arrives with its content pane drawn (client/ssr/render.tsx): the landing
 * and the form from the very answer the page's data block carries
 * (http/firstPaint.ts), which the client then takes over in place; a room
 * from the words http/publicPage.ts read under the public grant. A
 * signed-in reader's pages stay the client's to draw.
 *
 * The renderer is client code, so the server never imports it: from the
 * build it is dist/ssr/render.js (vite.ssr.config.ts, React inside); under
 * tsx, the source through Vite's server-side loader. Whatever goes wrong —
 * no build of it, a throw, a render past its time — the page is sent
 * without it and the client draws as it always did. MISTRI_SSR=0 turns it
 * off.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FROM_SOURCE, SOURCE_CLIENT, devClient } from '@mistriwork/engine/server/devclient.js';
import { readKey } from '@mistriwork/engine/shared/firstPaint.js';
import { CLIENT_FILES } from './clientFiles.js';
import type { PublicRoom } from '../shared/publicDocument.js';

/** What the renderer is asked to draw (client ssr/render.tsx, PublicRenderInput). */
type RenderInput =
  | { kind: 'landing'; mount: string; app: unknown; landing: unknown }
  | { kind: 'form'; mount: string; app: unknown; form: unknown }
  | { kind: 'room'; mount: string; room: PublicRoom };

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

/**
 * How this page's content pane is drawn on the server, if it is: a function
 * of the page's carried answers (by request, as firstPaint.ts keys them),
 * or undefined for a page the server leaves to the client.
 */
export function publicPane(
  path: string,
  room: PublicRoom | undefined,
  mount: { base: string; json: string },
): ((answers: Readonly<Record<string, { body: unknown }>> | undefined) => Promise<DrawnPane | undefined>) | undefined {
  if (room) return () => draw({ kind: 'room', mount: mount.json, room }, mount.base);
  const welcome = WELCOME.exec(path);
  if (welcome) {
    const app = decoded(welcome[1]);
    return async (answers) => {
      const found = answers?.[readKey('GET', '/api/landing')]?.body as { app?: { id?: unknown }; landing?: unknown } | undefined;
      // As the client checks it (publicSurface.js): this App's landing, or the client draws something else.
      if (!found?.landing || found.app?.id !== app) return undefined;
      return draw({ kind: 'landing', mount: mount.json, app: found.app, landing: found.landing }, mount.base);
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
      return draw({ kind: 'form', mount: mount.json, app: found.app, form: found.form }, mount.base);
    };
  }
  return undefined;
}
