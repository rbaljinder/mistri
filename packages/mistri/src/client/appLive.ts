/**
 * The page follows the App's source: each save the server reloads is a
 * `reload` on `/api/app/live` (server/app/appLive.ts), and the page asks for
 * the App again and redraws it where it stands (app.js `reloadAppInPlace`).
 *
 * A server-sent event stream rather than Vite's HMR socket: an App served by
 * `npx tablewalk` has no Vite — its client is the built one — and is the
 * case this exists for. Custom components and `pages/*.page.tsx` are not
 * Vite modules either (the server compiles them, appComponents.ts); a save
 * gives them a new hashed address and they are drawn again from it.
 *
 * Imported only when `/api/app` says the server watches the App (`live`):
 * a built App, a production server and a tenant platform never say so, and
 * no first page carries this module or the overlay it draws.
 */
import { createElement } from 'react';
import type { AppLoadProblem } from '../shared/appPayload.js';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { AppReloadProblem } from './components/AppReloadProblem.js';
import { scopeApiRequest } from '@mistriwork/kit/client/requestIdentity.js';
import { served } from '@mistriwork/kit/client/addressMount.js';
import { shellBody } from '@mistriwork/kit/client/shellHost.js';

interface Follow {
  /** The connection the page is on now: the stream is that App's. */
  connection: () => string | null | undefined;
  /** Ask for the App again and redraw it in place. */
  reload: () => Promise<void>;
  /** The placed failure the page holds now, if any. */
  problem: () => AppLoadProblem | undefined;
}

let following: Follow | undefined;
let source: EventSource | undefined;
let openFor: string | null | undefined;
let reloading: Promise<void> | undefined;
let again = false;

/** Start following, or follow the App the page is on now when it moved. Idempotent. */
export function followAppSaves(follow: Follow): void {
  following = follow;
  showProblem(follow.problem());
  const connection = follow.connection();
  if (source && openFor === connection) return;
  source?.close();
  openFor = connection;
  let url: string;
  try {
    url = served(scopeApiRequest('/api/app/live', undefined, connection).url);
  } catch {
    source = undefined;
    return;
  }
  const stream = new EventSource(url);
  source = stream;
  let dropped = false;
  stream.addEventListener('reload', () => void settle());
  /* A stream that comes back after dropping may have missed saves (the
     server restarted, the laptop slept): one ask covers them all, and an
     unchanged App answers 304. */
  stream.addEventListener('hello', () => {
    if (dropped) void settle();
    dropped = false;
  });
  stream.addEventListener('error', () => {
    dropped = true;
  });
}

/* One reload at a time; saves landing during one are one more after it. */
async function settle(): Promise<void> {
  if (reloading) {
    again = true;
    return reloading;
  }
  reloading = (async () => {
    do {
      again = false;
      await following?.reload().catch(() => {});
      showProblem(following?.problem());
    } while (again);
  })().finally(() => {
    reloading = undefined;
  });
  return reloading;
}

/* ---------- the overlay ---------- */

let host: HTMLElement | undefined;
/** The problem dismissed, by its words: the same failure saved again stays dismissed, a new one shows. */
let dismissed: string | undefined;

function showProblem(problem: AppLoadProblem | undefined): void {
  const key = problem && JSON.stringify([problem.file, problem.line, problem.code, problem.message]);
  if (!problem || key === dismissed) {
    if (!problem) dismissed = undefined;
    if (host) {
      unmount(host);
      host.remove();
      host = undefined;
    }
    return;
  }
  if (!host || !host.isConnected) {
    host = document.createElement('div');
    host.className = 'app-reload-problem-host';
    shellBody().append(host);
  }
  mount(
    host,
    createElement(AppReloadProblem, {
      problem,
      onDismiss: () => {
        dismissed = key;
        showProblem(problem);
      },
    }),
  );
}
