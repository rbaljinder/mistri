/**
 * The database browser's dispatchers (the engine's http/router.ts says what one is): its one HTTP server's.
 * test/door.test.ts stands each up and sends it the door's refusals.
 */
import type { Dispatcher } from '@mistriwork/engine/server/http/router.js';

export const BROWSER_DISPATCHERS: readonly Dispatcher[] = [
  { module: 'packages/tablewalk/src/server/http/browserHandler.ts', serves: 'the database browser' },
];
