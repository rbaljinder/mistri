/**
 * `mistri check --deploy`: whether this App, with this configuration and
 * this environment, is the shape that survives a container being replaced.
 *
 * A container's disk goes with it and a second replica has a disk of its own,
 * so every store must be a network database, and the secrets a start refuses
 * without must be there. Each of these starts and works on a laptop, then
 * signs everyone out on the next deploy, which is why a command says so
 * before a deploy does (docs/deploy-targets.md, G1). Pure: the caller hands
 * in what it read, so each refusal is a test of its own.
 *
 * It is not run at start. `NODE_ENV=production` is set by every image and by
 * plenty of hosts, and a single container with a mounted volume and a SQLite
 * file is a deployment this project supports; refusing there would break it.
 */
import { isAbsolute } from 'node:path';
import { availableParallelism } from 'node:os';
import { appReaders } from '@mistriwork/engine/adapters/postgresPool.js';
import { balancedPoolSize } from '@mistriwork/engine/adapters/writeLanes.js';
import { databaseOf, primaryConnections, sayBudget, type DatabaseBudget } from '@mistriwork/engine/adapters/connectionBudget.js';
import { isPublicCommandPage, type AppDef } from '../../shared/appModel.js';
import { authPoolSize } from '../auth/authStore.js';
import { servedHosts, type HostConnections, type ServedFacts } from './servedHosts.js';
import { hasTicketKey } from '../forms/publicTicket.js';

interface DeployFinding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
}

export interface DeployInput {
  app: Pick<AppDef, 'id' | 'connection' | 'sources' | 'auth'> & Partial<Pick<AppDef, 'views'>>;
  /** The connections the configuration holds, as written (references intact). */
  connections: ReadonlyArray<{ id: string; name: string; url: string; http?: unknown; pool?: unknown; replicas?: unknown }>;
  /** The connection a start with none named uses. */
  activeId?: string;
  /** Whether the configuration names a `cache` service (Valkey) for the limiters to share. */
  cache: boolean;
  /** How many instances the deployment runs, when the operator said (`--replicas`). */
  replicas?: number;
  /** What the database allows this role, when the operator said (`--connection-limit`): the sum below must fit it. */
  connectionLimit?: number;
  /** The process's `--read-pool` and `--write-pool`, when given; a connection's own `pool` wins over them. */
  pools?: { readers?: number; writers?: number };
  /** The cores the deployment has (`--cpus`), which size the pool defaults; this machine's when absent. */
  cpus?: number;
  /** The hosts the App serves with, from its declarations and jobs module (servedHosts.ts). */
  served?: ServedFacts;
  env: NodeJS.ProcessEnv;
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const networkDatabase = (url: string): boolean => /^postgres(ql)?:\/\//i.test(url);

/** The URL with its `${NAME}` references filled in, and the names the environment lacks. */
function expanded(text: string, env: NodeJS.ProcessEnv): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = text.replace(REFERENCE, (_, name: string) => {
    if (env[name] === undefined) {
      missing.push(name);
      return '';
    }
    return env[name]!;
  });
  return { value, missing };
}

