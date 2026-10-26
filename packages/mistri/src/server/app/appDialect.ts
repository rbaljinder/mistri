/**
 * What an App may run on: PostgreSQL and SQLite. MySQL and MariaDB are
 * supported for browsing — the database browser and its MCP server — and an
 * App brings writers, row scopes, history and transactions the MySQL adapter
 * is not held to, so an App whose source is one is refused at `check` and at
 * startup in the words the status page uses (docs/status).
 *
 * Judged from the connection's URL scheme before any database is dialed. An
 * App with no connection of its own runs on the active one.
 */
import type { AppDef } from '../../shared/app.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';

export function appDialectProblems(app: AppDef, registry: Pick<Registry, 'list' | 'active'>): string[] {
  const connections = registry.list();
  const find = (reference: string | undefined) =>
    reference === undefined
      ? connections.find((connection) => connection.id === registry.active)
      : connections.find((connection) => connection.id === reference || connection.name === reference);
  const bound: Array<{ at: string; reference: string | undefined }> = app.sources
    ? Object.entries(app.sources).map(([name, source]) => ({
        at: `source "${name}" (connection "${source.connection}")`,
        reference: source.connection,
      }))
    : [{ at: `connection${app.connection ? ` "${app.connection}"` : ''}`, reference: app.connection }];
  const problems: string[] = [];
  for (const { at, reference } of bound) {
    const found = find(reference);
    if (found?.dialect !== 'mysql' && found?.dialect !== 'mariadb') continue;
    problems.push(
      `${app.name}: its ${at} is a ${found.dialect === 'mariadb' ? 'MariaDB' : 'MySQL'} database [app-on-mysql]. ` +
        'An App runs on PostgreSQL or SQLite. MySQL/MariaDB is supported for browsing, in the database browser and its MCP server. ' +
        'Point the App at a PostgreSQL or SQLite connection, or open this database without --app.',
    );
  }
  return problems;
}

/** Startup's refusal: the first App on a MySQL or MariaDB database stops the start. */
export function assertAppDialects(apps: readonly AppDef[], registry: Pick<Registry, 'list' | 'active'>): void {
  for (const app of apps) {
    const [problem] = appDialectProblems(app, registry);
    if (problem) throw new Error(problem);
  }
}
