/** Private one-shot operator integration. No public dispatch, stdout or auth
 * startup. Loaded source is trusted operator code;
 * dependency injection is a test seam, not admission or ownership evidence. */
import { randomUUID } from 'node:crypto';
import { loadApp } from '../app/apps.js';
import { apiExposesCommands } from '../../shared/appApi.js';
import { loadConfig, Registry } from '@mistriwork/engine/server/connections.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';
import { loadBusinessCommands } from '../commands/businessCommandLoader.js';
import { provisionSqliteApiTokenStore } from '../auth/provisionSqliteApiTokenStore.js';
import {
  inspectSqliteApiToken,
  revokeSqliteApiToken,
  issueSqliteApiToken,
  issueSqliteApiCommandToken,
} from '../auth/sqliteApiTokenMaintenance.js';
import { parseApiTokenArgs } from './apiTokenArgs.js';
import { resolveSqliteTokenRevokeContext } from './apiTokenContext.js';
import { loadSqliteTokenSchema, type TokenCommandEvidence } from './apiTokenSchema.js';
import { appAuthStore } from '../auth/auth.js';
import { resolvePostgresTokenRevokeContext } from './postgresApiTokenContext.js';
import { provisionPostgresApiTokenStore } from '../auth/provisionPostgresApiTokenStore.js';
import {
  inspectPostgresApiToken,
  revokePostgresApiToken,
  issuePostgresApiToken,
  issuePostgresApiCommandToken,
} from '../auth/postgresApiTokenMaintenance.js';
import { loadPostgresTokenSchema } from './postgresApiTokenSchema.js';
import { readTenantIssuance } from './apiTokenTenant.js';
import { issueSqliteApiTenantToken } from '../auth/sqliteApiTokenMaintenance.js';
import { issuePostgresApiTenantToken } from '../auth/postgresApiTokenMaintenance.js';

const production = {
  loadApp,
  loadConfig: (path: string | undefined) => loadConfig(path, CONFIG_SECTIONS),
  context: resolveSqliteTokenRevokeContext,
  provision: provisionSqliteApiTokenStore,
  inspect: inspectSqliteApiToken,
  revoke: revokeSqliteApiToken,
  now: Date.now,
  schema: loadSqliteTokenSchema,
  issue: issueSqliteApiToken,
  pgContext: resolvePostgresTokenRevokeContext,
  pgProvision: provisionPostgresApiTokenStore,
  pgInspect: inspectPostgresApiToken,
  pgRevoke: revokePostgresApiToken,
  pgSchema: loadPostgresTokenSchema,
  pgIssue: issuePostgresApiToken,
  commands: loadBusinessCommands,
  commandIssue: issueSqliteApiCommandToken,
  pgCommandIssue: issuePostgresApiCommandToken,
  tenant: readTenantIssuance,
  tenantIssue: issueSqliteApiTenantToken,
  pgTenantIssue: issuePostgresApiTenantToken,
};
const refuse = (): never => {
  throw new Error('API token maintenance could not be completed.');
};

