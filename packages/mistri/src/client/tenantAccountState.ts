/** Synchronous account-session and mutation-exit probes. Controllers register
 * only their live admissions/attempts; their transport and dialogs load later. */
import type { TenantAdministrationController } from './tenantAdministration.js';
import type { TenantInvitationsController } from './tenantInvitations.js';

export const administrationAdmitted = new Set<TenantAdministrationController>();
export const administrationUnresolved = new Set<TenantAdministrationController>();
export const invitationAdmitted = new Set<TenantInvitationsController>();
export const invitationUnresolved = new Set<TenantInvitationsController>();

/** UI availability only: requests still prove their captured native account. */
export function hasAdministrationSession(): boolean {
  return [...administrationAdmitted].some((controller) => controller.current() && controller.snapshot().session !== null);
}
export function hasInvitationSession(): boolean {
  return [...invitationAdmitted].some((controller) => controller.current());
}
/** Unmounting a dialog never settles an uncertain attempt. */
export function hasUnresolvedAdministration(): boolean {
  return [...administrationUnresolved].some((controller) => controller.current() && controller.locked());
}
export function hasUnresolvedInvitations(): boolean {
  return [...invitationUnresolved].some((controller) => controller.current() && controller.locked());
}
