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
import { isPublicCommandPage, type AppDef } from '../../shared/appModel.js';
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
  connections: ReadonlyArray<{ id: string; name: string; url: string; http?: unknown }>;
  /** The connection a start with none named uses. */
  activeId?: string;
  /** Whether the configuration names a `cache` service (Valkey) for the limiters to share. */
  cache: boolean;
  /** How many instances the deployment runs, when the operator said (`--replicas`). */
  replicas?: number;
  env: NodeJS.ProcessEnv;
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const networkDatabase = (url: string): boolean => /^(postgres(ql)?|mysql|mariadb):\/\//i.test(url);

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
        fix: 'Point the connection at a postgres:// (or mysql://) URL, e.g. "${DATABASE_URL}", and move the data with your own tools.',
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
