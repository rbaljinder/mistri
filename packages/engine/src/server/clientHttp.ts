/**
 * The shared client files. Callers own host checks and API dispatch.
 *
 * From source, Vite's middleware answers (devclient.ts). From the build,
 * dist/client is served the way `vite build` left it (vite.config.ts): the
 * scripts and stylesheets under assets/ are named for their content, so a
 * browser may keep them for a year and never ask again; index.html and
 * anything else unhashed is revalidated on every load, by ETag, so an
 * unchanged page costs a 304. Every text file has a `.br` and a `.gz` beside
 * it, and the request's Accept-Encoding picks one; the one thing compressed
 * here, per request, is a public page with its own head (publicHead.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlib, createBrotliCompress, createGzip, gzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { SOURCE_CLIENT, devClient, type ClientFiles } from './devclient.js';
import { localePreloads, lookPreloads, SURFACE_PAGES, surfaceFor, tenantPreloads, type PageGrounds } from './clientSurface.js';
import { FONT_TOKENS, PALETTE_TOKENS, parseThemes, shapeTokens } from '../shared/theme.js';
import { headingWeight, inheritThemePreset, lookNavRole } from '../shared/themePresets.js';
import { typeTokens } from '../shared/themeType.js';
import { fieldEdge } from '../shared/themeColor.js';
import { recipeAttributes } from '../shared/themeRecipes.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The page's Content-Security-Policy: what the shell — the one page every
 * App, sign-in and the Workbench are drawn in — may load and talk to.
 *
 * The reason is egress. Every endpoint the page can reach is authorized on
 * the server, so a script in the page can do nothing the reader could not;
 * what the server cannot stop is a script sending what the reader sees
 * somewhere else. So scripts come from this origin and from the inline
 * startup scripts in index.html, pinned by their hashes, and the page talks
 * to this origin alone (`connect-src 'self'`, which also admits the dev
 * server's hot-reload socket on the same port). Images may come from any
 * https address, because an App may name a picture by URL in a column (a
 * card's image); nothing else leaves the origin. Styles keep
 * `'unsafe-inline'`: React's style props, the layout preview's copied
 * sheets and the dev server's injected stylesheets are all inline, and a
 * stylesheet cannot send anything the image and connect rules do not let
 * out. The hashes are read from the page being sent — Vite adds its own
 * inline script in development — so a changed startup script cannot drift
 * from its policy.
 */
export function shellPolicy(html: string, { fromSource = false, socket }: { fromSource?: boolean; socket?: string } = {}): string {
  const hashes: string[] = [];
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    /* A data block (firstPaint.ts) is never run, so it is never allowed to be. */
    if (/\bsrc\s*=/i.test(attributes) || /\btype\s*=\s*"application\/json"/i.test(attributes)) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    /* From source only, the dev client's hot-reload socket where it is not this origin's (devclient.ts devSocket). */
    ["connect-src 'self'", ...(fromSource && socket ? [socket] : [])].join(' '),
    "object-src 'none'",
    /* An attached PDF is previewed in a frame of a Blob the page made from
       bytes it checked begin `%PDF-` (FilePreview.tsx): a document of this
       origin, typed by the page, never a URL a column names. */
    "frame-src 'self' blob:",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    /* From source only: Vite's client, when its hot-reload socket drops,
       waits for the server in a shared worker it makes from a blob. The
       built client has no such worker and is not offered one. */
    ...(fromSource ? ["worker-src 'self' blob:"] : []),
  ].join('; ');
}

/**
 * Where the served Apps' custom components may reach beyond the page's own
 * origin (`ui.csp`, recorded in each App's authority.lock).
 * One shell draws every App a server serves, and a reader moves between them
 * without it reloading, so the policy opens the union — nothing any of them
 * did not declare. Once any App serves components, the page's pictures stop
 * coming from any https address: an image request is a way out too, so its
 * origins are the declared ones.
 */
interface ShellEgress {
  connect: readonly string[];
  images: readonly string[];
  narrowImages: boolean;
  /** A human check's provider (`auth.challenge` with a widget): its script, the frame it draws and what it asks. */
  widgets?: readonly string[];
}

/** The egress of the Apps a server serves, from their `ui`, whether each serves components, and the origin of the
    human check widget its public forms draw (the App framework's commands/challenges.ts), if any. */
export function shellEgress(
  apps: ReadonlyArray<{ ui: { csp?: { connect?: readonly string[]; images?: readonly string[] } }; components: boolean; widget?: string }>,
): ShellEgress | undefined {
  const connect = [...new Set(apps.flatMap((app) => app.ui.csp?.connect ?? []))].sort();
  const images = [...new Set(apps.flatMap((app) => app.ui.csp?.images ?? []))].sort();
  const narrowImages = apps.some((app) => app.components);
  const widgets = [...new Set(apps.flatMap((app) => (app.widget ? [new URL(app.widget).origin] : [])))].sort();
  return connect.length || images.length || narrowImages || widgets.length
    ? { connect, images, narrowImages, ...(widgets.length ? { widgets } : {}) }
    : undefined;
}