export function deployFindings(input: DeployInput): DeployFinding[] {
  const found: DeployFinding[] = [];
  const { app, env } = input;

  /* The connections the App reads and writes: its bindings, else its one connection, else the active one. */
  const bound = [
    ...new Set([...Object.values(app.sources ?? {}).map((source) => source.connection), ...(app.connection ? [app.connection] : [])]),
  ];
  const used = bound.length
    ? bound.map((name) => input.connections.find((c) => c.id === name || c.name === name)).filter((c) => c !== undefined)
    : input.connections.filter((c) => c.id === input.activeId);
  for (const connection of used) {
    if (connection.http) continue;
    const { value, missing } = expanded(connection.url, env);
    if (missing.length) {
      found.push({
        code: 'deploy-unset-reference',
        severity: 'error',
        message: `Connection "${connection.name}" references ${missing.map((name) => `$${name}`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not set here.`,
        fix: `Export ${missing.join(', ')} when you run check (the deployment's secret store holds the real value), or the start will refuse.`,
      });
    } else if (!networkDatabase(value)) {
      found.push({
        code: 'deploy-sqlite-source',
        severity: 'error',
        message: `Connection "${connection.name}" is a SQLite file. A container's disk is lost when it is replaced, and each replica would have its own.`,
        fix: 'Point the connection at a postgres:// URL, e.g. "${DATABASE_URL}", and move the data with your own tools.',
      });
    }
  }

  /* Sign-in: where sessions live, and what signs them. */
  if (app.auth) {
    const store = app.auth.store;
    if (!store) {
      found.push({
        code: 'deploy-default-auth-store',
        severity: 'error',
        message:
          'auth.store is not set, so accounts and sessions live in a SQLite file in the config directory. It is lost with the container (everyone is signed out on each deploy) and not shared between replicas.',
        fix: 'Set auth: { store: "${AUTH_DATABASE_URL}" } to a postgres:// URL, kept apart from the business database.',
      });
    } else {
      const { value, missing } = expanded(store, env);
      if (missing.length) {
        found.push({
          code: 'deploy-unset-reference',
          severity: 'error',
          message: `auth.store references ${missing.map((name) => `$${name}`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not set here.`,
          fix: `Export ${missing.join(', ')} when you run check, or the start will refuse.`,
        });
      } else if (!/^postgres(ql)?:\/\//i.test(value)) {
        found.push({
          code: 'deploy-sqlite-auth-store',
          severity: 'error',
          message: `auth.store is a SQLite file (${isAbsolute(value) ? value : `./${value}`}). It is lost with the container and not shared between replicas.`,
          fix: 'Set auth.store to a postgres:// URL.',
        });
      }
    }
    if ((env.BETTER_AUTH_SECRET ?? '').trim().length < 32) {
      found.push({
        code: 'deploy-missing-secret',
        severity: 'error',
        message: `BETTER_AUTH_SECRET is ${env.BETTER_AUTH_SECRET?.trim() ? 'shorter than 32 characters' : 'not set'}; the App signs sessions with it and a start refuses without it.`,
        fix: 'Generate one once with `openssl rand -base64 32`, keep it in the platform secret store, and expose it as BETTER_AUTH_SECRET. Changing it signs everyone out.',
      });
    }
    if (!env.MISTRI_PUBLIC_URL?.trim()) {
      found.push({
        code: 'deploy-public-url',
        severity: 'warning',
        message: 'MISTRI_PUBLIC_URL is not set, so cookies and emailed or OAuth links name the loopback address, not the one people reach.',
        fix: 'Set MISTRI_PUBLIC_URL to the public https address.',
      });
    }
  }

  /* A public page's door signs its tickets with the form key: without it each instance signs with its own, and a
     page served by one is refused by the next (forms/publicTicket.ts). */
  if (Object.values(app.views ?? {}).some((view) => isPublicCommandPage(view)) && !hasTicketKey(env)) {
    const several = (input.replicas ?? 1) > 1;
    found.push({
      code: 'deploy-form-key',
      severity: several ? 'error' : 'warning',
      message: several
        ? `MISTRI_FORM_KEY is not set and ${input.replicas} replicas are expected: each signs a public page's tickets with a key of its own and refuses the others'.`
        : "MISTRI_FORM_KEY is not set: a public page's tickets are signed with a key made at start, so a restart or a second instance refuses the pages already open.",
      fix: 'Generate one once with `openssl rand -base64 32`, keep it in the platform secret store, and expose it as MISTRI_FORM_KEY to every instance.',
    });
  }

  if ((input.replicas ?? 1) > 1 && !input.cache) {
    found.push({
      code: 'deploy-per-process-limits',
      severity: 'warning',
      message: `${input.replicas} replicas are expected and no cache service is configured, so each keeps its own rate limits and sign-in lockout counters: a visitor gets ${input.replicas} times the budget.`,
      fix: 'Add a "cache" service (Valkey) to the configuration so the replicas share them, or run one replica.',
    });
  }
  return found;
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * What the replicas of this App may hold against each database: one process's pools times the replicas, summed by
 * database, because two connections or the auth store may name one. Per process, a PostgreSQL source holds its
 * readers, its writers and the background writer, one LISTEN connection for live sync, and each read replica
 * another reader pool; the sign-in store holds `MISTRI_AUTH_POOL`. Sizes follow the flags, a connection's `pool`,
 * and else the defaults an App gets (writers: twice the cores, 4 to 16; readers: as many as the writers) — the cores
 * of the machine that runs the check, which are the deployment's only when the two match. Jobs, mail, integration and
 * decision hosts open pools of their own on top (docs/postgresql.md); they are not counted here.
 */
export function connectionBudgets(input: DeployInput): { rows: DatabaseBudget[]; findings: DeployFinding[] } {
  const { app, env } = input;
  const processes = input.replicas ?? 1;
  const perProcess = new Map<string, number>();
  const parts = new Map<string, HostConnections[]>();
  const add = (url: string, connections: number, host: string) => {
    const database = databaseOf(url);
    perProcess.set(database, (perProcess.get(database) ?? 0) + connections);
    parts.set(database, [...(parts.get(database) ?? []), { host, connections }]);
  };
  const cores = input.cpus ?? availableParallelism();
  let sized = false;
  const bound = [
    ...new Set([...Object.values(app.sources ?? {}).map((source) => source.connection), ...(app.connection ? [app.connection] : [])]),
  ];
  const used = bound.length
    ? bound.map((name) => input.connections.find((c) => c.id === name || c.name === name)).filter((c) => c !== undefined)
    : input.connections.filter((c) => c.id === input.activeId);
  const known = (url: string): string | undefined => {
    const { value, missing } = expanded(url, env);
    return missing.length || !networkDatabase(value) ? undefined : value;
  };
  let home = true;
  for (const connection of used) {
    const url = connection.http ? undefined : known(connection.url);
    if (!url) continue;
    const pool = (connection.pool ?? {}) as { read?: unknown; write?: unknown };
    const given = { write: count(pool.write) ?? input.pools?.writers, read: count(pool.read) ?? input.pools?.readers };
    if (given.write === undefined || given.read === undefined) sized = true;
    const writers = given.write ?? balancedPoolSize(cores);
    const readers = given.read ?? appReaders(writers, cores);
    add(url, primaryConnections({ readers, writers }), 'adapter');
    /* The hosts the App serves with sit on its home connection, the one its commands' stores are beside. */
    if (home) for (const host of servedHosts(input.served ?? {}, readers, writers)) add(url, host.connections, host.host);
    home = false;
    for (const replica of Array.isArray(connection.replicas) ? connection.replicas : []) {
      const found = typeof replica === 'string' ? known(replica) : undefined;
      if (found) add(found, readers, 'read replica');
    }
  }
  const store = app.auth?.store ? known(app.auth.store) : undefined;
  if (store) add(store, authPoolSize(env), 'sign-in store');
  const limit = input.connectionLimit;
  const rows = [...perProcess].map(([database, each]): DatabaseBudget => ({
    database,
    perProcess: each,
    processes,
    total: each * processes,
    ...(limit === undefined ? {} : { limit }),
    ...(sized ? { cpus: cores } : {}),
    parts: parts.get(database)!,
  }));
  const findings = rows
    .filter((row) => limit !== undefined && row.total > limit)
    .map((row): DeployFinding => ({
      code: 'deploy-connection-limit',
      severity: 'error',
      message: `${sayBudget(row)}: more than the ${limit} connections the database allows.`,
      fix: 'Lower --read-pool and --write-pool (or a connection\'s "pool", or MISTRI_AUTH_POOL for the sign-in store), run fewer replicas, or put a pooler in front (--pooler transaction).',
    }));
  return { rows, findings };
}
