/*
 * mistri mounted in Next's own server, under /api/mistri: the App's API, its sign-in and the auth routes. The page
 * (app/page.tsx) calls it through the hooks; nothing else here is mistri's.
 */
import { resolve } from 'node:path';
import { createHandler, type Handler } from '@mistriwork/mistri/handler';

export const runtime = 'nodejs';

const shared = globalThis as { mistri?: Handler };
// One handler per process: development reloads this module.
const mistri = (shared.mistri ??= createHandler({
  config: resolve('.data/reviews.db.json'),
  basePath: '/api/mistri',
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000',
  app: resolve('mistri'),
  commands: resolve('../../test/fixtures/apps/command-desk/commands.ts'),
}));

const handle = (request: Request) => mistri.fetch(request);
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
