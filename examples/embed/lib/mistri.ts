/*
 * The mounted App, made once per process: the route handler (app/api/mistri) serves it to browsers, and a server
 * component (app/server/page.tsx) mints a token from it. Development reloads this module, so it is kept on `globalThis`.
 */
import { resolve } from 'node:path';
import { createHandler, type Handler } from '@mistriwork/mistri/handler';

const shared = globalThis as { mistri?: Handler };

export const mistri = (shared.mistri ??= createHandler({
  config: resolve('.data/reviews.db.json'),
  basePath: '/api/mistri',
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000',
  app: resolve('mistri'),
  commands: resolve('../../test/fixtures/apps/command-desk/commands.ts'),
}));
