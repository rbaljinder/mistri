/**
 * Tenant clone at startup and enrollment. An App that marks a
 * resource `clone` has its plan judged before anyone can clone — an
 * auto-increment id, a reference the copy would have to leave pointing at the
 * source tenant, a profile column no two tenants may share that cannot be
 * cleared — and its sandbox store attested, never provisioned.
 */
import type { AppDef } from '../../shared/app.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { tenantClonePlan, TenantCloneRefusal } from './tenantClonePlan.js';
import { assertSandboxStore, assertSqliteSandboxStore, postgresSandboxSession } from './tenantSandboxStore.js';
import { TenantAuthoringStartupError } from './tenantStartupError.js';

const clones = (app: AppDef) => Object.values(app.resources ?? {}).some((resource) => resource.clone !== undefined);

export const cloneCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  stage: 'the resources marked clone',
  run: ({ app, owned, policy }) => {
    try {
      tenantClonePlan(app, owned, policy);
    } catch (error) {
      // The author's own marks, named: mistri check is asked what is wrong.
      if (error instanceof TenantCloneRefusal)
        throw new TenantAuthoringStartupError(`Tenant startup could not validate the resources marked clone:\n  ${error.message}`);
      throw error;
    }
  },
});

export const sandboxStoreHook = Object.freeze<TenantEnrollmentHook>({
  sqlite: (db, { app }) => {
    if (clones(app)) assertSqliteSandboxStore(db);
  },
  postgres: async (client, { app }) => {
    if (clones(app)) await assertSandboxStore(postgresSandboxSession(client));
  },
});
