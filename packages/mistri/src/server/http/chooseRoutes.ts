/**
 * `/api/choose`: keep one App-wide pick (an App's `choose`) for the signed-in person, or clear it, so it follows them
 * to their next device (app/appPreferences.ts). Whose pick it is comes from the verified session alone, and the value
 * goes through the same check as the tab's header: a row this reader cannot read is refused, never stored. A database
 * that keeps no preferences store answers 409, and the shell keeps the pick in the browser.
 */
import { HttpError, send } from '@mistriwork/engine/server/http/reply.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';
import { appForConnection } from '../app/apps.js';
import { readChosen } from '../app/appChoices.js';
import { preferencesFor, storePick } from '../app/appPreferences.js';
import { CHOOSE_PATH, chooseBody } from '../app/appChoosing.js';

export async function chooseRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, connection, appHosts, principal } = post;
  if (path !== CHOOSE_PATH) return false;
  const host = appHosts?.length ? appForConnection(appHosts, connection, registry.configOf(connection)?.name) : undefined;
  const app = host?.app.app;
  if (!host || !app?.choose) {
    send(res, 404, { error: 'This App has no choices to make.' });
    return true;
  }
  if (!principal) throw new HttpError(401, 'Sign in to make a choice.');
  const asked = chooseBody(app, body);
  const store = await preferencesFor(registry, host);
  if (!store) {
    send(res, 409, { error: 'This deployment keeps no choices for people.', code: 'preferences_unavailable' });
    return true;
  }
  if (asked.value !== null) {
    const proven = await readChosen(app, schema, adapter, new URLSearchParams({ [asked.name]: asked.value }).toString());
    if (proven?.[asked.name] == null) throw new HttpError(422, 'That is not a choice you can make.');
  }
  res.setHeader('cache-control', 'no-store');
  await storePick(app, store, principal, '', asked.name, asked.value);
  send(res, 200, { ok: true });
  return true;
}
