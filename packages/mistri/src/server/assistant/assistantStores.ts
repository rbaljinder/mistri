/**
 * Where an App's conversations are kept: the reserved store in the database
 * beside its records, opened once per load of the App and attested as it is
 * opened. Serving never creates it; a deployment that declares an assistant
 * and holds no store is refused, naming the call that provisions it — at
 * startup (serve.ts), and on a request if it went missing since.
 */
import { AssistantStoreUnavailable, type AssistantStore } from '../../adapters/assistant/assistantStore.js';
import { openPostgresAssistant } from '../../adapters/assistant/postgresAssistant.js';
import { openSqliteAssistant } from '../../adapters/assistant/sqliteAssistant.js';
import type { AppDef } from '../../shared/appModel.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import type { AppHost } from '../app/apps.js';
import { MYSQL_REFUSAL } from '@mistriwork/engine/adapters/connect.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';

const opened = new WeakMap<AppDef, Promise<AssistantStore>>();

const GENERIC = new AssistantStoreUnavailable().message;
/** Why the store did not open, as the operator acts on it: a store of another layout version says which way to go
 * (`mistri migrate stores up`, or a newer mistri), and only a store that is not there is told to provision. */
function unavailable(app: AppDef, dialect: string, error?: unknown): AssistantStoreUnavailable {
  if (error instanceof AssistantStoreUnavailable && error.message !== GENERIC)
    return new AssistantStoreUnavailable(`${app.name} declares an assistant. ${error.message}`);
  const call = `provisionStores({ ${dialect === 'postgres' ? 'postgres: url' : 'sqlite: path'} }, { only: ['assistant'] })`;
  return new AssistantStoreUnavailable(
    `${app.name} declares an assistant, and its database holds no assistant store of this version. ` +
      `Provision it once with \`mistri migrate stores up --app <the App's directory>\` (with the server stopped), ` +
      `or ${call} from @mistriwork/mistri/maintenance, then start the server again.`,
  );
}

/** What a request that needed the store is told when it did not open: the operator-facing sentence of an
 * AssistantStoreUnavailable (written to be read), and for anything else a fixed one — a driver's own text can name
 * a host, a user or a path — with the whole of it on the server's log. */
export function storeUnavailableReply(error: unknown): HttpError {
  if (error instanceof AssistantStoreUnavailable) return new HttpError(503, error.message);
  console.error(`mistri: the assistant store did not open: ${error instanceof Error ? error.message : String(error)}`);
  return new HttpError(503, 'The assistant store is unavailable.');
}

/** The App's store, opened and attested once per load. */
export function assistantStoreFor(registry: Registry, host: AppHost): Promise<AssistantStore> {
  const { app } = host.app;
  let store = opened.get(app);
  if (!store) {
    store = (async () => {
      const connection = appEntrypoint(host, registry);
      const url = connection ? registry.configOf(connection)?.url : undefined;
      if (!url)
        throw new AssistantStoreUnavailable(
          `${app.name} declares an assistant; it keeps its conversations on one connection, and none is configured.`,
        );
      if (/^(mysql|mariadb):\/\//i.test(url)) throw new AssistantStoreUnavailable(MYSQL_REFUSAL);
      const dialect = /^postgres(ql)?:\/\//i.test(url) ? 'postgres' : 'sqlite';
      try {
        return dialect === 'postgres' ? await openPostgresAssistant(url) : openSqliteAssistant(url.replace(/^sqlite:(\/\/)?/i, ''));
      } catch (error) {
        throw unavailable(app, dialect, error);
      }
    })();
    opened.set(app, store);
    // A failed open is tried again on the next request: the operator may provision in between.
    store.catch(() => opened.delete(app));
  }
  return store;
}

/** A tenant App's store: beside its tenant source, where the host's enrollment says that is (tenantAssistant.ts).
 * The host keeps the one it opened; a registry plays no part, as no request names a connection there. */
export async function assistantStoreAt(app: AppDef, where: { readonly path: string } | { readonly url: string }): Promise<AssistantStore> {
  const dialect = 'url' in where ? 'postgres' : 'sqlite';
  try {
    return 'url' in where ? await openPostgresAssistant(where.url) : openSqliteAssistant(where.path);
  } catch (error) {
    throw unavailable(app, dialect, error);
  }
}
