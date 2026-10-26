/**
 * `@mistriwork/mistri/handler`: an App mounted in a host's own server, under a path it
 * chooses (embed/handler.ts).
 */
export { createHandler } from './embed/handler.js';
export type { Handler, HandlerOptions } from './embed/handler.js';
/* The host's side of signing its people in (embed-sign-in): server-only, it
   signs with node:crypto and refuses to load in a browser. */
export { mintEmbedAssertion } from './embed/mint.js';
export type { EmbedAssertionInput } from './embed/mint.js';
