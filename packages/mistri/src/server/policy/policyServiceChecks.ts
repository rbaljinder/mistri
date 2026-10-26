/**
 * `mistri check` for a row-policy App that runs jobs: every principal of the
 * jobs module is one the policy's `services` names (startup refuses one that
 * is not), a service it names is one something runs as, and the rows the
 * policy gives each service, asked of the check's database, reach the tables
 * its commands read and write. The last is advice: the rows a policy gives
 * may depend on data the check database does not hold.
 */
import { isPromise } from 'node:util/types';
import { logicalResource, type AppDef } from '../../shared/app.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { PolicyPrincipal } from './appPolicyContext.js';
import { acquireAppPolicyResources } from './appPolicyResources.js';
import { loadAppRowPolicy } from './appRowPolicy.js';
import { createPolicyDb } from './policyDb.js';
import { appZone } from '../../shared/appZone.js';

export async function policyServiceFindings(
  options: Readonly<{
    registry: Registry;
    app: AppDef;
    file: string;
    commands: BusinessCommandRegistry | undefined;
    /** The jobs module's principals and the roles it gives each. */
    principals: ReadonlyMap<string, readonly string[]>;
    /** The commands each principal runs: its jobs', timers', workflow steps', inbound endpoints' and integration webhooks'. */
    runs: ReadonlyMap<string, ReadonlySet<string>>;
  }>,
): Promise<{ problems: string[]; warnings: string[] }> {
  const { app, principals, runs } = options;
  const policy = await loadAppRowPolicy(options.file);
  const listed = policy.services ?? [];
  const problems = [...principals.keys()]
    .filter((name) => !listed.includes(name))
    .map(
      (name) =>
        `[policy-service-unnamed] The jobs run as "${name}", which the row policy's services do not name: add it to services, or the jobs it runs run nothing.`,
    );
  const warnings = listed
    .filter((name) => !principals.has(name))
    .map(
      (name) =>
        `[policy-service-unused] The row policy's services name "${name}", which no job, timer, workflow, inbound endpoint or integration runs as.`,
    );
  const asked = listed.filter((name) => principals.has(name) && runs.get(name)?.size);
  if (!asked.length || !options.commands) return { problems, warnings };
  const acquired = await acquireAppPolicyResources(options.registry, app);
  try {
    const context = Object.freeze({ db: createPolicyDb(acquired.resources, appZone(app.ui)) });
    for (const name of asked) {
      const principal: PolicyPrincipal = Object.freeze({
        id: `service:${name}`,
        appId: app.id,
        roles: Object.freeze([...principals.get(name)!]),
        kind: 'service' as const,
      });
      let rows: RowScope;
      try {
        const resolved = policy.resolveRows(principal, context);
        rows = isPromise(resolved) ? await resolved : resolved;
      } catch (error) {
        warnings.push(
          `[policy-service-rows] The row policy's resolveRows threw for service "${name}" on this database (${(error as Error).message}); its attempts would be retried and then fail.`,
        );
        continue;
      }
      const reported = new Set<string>();
      for (const id of runs.get(name)!) {
        const command = Object.hasOwn(options.commands, id) ? options.commands[id] : undefined;
        if (!command) continue;
        for (const table of [...command.write, ...command.read].map((local) => logicalResource(app, command.source, local))) {
          const rule = rows && typeof rows === 'object' && Object.hasOwn(rows, table) ? rows[table] : undefined;
          if ((rule !== undefined && rule !== false) || reported.has(table)) continue;
          reported.add(table);
          warnings.push(
            `[policy-service-rows] The row policy gives service "${name}" no rows of "${table}" on this database, which its command "${id}" reaches: its runs there find nothing and write nothing.`,
          );
        }
      }
    }
  } finally {
    await acquired.release();
  }
  return { problems, warnings };
}