/** The shell's policy with the served Apps' egress in its connect and image sources (shellPolicy writes both directives exactly so). */
export function withEgress(policy: string, egress: ShellEgress | undefined): string {
  if (!egress) return policy;
  return policy
    .split('; ')
    .map((directive) => {
      const widgets = egress.widgets ?? [];
      if (directive.startsWith("connect-src 'self'")) return [directive, ...egress.connect, ...widgets].join(' ');
      if (widgets.length && (directive.startsWith("script-src 'self'") || directive.startsWith("frame-src 'self'")))
        return [directive, ...widgets].join(' ');
      if (directive.startsWith('img-src ') && egress.narrowImages) return ["img-src 'self' data: blob:", ...egress.images].join(' ');
      if (directive.startsWith('img-src ')) return [directive, ...egress.images].join(' ');
      return directive;
    })
    .join('; ');
}

/**
 * The shell's policy with who may frame it: `'self'` alone, unless the page
 * was asked for as a frame (`?embed=frame`, http/handler.ts) and a host's
 * origins are listed for it (embed/crossOrigin.ts) — the iframe fallback for
 * a page that is not a React app, or whose own unlayered CSS would reach an
 * embedded shell. Only an origin listed is ever named: everyone else is
 * refused the frame, as before. shellPolicy writes the directive exactly so.
 */
function withFrameAncestors(policy: string, origins: readonly string[] | undefined): string {
  if (!origins?.length) return policy;
  return policy.replace("frame-ancestors 'self'", ["frame-ancestors 'self'", ...origins].join(' '));
}

/** A page's whole policy: its own, the served Apps' egress, and who may frame it. */
const pagePolicy = (policy: string, shell: ShellTitle | undefined) =>
  shell?.unframed
    ? withEgress(policy, shell.egress).replace("frame-ancestors 'self'", "frame-ancestors 'none'")
    : withFrameAncestors(withEgress(policy, shell?.egress), shell?.frameAncestors);

/**
 * What one page's shell says of itself beyond the static file: a public
 * page's title and canonical address (http/publicHead.ts), the served Apps'
 * egress, and where the Apps are mounted (shared/mount.ts) — the base path
 * its own files are under and the mounts the client reads its addresses by —
 * with the inside address the page is for, which names its surface, and
 * where the dev observer is when one runs (server/observe/): the page reports
 * its errors and layout shifts there and shows its badge.
 */
interface ShellTitle {
  title?: string;
  canonical?: string;
  egress?: ShellEgress;
  /** Origins besides this one that may frame the page (`withFrameAncestors`). */
  frameAncestors?: readonly string[];
  /** Nobody may frame the page, this origin included: an OAuth consent page (http/handler.ts). */
  unframed?: boolean;
  mount?: { base: string; json: string };
  path?: string;
  /** The database browser's page (browserHandler.ts): its own surface, and the meta that starts its main (clientSurface.ts). */
  workbench?: true;
  observe?: string;
  /** Already resolved under the request's read owner, before streaming begins. */
  branding?: HeadBranding;
  /** The look sheets the App at this address wears (clientSurface.ts lookSheetsFor), preloaded beside the entry. */
  looks?: readonly string[];
  /** The density that look starts at (clientSurface.ts lookDensityFor), said in the page so boot zooms to it once. */
  density?: string;
  /**
   * The App at this address is an installable PWA (mistri http/pwaRoutes.ts):
   * its manifest and the script that registers its worker, both from this
   * origin, so the page's `script-src 'self'` admits them with no inline
   * script and no hash to keep. Absent, the page says nothing of the kind.
   */
  pwa?: { manifest: string; register: string };
  /** The scheme that look says (clientSurface.ts lookSchemeFor), said in the page so it is dark from its first paint. */
  scheme?: 'dark' | 'dark-only';
  /** The page's colours in each mode (clientSurface.ts lookGroundsFor), written as `color-scheme` and `theme-color`. */
  grounds?: PageGrounds;
  /** The look sheets whose face that look is set in (clientSurface.ts lookFacesFor), preloaded beside them. */
  faces?: readonly string[];
  /** The App theme's own faces: their `@font-face` rules and the heading face's preload (clientSurface.ts appFaceHead). */
  appFaces?: string;
  /** A tenant host's page: its shell page preloads the tenant's flows too (clientSurface.ts tenantPreloads). */
  tenant?: true;
  /** The reader's locale where the server knows it (an App's), so a non-English reader's chrome words are preloaded (clientSurface.ts localePreloads). */
  locale?: string;
  /** The page's first answers (http/firstPaint.ts), asked only when a page — not a file — is what is sent. */
  data?: () => Promise<ShellData | undefined>;
  /** What a link preview reads (http/publicHead.ts): the page's absolute address, its words and its picture. */
  social?: SocialHead;
  /** The content pane drawn on the server (publicRender.ts), from the page's carried answers where it needs them. */
  pane?: (answers: ShellData['answers']) => Promise<DrawnPane | undefined>;
}

