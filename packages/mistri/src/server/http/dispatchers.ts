/**
 * The App framework's dispatchers (the engine's http/router.ts says what one is): every module that takes a request
 * from a socket, or from a host's server, before any route reads it. test/door.test.ts stands each up and sends it the
 * door's refusals; a new one is named here, and given a row there.
 */
import type { Dispatcher } from '@mistriwork/engine/server/http/router.js';

export const APP_DISPATCHERS: readonly Dispatcher[] = [
  { module: 'packages/mistri/src/server/http/handler.ts', serves: 'the Apps of a deployment that serves them' },
  { module: 'packages/mistri/src/server/embed/handler.ts', serves: 'an App mounted inside somebody else’s server' },
  { module: 'packages/mistri/src/server/http/suite.ts', serves: 'several deployments under one origin, each behind its own dispatcher' },
  { module: 'packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts', serves: 'a tenant App’s browser host and its native sign-in' },
  { module: 'packages/mistri/src/server/tenant/tenantHttp.ts', serves: 'a tenant App’s data, inside its browser host' },
];
