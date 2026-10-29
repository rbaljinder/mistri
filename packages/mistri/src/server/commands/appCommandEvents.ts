/**
 * An ordinary App's command events: which event store its emitting commands
 * write into, and the startup step that finds that store and issues the
 * App-scope event source the command binding needs.
 *
 * Generation is declared on commands (`events` on defineCommand) and happens
 * whenever the source's event store is attested. The store is provisioned
 * once, by an operator (`mistri migrate stores up --app`, or `@mistriwork/mistri/maintenance`); startup and
 * `mistri check` attest it and never create it. A command that declares
 * events on a source without one refuses startup, naming that step.
 */
import { DatabaseSync } from 'node:sqlite';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { assertSqliteCommandEventStore, type CommandEventStoreBinding } from '../../adapters/events/commandEventSchema.js';
import { assertPostgresCommandEventStore } from '../../adapters/events/postgresCommandEventStore.js';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
import { logicalResource, type AppDef } from '../../shared/app.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import { connectionFailure } from '../storeConnection.js';
import { issueAppScopeCommandEvents } from './businessCommandAccess.js';
import { BusinessCommandDefinitionError, getCommandEvents, type BusinessCommandRegistry } from './businessCommands.js';

/** Where a source's runtime stores live: its SQLite file or its PostgreSQL database. */
export type StoreTarget = Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;

/** The database a connection URL names. */
export function storeTargetOf(url: string | undefined): StoreTarget | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  if (/^postgres(ql)?:\/\//i.test(url)) return Object.freeze({ postgres: url });
  return Object.freeze({ sqlite: url.replace(/^sqlite:(\/\/)?/i, '') });
}

/** An App-scope event store's identity: the App, and the source whose
 * journal it sits beside. One App has at most one. */
export function appCommandEventStore(appId: string, sourceId: string): CommandEventStoreBinding {
  return Object.freeze({ appId, storeId: `app:${appId}`, sourceId });
}

/** Attestation only: the store is there, in its exact layout, bound to this
 * App and source. A refusal carries no detail. */
async function attestCommandEventStore(target: StoreTarget, binding: CommandEventStoreBinding): Promise<void> {
  if ('sqlite' in target) {
    const db = new DatabaseSync(target.sqlite, { readOnly: true });
    try {
      assertSqliteCommandEventStore(db, binding);
    } finally {
      db.close();
    }
    return;
  }
  const connection = new PgConnectionManager(target.postgres);
  try {
    await connection.withReadClient((client) => assertPostgresCommandEventStore(client, binding));
  } finally {
    await connection.close().catch(() => {});
  }
}

/**
 * The event source an App's emitting commands bind to, attested; undefined
 * when no command declares events. Every emitting command shares one source,
 * the one its store sits beside.
 */
export async function appCommandEventsFor(
  app: AppDef,
  commands: BusinessCommandRegistry,
  resources: Pick<RuntimeResources, 'connectionFor'>,
  locate: (connection: string) => string | undefined,
): Promise<CommandJournalAppScope | undefined> {
  const emitting = Object.entries(commands).filter(([, command]) => getCommandEvents(command));
  if (!emitting.length) return undefined;
  const sources = [...new Set(emitting.map(([, command]) => command.source))];
  if (sources.length > 1) {
    throw new BusinessCommandDefinitionError(
      `Commands that declare events must share one source; they are on ${sources.map((source) => `"${source}"`).join(' and ')}.`,
    );
  }
  const [id, command] = emitting[0];
  const binding = appCommandEventStore(app.id, command.source);
  try {
    const target = storeTargetOf(locate(resources.connectionFor(logicalResource(app, command.source, command.target))));
    if (!target) throw new Error();
    await attestCommandEventStore(target, binding);
  } catch (error) {
    const unreachable = connectionFailure(error);
    if (unreachable !== undefined) {
      throw new BusinessCommandDefinitionError(
        `Command "${id}" declares events, but source "${command.source}" could not be reached to attest its event store (${unreachable}). ` +
          'The store is not the problem; fix the connection and start again.',
      );
    }
    throw new BusinessCommandDefinitionError(
      `Command "${id}" declares events, but source "${command.source}" has no event store for App "${app.id}". ` +
        "Provision it once, with the server stopped: `mistri migrate stores up --app <the App's directory>` " +
        '(or provisionStores with the App, from @mistriwork/mistri/maintenance).',
    );
  }
  return issueAppScopeCommandEvents(binding);
}
