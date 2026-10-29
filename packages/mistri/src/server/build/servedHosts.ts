/**
 * Which hosts a served App builds, each with a PostgreSQL manager of its own, and what each may hold.
 *
 * A pool knows nothing of its neighbors, and an App that declares jobs, effects or integrations serves with several
 * managers on one database. `mistri check --deploy` counts them from what the App declares, by this rule; a start
 * counts the managers it actually built (connectionBudget.ts). The rule, with the call site that is each term:
 *
 * - the App's adapter, one per connection it uses: `R + W + 1` (the record history, inbox, branding and live stores
 *   share it), and `+ 1` for live sync's LISTEN;
 * - the jobs host, when the jobs module declares a job or workflow (`commandHost.ts` → `openJobHost`): one default
 *   manager `R + W + 1` for the job, workflow and event-delivery stores, and a LISTEN `+ 1` (`jobHost.ts`);
 * - the decisions store, when the module declares decisions (`postgresDecisions.ts`): a small manager;
 * - the effects host, when a command declares effects (`effectHost.ts`): `R + W + 1`;
 * - the App's integrations store, when the module lists integrations (`integrationHost.ts`): `R + W + 1`; an inbound
 *   endpoint without integrations opens one for its deliveries (`commandHost.ts`): the same;
 * - the API event feed's reader, when the API exposes events (`postgresApiReadOwner.ts`): a small manager;
 * - the assistant's store, when the App declares an assistant (`postgresAssistant.ts`): a small manager, opened on
 *   the first request.
 *
 * A small manager is `SMALL_STORE_POOL` (one reader, one writer) plus the background writer: 3.
 *
 * A tenant App holds the documented ceiling instead (docs/postgresql.md): request, membership and history readers,
 * the tenant, administration, support, jobs, outbox and integrations writers, two LISTEN connections and the
 * background writers and assistant: `3R + 6W + 5`.
 *
 * Not counted: a retention prune's short-lived manager, the cancel and probe clients, experiments and flags in a
 * suite, and a mail-driven App's contact mail (it needs its own service).
 */
import { managerConnections, SMALL_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';

/** What the App and its jobs module declare, as far as hosting is concerned. */
export interface ServedFacts {
  /** A tenant App (`auth.rows: "tenant"`). */
  tenant?: boolean;
  /** The jobs module declares at least one job or workflow. */
  jobs?: boolean;
  decisions?: boolean;
  /** Effects declared by a command. */
  effects?: boolean;
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

const small = managerConnections(SMALL_STORE_POOL.readers, SMALL_STORE_POOL.writers);

/** The hosts beside the App's adapter on its home database, with what each may hold at `readers` and `writers`. */
export function servedHosts(facts: ServedFacts, readers: number, writers: number): HostConnections[] {
  if (facts.tenant) return [{ host: 'tenant App (3R + 6W + 5)', connections: 3 * readers + 6 * writers + 5 }];
  const full = managerConnections(readers, writers);
  const hosts: HostConnections[] = [];
  if (facts.jobs) hosts.push({ host: 'jobs host', connections: full }, { host: 'jobs LISTEN', connections: 1 });
  if (facts.decisions) hosts.push({ host: 'decisions store', connections: small });
  if (facts.effects) hosts.push({ host: 'effects host', connections: full });
  if (facts.integrations) hosts.push({ host: 'integrations store', connections: full });
  else if (facts.inbound) hosts.push({ host: 'inbound deliveries store', connections: full });
  if (facts.apiEvents) hosts.push({ host: 'API event feed', connections: small });
  if (facts.assistant) hosts.push({ host: 'assistant store', connections: small });
  return hosts;
}
