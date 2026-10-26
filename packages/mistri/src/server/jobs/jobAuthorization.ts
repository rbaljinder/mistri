/**
 * A job attempt's authority, asked fresh on every attempt by the runner.
 *
 * The principal is server-declared: the jobs module names it and the App
 * role names it holds. An attempt is granted only while the job is still
 * registered at its version, the App is the one the job belongs to, and the
 * principal's roles, read from the App loaded now, grant the job's command
 * and grant no generic write and no operations. Editing the App's role
 * revokes at the next attempt; the module's own declaration changes only on
 * restart. The command's in-transaction authorization runs after this.
 */
import { appCommandGrants, type AppDef } from '../../shared/app.js';
import { serviceRoleRefusal } from '../commands/businessCommandAuthorization.js';
import type { BusinessCommandActor } from '../commands/businessCommands.js';
import type { CapturedJobModule } from './jobModule.js';
import type { JobAuthorizer } from './jobRunner.js';
import { isWorkflowJob, WORKFLOW_JOB_PREFIX, WORKFLOW_JOB_VERSION } from '../workflows/workflowKeys.js';

/** The actor a principal's command runs as, and its receipts name. */
export function serviceActor(appId: string, principal: string, roles: readonly string[]): BusinessCommandActor {
  return Object.freeze({ id: `service:${principal}`, appId, roles: Object.freeze([...roles]), kind: 'service' as const });
}

export function createJobAuthorizer(
  options: Readonly<{
    module: CapturedJobModule;
    appId: string;
    /** The App as it is loaded now; a hot reload is seen by the next attempt. */
    app: () => AppDef;
    attemptTimeoutMs: number;
    now: () => number;
  }>,
): JobAuthorizer {
  const { module, appId, attemptTimeoutMs } = options;
  return (request) => {
    const workflow = isWorkflowJob(request.job) ? module.workflows.get(request.job.slice(WORKFLOW_JOB_PREFIX.length)) : undefined;
    if (workflow) {
      // A workflow's advance is granted while its principal's roles are sound; each step's command is then authorized as the principal, in its own transaction.
      const app = options.app();
      const roles = module.principals.get(workflow.runAs);
      if (
        request.version !== WORKFLOW_JOB_VERSION ||
        request.provenance.appId !== appId ||
        !app ||
        app.id !== appId ||
        !roles ||
        serviceRoleRefusal(app, roles)
      )
        return null;
      return { audience: 'mistri.jobs', job: request.job, version: request.version, appId, expiresAt: options.now() + attemptTimeoutMs };
    }
    const job = module.jobs.get(request.job);
    if (!job || job.version !== request.version || request.provenance.appId !== appId) return null;
    const app = options.app();
    const roles = module.principals.get(job.runAs);
    if (!app || app.id !== appId || !roles || serviceRoleRefusal(app, roles) || !appCommandGrants(app, roles).has(job.command.id))
      return null;
    // Within the attempt's own deadline, which the runner keeps below the lease.
    return { audience: 'mistri.jobs', job: job.id, version: job.version, appId, expiresAt: options.now() + attemptTimeoutMs };
  };
}
