/**
 * The server a test stands up, the way the product that serves it does: the
 * database browser's (http/browserServer.ts) for options that name no App and
 * nothing only the App framework serves, and the App framework's
 * (http/server.ts) otherwise — as the bin's two mains choose between them.
 *
 * One import for both, rather than each suite naming its product, because a
 * suite's options already say which it is, and a suite written against the
 * Workbench that one day passes an App moves to the other server by what it
 * passes, not by a second edit a reviewer might miss.
 *
 * test-package: dispatch — so a suite that imports this is owned by what else it reaches
 * (scripts/test-owners.mjs): one that reaches an App's source is mistri's, one that does not is the browser's.
 */
import type { Server } from 'node:http';
import { createApp as createMistriApp } from '../../packages/mistri/src/server/http/server.js';
import { createBrowserApp } from '../../packages/tablewalk/src/server/http/browserServer.js';

export { apiReadLifetimes, commandOperations } from '../../packages/mistri/src/server/http/server.js';

type Options = Parameters<typeof createMistriApp>[0];

/** Whether the options name anything only the App framework serves. */
const servesApps = (options: Options) =>
  Boolean(
    options.apps?.length ||
    options.policy ||
    options.policyUnavailable ||
    options.commands ||
    options.apiReads ||
    options.inbound ||
    options.testControl ||
    options.jobs,
  );

export function createApp(options: Options): Server {
  return servesApps(options) ? createMistriApp(options) : createBrowserApp(options);
}