export async function runApiTokenMaintenance(
  rawArgv: unknown,
  dependencies: typeof production = production,
  onIssueLocator?: (tokenId: string) => void,
) {
  try {
    const args = parseApiTokenArgs(rawArgv);
    const config = await dependencies.loadConfig(args.config);
    if (!config) return refuse();
    // Registry.add/configs only normalize identities; no adapter is opened.
    // Ignore any undeclared JSON id exactly as ordinary config startup does.
    const registry = new Registry();
    let connections;
    try {
      for (const connection of config.connections) registry.add({ ...connection, id: undefined, source: 'config' });
      connections = registry.configs();
    } finally {
      await registry.closeAll();
    }
    const app = await dependencies.loadApp(args.app, { lock: 'enforce' });
    /* A command-exposing App's catalog includes its commands, which only its
       registry can check: issuance takes --commands exactly then, and loads
       no command code otherwise. Decided before any context or data is read.
       Provision, inspect and revoke never need it; revoke must still work
       after an exposure is removed. */
    const commandsFile = args.verb === 'issue' ? args.commands : undefined;
    if (args.verb === 'issue' && apiExposesCommands(app.app.api) !== (commandsFile !== undefined)) return refuse();
    /* A tenant App's token binds one tenant membership, read from its business
       store with its policy; an `all` App's never does. Its commands, when it
       exposes them, are checked against that deployment's attested ownership,
       not the ordinary command evidence. Decided before any data is read. */
    const tenantApp = app.app.auth?.rows === 'tenant';
    const tenantInput =
      args.verb === 'issue' && args.tenant !== undefined && args.policy !== undefined
        ? { policyFile: args.policy, tenantId: args.tenant, accountId: args.subjectId }
        : undefined;
    if (args.verb === 'issue' && (tenantApp !== (tenantInput !== undefined) || (args.tenant === undefined) !== (args.policy === undefined)))
      return refuse();
    let evidence: TokenCommandEvidence | undefined;
    const capture = (captured: TokenCommandEvidence) => {
      evidence = captured;
    };
    if (/^postgres(?:ql)?:\/\//i.test(appAuthStore(app))) {
      const pg = await dependencies.pgContext([app], connections);
      if (args.verb === 'issue') {
        const declared = commandsFile === undefined ? undefined : await dependencies.commands(commandsFile);
        const tenant = tenantInput && (await dependencies.tenant(app, connections, tenantInput, declared));
        const schema = tenant
          ? undefined
          : await dependencies.pgSchema(app, connections, pg.excludeConnections, declared ? capture : undefined);
        const current = await dependencies.pgContext([app], connections);
        if (
          current.url !== pg.url ||
          current.appId !== pg.appId ||
          JSON.stringify(current.excludeConnections) !== JSON.stringify(pg.excludeConnections)
        )
          return refuse();
        if (declared && !tenant && !evidence) return refuse();
        const tokenId = randomUUID();
        onIssueLocator?.(tokenId);
        const options = {
          storeId: args.storeId,
          excludeConnections: current.excludeConnections,
          tokenId,
          subjectId: args.subjectId,
          actorId: args.actorId,
          roles: args.roles,
          label: args.label,
          expiresAt: args.expiresAt,
          ...(args.operations === undefined ? {} : { operations: args.operations }),
          ...(tenant ? { tenant: tenant.tenant } : {}),
        };
        return Object.freeze({
          verb: args.verb,
          result: tenant
            ? await dependencies.pgTenantIssue(current.url, app.app, tenant.catalog, options, dependencies.now)
            : declared
              ? await dependencies.pgCommandIssue(current.url, app.app, schema!, declared, evidence!, options, dependencies.now)
              : await dependencies.pgIssue(current.url, app.app, schema!, options, dependencies.now),
        });
      }
      const owner = { appId: pg.appId, storeId: args.storeId, excludeConnections: pg.excludeConnections };
      if (args.verb === 'provision') return Object.freeze({ verb: args.verb, result: await dependencies.pgProvision(pg.url, owner) });
      if (args.verb === 'inspect')
        return Object.freeze({ verb: args.verb, result: await dependencies.pgInspect(pg.url, { ...owner, tokenId: args.tokenId }) });
      return Object.freeze({
        verb: args.verb,
        result: await dependencies.pgRevoke(
          pg.url,
          { ...owner, tokenId: args.tokenId, expectedVersion: args.expectedVersion, actorId: args.actorId },
          dependencies.now,
        ),
      });
    }
    const context = await dependencies.context([app], connections);
    if (args.verb === 'issue') {
      // Command code is trusted operator code, loaded before the catalog read
      // so nothing it does can land between that read and the context recheck.
      const declared = commandsFile === undefined ? undefined : await dependencies.commands(commandsFile);
      const tenant = tenantInput && (await dependencies.tenant(app, connections, tenantInput, declared));
      // The schema loader closes its registry before returning. No awaited
      // cleanup can replace a committed secret with an unrelated close error.
      const schema = tenant ? undefined : await dependencies.schema(app, connections, declared ? capture : undefined);
      const current = await dependencies.context([app], connections);
      if (
        current.path !== context.path ||
        current.appId !== context.appId ||
        JSON.stringify(current.exclusions) !== JSON.stringify(context.exclusions)
      )
        return refuse();
      if (declared && !tenant && !evidence) return refuse();
      const tokenId = randomUUID();
      onIssueLocator?.(tokenId);
      const options = {
        storeId: args.storeId,
        exclusions: current.exclusions,
        tokenId,
        subjectId: args.subjectId,
        actorId: args.actorId,
        roles: args.roles,
        label: args.label,
        expiresAt: args.expiresAt,
        ...(args.operations === undefined ? {} : { operations: args.operations }),
        ...(tenant ? { tenant: tenant.tenant } : {}),
      };
      return Object.freeze({
        verb: args.verb,
        result: tenant
          ? dependencies.tenantIssue(current.path, app.app, tenant.catalog, options, dependencies.now())
          : declared
            ? dependencies.commandIssue(current.path, app.app, schema!, declared, evidence!, options, dependencies.now())
            : dependencies.issue(current.path, app.app, schema!, options, dependencies.now()),
      });
    }
    const owner = { appId: context.appId, storeId: args.storeId, exclusions: context.exclusions };
    if (args.verb === 'provision') {
      return Object.freeze({ verb: args.verb, result: dependencies.provision(context.path, owner) });
    }
    if (args.verb === 'inspect') {
      return Object.freeze({ verb: args.verb, result: dependencies.inspect(context.path, { ...owner, tokenId: args.tokenId }) });
    }
    return Object.freeze({
      verb: args.verb,
      result: dependencies.revoke(
        context.path,
        { ...owner, tokenId: args.tokenId, expectedVersion: args.expectedVersion, actorId: args.actorId },
        dependencies.now(),
      ),
    });
  } catch {
    return refuse();
  }
}
