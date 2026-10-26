/** Loopback-only SQLite command transport, mounted by createApp under
 * `--api-reads` for an App that exposes commands. The shared core
 * (`apiCommandHttp.ts`) owns admission, parsing and problem details. */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import type { CommandHosting } from '../http/appContext.js';
import { createApiCommandHttp } from './apiCommandHttp.js';
import { createSqliteApiCommandOwner } from './sqliteApiCommandOwner.js';

export function createSqliteApiCommandHttp(
  registry: Registry,
  host: AppHost,
  hosting: CommandHosting,
  options: Parameters<typeof createApiCommandHttp>[1],
) {
  return createApiCommandHttp(host, options, {
    acquire: () => createSqliteApiCommandOwner(registry, host, hosting, { wire: 'api-v1', integers: options.integers }),
    async deliver(owner, kind, credential, envelope, signal, write) {
      const handle =
        kind === 'spec'
          ? await owner.readSpec(credential, signal)
          : kind === 'prepare'
            ? await owner.prepare(credential, envelope, signal)
            : kind === 'recover'
              ? await owner.recover(credential, envelope, signal)
              : await owner.execute(credential, envelope, signal);
      try {
        if (signal.aborted) return;
        // Serialized and re-authorized inside the owner. Consume and hand the
        // bytes to the socket on this stack, with no asynchronous gap between.
        write(owner.consumeResult(handle));
      } finally {
        owner.discardResult(handle);
      }
    },
  });
}
