/**
 * The public pages, drawn on the server: what a search engine, a link
 * preview and a reader without scripts get as HTML (server/publicRender.ts
 * loads this module and splices its output into the content pane).
 *
 * Four kinds, and only public ones; a signed-in screen is always the
 * client's to draw:
 *
 *   landing   `/{app}/welcome`: LandingSurface, the very component the
 *             public chunk draws, from the same answer the page carries in
 *             its data block (firstPaint.ts), so the client takes the
 *             server's markup over in place (`hydrateRoot`, mount.tsx).
 *   form      `/{app}/form/{id}`: FormSurface as it opens, the same way.
 *   room      a signed-out visitor's list or record (`auth.public`): a plain
 *             document (PublicRoom.tsx) the App's own room replaces when it
 *             boots, behind the startup hold, so nothing a reader sees moves.
 *   page      a signed-out visitor's custom `definePage({ public: true })`
 *             (home, directory, article, detail, storefront, etc.): rendered
 *             through the SSR `UiHost` with a fast prefetch pass so data,
 *             photographs, formatted values, and `ui.site` chrome arrive in
 *             the very first HTML response.
 *
 * Drawn with React's streaming renderer and collected whole: nothing in
 * these trees suspends, so the stream is one piece, and the page that
 * carries it is itself streamed (clientHttp.ts). Built for Node with React
 * inside (config/vite.ssr.config.ts), so an install needs no React of its own;
 * under tsx the server loads the same module through Vite (devclient.ts). Never part of
 * the client bundle.
 */
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import { createElement, type ReactNode } from 'react';
import { renderToPipeableStream, renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installSurfaceSeam } from '@mistriwork/ui';
import type { AppLanding } from '../../shared/app.js';
import { readMountJson } from '@mistriwork/engine/shared/mount.js';
import type { PublicRoom as Room } from '../../shared/publicDocument.js';
import { LandingSurface } from '@mistriwork/kit/client/components/LandingSurface.js';
import { AppFooter } from '@mistriwork/kit/client/components/AppFooter.js';
import { FormSurface, type FormPresentation } from '../components/FormSurface.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { say as saySiteHeader } from '../copy/components/components/SiteHeader.js';
import { rooted } from '@mistriwork/kit/client/components/mount.js';
import { shownUnplaced } from '@mistriwork/kit/client/addressMount.js';
import { UiHostContext, UiPageContext, UiParamKindsContext } from '../components/sdk/context.js';
import * as sdkUi from '../components/sdk/index.js';
import * as sdkPage from '../components/sdk/page.js';
import { registerPageBlocks } from '../components/sdk/pageBlocks.js';
import { mistriSurfaceSeam } from '../components/sdk/seam.js';
import { PublicRoom } from './PublicRoom.js';
import { withMount } from './requestMount.js';
import { createSsrPageHost, loadSsrPageComponent, type SsrPageInput } from './pageHost.js';

type LandingApp = Parameters<typeof LandingSurface>[0]['app'];

export type PublicRenderInput =
  | { kind: 'landing'; mount: string; app: LandingApp; landing: AppLanding }
  | { kind: 'form'; mount: string; app: { id: string; name: string }; form: FormPresentation }
  | { kind: 'room'; mount: string; room: Room }
  | SsrPageInput;

interface Chunked {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: 'end' | 'error', listener: (error?: unknown) => void): unknown;
}

const stream = (
  globalThis as unknown as { process?: { getBuiltinModule?: (name: string) => { PassThrough: new () => Chunked } } }
).process?.getBuiltinModule?.('node:stream');

/** How long a render may take before it is abandoned and the page goes without it. */
const MOST_MS = 2_000;
const PREFETCH_PASSES = 2;

let ssrHostModulesReady: Promise<Readonly<Record<string, unknown>>> | undefined;

function getSsrHostModules(): Promise<Readonly<Record<string, unknown>>> {
  if (!ssrHostModulesReady) {
    ssrHostModulesReady = (async () => {
      installSurfaceSeam(mistriSurfaceSeam);
      registerPageBlocks(() => import('../components/sdk/blocks.js'));
      const [behaviors, primitives, charts, views] = await Promise.all([
        import('../components/sdk/behaviors.js'),
        import('../components/sdk/primitives.js'),
        import('../components/sdk/charts.js'),
        import('../components/sdk/views.js'),
      ]);
      /* Pre-resolve all onDemand blocks exported on @mistriwork/mistri/page so SSR renders them synchronously. */
      await Promise.all(
        Object.values(sdkPage).flatMap((val) => {
          const maybe = val as { ready?: () => Promise<void> } | null;
          return typeof maybe?.ready === 'function' ? [maybe.ready().catch(() => undefined)] : [];
        }),
      );
      return Object.freeze({
        react: React,
        'react/jsx-runtime': JsxRuntime,
        'react-dom': ReactDOM,
        '@mistriwork/mistri/ui': sdkUi,
        '@mistriwork/mistri/page': sdkPage,
        '@mistriwork/mistri/behaviors': behaviors,
        '@mistriwork/mistri/primitives': primitives,
        '@mistriwork/mistri/charts': charts,
        '@mistriwork/mistri/views': views,
      });
    })();
  }
  return ssrHostModulesReady;
}

