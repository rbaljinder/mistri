/**
 * Statements per HTTP request, counted in process: every SQLite statement the
 * server runs (`StatementSync` all/get/run/iterate and `DatabaseSync.exec`)
 * and every `pg` query, attributed to the request it ran for through
 * AsyncLocalStorage around the server's `request` listeners.
 *
 * Deterministic where wall-clock time is not: a count is the same on a
 * loaded CI runner as on an idle laptop, so a change that adds a probe per
 * read, a second introspection or a count nobody shows fails a test instead
 * of waiting for someone to profile it. Statements run outside any request
 * (connect-time introspection, a pool's session SETs) are not counted.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DatabaseSync, StatementSync } from 'node:sqlite';

export interface Counted {
  method: string;
  path: string;
  statements: string[];
  /** Which engine ran each statement, index for index: a tenant request reads its business
   * database on PostgreSQL and its native auth store on SQLite, and the two are budgeted apart. */
  engines: Array<'sqlite' | 'postgres'>;
}

interface Patch {
  target: object;
  name: string;
  original: unknown;
}

export interface StatementCounter {
  /** Every request answered since `install` or the last `clear`, in arrival order. */
  readonly requests: Counted[];
  /** The statements of the one request made to `path` since the last `clear`. */
  one(path: string): string[];
  /** The same request's statements on one engine. */
  on(path: string, engine: 'sqlite' | 'postgres'): string[];
  clear(): void;
  restore(): void;
}

/** A pg client class to patch as well, when the test reads Postgres. */
export type PgClientClass = { prototype: { query: (...args: unknown[]) => unknown } };

export function countStatements(server: Server, pgClient?: PgClientClass): StatementCounter {
  const store = new AsyncLocalStorage<Counted>();
  const requests: Counted[] = [];
  const patches: Patch[] = [];
  const patch = (
    target: object,
    name: string,
    text: (self: unknown, args: unknown[]) => string,
    engine: 'sqlite' | 'postgres' = 'sqlite',
  ) => {
    const original = (target as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;
    patches.push({ target, name, original });
    (target as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      const counted = store.getStore();
      if (counted) {
        counted.statements.push(text(this, args));
        counted.engines.push(engine);
      }
      return original.apply(this, args);
    };
  };
  const sqlOf = (statement: unknown) => (statement as StatementSync).sourceSQL ?? '?';
  for (const name of ['all', 'get', 'run', 'iterate']) patch(StatementSync.prototype, name, (self) => sqlOf(self));
  patch(DatabaseSync.prototype, 'exec', (_self, args) => String(args[0]));
  if (pgClient) {
    patch(
      pgClient.prototype,
      'query',
      (_self, args) => {
        const first = args[0];
        return typeof first === 'string' ? first : String((first as { text?: unknown } | undefined)?.text ?? '?');
      },
      'postgres',
    );
  }

  const listeners = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  for (const listener of listeners) {
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const counted: Counted = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], statements: [], engines: [] };
      requests.push(counted);
      store.run(counted, () => listener(req, res));
    });
  }

  const only = (path: string) => {
    const matching = requests.filter((request) => request.path === path);
    if (matching.length !== 1) throw new Error(`Expected one request to ${path}, saw ${matching.length}.`);
    return matching[0];
  };
  return {
    requests,
    one: (path) => only(path).statements,
    on(path, engine) {
      const counted = only(path);
      return counted.statements.filter((_, index) => counted.engines[index] === engine);
    },
    clear() {
      requests.length = 0;
    },
    restore() {
      for (const { target, name, original } of patches.reverse()) (target as Record<string, unknown>)[name] = original;
      server.removeAllListeners('request');
      for (const listener of listeners) server.on('request', listener);
    },
  };
}
