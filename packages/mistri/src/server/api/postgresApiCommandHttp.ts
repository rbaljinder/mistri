/** Loopback-only PostgreSQL command transport, mounted by createApp under
 * `--api-reads` beside the PostgreSQL read transport for an App that exposes
 * commands. The shared core (`apiCommandHttp.ts`) owns admission, parsing and
 * problem details. The
 * owner writes inside its native handoff, so the socket write happens while
 * the token's native locks are still held. */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import type { CommandHosting } from '../http/appContext.js';
import { createApiCommandHttp } from './apiCommandHttp.js';
import { createPostgresApiCommandOwner } from './postgresApiCommandOwner.js';

export function createPostgresApiCommandHttp(
  registry: Registry,
  host: AppHost,
  hosting: CommandHosting,
  options: Parameters<typeof createApiCommandHttp>[1],
) {
  return createApiCommandHttp(host, options, {
    acquire: () => createPostgresApiCommandOwner(registry, host, hosting, { wire: 'api-v1', integers: options.integers }),
    async deliver(owner, kind, credential, envelope, signal, write) {
      // An `uncertain` handoff needs nothing more here: the answer was either
      // written, or the core answers 503 unknown because nothing was.
      const send = (answer: Parameters<typeof write>[0]) => write(answer);
      await (kind === 'spec'
        ? owner.readSpec(credential, send, signal)
        : kind === 'prepare'
          ? owner.prepare(credential, envelope, send, signal)
          : kind === 'recover'
            ? owner.recover(credential, envelope, send, signal)
            : owner.execute(credential, envelope, send, signal));
    },
  });
}
