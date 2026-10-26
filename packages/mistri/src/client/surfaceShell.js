/**
 * The shell answers every App surface gives the kit, the public pages as much
 * as the App shell: who the visitor is, how a tenant's requests travel, which
 * writes are still unresolved, and where an App's components come from.
 *
 * The App shell lays these under the rest of its answers (appnav.js
 * `appShell`); a public form or landing, drawn without that shell, names them
 * itself before it draws (publicSurface.js). Before installShell, core.js and
 * the value and input slots imported these modules directly, so a public page
 * had them without asking.
 */
import { isPublicVisitor } from './publicVisitor.js';
import { PUBLIC_READ_GETS, PUBLIC_READ_POSTS } from '../shared/tenantPublicReads.js';
import { isTenantMutationPath, tenantMutationApi, tenantReadApi } from './tenantTransport.js';
import { tenantMutationState } from './tenantMutationState.js';
import { hasUnresolvedAdministration, hasUnresolvedInvitations } from './tenantAccountState.js';
import { appComponents } from './components/sdk/appComponents.js';

/** @satisfies {Partial<import('@mistriwork/kit/client/shellMode.js').ShellMode>} */
export const surfaceShell = {
  publicVisitor: isPublicVisitor,
  /** @param {string} path */
  publicRead: (path) => PUBLIC_READ_GETS.has(path) || PUBLIC_READ_POSTS.has(path),
  tenant: { read: tenantReadApi, mutate: tenantMutationApi, isMutation: isTenantMutationPath },
  mutations: tenantMutationState,
  accountBusy: () => hasUnresolvedAdministration() || hasUnresolvedInvitations(),
  components: appComponents,
};
