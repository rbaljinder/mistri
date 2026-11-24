/**
 * The signed-in reader's account profile as a page component asks for it (`useAccountProfile()`): over the same
 * `/api/auth/profile` and `/api/auth/change-email` routes the shell's account dialog uses (`accountProfile.ts`),
 * loaded lazily only when a component calls one of its methods. Every method checks `owner.accountId` and `owner.appId`.
 */
import { sessionIdentity, type SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';
import { noAccountProfileAccess, type AccountProfileAccess } from './accountProfileTypes.js';

export function createAccountProfileAccess(readIdentity: () => SessionIdentitySnapshot = sessionIdentity): AccountProfileAccess {
  return {
    async read() {
      const owner = readIdentity();
      if (owner.mode !== 'authenticated' || !owner.accountId || !owner.appId) return null;
      const { loadAccountProfile } = await import('./accountProfile.js');
      return loadAccountProfile(owner);
    },
    async save(name) {
      const owner = readIdentity();
      if (owner.mode !== 'authenticated' || !owner.accountId || !owner.appId) {
        return noAccountProfileAccess.save(name);
      }
      const { saveAccountProfile } = await import('./accountProfile.js');
      return saveAccountProfile(owner, name);
    },
    async changeEmail(newEmail) {
      const owner = readIdentity();
      if (owner.mode !== 'authenticated' || !owner.accountId || !owner.appId) {
        return noAccountProfileAccess.changeEmail(newEmail);
      }
      const { requestEmailChange } = await import('./accountProfile.js');
      return requestEmailChange(owner, newEmail);
    },
  };
}
