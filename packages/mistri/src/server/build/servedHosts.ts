/**
 * Which hosts a served App builds beside its adapter, and what each may hold, on its home database.
 *
 * `mistri check --deploy` counts them from what the App declares, by this rule; a start counts the managers it
 * actually built (connectionBudget.ts). The rule, with the call site that is each term:
 *
 * - an ordinary App's adapter, one per connection it uses: `R + W + 1` (the record history, inbox, branding and live
 *   stores share it), and `+ 1` for live sync's LISTEN — counted by the caller (checkDeploy.ts), not here;
 * - a tenant App's request paths — its reader, discovery, writer, administration and support — share one manager
 *   instead (tenant/tenantConnections.ts): `R + W + 1`, and live sync's LISTEN `+ 1`. No adapter of the App's own is
 *   opened beside it;
 * - the server's own stores share one manager of `RUNTIME_STORE_POOL` (two readers, two writers) plus the background
 *   writer, 5, when any of them is opened (postgresPool.ts sharedPgConnections): the jobs host with its workflow and
 *   event-delivery stores, when the jobs module declares a job or workflow (`jobHost.ts`); the decisions store
 *   (`postgresDecisions.ts`); the effects host, when a command declares effects (`effectHost.ts`); the mail outbox,
 *   when the jobs module declares mail (`mailStore.ts`); the integrations store, or an inbound endpoint's deliveries
 *   (`integrationStore.ts`); the API event feed's reader (`postgresApiReadOwner.ts`); the assistant's store, opened
 *   on its first request (`postgresAssistant.ts`);
 * - the jobs host's LISTEN, `+ 1` (`jobHost.ts`).
 *
 * Not counted: a retention prune's short-lived manager, the cancel and probe clients, experiments and flags in a
 * suite, and a mail-driven App's contact mail (it needs its own service).
 */
import { managerConnections, RUNTIME_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';

/** What the App and its jobs module declare, as far as hosting is concerned. */
export interface ServedFacts {
  /** A tenant App (`auth.rows: "tenant"`). */
  tenant?: boolean;
  /** The jobs module declares at least one job or workflow. */
  jobs?: boolean;
  decisions?: boolean;
  /** Effects declared by a command. */
  effects?: boolean;
  /** The jobs module declares mail. */
  mail?: boolean;
  /** The jobs module lists integrations. */
  integrations?: boolean;
  /** The jobs module declares inbound endpoints. */
  inbound?: boolean;
  /** The App's API exposes events. */
  apiEvents?: boolean;
  assistant?: boolean;
}

export interface HostConnections {
  host: string;
  connections: number;
}

/** What the server's own stores hold together on a database. */
const RUNTIME_STORE_CONNECTIONS = managerConnections(RUNTIME_STORE_POOL.readers, RUNTIME_STORE_POOL.writers);

/** The hosts beside an ordinary App's adapter on its home database — for a tenant App, every host there — with what each may hold at `readers` and `writers`. */
export function servedHosts(facts: ServedFacts, readers: number, writers: number): HostConnections[] {
  const hosts: HostConnections[] = facts.tenant
    ? [
        { host: 'tenant requests', connections: managerConnections(readers, writers) },
        { host: 'live LISTEN', connections: 1 },
      ]
    : [];
  const stores =
    facts.jobs ||
    facts.decisions ||
    facts.effects ||
    facts.mail ||
    facts.integrations ||
    facts.inbound ||
    facts.apiEvents ||
    facts.assistant;
  if (stores) hosts.push({ host: 'server stores', connections: RUNTIME_STORE_CONNECTIONS });
  if (facts.jobs) hosts.push({ host: 'jobs LISTEN', connections: 1 });
  return hosts;
}
