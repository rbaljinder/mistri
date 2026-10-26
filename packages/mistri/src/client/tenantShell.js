/**
 * A tenant App's flows, as the shell reaches them: choosing a tenant, its
 * links and history, the support visit. One module the shell loads for a
 * tenant session (app.js `boot`), so no other page carries them.
 */
export {
  checkBrowserTenant,
  configureTenantResume,
  configureTenantSupport,
  initialTenantSelection,
  refreshTenantDiscovery,
  suspendBrowserTenant,
  tenantControl,
} from './tenantBrowser.js';
export { parseTenantLink, qualifyTenantLink, tenantRootLink } from './tenantLink.js';
export { followTenantHistory } from './tenantNavigation.js';
