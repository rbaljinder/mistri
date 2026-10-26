/**
 * The order tenant features are checked in at startup and attested in at
 * enrollment. It is explicit because it is observable: the first check that
 * fails names the refusal, and every attestation reads the same snapshot. A
 * feature adds its own tenantFeature*.ts module and one line to each list it
 * needs; nothing here decides anything itself.
 */
import { administrationJournalHook, administrationWriteCheck } from './tenantFeatureAdministration.js';
import { cloneCheck, sandboxStoreHook } from './tenantFeatureClone.js';
import { commandJournalHook, commandLookupCheck, commandReferencesCheck } from './tenantFeatureCommands.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { delegationHook, delegationRoleCheck } from './tenantFeatureDelegation.js';
import { effectsCheck, effectsHook } from './tenantFeatureEffects.js';
import { eventStoreHook } from './tenantFeatureEvents.js';
import { intakeCheck } from './tenantFeatureIntake.js';
import { publicReadsCheck } from './tenantFeaturePublicReads.js';
import { integrationsCheck, integrationsHook } from './tenantFeatureIntegrations.js';
import { invitationAuthStoreCheck, invitationLinksHook, invitationWriteCheck } from './tenantFeatureInvitations.js';
import { jobsCheck, jobsHook } from './tenantFeatureJobs.js';
import { roleCeilingCheck, roleCeilingHook } from './tenantFeatureMembershipRoles.js';
import { ownershipHook } from './tenantFeatureOwnership.js';
import { SUPPORT_STARTUP_CHECKS, supportHook } from './tenantFeatureSupport.js';
import { platformSourceCommandsCheck, platformSourcesCheck, platformSourcesHook } from './tenantFeaturePlatformSources.js';

/** prepareTenantStartup runs the `policy` checks once the server-only policy
 * has loaded, and the `commands` checks once the registry has, in this order. */
export const TENANT_STARTUP_CHECKS: readonly TenantStartupCheck[] = Object.freeze([
  platformSourcesCheck,
  platformSourceCommandsCheck,
  administrationWriteCheck,
  invitationWriteCheck,
  roleCeilingCheck,
  delegationRoleCheck,
  invitationAuthStoreCheck,
  ...SUPPORT_STARTUP_CHECKS,
  commandLookupCheck,
  intakeCheck,
  publicReadsCheck,
  effectsCheck,
  commandReferencesCheck,
  jobsCheck,
  integrationsCheck,
  cloneCheck,
]);

/** createTenantEnrollment runs every `declare`, then, in its snapshot, every
 * engine attestation, each phase in this order. */
export const TENANT_ENROLLMENT_HOOKS: readonly TenantEnrollmentHook[] = Object.freeze([
  platformSourcesHook,
  commandJournalHook,
  ownershipHook,
  roleCeilingHook,
  delegationHook,
  effectsHook,
  eventStoreHook,
  jobsHook,
  integrationsHook,
  administrationJournalHook,
  invitationLinksHook,
  supportHook,
  sandboxStoreHook,
]);
