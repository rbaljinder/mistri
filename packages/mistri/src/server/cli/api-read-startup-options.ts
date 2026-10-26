/** Early opt-in validation only. No hosts, credentials, databases or listeners
 * are acquired here; serving must separately await genuine API readiness. */
import type { LoadedApp } from '../app/apps.js';
import type { ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { homeSourceOf } from '../../shared/app.js';
import { assertAppApiContext, readApiApp } from '../api/appApiValidation.js';
import { apiExposedSources, apiExposesCommands } from '../../shared/appApi.js';
import { appAuthStore } from '../auth/auth.js';
import { isExplicitPostgresUrl } from './postgresApiTokenContext.js';
import { expandEnv } from '@mistriwork/engine/server/auth/credentials.js';
// The flags alone are checked in startupOptions.ts, which main reads on every start.

/** The one App an API mode serves, and its engine, before any database opens:
 * SQLite on unambiguous literal business and native auth file paths, or
 * PostgreSQL on explicit postgres:// URLs for both (user, host, port and
 * database named; the token CLI's rule). A business URL is judged as it will
 * be opened, its `${VAR}` references expanded first, so a config that names
 * its database by reference is not refused for the spelling. A tenant App
 * may mix them — PostgreSQL data beside the default local SQLite sign-ins —
 * because its owner reads the token and the membership in two stores anyway
 * (tenantApiReadOwner.ts); an ordinary App's owners read both in one engine,
 * so for it mixed engines, HTTP sources and anything else refuse. `commands`: whether `--commands` was given — an App
 * that exposes commands is never served without its registry. `policy`:
 * whether `--policy` was given — a tenant App is served under its policy, by
 * its tenant host (or its own MCP enrollment), a row-policy App under its row
 * policy, and an App whose roles read all rows under none. The owners
 * still check the engine, the stores and their separation themselves. */
export function apiStartupEngine(
  apps: readonly LoadedApp[],
  connections: readonly ConnectionConfig[],
  commands: boolean,
  mode: '--api-reads' | '--app-mcp',
  policy = false,
): 'sqlite' | 'postgres' {
  if (apps.length !== 1 || !apps[0].app.auth || !apps[0].app.api) throw new Error(`${mode} requires one authenticated API App.`);
  const loaded = apps[0],
    app = loaded.app,
    rows = app.auth?.rows ?? 'all';
  /* A row-policy App's rows are its policy's to narrow for the token's
     account (policyApiOwner.ts), so it is served under that policy, as its
     pages are; a tenant App's under its tenant policy. */
  if (rows === 'policy' && !policy) throw new Error(`${mode} serves a row-policy App under its --policy <file>.`);
  if (rows === 'tenant' && !policy) throw new Error(`${mode} serves a tenant App under its --policy <file>.`);
  if (rows === 'all' && policy) throw new Error(`${mode} takes --policy only for a tenant or row-policy App.`);
  assertAppApiContext(readApiApp(app));
  if (apiExposesCommands(app.api) && !commands)
    throw new Error(`This App exposes API commands: ${mode} needs --commands <file> to serve them.`);
  /* Every connection an exposed operation reads is served by the one
     engine the owners run, the auth store's; a source the API never reads is
     not judged. A one-source App names its home connection, as before. */
  const exposed = app.sources ? apiExposedSources(app).map((source) => app.sources![source].connection) : [];
  const references = exposed.length ? [...new Set(exposed)] : [app.sources ? app.sources[homeSourceOf(app)!]?.connection : app.connection];
  const postgres = (value: string) => /^postgres(?:ql)?:\/\//i.test(value);
  const literal = (path: string) =>
    !!path &&
    path.trim() === path &&
    !/[\p{Cc}\p{Cs}]/u.test(path) &&
    !path.startsWith('~') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
    !/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(path);
  const refusal =
    rows === 'tenant'
      ? `${mode} requires a literal SQLite file path or an explicit PostgreSQL URL for the business source, and for the native auth store.`
      : `${mode} requires unambiguous literal SQLite business and native auth file paths, or explicit PostgreSQL URLs for both.`;
  const businesses = references.map((reference) => {
    const matches = connections.filter(
      (connection) => reference === undefined || connection.id === reference || connection.name === reference,
    );
    if (matches.length !== 1 || matches[0].http) throw new Error(refusal);
    try {
      return expandEnv(matches[0].url);
    } catch {
      throw new Error(refusal);
    }
  });
  const store = appAuthStore(loaded);
  const engineOf = (value: string, written: string | undefined): 'sqlite' | 'postgres' => {
    if (postgres(value)) {
      if (!isExplicitPostgresUrl(value)) throw new Error(refusal);
      return 'postgres';
    }
    if (!literal(value) || (written !== undefined && !literal(written))) throw new Error(refusal);
    return 'sqlite';
  };
  const engines = businesses.map((business) => engineOf(business, undefined)),
    data = engines[0],
    auth = engineOf(store, app.auth?.store);
  if (rows !== 'tenant' && engines.some((engine) => engine !== auth)) throw new Error(refusal);
  return data;
}

/** The engine `--api-reads` serves over HTTP, both with the same checks.
 * `network`: the operator listens beyond loopback (startupOptions.ts), which
 * the App must have declared too — the operator alone cannot widen it. */
export function assertApiReadStartupComposition(
  apps: readonly LoadedApp[],
  connections: readonly ConnectionConfig[],
  commands = false,
  policy = false,
  network = false,
) {
  const engine = apiStartupEngine(apps, connections, commands, '--api-reads', policy);
  if (network && apps[0].app.api?.network !== true)
    throw new Error(
      '--api-reads serves beyond loopback (--host, --allowed-host or --trust-proxy) only for an App whose api declares network: true.',
    );
  return engine;
}