/**
 * A record's look a page is sent in (the App framework's http/recordBranding.ts
 * BrandingPresentation): the theme, which is validated again here before a
 * token is written, whether the look is one person's (the page is then never
 * stored by a shared cache), and the whole presentation, which the page
 * carries as JSON.
 */
interface HeadBranding {
  readonly value: { readonly theme: unknown };
  readonly private: boolean;
}

/** A content pane drawn on the server (the App framework's publicRender.ts): its kind, said to the client, and its markup. */
interface DrawnPane {
  kind: string;
  html: string;
}

/** A page's data block (firstPaint.ts), written where the page's body ends, and the answers it carries by request. */
interface ShellData {
  block: string;
  answers?: Readonly<Record<string, { body: unknown }>>;
}

/** A public page as a link preview and a search result say it: Open Graph and Twitter's card. */
export interface SocialHead {
  /** The canonical address, absolute. */
  url: string;
  title: string;
  site: string;
  description?: string;
  /** The preview picture, absolute. */
  image?: string;
  imageAlt?: string;
  type: 'website' | 'article';
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Whether a page's head changes its bytes: anything but the egress, which is only its policy. */
const writesHead = (head: ShellTitle | undefined) =>
  Boolean(
    head?.title ||
    head?.canonical ||
    head?.mount ||
    head?.workbench ||
    head?.observe ||
    head?.density ||
    head?.scheme ||
    head?.grounds ||
    head?.branding ||
    head?.looks?.length ||
    head?.social ||
    head?.pane ||
    head?.pwa,
  );

/** Generate only registered token names and validated theme values. Row text
 * exists only in escaped JSON; it can never close a style/script element. */
function brandingHead(html: string, presentation: HeadBranding): string {
  const theme = parseThemes([presentation.value.theme], 'Request branding')![0];
  const declarations = (mode: 'light' | 'dark') => {
    const pairs: Array<[string, string]> = [];
    for (const [key, token] of Object.entries(PALETTE_TOKENS)) {
      const value = theme[mode][key as keyof typeof theme.light];
      if (value) pairs.push([token, value]);
    }
    // A command form's field edge at rest, as the App's theme writer derives it (appTheme.js).
    const edge = fieldEdge(theme[mode]);
    if (edge) pairs.push(['--field-edge', edge]);
    for (const [key, token] of Object.entries(FONT_TOKENS)) {
      const value = theme.fonts?.[key as keyof NonNullable<typeof theme.fonts>];
      if (value) pairs.push([token, value]);
    }
    for (const [token, value] of Object.entries(shapeTokens(theme))) pairs.push([token, value]);
    for (const [token, value] of Object.entries(typeTokens(inheritThemePreset(theme).type))) pairs.push([token, value]);
    pairs.push(['--heading-weight', String(headingWeight(theme))]);
    return pairs.map(([key, value]) => `${key}:${value}`).join(';');
  };
  const root = ':root[data-record-branding]';
  const css = `${root}{${declarations('light')}}@media(prefers-color-scheme:dark){${root}:not([data-theme="light"]){${declarations('dark')}}}${root}[data-theme="dark"]{${declarations('dark')}}`;
  const json = JSON.stringify(presentation).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const block = `<style id="mistri-branding-style">${css}</style><script type="application/json" id="mistri-branding">${json}</script>`;
  /* The recipes are menu values (parseThemes refused anything else), written as attributes the sheets answer. */
  const looks = Object.entries(recipeAttributes(inheritThemePreset(theme), lookNavRole(theme)).attributes)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
  let out = html.replace(
    /<html\b([^>]*)>/i,
    (_, attributes: string) =>
      `<html${attributes} data-record-branding data-custom-theme data-visual-theme="${theme.id}" data-theme-style="${theme.base ?? ''}" data-theme-palette="default"${looks}>`,
  );
  out = /<meta charset[^>]*>/i.test(out)
    ? out.replace(/<meta charset[^>]*>/i, (match) => `${match}\n${block}`)
    : /<head>/i.test(out)
      ? out.replace(/<head>/i, (match) => `${match}${block}`)
      : `${block}${out}`;
  return out;
}

/**
 * The shell with a page's own head written in. Under a base path the page's
 * own files are said under it (a component's host modules are said under it
 * where the component is served, componentRoutes.ts). An inline script the
 * head adds changes the page, so a caller whose page changed takes its policy
 * from the page it sends (shellPolicy), never the static file's.
 */
export function withHead(html: string, head: ShellTitle | undefined): string {
  if (!writesHead(head)) return html;
  let out = html;
  if (head?.branding) out = brandingHead(out, head.branding);
  const base = head!.mount?.base;
  if (base) {
    out = out.replace(/(\s(?:src|href)=")\/(?=assets\/)/g, (_, attribute: string) => `${attribute}${base}/`);
  }
  /* Before any script reads them: index.html's first script keys its startup colours by App and stamps its scheme. */
  const beforeScripts = (meta: string) => {
    out = /<meta charset[^>]*>/i.test(out)
      ? out.replace(/<meta charset[^>]*>/i, (match) => `${match}\n    ${meta}`)
      : /<head>/i.test(out)
        ? out.replace(/<head>/i, (match) => `${match}${meta}`)
        : out.replace(/<title>|<script/i, (match) => `${meta}${match}`);
  };
  if (head!.mount) beforeScripts(`<meta name="mistri-mount" content="${escapeHtml(head!.mount.json)}">`);
  /* Read by the entry before it starts a main (packages/kit/src/client/shellStart.js): the Workbench's, not an App's. */
  if (head!.workbench) beforeScripts('<meta name="mistri-shell" content="workbench">');
  if (head!.scheme) beforeScripts(`<meta name="mistri-scheme" content="${escapeHtml(head!.scheme)}">`);
  if (head!.grounds) out = out.replace(/<\/head>/i, () => `  ${groundsMeta(head!.grounds!)}\n  </head>`);
  if (head!.observe)
    out = out.replace(/<\/head>/i, () => `  <meta name="mistri-observe" content="${escapeHtml(head!.observe!)}">\n  </head>`);
  if (head!.density)
    out = out.replace(/<\/head>/i, () => `  <meta name="mistri-density" content="${escapeHtml(head!.density!)}">\n  </head>`);
  /* An installable App: its manifest, and the script that registers its
     worker once the page has loaded. Both from this origin, so no inline
     script is needed and the page's policy admits them as they stand. */
  if (head!.pwa)
    out = out.replace(
      /<\/head>/i,
      () =>
        `  <link rel="manifest" href="${escapeHtml(head!.pwa!.manifest)}">\n  <script src="${escapeHtml(head!.pwa!.register)}" defer></script>\n  </head>`,
    );
  if (!head?.title && !head?.canonical) return out;
  /* Replaced by a function, never a replacement string: a string's `$&`,
     `` $` `` and `$'` are patterns, and a record's name is anybody's text —
     `$'` in a title would pour the rest of the page into it. */
  const title = head.title && `<title>${escapeHtml(head.title)}</title>`;
  const canonical = head.canonical && `  <link rel="canonical" href="${escapeHtml(head.canonical)}">\n`;
  const social = head.social ? socialMeta(head.social) : '';
  if (title) out = out.replace(/<title>[^<]*<\/title>/i, () => title);
  if (canonical || social) out = out.replace(/<\/head>/i, () => `${canonical || ''}${social}  </head>`);
  return out;
}

/**
 * What the browser draws around the page: the form controls and scroll bars in the scheme the theme wears
 * (`color-scheme`; a dark-only theme says dark alone), and the address bar and overscroll in its ground, one
 * `theme-color` for each mode the reader's machine can be in. Plain HTML in the head: nothing for a script to wait on.
 */
export function groundsMeta(grounds: PageGrounds): string {
  const colors = [grounds.light, grounds.dark].map(escapeHtml);
  if (grounds.scheme === 'dark-only')
    return `<meta name="color-scheme" content="dark">\n  <meta name="theme-color" content="${colors[1]}">`;
  return [
    '<meta name="color-scheme" content="light dark">',
    `<meta name="theme-color" content="${colors[0]}" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="${colors[1]}" media="(prefers-color-scheme: dark)">`,
  ].join('\n  ');
}

/** The tags a link preview and a search result read, every value escaped: a record's name and words are anybody's text. */
function socialMeta(social: SocialHead): string {
  const tags: Array<[attribute: 'name' | 'property', key: string, value: string | undefined]> = [
    ['name', 'description', social.description],
    ['property', 'og:type', social.type],
    ['property', 'og:site_name', social.site],
    ['property', 'og:title', social.title],
    ['property', 'og:url', social.url],
    ['property', 'og:description', social.description],
    ['property', 'og:image', social.image],
    ['property', 'og:image:alt', social.image ? social.imageAlt || undefined : undefined],
    ['name', 'twitter:card', social.image ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', social.title],
    ['name', 'twitter:description', social.description],
    ['name', 'twitter:image', social.image],
  ];
  return tags
    .filter(([, , value]) => value)
    .map(([attribute, key, value]) => `  <meta ${attribute}="${key}" content="${escapeHtml(value!)}">\n`)
    .join('');
}

/** The tag that opens the content pane, and everything to its close: the place a server-drawn pane goes. */
const PANE = /<main\b([^>]*\bid="content"[^>]*)>[\s\S]*?<\/main>/i;

/** The page with its content pane drawn in, and marked with its kind for the client (client serverDrawing.js). */
function withPane(html: string, pane: DrawnPane | undefined): string {
  if (!pane) return html;
  return html.replace(PANE, (_, attributes: string) => `<main${attributes} data-ssr="${pane.kind}">${pane.html}</main>`);
}

/** The pane, or none: a page is served whole whether or not the server could draw it. */
async function drawnPane(shell: ShellTitle | undefined, data: ShellData | undefined): Promise<DrawnPane | undefined> {
  if (!shell?.pane) return undefined;
  try {
    return await shell.pane(data?.answers);
  } catch {
    return undefined;
  }
}

/** The page asking for its look's sheets, its reader's words and a tenant host's flows beside the entry (clientSurface.ts), ahead of the entry's own script. */
function withLooks(html: string, shell: ShellTitle | undefined, files: Iterable<string>): string {
  const assets = [...files];
  const links =
    lookPreloads(shell?.looks ?? [], assets, shell?.faces) +
    (shell?.appFaces ?? '') +
    localePreloads(shell?.locale, assets) +
    (shell?.tenant && !shell.workbench && surfaceFor(shell.path ?? '') === 'shell' ? tenantPreloads(assets) : '');
  if (!links) return html;
  return /<script type="module"/i.test(html)
    ? html.replace(/<script type="module"/i, (match) => `${links.trimStart()}    ${match}`)
    : html.replace(/<\/head>/i, () => `${links}  </head>`);
}

/** The page with its data block (firstPaint.ts) at the end of its body, where nothing waits on it. */
function withData(html: string, data: ShellData | undefined): string {
  if (!data) return html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${data.block}\n  </body>`) : `${html}${data.block}`;
}

/** The page's data, or none: a page is served whole whether or not its data could be asked. */
async function pageData(shell: ShellTitle | undefined, head: boolean): Promise<ShellData | undefined> {
  if (head || !shell?.data) return undefined;
  try {
    return await shell.data();
  } catch {
    return undefined;
  }
}

/**
 * How a page is kept. The shell alone is everybody's and revalidated; one
 * that may carry answers is one reader's (`Vary: Cookie`) and is not kept at
 * all: who-am-I, the first of them, never is either.
 */
const PERSONAL = 'private, no-store';
const pageCache = (data: ShellData | undefined, shell?: ShellTitle) => (data || shell?.branding?.private ? PERSONAL : 'no-cache');

/**
 * A page that carries its data, sent as it is made: everything up to the end
 * of its body at once — the entry and its preloads start downloading — and
 * the data block once it is asked, then the rest. The entry is a module,
 * which runs once the page is parsed, so it reads the block however late it
 * comes; the browser's wait for the answers overlaps its wait for the script.
 * Compressed as it streams, flushed at the break. No ETag: the bytes are not
 * known when the headers go, and the page is not kept anyway.
 */
async function streamPage(
  res: ServerResponse,
  text: string,
  headers: Record<string, string>,
  encoding: 'br' | 'gzip' | undefined,
  data: () => Promise<ShellData | undefined>,
  shell?: ShellTitle,
): Promise<void> {
  /* A page whose pane the server may draw is sent up to the pane at once —
     its head, its preloads, its chrome — and the rest once the answers are
     in and the pane is drawn from them. */
  const at = shell?.pane ? text.search(PANE) : text.search(/<\/body>/i);
  const [before, after] = at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at)];
  const coder =
    encoding === 'br'
      ? createBrotliCompress({ params: { [zlib.BROTLI_PARAM_QUALITY]: 4, [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT } })
      : encoding === 'gzip'
        ? createGzip({ level: 6 })
        : undefined;
  const finished = new Promise<void>((resolve) => {
    const done = () => {
      res.off('finish', done);
      res.off('close', done);
      resolve();
    };
    res.once('finish', done);
    res.once('close', done);
  });
  res.writeHead(200, { ...headers, ...(encoding ? { 'content-encoding': encoding } : {}) });
  const out = coder ?? res;
  if (coder) {
    coder.pipe(res);
    coder.on('error', () => res.destroy());
  }
  out.write(before);
  coder?.flush();
  let block: ShellData | undefined;
  try {
    block = res.destroyed ? undefined : await data();
  } catch {
    block = undefined;
  }
  if (res.destroyed) {
    coder?.destroy();
    return;
  }
  if (shell?.pane && at >= 0) {
    const pane = await drawnPane(shell, block);
    if (res.destroyed) {
      coder?.destroy();
      return;
    }
    out.end(withData(withPane(after, pane), block));
    await finished;
    return;
  }
  out.end(`${block ? `${block.block}\n  ` : ''}${after}`);
  await finished;
}

export async function serveClient(files: ClientFiles, req: IncomingMessage, res: ServerResponse, shell?: ShellTitle): Promise<void> {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  if (res.destroyed || res.writableEnded) return;
  if (SOURCE_CLIENT) {
    const base = shell?.mount?.base ?? '';
    const vite = await devClient(files, base);
    if (res.destroyed || res.writableEnded) return;
    // App routing already removed its base. Vite's native base middleware
    // expects the external address and removes it itself when serving files.
    const sourceURL = `${base}${req.url ?? '/'}`;
    req.url = sourceURL;
    // Middleware owns module/style responses; unmatched paths render the SPA.
    // Hold the request through completion, including an in-flight HTML fallback
    // after disconnect, so a retiring host does not release its owner early.
    await new Promise<void>((resolve, reject) => {
      let fallback: Promise<void> | undefined;
      const clean = () => {
        res.off('finish', complete);
        res.off('close', complete);
        res.off('error', fail);
      };
      const done = () => {
        clean();
        resolve();
      };
      const fail = (error: unknown) => {
        clean();
        reject(error);
      };
      const complete = () => {
        if (fallback) void fallback.then(done, fail);
        else done();
      };
      res.once('finish', complete);
      res.once('close', complete);
      res.once('error', fail);
      try {
        vite.middlewares(req, res, (error?: unknown) => {
          fallback = Promise.resolve().then(async () => {
            if (res.destroyed || res.writableEnded) return;
            if (error) {
              res.writeHead(500).end(head ? undefined : String(error));
              return;
            }
            try {
              const raw = await readFile(join(files.source, 'index.html'), 'utf8');
              const data = await pageData(shell, head);
              const pane = head ? undefined : await drawnPane(shell, data);
              /* No built files to preload from source; an App theme's own faces are the App's, and are said as in a build. */
              const html = withData(
                withPane(withHead(withLooks(await vite.transformIndexHtml(sourceURL, raw), shell, []), shell), pane),
                data,
              );
              if (res.destroyed || res.writableEnded) return;
              res.writeHead(200, {
                'content-type': MIME['.html'],
                'cache-control': pageCache(data, shell),
                ...(data || shell?.branding?.private ? { vary: 'Cookie' } : {}),
                'x-content-type-options': 'nosniff',
                'content-security-policy': pagePolicy(shellPolicy(html, { fromSource: true, socket: vite.socket }), shell),
              });
              res.end(head ? undefined : html);
            } catch {
              if (!res.destroyed && !res.writableEnded) res.writeHead(404).end(head ? undefined : 'Not found');
            }
          });
          void fallback.then(() => {
            if (res.destroyed || res.writableFinished) complete();
          }, fail);
        });
      } catch (error) {
        fail(error);
      }
    });
    return;
  }
  await fromBuild(files.built)(req, res, head, shell);
}

/** One way a file can be sent: as it is, or as one of the compressed copies beside it. */
interface Variant {
  file: string;
  size: number;
  etag: string;
  encoding?: 'br' | 'gzip';
}
/** A servable file, its variants in the order the server prefers them. */
interface Asset {
  type: string;
  cache: string;
  variants: Variant[];
  policy?: string;
}

/** Named for their content (vite.config.ts): a changed file is a new name, never new bytes under an old one. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** A source map is named after its script, not its own content, so it is asked about each time. */
const hashed = (rel: string) => rel.startsWith('assets/') && !rel.endsWith('.map');
const COMPRESSED: Array<[suffix: string, encoding: 'br' | 'gzip']> = [
  ['.br', 'br'],
  ['.gz', 'gzip'],
];

/** A strong ETag: the hash of the bytes sent, so two servers behind one balancer agree. */
const strongTag = (data: Buffer) => `"${createHash('sha256').update(data).digest('base64url').slice(0, 27)}"`;

/**
 * Every file in the directory, read once and kept. dist does not change
 * while the process runs — a new build is a new install and a restart — so
 * each variant's strong ETag is the hash of its bytes, taken on the first
 * request, and every request after it is a map lookup. The hash is of the
 * content rather than a timestamp so two servers behind one balancer agree.
 */
async function inventory(dir: string): Promise<Map<string, Asset>> {
  const names = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
  const present = new Set(names);
  const tag = async (file: string) => {
    const data = await readFile(file);
    return { size: data.length, etag: strongTag(data) };
  };
  const assets = new Map<string, Asset>();
  await Promise.all(
    names
      .filter((rel) => !COMPRESSED.some(([suffix]) => rel.endsWith(suffix) && present.has(rel.slice(0, -suffix.length))))
      .map(async (rel) => {
        const file = join(dir, rel);
        const variants: Variant[] = [];
        for (const [suffix, encoding] of COMPRESSED) {
          if (present.has(rel + suffix)) variants.push({ file: file + suffix, encoding, ...(await tag(file + suffix)) });
        }
        variants.push({ file, ...(await tag(file)) });
        /* A page carries its policy, read from the page itself once (shellPolicy). */
        const policy = extname(rel) === '.html' ? shellPolicy(await readFile(file, 'utf8')) : undefined;
        assets.set(rel, {
          type: MIME[extname(rel)] ?? 'application/octet-stream',
          cache: hashed(rel) ? IMMUTABLE : 'no-cache',
          variants,
          ...(policy ? { policy } : {}),
        });
      }),
  );
  return assets;
}

/**
 * The codings a request will take (RFC 9110 §12.5.3). A coding named with
 * `q=0` is refused, `*` answers for every coding not named, and a request
 * that names none gets the file as it is. The server's order decides among
 * the acceptable ones — brotli is smaller than gzip for the same text — so
 * only a zero weight counts, not how two nonzero weights compare.
 */
function acceptable(header: string | string[] | undefined): (encoding: 'br' | 'gzip') => boolean {
  const weights = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',')) {
    const [name = '', ...params] = part.split(';').map((piece) => piece.trim().toLowerCase());
    if (!name) continue;
    const q = params.map((param) => /^q\s*=\s*([\d.]+)$/.exec(param)?.[1]).find((value) => value !== undefined);
    weights.set(name, q === undefined ? 1 : Number(q) || 0);
  }
  return (encoding) => (weights.get(encoding) ?? (encoding === 'gzip' ? weights.get('x-gzip') : undefined) ?? weights.get('*') ?? 0) > 0;
}

/** A page with its own head, compressed as it is sent: brotli at quality 4 or
 * gzip at 6, as API replies are (http/reply.ts). The shell is a few kilobytes,
 * well under a millisecond either way. */
function compressPage(page: Buffer, encoding: 'br' | 'gzip'): Buffer {
  return encoding === 'br'
    ? brotliCompressSync(page, {
        params: {
          [zlib.BROTLI_PARAM_QUALITY]: 4,
          [zlib.BROTLI_PARAM_SIZE_HINT]: page.length,
          [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
        },
      })
    : gzipSync(page, { level: 6 });
}

/** If-None-Match names this representation, by the weak comparison the header is defined with. */
function unchanged(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((tag) => {
    const t = tag.trim();
    return t === '*' || t.replace(/^W\//, '') === etag;
  });
}

/** Serves a built client directory: the one the package ships, or a test's. */
export function builtClient(dir: string): (req: IncomingMessage, res: ServerResponse, head: boolean, shell?: ShellTitle) => Promise<void> {
  const root = dir.endsWith(sep) ? dir : dir + sep;
  let files: Promise<Map<string, Asset>> | undefined;
  return async (req, res, head, shell) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    // Normalize before joining so .. cannot walk out of the client directory.
    const rel = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end(head ? undefined : 'Forbidden');
      return;
    }
    let assets: Map<string, Asset>;
    try {
      assets = await (files ??= inventory(root));
    } catch (error) {
      files = undefined;
      throw error;
    }
    /* Unknown paths are SPA routes, not missing files: the page for the
       surface the address will draw, which preloads that part (clientSurface.ts).
       A build without per-surface pages (a test's) has index.html alone.
       The root is a route like any other, not the file index.html, which is
       an App's shell page: the database browser's landing is at `/`, and its
       page preloads its own main, not the App's chrome. */
    const asset =
      (path === '/' ? undefined : assets.get(relative(root, file).split(sep).join('/'))) ??
      assets.get(SURFACE_PAGES[shell?.workbench ? 'workbench' : surfaceFor(shell?.path ?? path)]) ??
      assets.get('index.html');
    if (!asset) {
      if (!res.destroyed && !res.writableEnded) res.writeHead(404).end(head ? undefined : 'Not found');
      return;
    }
    /* A public page's own head (withHead): the shell's bytes with it written
       in, sent as they are. It names one record, so it is never the shared
       file's ETag and never a cached copy of another page's: its ETag is the
       hash of these bytes, so a revisit is still a 304 until the head — a
       record's name, the App's — or the shell under it changes. Without one
       every public page was downloaded whole on every visit.
       It is compressed as it is sent, as the shared page's copies were at
       build time: the public page is the one a stranger's first visit and
       every link preview fetches, and it went out at its full size while the
       signed-in shell went as brotli. The tag is of the bytes sent, so each
       coding has its own, as the static copies do. */
    const isPage = asset.type === MIME['.html'];
    if (isPage && shell?.data) {
      const plain = asset.variants.find((v) => !v.encoding)!;
      const text = withHead(withLooks(await readFile(plain.file, 'utf8'), shell, assets.keys()), shell);
      if (res.destroyed || res.writableEnded) return;
      const accepts = acceptable(req.headers['accept-encoding']);
      const encoding = asset.variants.some((v) => v.encoding) ? COMPRESSED.map(([, e]) => e).find(accepts) : undefined;
      const headers: Record<string, string> = {
        'cache-control': PERSONAL,
        'x-content-type-options': 'nosniff',
        'content-type': asset.type,
        vary: asset.variants.length > 1 ? 'Accept-Encoding, Cookie' : 'Cookie',
        ...(asset.policy ? { 'content-security-policy': pagePolicy(shell.mount?.base ? shellPolicy(text) : asset.policy, shell) } : {}),
      };
      if (head) {
        res.writeHead(200, headers).end();
        return;
      }
      await streamPage(res, text, headers, encoding, shell.data, shell);
      return;
    }
    if (isPage && writesHead(shell)) {
      const plain = asset.variants.find((v) => !v.encoding)!;
      const pane = head ? undefined : await drawnPane(shell, undefined);
      const text = withPane(withHead(withLooks(await readFile(plain.file, 'utf8'), shell, assets.keys()), shell), pane);
      const page = Buffer.from(text, 'utf8');
      if (res.destroyed || res.writableEnded) return;
      const accepts = acceptable(req.headers['accept-encoding']);
      const encoding = asset.variants.some((v) => v.encoding) ? COMPRESSED.map(([, e]) => e).find(accepts) : undefined;
      const body = encoding ? compressPage(page, encoding) : page;
      const privately = shell?.branding?.private;
      const headers: Record<string, string> = {
        'cache-control': privately ? PERSONAL : 'no-cache',
        ...(!privately ? { etag: strongTag(body) } : {}),
        'x-content-type-options': 'nosniff',
        ...(asset.policy ? { 'content-security-policy': pagePolicy(shell?.mount?.base ? shellPolicy(text) : asset.policy, shell) } : {}),
        ...(asset.variants.length > 1 || privately
          ? { vary: [asset.variants.length > 1 ? 'Accept-Encoding' : '', privately ? 'Cookie' : ''].filter(Boolean).join(', ') }
          : {}),
      };
      if (!privately && unchanged(req.headers['if-none-match'], headers.etag)) {
        res.writeHead(304, headers).end();
        return;
      }
      res.writeHead(200, {
        ...headers,
        'content-type': asset.type,
        'content-length': body.length,
        ...(encoding ? { 'content-encoding': encoding } : {}),
      });
      res.end(head ? undefined : body);
      return;
    }
    const accepts = acceptable(req.headers['accept-encoding']);
    const variant = asset.variants.find((v) => !v.encoding || accepts(v.encoding))!;
    const headers: Record<string, string | number> = {
      'cache-control': asset.cache,
      etag: variant.etag,
      'x-content-type-options': 'nosniff',
      ...(asset.policy ? { 'content-security-policy': pagePolicy(asset.policy, shell) } : {}),
    };
    if (asset.variants.length > 1) headers.vary = 'Accept-Encoding';
    if (unchanged(req.headers['if-none-match'], variant.etag)) {
      if (!res.destroyed && !res.writableEnded) res.writeHead(304, headers).end();
      return;
    }
    const bytes = head ? undefined : await readFile(variant.file);
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, {
      ...headers,
      'content-type': asset.type,
      'content-length': variant.size,
      ...(variant.encoding ? { 'content-encoding': variant.encoding } : {}),
    });
    res.end(bytes);
  };
}

/* One server per built page, made on its first request: a process serves one page, but a test may serve its own. */
const built = new Map<string, ReturnType<typeof builtClient>>();
const fromBuild = (dir: string) => {
  let serve = built.get(dir);
  if (!serve) built.set(dir, (serve = builtClient(dir)));
  return serve;
};
