/** Own-account presentation only; never a business-resource or authority DTO. */
export interface AccountProfile {
  accountId: string;
  appId: string;
  name: string;
  email: string;
  providers: string[];
  /** The address can be changed here: the App sends mail, and the account signs in by email. */
  emailChange?: true;
  /** The App's authorization server issues tokens (api/oauthConfig.ts): the profile lists the applications this person connected. */
  connectedClients?: true;
}

export const PROFILE_NAME_LIMIT = 120;
export function profileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const name = value.trim();
  if (!name.length || name.length > PROFILE_NAME_LIMIT || /[\p{Cc}\u2028\u2029]/u.test(name)) return;
  return name;
}
