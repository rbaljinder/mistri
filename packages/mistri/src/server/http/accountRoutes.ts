/**
 * `/api/accounts`: the administrator's accounts screen for an App that signs
 * people in. GET lists a page of accounts with their roles, or with
 * `trail=1` a page of the account-administration trail (one account's with
 * `account=<id>`); POST makes one change — add an account, set its roles,
 * deactivate or reactivate it, give it a new password.
 *
 * Authorized here, on the verified session alone: an account holding the
 * `admin` role, in this App, and nobody else — no body or query names who is
 * asking. A tenant App never reaches this (its members are its tenants' own,
 * and public transports refuse it before any route). Before the row-policy
 * wrapper on purpose: accounts are the auth store's, not the App's rows, so a
 * row policy has nothing to say about them. The auth runtime then calls
 * Better Auth's admin API with the same session, which judges it again.
 */
import { administersAccounts, assignableRoles, type AccountChange } from '../../shared/accountAdministration.js';
import { AccountAdminRefusal } from '../auth/accountAdministration.js';
import { HttpError, readJson, send } from '@mistriwork/engine/server/http/reply.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';

const ACCOUNTS_PATH = '/api/accounts';

/** Whether this request's verified session administers the accounts of the App it signed in to. */
export function accountAdministrator(ctx: Pick<RequestContext, 'signedIn' | 'identity'>): boolean {
  return Boolean(
    ctx.signedIn?.auth?.accounts && typeof ctx.identity.id === 'string' && ctx.identity.id && administersAccounts(ctx.identity.role),
  );
}

const CHANGE_KEYS = ['app', 'operation', 'accountId', 'email', 'name', 'roles', 'password'];

export async function accountRoutes(ctx: Pick<RequestContext, 'req' | 'res' | 'path' | 'url' | 'signedIn' | 'identity'>): Promise<boolean> {
  const { req, res, path, url, signedIn, identity } = ctx;
  if (path !== ACCOUNTS_PATH) return false;
  res.setHeader('cache-control', 'no-store');
  const accounts = signedIn?.auth?.accounts;
  if (!signedIn || !accounts) {
    send(res, 404, { error: 'This App has no accounts to manage.' });
    return true;
  }
  if (!accountAdministrator(ctx)) {
    send(res, 403, { error: 'Only an administrator manages accounts.' });
    return true;
  }
  const app = signedIn.app.app;
  const roles = assignableRoles(app.auth);
  try {
    if (req.method === 'GET') {
      if (url.searchParams.get('app') !== app.id) throw new HttpError(400, 'This request must name its App.');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (url.searchParams.get('trail') === '1') {
        const account = url.searchParams.get('account');
        send(res, 200, await accounts.trail({ offset, ...(account !== null ? { accountId: account } : {}) }));
        return true;
      }
      send(res, 200, await accounts.list(req, { search: url.searchParams.get('q') ?? undefined, offset }, roles));
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    const body = await readJson(req, 8 * 1024);
    if (body.app !== app.id || Object.keys(body).some((key) => !CHANGE_KEYS.includes(key)))
      throw new HttpError(400, 'This request must name its App, and only the change.');
    const { app: _app, ...change } = body;
    const account = await accounts.change(req, { id: identity.id!, who: identity.who ?? identity.id! }, change as AccountChange, roles);
    send(res, 200, { account, outcome: 'applied' });
    return true;
  } catch (error) {
    if (error instanceof AccountAdminRefusal || error instanceof HttpError) {
      send(res, error.status, { error: error.message, outcome: 'not_applied' });
      return true;
    }
    /* Better Auth refused, or the store could not answer: said once, without its internals. */
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 503;
    send(res, status >= 400 && status < 500 ? status : 503, {
      error: status === 403 ? 'Only an administrator manages accounts.' : 'The accounts could not be changed. Reload and try again.',
      outcome: req.method === 'POST' ? 'unknown' : 'not_applied',
    });
    return true;
  }
}