function renderStream(mountJsonText: string, element: ReactNode): Promise<string> {
  if (!stream) return Promise.reject(new Error('The server renderer runs only on Node.'));
  return new Promise<string>((done, fail) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resolve = (html: string) => {
      clearTimeout(timer);
      done(html);
    };
    const reject = (error: unknown) => {
      clearTimeout(timer);
      fail(error);
    };
    const sink = new stream.PassThrough();
    const parts: string[] = [];
    const decoder = new TextDecoder();
    sink.on('data', (chunk) => parts.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })));
    sink.on('end', () => resolve(parts.join('') + decoder.decode()));
    sink.on('error', reject);
    let failed: unknown;
    const rendering = withMount(readMountJson(mountJsonText), () =>
      renderToPipeableStream(element, {
        onAllReady: () => (failed ? reject(failed) : rendering.pipe(sink as never)),
        onShellError: reject,
        onError: (error) => {
          failed ??= error;
        },
      }),
    );
    timer = setTimeout(() => {
      rendering.abort();
      reject(new Error('The public render took too long.'));
    }, MOST_MS);
  });
}

function syncTree(input: Exclude<PublicRenderInput, SsrPageInput>): ReactNode {
  if (input.kind === 'landing') return rooted(createElement(LandingSurface, { landing: input.landing, app: input.app }));
  if (input.kind === 'form')
    return rooted(
      createElement(FormSurface, {
        form: input.form,
        appName: input.app.name,
        review: Boolean(input.form.steps?.length),
        visitor: { app: input.app.id },
        held: { form: input.form.id },
        submit: () => Promise.reject(new Error('Not in the page yet.')),
      }),
    );
  return createElement(PublicRoom, { room: input.room });
}

async function renderPublicPage(input: SsrPageInput): Promise<string> {
  const hostModules = await getSsrHostModules();
  const PageComponent = await loadSsrPageComponent(input.code, hostModules);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const { host, frame, drain, resolveSiteLinkHref } = createSsrPageHost(input, queryClient);

  /* Preload the page's primary loader result (`data` prop) if declared. */
  const initialData = input.page.loader ? await host.load(input.viewKey, input.place, input.page.loader).catch(() => undefined) : undefined;

  const bare = input.dashboard.layout === 'bare';
  const site = !bare ? input.app.ui.site : undefined;
  const siteFooter = site?.footer;
  const footer = siteFooter
    ? {
        ...(siteFooter.text ? { text: siteFooter.text } : {}),
        ...(siteFooter.links?.length
          ? { links: siteFooter.links.map((link) => ({ label: link.label, href: resolveSiteLinkHref(link) })) }
          : {}),
      }
    : input.app.ui.footer;
  const signInHref =
    site && (site.signIn ?? 'footer') === 'footer' ? shownUnplaced(`/${encodeURIComponent(input.app.id)}/sign-in`) : undefined;

  const buildElement = (): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        UiHostContext.Provider,
        { value: host },
        createElement(
          UiPageContext.Provider,
          { value: frame },
          createElement(
            UiParamKindsContext.Provider,
            { value: {} },
            createElement(
              'div',
              { className: `page-body free-page-body${bare ? ' is-bare' : ''}` },
              site
                ? createElement(
                    'header',
                    { className: 'ssr-site-header' },
                    createElement(SiteHeader, {
                      app: { id: input.app.id, name: input.app.name, views: input.app.views },
                      site,
                      resolveHref: resolveSiteLinkHref,
                      activeView: input.viewKey,
                    }),
                  )
                : null,
              createElement('section', { className: 'page-section width-full' }, createElement(PageComponent, { data: initialData })),
              !bare && (footer || signInHref)
                ? createElement(AppFooter, {
                    footer,
                    signInHref,
                    signInLabel: signInHref ? saySiteHeader('signIn') : undefined,
                  })
                : null,
            ),
          ),
        ),
      ),
    );

  const mount = readMountJson(input.mount);
  /* Two-pass prefetch: pass 1 discovers top-level useRows/useRecord/useLoader queries; pass 2 discovers
     dependent queries (e.g., <Photos> after useRecord resolves). */
  for (let pass = 0; pass < PREFETCH_PASSES; pass++) {
    withMount(mount, () => {
      try {
        renderToStaticMarkup(buildElement());
      } catch {
        /* Any throw during prefetch is caught; final pass determines whether SSR succeeds or falls back. */
      }
    });
    const ran = await drain();
    if (!ran) break;
  }

  return renderStream(input.mount, buildElement());
}

/** The HTML of one public page's content pane, or a refusal the server answers by sending the page without it. */
export function renderPublic(input: PublicRenderInput): Promise<string> {
  if (input.kind === 'page') return renderPublicPage(input);
  return renderStream(input.mount, syncTree(input));
}
