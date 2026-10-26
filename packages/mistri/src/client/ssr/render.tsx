/**
 * The public pages, drawn on the server: what a search engine, a link
 * preview and a reader without scripts get as HTML (server/publicRender.ts
 * loads this module and splices its output into the content pane).
 *
 * Three kinds, and only public ones; a signed-in screen is always the
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
 *
 * Drawn with React's streaming renderer and collected whole: nothing in
 * these trees suspends, so the stream is one piece, and the page that
 * carries it is itself streamed (clientHttp.ts). Built for Node with React
 * inside (vite.ssr.config.ts), so an install needs no React of its own;
 * under tsx the server loads it through Vite (devclient.ts). Never part of
 * the client bundle.
 */
import { createElement, type ReactNode } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import type { AppLanding } from '../../shared/app.js';
import { readMountJson } from '@mistriwork/engine/shared/mount.js';
import type { PublicRoom as Room } from '../../shared/publicDocument.js';
import { LandingSurface } from '@mistriwork/kit/client/components/LandingSurface.js';
import { FormSurface, type FormPresentation } from '../components/FormSurface.js';
import { rooted } from '@mistriwork/kit/client/components/mount.js';
import { PublicRoom } from './PublicRoom.js';
import { withMount } from './requestMount.js';

type LandingApp = Parameters<typeof LandingSurface>[0]['app'];

export type PublicRenderInput =
  | { kind: 'landing'; mount: string; app: LandingApp; landing: AppLanding }
  | { kind: 'form'; mount: string; app: { id: string; name: string }; form: FormPresentation }
  | { kind: 'room'; mount: string; room: Room };

interface Chunked {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: 'end' | 'error', listener: (error?: unknown) => void): unknown;
}

const stream = (
  globalThis as unknown as { process?: { getBuiltinModule?: (name: string) => { PassThrough: new () => Chunked } } }
).process?.getBuiltinModule?.('node:stream');

/** How long a render may take before it is abandoned and the page goes without it. */
const MOST_MS = 2_000;

function tree(input: PublicRenderInput): ReactNode {
  if (input.kind === 'landing') return rooted(createElement(LandingSurface, { landing: input.landing, app: input.app }));
  if (input.kind === 'form')
    return rooted(
      createElement(FormSurface, {
        form: input.form,
        appName: input.app.name,
        review: Boolean(input.form.steps?.length),
        // As the page draws it (publicForm.js), so a reference input's field stands where the page will keep it.
        visitor: { app: input.app.id },
        // Never called: a submit happens in the page, after it has taken the form over.
        submit: () => Promise.reject(new Error('Not in the page yet.')),
      }),
    );
  return createElement(PublicRoom, { room: input.room });
}

/** The HTML of one public page's content pane, or a refusal the server answers by sending the page without it. */
export function renderPublic(input: PublicRenderInput): Promise<string> {
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
    const rendering = withMount(readMountJson(input.mount), () =>
      renderToPipeableStream(tree(input), {
        onAllReady: () => (failed ? reject(failed) : rendering.pipe(sink as never)),
        onShellError: reject,
        // A part that throws would be drawn by the client in its place; a public page then goes without the server's copy.
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
