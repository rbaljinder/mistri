/**
 * An App's part of the authoring and planning routes: it refuses the layout
 * and page builders, which are the database browser's (authoringRoutes.ts) —
 * an App's rooms are its definition — and gives the page routes it does serve
 * (pageRoutes.ts) its rules: its field grants, its row policy's record, its
 * sign-in, and its failures said by code.
 */
import { appError } from '../app/appErrors.js';
import { fieldAccessiblePage } from '../app/appFieldProjection.js';
import { appForConnection } from '../app/apps.js';
import { readHttpPolicyRecord, requireHttpPolicyRecord } from '../policy/appPolicyHttp.js';
import { defaultPage } from './appProjection.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';
import type { PageHooks } from '@mistriwork/engine/server/http/pageRoutes.js';
import { send } from '@mistriwork/engine/server/http/reply.js';

/** The builders' routes on an App server: refused. True when answered. */
export function appAuthoringRoutes(post: PostContext): boolean {
  /* Saved filters are not shared authoring storage — each account, or the App, keeps its own (pageRoutes.ts). */
  if (!['/api/layouts', '/api/pages/save'].includes(post.path)) return false;
  send(post.res, 403, { error: 'Layouts and saved pages belong to the standalone database browser; an App is shaped by its definition.' });
  return true;
}

/** The page routes in an App: its anatomy of a table, and its rules. */
export const APP_PAGES: PageHooks = {
  suggested: (post, table) => defaultPage(post.appHost, post.schema, table),
  rules: {
    signsIn: (post) =>
      Boolean(
        appForConnection(post.appHosts ?? [], post.connection, post.registry.list().find((c) => c.id === post.connection)?.name)?.app.app
          .auth,
      ),
    readsPage: fieldAccessiblePage,
    requireRecord: requireHttpPolicyRecord,
    readRecord: readHttpPolicyRecord,
    said: (error) => {
      const failure = appError(error);
      return { message: failure.message, code: failure.code };
    },
  },
};
