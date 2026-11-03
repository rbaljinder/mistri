/**
 * The server a test stands up: the App framework's (http/server.ts), as the
 * `mistri` binary serves it — with an App when the options name one, and
 * over the bare registry when they do not, which is where the engine's own
 * HTTP rules (the door, the body reader, the clamps, the read and write
 * routes) are held without an App's grants in the way.
 *
 * One import for every suite, rather than each naming the server module,
 * so a suite says what it serves by what it passes.
 */
import type { Server } from 'node:http';
import { createApp as createMistriApp } from '../../packages/mistri/src/server/http/server.js';

export { apiReadLifetimes, commandOperations } from '../../packages/mistri/src/server/http/server.js';

type Options = Parameters<typeof createMistriApp>[0];

export function createApp(options: Options): Server {
  return createMistriApp(options);
}
