/** Own-account navigation preferences. Native identity proves the subject;
 * neither a preference nor a native role confers an App grant. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { captureAppAuthRuntime, type AppAuthRuntime, type VerifiedSessionInstance } from './auth.js';
import { SuitePreferencesConflict } from './suitePreferences.js';
import type { SuitePreferences } from './suiteStores.js';

export async function suitePreferencesHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    native: AppAuthRuntime;
    preferences: SuitePreferences;
    bound: Bound;
    basePath: string;
    current: () => boolean;
    /** The Apps this session may enter, with explicit, valid grants as the session may use them (suiteGrantStore.ts
     * readForSession). Asynchronous where the grants are (PostgreSQL); the session is checked again after it. */
    allowedApps: (proof: VerifiedSessionInstance) => readonly string[] | Promise<readonly string[]>;
  },
): Promise<void> {
  const send = (status: number, body: unknown) => {
    if (!res.destroyed && !res.writableEnded)
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  };
  if (req.method !== 'GET' && req.method !== 'POST') return send(405, { error: 'Use GET or POST.' });
  // Read or written, the preferences are the account's own: the Origin is checked on a GET too.
  const refused = doorRefusal(req, options.bound, { writing: req.method === 'POST', origin: 'always' });
  if (refused) return refused.check === 'json' ? send(400, { error: 'Use application/json.' }) : send(403, { error: 'Invalid origin.' });
  let auth: ReturnType<typeof captureAppAuthRuntime>;
  let proof;
  try {
    auth = captureAppAuthRuntime(options.native);
    proof = await auth.sessionInstance(req);
  } catch {
    return send(401, { error: 'Sign in to continue.' });
  }
  if (!proof) return send(401, { error: 'Sign in to continue.' });
  if (req.headers['x-mistri-account'] !== proof.identity.id) return send(409, { error: 'The signed-in account changed.' });
  if (new URL(req.url ?? '/', 'http://localhost').search) return send(400, { error: 'This endpoint takes no query parameters.' });
  let body: Record<string, unknown> | undefined;
  if (req.method === 'POST') {
    try {
      body = await readJson(req, 16 * 1024);
    } catch {
      return send(400, { error: 'Invalid App preference request.' });
    }
    if (
      Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, 'defaultApp') ||
      !Object.hasOwn(body, 'expectedRevision') ||
      (body.defaultApp !== null &&
        (typeof body.defaultApp !== 'string' ||
          body.defaultApp.trim() !== body.defaultApp ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.defaultApp))) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 0 ||
      (body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
    )
      return send(400, { error: 'Expected defaultApp and expectedRevision.' });
  }
  try {
    await auth.observeSession(proof);
    auth.assertSessionCurrent(proof);
    if (!options.current()) return send(409, { error: 'The signed-in account changed.' });
    if (req.aborted || res.destroyed) return;
  } catch {
    return send(409, { error: 'The signed-in account changed.' });
  }
  const accountId = proof.identity.id;
  try {
    if (!body) return send(200, { accountId, ...(await options.preferences.read(accountId)) });
    const defaultApp = body.defaultApp as string | null;
    const allowed = defaultApp === null ? undefined : options.allowedApps(proof);
    // Only a PostgreSQL grant read is awaited: a SQLite one is decided on and written in the same turn, as before.
    if (allowed && !(allowed instanceof Promise ? await allowed : allowed).includes(defaultApp!)) {
      return send(403, { error: 'This App is unavailable to this account.' });
    }
    // Fence native session retirement during the grant read too: a PostgreSQL session is observed afresh after its await.
    if (!auth.synchronous) await auth.observeSession(proof);
    auth.assertSessionCurrent(proof);
    if (!options.current()) return send(409, { error: 'The signed-in account changed.' });
    const revision = await options.preferences.change({
      subjectId: accountId,
      defaultApp,
      expectedRevision: body.expectedRevision as number,
    });
    return send(200, { accountId, defaultApp, revision });
  } catch (error) {
    if (error instanceof SuitePreferencesConflict) return send(409, { error: error.message });
    return send(409, { error: 'The App preference or account is unavailable.' });
  }
}
