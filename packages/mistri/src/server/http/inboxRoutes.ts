/**
 * `/api/inbox` and `/api/inbox/read`: the signed-in person's own notices in
 * an App, and marking them read (server/inbox.ts says what they may see);
 * `/api/inbox/email`: whether they are emailed too, and turning it off.
 * Whose inbox it is comes from the verified session alone — a body naming a
 * recipient is refused — and a signed-out visitor has none.
 */
import { appForConnection } from '../app/apps.js';
import { inboxEmailFor, markInboxFor, readInboxFor } from '../inbox.js';
import { HttpError, send } from '@mistriwork/engine/server/http/reply.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';

const INBOX_PATH = '/api/inbox';
const READ_PATH = '/api/inbox/read';
const EMAIL_PATH = '/api/inbox/email';
/* What each body may say besides the App it is for. Anything else — a
   recipient, an account, an app of another's — is a request confused about
   whose inbox this is, and is refused rather than ignored. */
const SAID: Record<string, readonly string[]> = {
  [INBOX_PATH]: ['limit', 'before', 'unread'],
  [READ_PATH]: ['ids', 'all'],
  [EMAIL_PATH]: ['email'],
};

export async function inboxRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, connection, appHosts, who, principal, recipient } = post;
  if (path !== INBOX_PATH && path !== READ_PATH && path !== EMAIL_PATH) return false;
  const host = appHosts?.length ? appForConnection(appHosts, connection, registry.configOf(connection)?.name) : undefined;
  if (!host?.auth) {
    send(res, 404, { error: 'Notifications belong to an App people sign in to.' });
    return true;
  }
  if (!principal || !who?.trim()) throw new HttpError(401, 'Sign in to read your notifications.');
  /* An address anyone could have typed (open sign-up, not yet proven) is
     nobody's inbox: notices kept for it may be someone else's. */
  if (!recipient?.trim()) throw new HttpError(403, 'Confirm your email address to read your notifications.');
  if (Object.keys(body).some((key) => key !== 'app' && !SAID[path].includes(key)))
    throw new HttpError(400, 'Invalid notification request.');
  res.setHeader('cache-control', 'no-store');
  const options = { app: host.app.app, reader: adapter, schema, who: recipient, registry };
  send(
    res,
    200,
    path === INBOX_PATH
      ? await readInboxFor({ ...options, limit: body.limit, before: body.before, unread: body.unread })
      : path === EMAIL_PATH
        ? await inboxEmailFor({ ...options, email: body.email })
        : await markInboxFor({ ...options, ids: body.ids, all: body.all }),
  );
  return true;
}
