/**
 * Which routes a host's cross-origin bearer stands for a session on
 * (embed/crossOrigin.ts). A bearer lapses in an hour; a route that issues a
 * longer-lived credential, or administers the account, never takes one, so a
 * script on the host page that reads the bearer keeps nothing past its hour.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerPreflight, carriesBearer, embedDoor } from '../packages/mistri/src/server/embed/crossOrigin.js';

const HOST = 'https://host.example';
const SESSION = 'mistri-app.session_token';

function request(path: string, method = 'POST') {
  const req = {
    method,
    url: path,
    headers: {
      host: 'app.example',
      origin: HOST,
      authorization: 'Bearer from-the-host',
      cookie: 'stray=riding-along',
      'content-type': 'application/json',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    } as Record<string, string | undefined>,
  };
  const headers = new Map<string, string>();
  let status: number | undefined;
  const res = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    writeHead: (code: number) => {
      status = code;
    },
    end: () => undefined,
  };
  return { req, res, headers, status: () => status };
}

const door = { origins: new Set([HOST]), sessionCookie: SESSION, bearer: async () => 'session-cookie-value' };

test("a bearer stands for its session on a browser route, and on no member's API-token or tenant administration route", async () => {
  const browser = request('/api/query');
  assert.equal(
    await embedDoor(browser.req as unknown as IncomingMessage, browser.res as unknown as ServerResponse, '/api/query', door),
    'bearer',
  );
  assert.equal(browser.req.headers.cookie, `${SESSION}=session-cookie-value`);
  // An embedded tenant App still opens its tenant, and reads which integrations are connected.
  for (const path of ['/api/tenant/bootstrap', '/api/tenant/context/open', '/api/integrations']) {
    const asked = request(path);
    assert.equal(
      await embedDoor(asked.req as unknown as IncomingMessage, asked.res as unknown as ServerResponse, path, door),
      'bearer',
      path,
    );
  }

  for (const path of [
    '/api/tokens',
    '/api/tokens/issue',
    '/api/tokens/revoke',
    '/API/Tokens/issue',
    '/api/tenant/administration',
    '/api/tenant/administration/open',
    '/api/tenant/administration/put-membership',
    '/API/Tenant/Administration/put-membership',
    '/api/tenant/invitations',
    '/api/tenant/invitations/create',
    '/api/tenant/invitations/status',
    '/api/integrations/save',
    '/API/Integrations/Save',
    // What is a platform operator's, or a tenant's settings: a support session
    // into a tenant and its trail, a tenant's branding, the Suite console.
    '/api/tenant/support/open',
    '/api/tenant/support/exit',
    '/api/tenant/support/status',
    '/api/tenant/support/log',
    '/api/tenant/support/sessions',
    '/API/Tenant/Support/open',
    '/api/branding/save',
    '/api/console',
    '/api/console/flags',
    // The rest of the account's and the operator's, held as before.
    '/api/auth/admin/create-user',
    '/api/accounts',
    '/api/v1/leads',
    '/api/mcp',
    '/api/operations/workflows/retry',
    '/api/suite/apps',
    '/api/connections/save',
    '/api/sql',
  ]) {
    const asked = request(path);
    const admitted = await embedDoor(asked.req as unknown as IncomingMessage, asked.res as unknown as ServerResponse, path, door);
    assert.equal(admitted, 'none', path);
    assert.equal(asked.req.headers.cookie, undefined, `${path}: no cookie stands for anyone cross-origin`);
    // The preflight is not answered either, so a browser never sends the bearer there.
    const preflight = request(path, 'OPTIONS');
    assert.equal(
      answerPreflight(preflight.req as unknown as IncomingMessage, preflight.res as unknown as ServerResponse, path, door.origins),
      false,
      path,
    );
  }
});

test('a request the door admitted on a bearer still carries one, though its Authorization header is gone', async () => {
  const admitted = request('/api/query');
  const req = admitted.req as unknown as IncomingMessage;
  assert.equal(await embedDoor(req, admitted.res as unknown as ServerResponse, '/api/query', door), 'bearer');
  assert.equal(admitted.req.headers.authorization, undefined);
  assert.equal(carriesBearer(req), true);
  // An API token still in its header carries one; a cookie alone does not.
  const token = request('/api/query');
  assert.equal(carriesBearer(token.req as unknown as IncomingMessage), true);
  const own = request('/api/query');
  delete own.req.headers.authorization;
  assert.equal(carriesBearer(own.req as unknown as IncomingMessage), false);
});
