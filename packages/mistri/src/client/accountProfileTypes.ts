/**
 * What `useAccountProfile()` reads and changes, apart from the routes that answer it (`accountProfile.ts`),
 * so an embedded headless surface can supply an empty profile access without importing the SDK hooks module.
 */
import type { AccountProfile } from '../shared/accountProfile.js';
import { say } from './copy/account/accountProfileTypes.js';

export interface AccountProfileAccess {
  read(): Promise<AccountProfile | null>;
  save(name: string): Promise<AccountProfile>;
  changeEmail(newEmail: string): Promise<void>;
}

const noProfile = async () => Promise.reject(new Error(say('noAccountProfile')));

export const noAccountProfileAccess: AccountProfileAccess = Object.freeze({
  read: async () => null,
  save: noProfile,
  changeEmail: noProfile,
});
